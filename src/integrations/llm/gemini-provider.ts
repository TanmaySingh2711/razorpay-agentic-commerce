import { GoogleGenAI } from "@google/genai";
import { assertServerOnly } from "@/lib/server-only";
import { getGeminiConfig } from "@/config/env";
import {
  AiProviderAuthError,
  AiProviderInvalidResponseError,
  AiProviderRateLimitedError,
  AiProviderTimeoutError,
  AiProviderUnavailableError,
} from "@/domain/buyer-agent/errors";
import type { JsonObject } from "@/lib/json";
import type {
  AiGenerationRequest,
  AiGenerationResponse,
  AiProvider,
  AiToolCall,
  AiToolDeclaration,
  AiToolResponseRequest,
} from "@/integrations/llm/provider";

/**
 * The Gemini adapter.
 *
 * This is the only file in the repository that imports `@google/genai`, and the
 * only one that knows what an "interaction" is. Everything above it speaks the
 * application's own `AiProvider` vocabulary.
 *
 * It uses the **Interactions API** (`client.interactions.create`), the current
 * surface for the Gemini Developer API, with:
 *
 *  - `response_format: { type: "text", mime_type: "application/json", schema }`
 *    for schema-constrained generation. (`response_mime_type` at the top level
 *    is deprecated in the current SDK and is not used.)
 *  - `tools: [{ type: "function", name, description, parameters }]` for tool
 *    declarations, with calls arriving as `function_call` steps and results
 *    going back as `function_result` input.
 *  - `previous_interaction_id` to continue a tool conversation. Gemini 3 models
 *    carry their own reasoning metadata across that handle, which is precisely
 *    why we never unwrap it: the reasoning stays with the provider and this
 *    process only ever holds an opaque id, for the life of one request.
 *
 * Two deliberate settings:
 *
 *  - `store: false`. The conversation is not retained by the provider for later
 *    retrieval. A shopping request is user data and there is no reason for it
 *    to outlive the request that produced it.
 *  - `retries: { strategy: "none" }`. The SDK can retry on its own; letting it
 *    would silently multiply every attempt our own bounded policy makes, and
 *    the combined behaviour would be untestable. Retry lives in one place, in
 *    the agent service, where it is deterministic.
 */
assertServerOnly("src/integrations/llm/gemini-provider.ts");

/** Wall-clock bound on a single provider call. */
export const GEMINI_TIMEOUT_MS = 30_000;

interface GeminiFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

interface GeminiStepLike {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
}

interface GeminiInteractionLike {
  readonly id?: string;
  readonly output_text?: string;
  readonly steps?: readonly GeminiStepLike[];
}

function toGeminiTools(
  tools: readonly AiToolDeclaration[] | undefined,
): readonly GeminiFunctionTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Extracts the tool calls the model asked for.
 *
 * Defensive about shape: a step missing an id or a name is dropped rather than
 * forwarded as a half-formed call. The dispatcher would reject it anyway, but
 * an unnamed call is a provider-contract violation, not a security decision,
 * and it belongs here.
 */
function readToolCalls(interaction: GeminiInteractionLike): readonly AiToolCall[] {
  const steps = interaction.steps ?? [];
  const calls: AiToolCall[] = [];
  for (const step of steps) {
    if (step.type !== "function_call") continue;
    if (typeof step.id !== "string" || typeof step.name !== "string") continue;
    calls.push({
      id: step.id,
      name: step.name,
      arguments: (step.arguments ?? {}) as JsonObject,
    });
  }
  return calls;
}

/**
 * Classifies a provider failure into the application taxonomy.
 *
 * The distinction that matters most is retryable versus not. A 401 retried with
 * backoff is a misconfiguration turned into an outage; a 429 not retried is a
 * transient blip turned into a user-visible failure. Neither the raw error nor
 * its message is ever propagated - both can carry request metadata and, on some
 * providers, an echo of the prompt.
 */
