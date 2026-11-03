// ModelProvider: the only LLM seam in the system.
//
// Every language-model call in ClearCart goes through this interface: the
// buyer agent's intent parsing and tool choices, the merchant agent's
// grounded product answers, and the optional plain-language explanation of
// a gate decision. The gate itself never calls this interface; compliance
// decisions are made by the deterministic rules engine in services/gate.
//
// Two implementations ship:
//   providers/mock.ts  Deterministic mock. The whole demo runs on it with
//                      zero API access.
//   providers/meta.ts  Meta Model API. Model ID comes from environment
//                      configuration only, because the exact model IDs an
//                      account can call are account specific.

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  // Set on role "tool" messages: which tool produced this result.
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type Completion =
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; toolCalls: ToolCall[] };

export interface ModelProvider {
  readonly name: string;
  complete(messages: Message[], tools?: ToolDefinition[]): Promise<Completion>;
}
