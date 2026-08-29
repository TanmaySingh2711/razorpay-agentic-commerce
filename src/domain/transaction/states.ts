/**
 * The authoritative transaction lifecycle.
 *
 * State lives on the server and only the Transaction Service writes it. No AI
 * component, and no browser payload, may set a state directly; they can only
 * *request* a transition, which this module adjudicates.
 */
export const TRANSACTION_STATES = [
  /** A structured purchase intent has been accepted from the user. */
  "INTENT_RECEIVED",
  /** The agent proposed a specific product. Proposal only - nothing is trusted yet. */
  "PRODUCT_SELECTED",
  /** The merchant service re-read price, currency and stock from the source of truth. */
  "PRODUCT_VERIFIED",
  /** The deterministic policy engine has evaluated the verified amount. */
  "POLICY_CHECKED",
  /** Policy requires a human to approve before money can move. */
  "APPROVAL_REQUIRED",
  /** A final, deterministic authorization exists for a specific amount. */
  "AUTHORIZED",
  /** A Razorpay order has been created server-side for the authorized amount. */
  "PAYMENT_CREATED",
  /** Checkout has been handed to the user; awaiting a verified payment outcome. */
  "PAYMENT_PENDING",
  /** A verified payment capture has been observed (signature or webhook). */
  "PAYMENT_CAPTURED",
  /** The transaction is finished successfully and fully audited. */
  "COMPLETED",
  /** A payment attempt failed. Recoverable: a fresh attempt may be started. */
  "PAYMENT_FAILED",
  /** A deterministic control refused the transaction. Terminal by design. */
  "BLOCKED",
  /** Abandoned by the user or by the system before completion. */
  "CANCELLED",
] as const;

export type TransactionState = (typeof TRANSACTION_STATES)[number];

/**
 * States from which no further transition is permitted.
 *
 * `PAYMENT_FAILED` is deliberately *not* terminal: a failed attempt is an
 * expected, recoverable outcome that the demo must handle gracefully, and the
 * retry must reuse the same authorization rather than starting a new intent.
 */
export const TERMINAL_TRANSACTION_STATES = ["COMPLETED", "BLOCKED", "CANCELLED"] as const;

/** States that represent an unsuccessful outcome, terminal or not. */
export const FAILURE_TRANSACTION_STATES = ["PAYMENT_FAILED", "BLOCKED"] as const;

/**
 * Components permitted to request a transition. The distinction between AI and
 * deterministic actors is enforced by the transition table, not by convention.
 */
export const TRANSACTION_ACTORS = [
  "human_user",
  "buyer_agent",
  "product_decision_engine",
  "merchant_service",
  "policy_engine",
  "approval_gate",
  "transaction_service",
  "razorpay_integration",
  "razorpay_webhook",
  "system",
] as const;

export type TransactionActor = (typeof TRANSACTION_ACTORS)[number];

/**
 * The only actors backed by an LLM. They may propose a product and nothing
 * else; every other transition rejects them.
 */
export const AI_ACTORS: readonly TransactionActor[] = [
  "buyer_agent",
  "product_decision_engine",
];

export function isAiActor(actor: TransactionActor): boolean {
  return AI_ACTORS.includes(actor);
}

export function isTerminalState(state: TransactionState): boolean {
  return (TERMINAL_TRANSACTION_STATES as readonly TransactionState[]).includes(state);
}

export function isFailureState(state: TransactionState): boolean {
  return (FAILURE_TRANSACTION_STATES as readonly TransactionState[]).includes(state);
}