function translateProviderError(error: unknown, correlationId: string): Error {
  const details: JsonObject = { correlationId, provider: "gemini" };

  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();

    if (
      name.includes("abort") ||
      name.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("timeout")
    ) {
      return new AiProviderTimeoutError(details);
    }

    // Status is read from the error object when the SDK attaches one, and only
    // then from the message. Message sniffing alone would misclassify a body
    // that happens to contain a number.
    const status = (error as { status?: unknown }).status;
    const statusCode = typeof status === "number" ? status : undefined;

    if (
      statusCode === 429 ||
      message.includes("rate limit") ||
      message.includes("quota")
    ) {
      return new AiProviderRateLimitedError(details);
    }
    if (statusCode === 401 || statusCode === 403 || message.includes("api key")) {
      return new AiProviderAuthError(details);
    }
    if (statusCode !== undefined && statusCode >= 500) {
      return new AiProviderUnavailableError(details);
    }
    if (statusCode !== undefined && statusCode >= 400) {
      return new AiProviderInvalidResponseError(
        "the provider rejected the request",
        details,
      );
    }
  }

  return new AiProviderUnavailableError(details);
}

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
}

/**
 * Builds the Gemini-backed provider.
 *
 * Credentials are read once here, through the config boundary, and never leave
 * this closure. Nothing returned from this function exposes the key.
 */
export function createGeminiProvider(options: GeminiProviderOptions): AiProvider {
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS;

  const requestOptions = {
    timeout_ms: timeoutMs,
    // Our own bounded policy owns retrying; see the note at the top.
    retries: { strategy: "none" } as const,
  };

  const toResponse = (interaction: GeminiInteractionLike): AiGenerationResponse => ({
    text: typeof interaction.output_text === "string" ? interaction.output_text : null,
    toolCalls: readToolCalls(interaction),
    providerStateRef: typeof interaction.id === "string" ? interaction.id : null,
  });

  return {
    providerName: "gemini",
    modelId: options.modelId,

    async generate(request: AiGenerationRequest): Promise<AiGenerationResponse> {
      try {
        const interaction = await client.interactions.create(
          {
            model: options.modelId,
            input: request.userMessage,
            system_instruction: request.systemInstruction,
            store: false,
            ...(request.responseSchema === undefined
              ? {}
              : {
                  response_format: {
                    type: "text" as const,
                    mime_type: "application/json" as const,
                    schema: request.responseSchema,
                  },
                }),
            ...(toGeminiTools(request.tools) === undefined
              ? {}
              : { tools: [...(toGeminiTools(request.tools) ?? [])] }),
          },
          requestOptions,
        );
        return toResponse(interaction as GeminiInteractionLike);
      } catch (error) {
        throw translateProviderError(error, request.correlationId);
      }
    },

    async continueWithToolResults(
      request: AiToolResponseRequest,
    ): Promise<AiGenerationResponse> {
      try {
        const interaction = await client.interactions.create(
          {
            model: options.modelId,
            ...(request.providerStateRef === null
              ? {}
              : { previous_interaction_id: request.providerStateRef }),
            system_instruction: request.systemInstruction,
            store: false,
            input: request.toolResults.map((result) => ({
              type: "function_result" as const,
              name: result.name,
              call_id: result.callId,
              ...(result.isError === true ? { is_error: true } : {}),
              result: [{ type: "text" as const, text: JSON.stringify(result.content) }],
            })),
            ...(request.responseSchema === undefined
              ? {}
              : {
                  response_format: {
                    type: "text" as const,
                    mime_type: "application/json" as const,
                    schema: request.responseSchema,
                  },
                }),
            ...(toGeminiTools(request.tools) === undefined
              ? {}
              : { tools: [...(toGeminiTools(request.tools) ?? [])] }),
          },
          requestOptions,
        );
        return toResponse(interaction as GeminiInteractionLike);
      } catch (error) {
        throw translateProviderError(error, request.correlationId);
      }
    },
  };
}

/** The process-wide provider, built from validated configuration on first use. */
export function defaultGeminiProvider(): AiProvider {
  const config = getGeminiConfig();
  return createGeminiProvider({
    apiKey: config.GEMINI_API_KEY,
    modelId: config.GEMINI_MODEL,
  });
}
