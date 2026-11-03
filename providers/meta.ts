// Meta Model API provider.
//
// Configuration comes from the environment only:
//   META_MODEL_API_KEY    API key for the Meta Model API account
//   META_MODEL_ID         Model ID to call (account specific, never hardcoded)
//   META_MODEL_API_BASE_URL  Optional base URL override
//
// Status: the request shape below follows the common chat-completions
// pattern, but the exact endpoint and the model IDs available on the
// project account are UNVERIFIED until that account access lands. This
// provider never fabricates a response: with no configuration it throws a
// clear not-configured error, and a failed live call surfaces the HTTP
// error verbatim. Local development and the recorded demo run on
// MockProvider instead.

import type { Completion, Message, ModelProvider, ToolCall, ToolDefinition } from "./model-provider.ts";

export class MetaProviderNotConfiguredError extends Error {
  constructor() {
    super(
      "Meta Model API is not configured. Set META_MODEL_API_KEY and META_MODEL_ID in the environment. " +
        "The model ID is account specific and is never hardcoded. Use MockProvider for local runs and the demo.",
    );
    this.name = "MetaProviderNotConfiguredError";
  }
}

export class MetaModelAPIProvider implements ModelProvider {
  readonly name = "meta-model-api";
  private readonly apiKey?: string;
  private readonly modelId?: string;
  private readonly baseUrl: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.apiKey = env.META_MODEL_API_KEY || undefined;
    this.modelId = env.META_MODEL_ID || undefined;
    this.baseUrl = (env.META_MODEL_API_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
  }

  get configured(): boolean {
    return Boolean(this.apiKey && this.modelId);
  }

  async complete(messages: Message[], tools: ToolDefinition[] = []): Promise<Completion> {
    if (!this.configured) {
      throw new MetaProviderNotConfiguredError();
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })),
        tools: tools.length
          ? tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            }))
          : undefined,
      }),
    });
    if (!res.ok) {
      throw new Error(`Meta Model API call failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    if (message?.tool_calls?.length) {
      const toolCalls: ToolCall[] = message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));
      return { kind: "tool_calls", toolCalls };
    }
    return { kind: "text", text: message?.content ?? "" };
  }
}
