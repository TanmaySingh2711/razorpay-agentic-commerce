import { GoogleGenAI } from "@google/genai";
import { assertServerOnly } from "@/lib/server-only";
import { getGeminiConfig } from "@/config/env";
import type { GeminiThinkingLevel } from "@/config/env";
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
  AiProviderStateRef,
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
 *  - a **replayed transcript** to continue a tool conversation. See below.
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
 *  - `generation_config: { thinking_level }`. Every call declares how much
 *    hidden reasoning the model may spend before answering. The Buyer Agent's
 *    own tasks are schema- or tool-constrained and every financial decision is
 *    made deterministically outside the model, so the production default is
 *    `minimal` - see `GEMINI_THINKING_LEVEL` in `@/config/env`.
 *
 * ## How a tool conversation is continued
 *
 * `store: false` and `previous_interaction_id` are mutually exclusive, and the
 * API says so by omission rather than by complaint: an unstored interaction
 * comes back with **no `id` field at all**, because there is nothing on the
 * provider's side to point at. This adapter used to read `interaction.id`
 * anyway, get `undefined`, quietly send the next turn with no
 * `previous_interaction_id`, and so present a bare `function_result` as the
 * opening move of a brand-new conversation. The API rejected that with a 400 -
 * "please ensure that function response turn comes immediately after a function
 * call turn" - which the error translator, correctly for a 4xx, reported as
 * `AI_PROVIDER_INVALID_RESPONSE`. Every tool-using run failed; only the
 * single-turn intent extraction worked, which is why the deployed agent could
 * read a request and never answer one.
 *
 * So continuation replays the conversation instead of referencing it: the next
 * call's `input` is everything already exchanged - the shopper's message, the
 * model's own steps from each turn, and our function results - followed by the
 * new results. The model's `thought` steps are replayed **verbatim, including
 * their signatures**, which Gemini 3 requires: dropping them is a 400, and
 * rewriting them would be forging the model's own reasoning record.
 *
 * That transcript is what `providerStateRef` carries. It stays inside this
 * closure's return value for the life of one request, is typed as opaque so
 * nothing above can read it, and is never logged or persisted - the same
 * guarantee the id was supposed to give, kept by construction rather than by
 * the value happening to be short.
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
  readonly output_text?: string;
  readonly steps?: readonly GeminiStepLike[];
}

/**
 * The conversation so far, in the provider's own input vocabulary.
 *
 * Deliberately not typed field by field. These items are the provider's own
 * step objects going straight back where they came from; describing their
 * insides here would invite code that reads them, and a `thought` signature is
 * exactly the thing nothing outside this file may touch.
 */
interface GeminiTranscript {
  readonly kind: "gemini-transcript";
  readonly items: readonly unknown[];
}

function isTranscript(
  value: AiProviderStateRef,
): value is AiProviderStateRef & GeminiTranscript {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "gemini-transcript"
  );
}

/** The items already exchanged, plus whatever the model just produced. */
function extendTranscript(
  priorItems: readonly unknown[],
  interaction: GeminiInteractionLike,
): AiProviderStateRef {
  const transcript: GeminiTranscript = {
    kind: "gemini-transcript",
    items: [...priorItems, ...(interaction.steps ?? [])],
  };
  // The one cast that produces the opaque handle. Nothing above unwraps it.
  return transcript as unknown as AiProviderStateRef;
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

/** The production default: no benefit from extended hidden reasoning here, only latency it would spend. */
export const DEFAULT_THINKING_LEVEL: GeminiThinkingLevel = "minimal";

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
  readonly thinkingLevel?: GeminiThinkingLevel;
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
  const thinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

  /**
   * Per-call request options, so an `abortSignal` the caller supplies genuinely
   * cancels this specific call's underlying HTTP request rather than a fixed
   * option baked in once for every call this provider instance ever makes.
   *
   * `timeout_ms` stays as the SDK's own floor even when a signal is present:
   * the SDK's documented behaviour is that an explicit `signal` takes
   * precedence, so ours firing earlier (a caller with less than
   * `GEMINI_TIMEOUT_MS` of its own budget left) still wins, while `timeout_ms`
   * remains a backstop if no signal is supplied at all.
   */
  function requestOptionsFor(abortSignal: AbortSignal | undefined) {
    return {
      timeout_ms: timeoutMs,
      // Our own bounded policy owns retrying; see the note at the top.
      retries: { strategy: "none" } as const,
      ...(abortSignal === undefined ? {} : { signal: abortSignal }),
    };
  }

  const toResponse = (
    interaction: GeminiInteractionLike,
    priorItems: readonly unknown[],
  ): AiGenerationResponse => ({
    text: typeof interaction.output_text === "string" ? interaction.output_text : null,
    toolCalls: readToolCalls(interaction),
    providerStateRef: extendTranscript(priorItems, interaction),
  });

  return {
    providerName: "gemini",
    modelId: options.modelId,

    async generate(request: AiGenerationRequest): Promise<AiGenerationResponse> {
      // The same message in the item form a continuation has to replay it as.
      // Turn one still sends the plain string the API accepts for a first
      // message; the item form is what the transcript carries afterwards.
      const inputItems = [{ type: "text" as const, text: request.userMessage }];
      try {
        const interaction = await client.interactions.create(
          {
            model: options.modelId,
            input: request.userMessage,
            system_instruction: request.systemInstruction,
            store: false,
            generation_config: { thinking_level: thinkingLevel },
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
          requestOptionsFor(request.abortSignal),
        );
        return toResponse(interaction as GeminiInteractionLike, inputItems);
      } catch (error) {
        throw translateProviderError(error, request.correlationId);
      }
    },

    async continueWithToolResults(
      request: AiToolResponseRequest,
    ): Promise<AiGenerationResponse> {
      // Everything already exchanged, then our answers to the calls the model
      // just made. A function result that does not follow its own function call
      // in the same input is a 400, so the prior turns are not optional -
      // which is why their absence is refused here rather than sent. A request
      // we know the API will reject is quota spent to produce a worse error
      // message, and losing the transcript is a defect in this process, not
      // something the provider did.
      if (!isTranscript(request.providerStateRef)) {
        throw new AiProviderInvalidResponseError(
          "a tool continuation was attempted without the preceding turn",
          { correlationId: request.correlationId, provider: "gemini" },
        );
      }
      const priorItems = request.providerStateRef.items;
      const inputItems = [
        ...priorItems,
        ...request.toolResults.map((result) => ({
          type: "function_result" as const,
          name: result.name,
          call_id: result.callId,
          ...(result.isError === true ? { is_error: true } : {}),
          result: [{ type: "text" as const, text: JSON.stringify(result.content) }],
        })),
      ];
      try {
        const interaction = await client.interactions.create(
          {
            model: options.modelId,
            system_instruction: request.systemInstruction,
            store: false,
            generation_config: { thinking_level: thinkingLevel },
            // The SDK types `input` as its own step union. Every item here is
            // either a text item or one of those very steps handed straight
            // back, so the cast asserts a round trip rather than inventing a
            // shape - and typing the transcript as the union would put the
            // provider's step types back into a file that must not read them.
            input: inputItems as never,
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
          requestOptionsFor(request.abortSignal),
        );
        return toResponse(interaction as GeminiInteractionLike, inputItems);
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
    thinkingLevel: config.GEMINI_THINKING_LEVEL,
  });
}
