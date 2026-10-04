// Pluggable, OpenAI-compatible chat provider. The open-core platform is model-
// agnostic: any backend that speaks the OpenAI Chat Completions shape (OpenAI,
// a self-hosted gateway, a ChatGPT-subscription proxy, …) can be plugged in.
// The specific ChatGPT-subscription proxy is NOT part of this package.

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional speaker name (group chats prefix human turns with a name). */
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  /** Reasoning effort hint (low | medium | high | xhigh); provider maps it. */
  reasoningEffort?: string;
  /** OpenAI-shaped tool definitions (function tools / MCP-adapted). */
  tools?: unknown[];
  temperature?: number;
}

/**
 * A chat backend. `chat()` returns a raw OpenAI-compatible `Response` — a JSON
 * `chat.completion` when `stream` is false, or an SSE stream of
 * `chat.completion.chunk` frames when true — so callers can stream it straight
 * through. Implementations live outside this package (BYO).
 */
export interface ChatProvider {
  chat(request: ChatCompletionRequest): Promise<Response>;
}
