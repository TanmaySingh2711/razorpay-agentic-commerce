import { ProviderError, ValidationError } from "@/domain/errors";
import type { JsonObject } from "@/lib/json";

/**
 * Buyer Agent and AI provider failures.
 *
 * Every one of these is application-owned. A Gemini exception, an HTTP status,
 * a provider error body and an SDK error class all stop at the adapter boundary
 * and are re-expressed here. Nothing downstream — a route handler, a log line,
 * a response — ever sees a raw provider object, because those objects carry
 * request headers, model metadata and sometimes echoes of the prompt.
 *
 * `retryable` is set deliberately per class rather than guessed at the call
 * site: it is what stops a bad API key becoming a retry storm against a free
 * tier.
 */

export class AiProviderTimeoutError extends ProviderError {
  constructor(details: JsonObject = {}) {
    super({
      code: "AI_PROVIDER_TIMEOUT",
      message: "The AI provider did not respond within the configured timeout.",
      publicMessage: "The assistant took too long to respond. Please try again.",
      details,
      retryable: true,
    });
  }
}

export class AiProviderRateLimitedError extends ProviderError {
  constructor(details: JsonObject = {}) {
    super({
      code: "AI_PROVIDER_RATE_LIMITED",
      message: "The AI provider rate-limited the request.",
      publicMessage: "The assistant is busy right now. Please try again shortly.",
      details,
      retryable: true,
    });
  }
}

export class AiProviderUnavailableError extends ProviderError {
  constructor(details: JsonObject = {}) {
    super({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "The AI provider is unavailable.",
      publicMessage: "The assistant is temporarily unavailable.",
      details,
      retryable: true,
    });
  }
}

/**
 * Credentials are wrong or missing.
 *
 * Explicitly **not** retryable. Retrying an authentication failure cannot
 * succeed, and doing it with backoff against a free tier turns a
 * misconfiguration into an outage.
 */
export class AiProviderAuthError extends ProviderError {
  constructor(details: JsonObject = {}) {
    super({
      code: "AI_PROVIDER_AUTH_FAILURE",
      message: "The AI provider rejected the credentials.",
      publicMessage: "The assistant is not correctly configured.",
      details,
      retryable: false,
    });
  }
}

/**
 * The model returned something our schema refuses.
 *
 * Not retryable by the transport layer: the request succeeded, the *content*
 * was wrong. The agent may make one bounded correction attempt, which is a
 * different mechanism with its own limit.
 */
export class AiProviderInvalidResponseError extends ProviderError {
  constructor(reason: string, details: JsonObject = {}) {
    super({
      code: "AI_PROVIDER_INVALID_RESPONSE",
      message: `The AI provider returned an unusable response: ${reason}`,
      publicMessage: "The assistant returned an unusable response.",
      details,
      retryable: false,
    });
  }
}

/**
 * The request's own execution budget ran out before another provider attempt
 * could be started.
 *
 * Distinct from `AiProviderTimeoutError`: that one means a single call to the
 * provider took too long. This one means the *request as a whole* - every
 * attempt and every tool-loop turn combined - has already spent enough
 * wall-clock time that starting another call could not realistically finish
 * before the hosting platform would kill the function outright. Refusing here
 * and returning this instead is strictly better than letting that happen: the
 * caller gets an error it can show a person and classify in a log, instead of
 * a connection the platform simply dropped.
 *
 * Not retryable. The request has already run out of the time it was given;
 * trying again immediately would not change that.
 */
export class AiProviderRequestBudgetExceededError extends ProviderError {
  constructor(details: JsonObject = {}) {
    super({
      code: "AI_PROVIDER_REQUEST_BUDGET_EXCEEDED",
      message:
        "The request's execution budget was exhausted before the provider could be tried again.",
      publicMessage: "The assistant took too long to respond. Please try again.",
      details,
      retryable: false,
    });
  }
}

/** The model kept calling tools and never produced an answer. */
export class AiProviderToolLoopLimitError extends ProviderError {
  constructor(limit: number, details: JsonObject = {}) {
    super({
      code: "AI_PROVIDER_TOOL_LOOP_LIMIT",
      message: `The agent exceeded its bounded limit of ${String(limit)} tool iterations.`,
      publicMessage: "The assistant could not reach a conclusion.",
      details: { limit, ...details },
      retryable: false,
    });
  }
}

/**
 * The model asked for a tool that is not in the registry.
 *
 * Its own class because it is a security event, not a transport fault: either
 * the model hallucinated a capability or something in its context talked it
 * into trying. Either way the call was refused before anything ran.
 */
export class UnknownToolError extends ValidationError {
  constructor(requestedTool: string) {
    super({
      code: "AI_TOOL_NOT_REGISTERED",
      // The name is truncated: it is attacker-influenced text heading for a log.
      message: `The model requested a tool that does not exist: ${requestedTool.slice(0, 64)}`,
      publicMessage: "The assistant attempted an unsupported action.",
      details: { requestedTool: requestedTool.slice(0, 64) },
    });
  }
}

/** A registered tool was called with arguments that failed local validation. */
export class InvalidToolArgumentsError extends ValidationError {
  constructor(toolName: string, reason: string) {
    super({
      code: "AI_TOOL_INVALID_ARGUMENTS",
      message: `Tool ${toolName} was called with invalid arguments: ${reason}`,
      publicMessage: "The assistant attempted an invalid action.",
      details: { toolName, reason },
    });
  }
}

/**
 * The model proposed something the deterministic checks refuse.
 *
 * The important cases: a product id that was never returned by a catalog tool,
 * and a product that breaks the user's explicit budget. Both mean the proposal
 * is discarded — never repaired. Silently correcting a financial value would
 * hide exactly the failure this error exists to surface.
 *
 * Callers should pass `reasonCode` (a `SelectionRejectionReason`, from
 * `src/domain/buyer-agent/validation.ts`) in `details`. The code alone,
 * `AI_INVALID_SELECTION`, does not distinguish a hallucinated id from an
 * over-budget pick from an unmet requirement — indistinguishable in the
 * operational log without it, and a live rerun was once the only way to tell
 * them apart.
 */
export class InvalidModelSelectionError extends ValidationError {
  constructor(reason: string, details: JsonObject = {}) {
    super({
      code: "AI_INVALID_SELECTION",
      message: `The model's product selection failed deterministic validation: ${reason}`,
      publicMessage: "The assistant proposed something that could not be verified.",
      details,
    });
  }
}

/** The human's message was missing, empty, or beyond the configured bound. */
export class InvalidBuyerRequestError extends ValidationError {
  constructor(reason: string) {
    super({
      code: "BUYER_REQUEST_INVALID",
      message: `Buyer request rejected: ${reason}`,
      publicMessage: `That request could not be processed: ${reason}`,
    });
  }
}
