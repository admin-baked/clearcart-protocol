// MetaLiveProvider: the live Meta Model API provider, wired through the
// connected account's helper CLI instead of an env-var API key.
//
// The API key lives in the registered Muse connection
// (custom.meta-model-api) and is never present in this process, in the
// environment, or in any file here. Each completion shells out to the
// connection's helper:
//
//   meta-model-api chat    reads a chat-completions JSON body on stdin,
//                          POSTs it to https://api.meta.ai/v1/chat/completions
//                          with the connection's bearer credential, and
//                          prints the response JSON on stdout.
//
// Model: muse-spark-1.3, confirmed callable on this team via the helper's
// models command (the -contributor variants are deliberately not used,
// because their inputs and outputs are used for training).
//
// Message mapping (interface adaptation, kept inside this provider):
// the buyer agent's history stores tool results as role "tool" messages,
// but it does not retain the structured tool-call envelopes (call ids and
// argument payloads) that the chat-completions schema requires before a
// role "tool" message is valid. Rather than fabricate those envelopes,
// this provider renders each tool result as a user turn labeled with the
// tool's name, and passes the agent's own "[tool call: name]" assistant
// notes through as assistant text. The transcript stays schema-valid and
// truthful, and the model still receives the tools list on every call, so
// its next action is a real tool call in the current turn.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Completion, Message, ModelProvider, ToolCall, ToolDefinition } from "./model-provider.ts";

export interface MetaLiveCallRecord {
  seq: number;
  timestamp: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface MetaLiveOptions {
  /** Model ID to call. Defaults to muse-spark-1.3. */
  model?: string;
  /** Path to the connection's helper CLI. Defaults to the registered
   *  custom.meta-model-api helper in the user's workspace. */
  helperPath?: string;
  maxTokens?: number;
  temperature?: number;
  /** Evidence hook: called once per completed model call with the exact
   *  request body sent and the exact response JSON received. */
  onCall?: (record: MetaLiveCallRecord) => void | Promise<void>;
}

const DEFAULT_HELPER = join(
  homedir(),
  "workspace/custom-connectors/custom.meta-model-api/bin/meta-model-api",
);

interface ChatMessage {
  role: string;
  content: string;
}

function mapMessage(m: Message): ChatMessage {
  if (m.role === "tool") {
    // See the mapping note at the top of this file.
    return { role: "user", content: `Tool result (${m.toolName ?? "unknown"}): ${m.content}` };
  }
  return { role: m.role, content: m.content };
}

function parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Live models occasionally wrap the JSON in prose. Recover the object
    // if one is present; otherwise fail loudly rather than invent args.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // fall through to the error below
      }
    }
    throw new Error(`Meta Model API returned unparseable arguments for tool ${toolName}: ${raw}`);
  }
}

export class MetaLiveProvider implements ModelProvider {
  readonly name = "meta-live";
  readonly model: string;
  private readonly helperPath: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly onCall?: MetaLiveOptions["onCall"];
  private callSeq = 0;

  constructor(options: MetaLiveOptions = {}) {
    this.model = options.model ?? "muse-spark-1.3";
    this.helperPath = options.helperPath ?? DEFAULT_HELPER;
    // muse-spark-1.3 spends part of its completion budget on reasoning
    // tokens (see completion_tokens_details.reasoning_tokens in the
    // responses). A 1024 cap truncated long turns to finish_reason
    // "length" with null content, so the default leaves real headroom.
    this.maxTokens = options.maxTokens ?? 4096;
    this.temperature = options.temperature ?? 0.2;
    this.onCall = options.onCall;
  }

  async complete(messages: Message[], tools: ToolDefinition[] = []): Promise<Completion> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(mapMessage),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const response = await this.callHelper(body);

    this.callSeq += 1;
    if (this.onCall) {
      await this.onCall({
        seq: this.callSeq,
        timestamp: new Date().toISOString(),
        request: body,
        response,
      });
    }

    const message = (
      response as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
      }
    ).choices?.[0]?.message;

    if (message?.tool_calls?.length) {
      const toolCalls: ToolCall[] = message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseToolArguments(tc.function.arguments, tc.function.name),
      }));
      return { kind: "tool_calls", toolCalls };
    }
    return { kind: "text", text: message?.content ?? "" };
  }

  private callHelper(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // spawn with an explicit stdin write: the request body goes to the
    // helper on stdin, per its contract. (execFile's input option does
    // not reliably deliver stdin, which leaves the helper blocked on a
    // read that never completes; this shape was verified against the
    // helper directly.)
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, ["chat"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Meta Model API helper call timed out after 150 seconds"));
      }, 150_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 16 * 1024 * 1024) child.kill("SIGTERM");
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Meta Model API helper failed to start: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const detail = stderr.trim() || `exit code ${code}`;
          reject(new Error(`Meta Model API helper call failed: ${detail}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          reject(new Error(`Meta Model API helper returned non-JSON output: ${stdout.slice(0, 200)}`));
        }
      });
      child.stdin.end(JSON.stringify(body));
    });
  }
}
