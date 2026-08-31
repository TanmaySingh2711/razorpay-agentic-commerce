import { DomainRuleError, InfrastructureError } from "@/domain/errors";
import type { ApprovalDecisionRefusal } from "@/domain/approval/contracts";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";

/**
 * Failures of the approval gate.
 *
 * As with policy, a refusal is a value rather than an exception on the way out
 * of the boundary - callers must be able to branch on "the price moved" without
 * a try/catch. The one error here exists for a different reason: it is how a
 * refusal discovered *inside* the write transaction aborts it.
 */

/**
 * A refusal raised from inside the approval transaction, to roll it back.
 *
 * The token is consumed by a conditional UPDATE at the very top of that
 * transaction, before the quote and policy are re-checked. If a later check
 * fails, throwing is what returns the approval to PENDING along with everything
 * else - so a person's one-time token is not burned because the world moved
 * while they were reading. The service catches this and converts it back into
 * an ordinary `REFUSED` result.
 */
export class ApprovalRefusedError extends DomainRuleError {
  readonly refusal: ApprovalDecisionRefusal;
  readonly approvalId: string | null;
  readonly transactionId: string | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly reasons: readonly QuoteInvalidationReason[];

  constructor(options: {
    readonly refusal: ApprovalDecisionRefusal;
    readonly approvalId?: string | null;
    readonly transactionId?: string | null;
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
    readonly reasons?: readonly QuoteInvalidationReason[];
  }) {
    super({
      code: `APPROVAL_${options.refusal}`,
      message: `The approval could not be applied: ${options.refusal}`,
      publicMessage: "This approval could not be applied. Please try again.",
      details: { refusal: options.refusal },
      retryable: true,
    });
    this.refusal = options.refusal;
    this.approvalId = options.approvalId ?? null;
    this.transactionId = options.transactionId ?? null;
    this.detail = options.detail ?? {};
    this.reasons = options.reasons ?? [];
  }
}

/** The approval decision could not be committed. Infrastructure, never a verdict. */
export class ApprovalPersistenceError extends InfrastructureError {
  constructor(reason: string, cause?: unknown) {
    super({
      code: "APPROVAL_PERSISTENCE_FAILED",
      message: `The approval decision could not be committed: ${reason}`,
      publicMessage: "We could not record that decision. Please try again.",
      details: { reason },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
