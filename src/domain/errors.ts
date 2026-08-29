import type { JsonObject } from "@/lib/json";

/**
 * Project-wide error taxonomy.
 *
 * Two rules drive the design:
 *
 *  1. Every failure is classified, so callers (and later the API layer) can
 *     react by category instead of string-matching messages.
 *  2. Every error carries two faces: an internal one for operators, and a
 *     deliberately dull public one for the browser. Internal messages, causes
 *     and provider payloads never cross the network boundary.
 */
export const ERROR_CATEGORIES = [
  /** Input failed schema/shape validation (client input, LLM output, webhook body). */
  "validation",
  /** A domain invariant or business rule was violated (e.g. illegal state transition). */
  "domain_rule",
  /** A deterministic authorization decision denied the action. */
  "authorization",
  /** An external provider (Razorpay, LLM) failed, timed out, or misbehaved. */
  "provider",
  /** A payment was attempted and did not succeed. */
  "payment",
  /** Required configuration is missing or malformed. */
  "configuration",
  /** Datastore, network, or runtime failure not attributable to a provider. */
  "infrastructure",
  /** A bug: an unexpected, unclassified condition. */
  "internal",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const DEFAULT_PUBLIC_MESSAGE: Record<ErrorCategory, string> = {
  validation: "The request was not valid.",
  domain_rule: "That action is not allowed in the current state.",
  authorization: "This action was not authorized.",
  provider: "An upstream service is currently unavailable.",
  payment: "The payment could not be completed.",
  configuration: "The service is not correctly configured.",
  infrastructure: "The service is temporarily unavailable.",
  internal: "Something went wrong.",
};

const DEFAULT_HTTP_STATUS: Record<ErrorCategory, number> = {
  validation: 400,
  domain_rule: 409,
  authorization: 403,
  provider: 502,
  payment: 402,
  configuration: 500,
  infrastructure: 503,
  internal: 500,
};

export interface AppErrorOptions {
  /** Stable machine-readable code, e.g. `TRANSACTION_INVALID_TRANSITION`. */
  readonly code: string;
  /** Operator-facing message. May contain internal detail. Never sent to a browser. */
  readonly message: string;
  /** Overrides the category default. Must be safe to show to an end user. */
  readonly publicMessage?: string;
  /** Redaction-safe structured context for logs and audit. No secrets, no payloads. */
  readonly details?: JsonObject;
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/** Shape returned across the HTTP boundary. Contains nothing sensitive. */
export interface PublicErrorPayload extends JsonObject {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
}

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly publicMessage: string;
  readonly details: JsonObject;
  readonly retryable: boolean;
  readonly httpStatus: number;

  constructor(category: ErrorCategory, options: AppErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.category = category;
    this.code = options.code;
    this.publicMessage = options.publicMessage ?? DEFAULT_PUBLIC_MESSAGE[category];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
    this.httpStatus = DEFAULT_HTTP_STATUS[category];
  }

  /** Safe to serialise to the browser. */
  toPublicPayload(): PublicErrorPayload {
    return { code: this.code, category: this.category, message: this.publicMessage };
  }

  /** Safe to hand to the operational logger (still passes through redaction). */
  toLogPayload(): JsonObject {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  constructor(options: AppErrorOptions) {
    super("validation", options);
  }
}

export class DomainRuleError extends AppError {
  constructor(options: AppErrorOptions) {
    super("domain_rule", options);
  }
}

export class AuthorizationError extends AppError {
  constructor(options: AppErrorOptions) {
    super("authorization", options);
  }
}

export class ProviderError extends AppError {
  constructor(options: AppErrorOptions) {
    super("provider", { retryable: true, ...options });
  }
}

export class PaymentError extends AppError {
  constructor(options: AppErrorOptions) {
    super("payment", options);
  }
}

export class ConfigurationError extends AppError {
  constructor(options: AppErrorOptions) {
    super("configuration", options);
  }
}

export class InfrastructureError extends AppError {
  constructor(options: AppErrorOptions) {
    super("infrastructure", { retryable: true, ...options });
  }
}

export class InternalError extends AppError {
  constructor(options: AppErrorOptions) {
    super("internal", options);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Funnels anything thrown into the taxonomy. Unrecognised throwables become
 * `internal` errors whose original message is kept for operators only.
 */
export function toAppError(thrown: unknown): AppError {
  if (isAppError(thrown)) return thrown;

  const message =
    thrown instanceof Error ? thrown.message : "Non-Error value was thrown.";
  return new InternalError({
    code: "UNEXPECTED_ERROR",
    message,
    cause: thrown,
  });
}
