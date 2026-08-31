import type { JsonObject, JsonValue } from "@/lib/json";

/**
 * The AI provider interface, owned by this application.
 *
 * Everything below is our vocabulary, not Gemini's. No `@google/genai` type
 * appears in this file, and none may appear anywhere the Buyer Agent can see.
 * The adapter translates in both directions; the agent talks only in these
 * terms.
 *
 * The reason is not hypothetical provider-swapping. It is that a financial
 * decision path must be testable without a network, a key, or a quota. Because
 * the agent depends on this interface, every deterministic test in this
 * objective drives a plain in-memory fake — the budget rules, the provenance
 * rules and the injection defences are all proven without spending a single
 * free-tier request.
 *
 * The interface is also deliberately *small*. It exposes structured generation
 * and a tool-call turn, and nothing else: no streaming, no embeddings, no file
 * upload, no model listing. A capability that is not exposed cannot be reached
 * by a prompt-injected instruction.
 */

/** A tool the model may call. Declared by us, in JSON Schema. */
export interface AiToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. The provider constrains; we re-validate. */
  readonly parameters: JsonObject;
}

/** A tool call the model asked for. Untrusted until validated. */
export interface AiToolCall {
  /** Provider-assigned id, echoed back so results match calls. */
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

/** Our answer to one tool call. */
export interface AiToolResult {
  readonly callId: string;
  readonly name: string;
  /** Serialised catalog data. Always data, never instruction. */
  readonly content: JsonValue;
  readonly isError?: boolean;
}

export interface AiGenerationRequest {
  /** Developer instruction. Never contains a secret and never echoes one. */
  readonly systemInstruction: string;
  readonly userMessage: string;
  /** JSON Schema the provider should constrain output to, when structured. */
  readonly responseSchema?: JsonObject;
  readonly tools?: readonly AiToolDeclaration[];
  /** Correlates provider logs with the agent run. Never the user's prompt. */
  readonly correlationId: string;
}

/**
 * One model turn.
 *
 * Either the model produced text (which, when a schema was supplied, is JSON we
 * then validate) or it asked to call tools. Both can be present; the agent
 * handles tool calls first.
 *
 * `providerStateRef` is an opaque handle for multi-turn continuation. It is
 * deliberately typed as an opaque string and documented as such: the agent must
 * never inspect it, interpret it, persist it, or log it. Whatever the provider
 * keeps behind it — including any internal reasoning metadata — stays inside
 * the provider and inside this process's memory for the life of one request.
 */
export interface AiGenerationResponse {
  readonly text: string | null;
  readonly toolCalls: readonly AiToolCall[];
  readonly providerStateRef: string | null;
}

/** A continuation turn: our tool results going back for the model's next move. */
export interface AiToolResponseRequest {
  readonly providerStateRef: string | null;
  readonly systemInstruction: string;
  readonly toolResults: readonly AiToolResult[];
  readonly responseSchema?: JsonObject;
  readonly tools?: readonly AiToolDeclaration[];
  readonly correlationId: string;
}

/**
 * What the Buyer Agent depends on. Two methods, both bounded.
 *
 * Implementations must translate every provider failure into the application
 * error taxonomy in `@/domain/buyer-agent/errors` before it escapes. A raw
 * provider exception reaching a caller would carry headers, request metadata,
 * and occasionally an echo of the prompt.
 */
export interface AiProvider {
  /** Provider identity for logs. Never a key, never an endpoint. */
  readonly providerName: string;
  /** The configured model id, for logs and for the completion report. */
  readonly modelId: string;

  generate(request: AiGenerationRequest): Promise<AiGenerationResponse>;

  continueWithToolResults(request: AiToolResponseRequest): Promise<AiGenerationResponse>;
}
