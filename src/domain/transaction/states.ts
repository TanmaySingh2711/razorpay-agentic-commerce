/**
 * The authoritative transaction lifecycle.
 *
 * State lives on the server and only the Transaction Service writes it. No AI
 * component, and no browser payload, may set a state directly; they can only
 * *request* a transition, which this module adjudicates.
 *
 * This file is the single source of truth for state names. Nothing else in the
 * repository may declare a competing enum, string union, or database enum.
 */
export const TRANSACTION_STATES = [
  /** A structured purchase intent has been accepted from the user. */
  "INTENT_RECEIVED",
  /** The agent proposed a specific product. Proposal only - nothing is trusted yet. */
  "PRODUCT_SELECTED",
  /** The merchant service re-read price, currency and stock from the source of truth. */
  "PRODUCT_VERIFIED",
  /** A PurchaseQuote froze the verified facts (amount, currency, quantity) with an expiry. */
  "QUOTE_CREATED",
  /** The deterministic policy engine has evaluated the quoted amount. */
  "POLICY_EVALUATED",
  /** Policy requires a human to approve before money can move. */
  "APPROVAL_REQUIRED",
  /** A final, deterministic authorization exists for one specific quoted amount. */
  "AUTHORIZED",
  /** Stock is held for this transaction, closing the check-then-charge race. */
  "INVENTORY_RESERVED",
  /** A payment order has been created at the provider for the authorized amount. */
  "PAYMENT_ORDER_CREATED",
  /** Checkout has been handed to the user; awaiting a verified payment outcome. */
  "PAYMENT_PENDING",
  /** A payment signature has been verified server-side. Not yet settled. */
  "PAYMENT_VERIFIED",
  /** A verified capture has been observed from the provider (webhook or API). */
  "PAYMENT_CAPTURED",
  /** The transaction is finished successfully, inventory committed, fully audited. */
  "COMPLETED",
  /** A payment attempt failed. Recoverable: a fresh attempt may reuse the authorization. */
  "PAYMENT_FAILED",
  /** A deterministic control refused the transaction. Terminal by design. */
  "BLOCKED",
  /** Abandoned by the user or by the system before completion. */
  "CANCELLED",
  /** A quote, approval, reservation or payment window elapsed before completion. */
  "EXPIRED",
] as const;

export type TransactionState = (typeof TRANSACTION_STATES)[number];

/**
 * The one state a transaction may be born in.
 *
 * Creation is not a transition - there is no prior state to transition from -
 * so the transition matrix cannot police it. This constant is what the
 * transaction creation boundary uses instead, so "a new transaction always
 * starts at the beginning of the lifecycle" is a value the compiler checks
 * rather than a default someone can override at a call site.
 */
export const INITIAL_TRANSACTION_STATE =
  "INTENT_RECEIVED" as const satisfies TransactionState;

export type InitialTransactionState = typeof INITIAL_TRANSACTION_STATE;

/**
 * States from which no further transition is permitted.
 *
 * `PAYMENT_FAILED` is deliberately *not* terminal: a failed attempt is an
 * expected, recoverable outcome that the demo must handle gracefully, and the
 * retry must reuse the same authorization rather than starting a new intent.
 */
export const TERMINAL_TRANSACTION_STATES = [
  "COMPLETED",
  "BLOCKED",
  "CANCELLED",
  "EXPIRED",
] as const;

/** States that represent an unsuccessful outcome, terminal or not. */
export const FAILURE_TRANSACTION_STATES = [
  "PAYMENT_FAILED",
  "BLOCKED",
  "EXPIRED",
] as const;

/**
 * States in which stock is held and must eventually be committed or released.
 * Any exit from one of these toward a terminal failure state releases the hold.
 */
export const INVENTORY_HELD_STATES = [
  "INVENTORY_RESERVED",
  "PAYMENT_ORDER_CREATED",
  "PAYMENT_PENDING",
  "PAYMENT_VERIFIED",
  "PAYMENT_CAPTURED",
  "PAYMENT_FAILED",
] as const;

/**
 * Components permitted to request a transition.
 *
 * Actor names are deliberately provider-neutral: `payment_provider`, not
 * `razorpay`. The domain core must not name a vendor, because swapping the
 * payment provider must not require rewriting the state machine. Razorpay
 * lives behind the adapter and appears nowhere in this file.
 */
export const TRANSACTION_ACTORS = [
  "human_user",
  "buyer_agent",
  "product_decision_engine",
  "merchant_service",
  "quote_service",
  "policy_engine",
  "approval_gate",
  "inventory_service",
  "transaction_service",
  "payment_provider",
  "payment_webhook",
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

export function holdsInventory(state: TransactionState): boolean {
  return (INVENTORY_HELD_STATES as readonly TransactionState[]).includes(state);
}
