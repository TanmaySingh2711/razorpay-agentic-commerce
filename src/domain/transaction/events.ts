/**
 * Domain events - things that happened, not states to move to.
 *
 * This distinction is the whole point of the state machine. A caller says
 * "product verification succeeded", never "set the state to PRODUCT_VERIFIED".
 * The machine decides whether that event is legal from the current state and
 * what state results.
 *
 * Without it, the API would be `setStatus(id, anyStatus)` - which is not a
 * state machine, it is an assignment with extra steps, and it would let any
 * service (or any bug) put a transaction into any state.
 */
export const TRANSACTION_EVENTS = [
  /** An agent proposed a specific product. A proposal, nothing more. */
  "PRODUCT_SELECTION_CONFIRMED",
  /** The merchant service re-read authoritative price, currency and stock. */
  "PRODUCT_VERIFICATION_SUCCEEDED",
  /** The product no longer matches the proposal, or is unavailable. */
  "PRODUCT_VERIFICATION_FAILED",
  /** A PurchaseQuote froze the verified facts. */
  "QUOTE_ISSUED",
  /** The quote's validity window elapsed. */
  "QUOTE_EXPIRED",
  /** The deterministic policy engine finished evaluating the quote. */
  "POLICY_EVALUATION_COMPLETED",
  /** Policy permits the purchase without a human. */
  "POLICY_ALLOWED",
  /** Policy demands a human decision before money moves. */
  "POLICY_REQUIRES_APPROVAL",
  /** Policy refuses the purchase outright. */
  "POLICY_BLOCKED",
  /** A human approved this exact quoted amount. */
  "APPROVAL_GRANTED",
  /** A human refused. */
  "APPROVAL_REJECTED",
  /** Nobody answered in time. */
  "APPROVAL_EXPIRED",
  /** Stock was held for this transaction. */
  "INVENTORY_RESERVED",
  /** Stock ran out before it could be held. */
  "INVENTORY_UNAVAILABLE",
  /** A held reservation elapsed. */
  "RESERVATION_EXPIRED",
  /** A payment order exists at the provider. */
  "PAYMENT_ORDER_CREATED",
  /** Checkout was handed to the user. */
  "PAYMENT_STARTED",
  /** A payment signature was verified server-side. */
  "PAYMENT_CALLBACK_VERIFIED",
  /** The provider confirmed settlement. */
  "PAYMENT_CAPTURE_CONFIRMED",
  /** A payment attempt did not succeed. */
  "PAYMENT_FAILED",
  /** A controlled retry of a failed payment. */
  "PAYMENT_RETRY_REQUESTED",
  /** The checkout window elapsed with no outcome. */
  "PAYMENT_WINDOW_EXPIRED",
  /** Everything settled and inventory was committed. */
  "TRANSACTION_COMPLETED",
  /** Abandoned by the user or the system. */
  "TRANSACTION_CANCELLED",
  /** A lifecycle clock elapsed with no resolution. */
  "TRANSACTION_EXPIRED",
  /** The intent itself was refused before any product was chosen. */
  "INTENT_REJECTED",
] as const;

export type TransactionEvent = (typeof TRANSACTION_EVENTS)[number];

/**
 * Events whose authority originates OUTSIDE this system - a payment provider.
 *
 * They are singled out because they arrive at-least-once, out of order, and
 * sometimes long after the transaction moved on. An illegal *internal* event is
 * a bug; an illegal *external* event is often just a late webhook, and must be
 * classified for reconciliation rather than rejected as nonsense.
 */
export const EXTERNAL_PAYMENT_EVENTS: readonly TransactionEvent[] = [
  "PAYMENT_CALLBACK_VERIFIED",
  "PAYMENT_CAPTURE_CONFIRMED",
  "PAYMENT_FAILED",
];

export function isExternalPaymentEvent(event: TransactionEvent): boolean {
  return EXTERNAL_PAYMENT_EVENTS.includes(event);
}

/**
 * Structured reason codes persisted with each transition.
 *
 * Deliberately a closed, short vocabulary. Free-form prose is never the
 * authoritative reason: a human-readable explanation is derived from a code
 * later, so the record stays queryable and cannot become a dumping ground.
 */
export const TRANSITION_REASON_CODES = [
  "PRODUCT_SELECTED",
  "PRODUCT_VERIFIED",
  "PRODUCT_VERIFICATION_FAILED",
  "QUOTE_ISSUED",
  "QUOTE_REISSUED",
  "QUOTE_EXPIRED",
  "POLICY_EVALUATED",
  "POLICY_ALLOWED",
  "POLICY_REQUIRES_APPROVAL",
  "POLICY_BLOCKED",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "INVENTORY_RESERVED",
  "INVENTORY_UNAVAILABLE",
  "RESERVATION_EXPIRED",
  "PAYMENT_ORDER_CREATED",
  "PAYMENT_STARTED",
  "PAYMENT_SIGNATURE_VERIFIED",
  "PAYMENT_CAPTURE_CONFIRMED",
  "PAYMENT_ATTEMPT_FAILED",
  "PAYMENT_RETRY_REQUESTED",
  "PAYMENT_WINDOW_EXPIRED",
  "LATE_CAPTURE_RECONCILED",
  "TRANSACTION_COMPLETED",
  "USER_CANCELLED",
  "TRANSACTION_EXPIRED",
  "INTENT_REJECTED",
] as const;

export type TransitionReasonCode = (typeof TRANSITION_REASON_CODES)[number];
