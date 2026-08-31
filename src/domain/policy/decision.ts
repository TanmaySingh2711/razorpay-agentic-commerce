import type { AuditEventType } from "@/domain/audit-event";
import type { MoneyDto } from "@/domain/money";

/**
 * The vocabulary of a deterministic authorization decision.
 *
 * Nothing in this file talks to a database, a clock, a model or a network. It
 * exists so that the answer to "may this quote be paid automatically?" is a
 * small closed set of values that can be persisted, compared, replayed and
 * asserted against - rather than prose that has to be interpreted.
 *
 * Three outcomes, and no fourth:
 *
 *  - ALLOWED            the server itself authorizes the spend
 *  - APPROVAL_REQUIRED  a human must decide before money can move
 *  - BLOCKED            a deterministic rule refuses the purchase outright
 *
 * There is deliberately no "probably fine", no confidence score and no
 * escalation to a model. A financial control that returns a maybe is a control
 * someone downstream has to guess about.
 */
/**
 * The audit event type every policy evaluation is recorded under.
 *
 * Declared once, and typed against the closed vocabulary in
 * `@/domain/audit-event`, so a typo is a compile error rather than a silent
 * divergence. Both the writer and the pre-payment recheck that reads the record
 * back import this - a literal repeated in two files is a coupling that fails
 * quietly the day one of them is edited.
 */
export const POLICY_AUDIT_EVENT_TYPE: AuditEventType = "policy_evaluated";

export const POLICY_DECISIONS = ["ALLOWED", "APPROVAL_REQUIRED", "BLOCKED"] as const;

export type PolicyDecisionKind = (typeof POLICY_DECISIONS)[number];

/**
 * Why the engine decided what it decided.
 *
 * A closed vocabulary, exactly like the transition reason codes. The persisted
 * record stores the *code*; the sentence a human reads is derived from it. That
 * ordering matters - a stored sentence is unqueryable, drifts when reworded,
 * and invites someone to write the model's narration into it.
 */
export const POLICY_REASON_CODES = [
  /** Total is at or below the buyer's automatic spending ceiling. */
  "WITHIN_AUTO_APPROVE_LIMIT",
  /** A valid quote, but above the ceiling: a human decides, not the server. */
  "EXCEEDS_AUTO_APPROVE_LIMIT",
  /** The policy permits no unattended purchase at all, at any amount. */
  "AUTO_PURCHASE_DISABLED",
  /** This buyer has no policy. Absence is never permission. */
  "NO_POLICY_FOUND",
  /** A superseded or otherwise non-active policy grants nothing. */
  "POLICY_NOT_ACTIVE",
  /** The quote and the policy are denominated differently. No conversion, ever. */
  "POLICY_CURRENCY_MISMATCH",
  /** The quote names a currency this system does not support. */
  "UNSUPPORTED_CURRENCY",
  /** The amount is not a positive integer, or contradicts its own line maths. */
  "INVALID_QUOTE_AMOUNT",
  /** The stored ceiling is not a usable non-negative amount. */
  "INVALID_POLICY_LIMIT",
] as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/**
 * The one-line explanation attached to each code.
 *
 * Short, factual, safe to show a user, and identical for every evaluation that
 * reaches the same code. Not reasoning, not a rationalisation, and never
 * anything a model said.
 */
const POLICY_EXPLANATIONS: Record<PolicyReasonCode, string> = {
  WITHIN_AUTO_APPROVE_LIMIT:
    "The quoted total is within the automatic spending limit on this buyer's active policy.",
  EXCEEDS_AUTO_APPROVE_LIMIT:
    "The quoted total is above the automatic spending limit, so a person has to approve it.",
  AUTO_PURCHASE_DISABLED:
    "This buyer's policy does not permit unattended purchases, so a person has to approve it.",
  NO_POLICY_FOUND: "No authorization policy exists for this buyer.",
  POLICY_NOT_ACTIVE: "This buyer's authorization policy is not active.",
  POLICY_CURRENCY_MISMATCH:
    "The quote is in a different currency from the authorization policy.",
  UNSUPPORTED_CURRENCY: "The quote is in a currency this service does not support.",
  INVALID_QUOTE_AMOUNT: "The quoted amount is not a valid payable amount.",
  INVALID_POLICY_LIMIT:
    "The spending limit on this buyer's policy is not a usable amount.",
};

export function explainPolicyReason(code: PolicyReasonCode): string {
  return POLICY_EXPLANATIONS[code];
}

/**
 * The persisted policy, as the engine sees it.
 *
 * Every field here is read from PostgreSQL by the service immediately before
 * evaluation. There is no field for anything a caller might wish were true:
 * no requested limit, no proposed decision, no override.
 */
export interface PolicySnapshot {
  readonly policyId: string;
  readonly buyerProfileId: string;
  /** The persisted revision. Recorded with every decision so it can be replayed. */
  readonly version: number;
  readonly status: string;
  readonly autoPurchaseAllowed: boolean;
  /** Integer minor units. The ceiling for spend with no human in the loop. */
  readonly maxAutoApproveAmountMinor: bigint;
  readonly currency: string;
}

/**
 * The quote, as the engine sees it.
 *
 * Populated from the PurchaseQuote row only - never from a request body, never
 * from a model's observation, never from a cached DTO that crossed the network.
 */
export interface EvaluableQuote {
  readonly quoteId: string;
  readonly transactionId: string;
  readonly quantity: number;
  readonly unitAmountMinor: bigint;
  readonly totalAmountMinor: bigint;
  readonly currency: string;
}

/**
 * The decision, with everything needed to prove it later.
 *
 * `policyVersion` is on the result rather than looked up afterwards on purpose:
 * the claim the audit trail has to support is "quote Q was evaluated under
 * policy version P and got decision D", and a version fetched at read time
 * would be whatever the policy happens to be now.
 */
export interface PolicyDecision {
  readonly decision: PolicyDecisionKind;
  readonly reasonCode: PolicyReasonCode;
  readonly explanation: string;
  readonly policyId: string | null;
  readonly policyVersion: number | null;
  readonly evaluatedAmountMinor: bigint;
  readonly currency: string;
  /** The ceiling the amount was compared against, when there was a usable one. */
  readonly autoApproveLimitMinor: bigint | null;
}

/** The wire shape. `bigint` never crosses an API boundary raw. */
export interface PolicyDecisionDto {
  readonly decision: PolicyDecisionKind;
  readonly reasonCode: PolicyReasonCode;
  readonly explanation: string;
  readonly policyId: string | null;
  readonly policyVersion: number | null;
  readonly evaluatedAmount: MoneyDto;
  readonly autoApproveLimit: MoneyDto | null;
}

export function toPolicyDecisionDto(decision: PolicyDecision): PolicyDecisionDto {
  const currency = decision.currency as MoneyDto["currency"];
  return {
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    explanation: decision.explanation,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    evaluatedAmount: {
      amountMinor: decision.evaluatedAmountMinor.toString(),
      currency,
    },
    autoApproveLimit:
      decision.autoApproveLimitMinor === null
        ? null
        : { amountMinor: decision.autoApproveLimitMinor.toString(), currency },
  };
}
