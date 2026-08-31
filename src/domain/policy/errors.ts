import { DomainRuleError, InfrastructureError, ValidationError } from "@/domain/errors";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { QuoteUnusableCause } from "@/domain/quote/contracts";

/**
 * Failures of the policy boundary.
 *
 * Note what is *not* here: there is no error for "denied". A denial is a
 * perfectly ordinary, successful evaluation that happens to say BLOCKED or
 * APPROVAL_REQUIRED, and it comes back as a value with a reason code. Turning
 * refusals into exceptions would put the most important outcomes of a financial
 * control on the path callers are most likely to swallow.
 */

/**
 * The quote stopped being usable between validation and the write transaction.
 *
 * A narrow race, and the reason it has a type: an expired or re-priced quote is
 * not a policy denial and must never be recorded as one. Thrown from inside the
 * transaction so the audit event and the state transitions roll back with it,
 * leaving the transaction exactly where it was - in the quoting phase, awaiting
 * a fresh quote.
 */
export class QuoteChangedDuringEvaluationError extends DomainRuleError {
  readonly quoteId: string;
  /**
   * Which flavour of unusable this is.
   *
   * Carried on the error rather than inferred from an empty reason list at the
   * catch site: "the row is gone" and "the price moved" are different facts,
   * and a caller told the wrong one abandons a purchase that only needed a
   * fresh quote. Named `causeCode` because `cause` belongs to Error itself.
   */
  readonly causeCode: QuoteUnusableCause;
  readonly reasons: readonly QuoteInvalidationReason[];

  constructor(
    quoteId: string,
    causeCode: QuoteUnusableCause,
    reasons: readonly QuoteInvalidationReason[] = [],
  ) {
    super({
      code: "QUOTE_CHANGED_DURING_POLICY_EVALUATION",
      message: `Quote ${quoteId} stopped being usable during policy evaluation (${causeCode})${reasons.length > 0 ? `: ${reasons.join(", ")}` : ""}`,
      publicMessage: "This order changed while we were checking it. Please try again.",
      details: { quoteId, causeCode, reasons: [...reasons] },
      retryable: true,
    });
    this.quoteId = quoteId;
    this.causeCode = causeCode;
    this.reasons = reasons;
  }
}

/**
 * The caller's operation identity is unusable.
 *
 * Idempotency is only as good as the key, so a missing or oversized one is
 * refused up front rather than silently truncated into a key that collides with
 * somebody else's evaluation.
 */
export class InvalidPolicyOperationIdError extends ValidationError {
  constructor(reason: string) {
    super({
      code: "POLICY_OPERATION_ID_INVALID",
      message: `The policy evaluation operation id is not usable: ${reason}`,
      publicMessage: "The request could not be processed.",
      details: { reason },
    });
  }
}

/** The decision could not be committed. Infrastructure, never a verdict. */
export class PolicyEvaluationFailureError extends InfrastructureError {
  constructor(reason: string, cause?: unknown) {
    super({
      code: "POLICY_EVALUATION_FAILED",
      message: `The policy evaluation could not be committed: ${reason}`,
      publicMessage: "We could not check this order. Please try again.",
      details: { reason },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
