import type { TransactionActor, TransactionState } from "@/domain/transaction/states";

/**
 * A named, actor-scoped edge in the transaction lifecycle.
 *
 * `allowedActors` is the load-bearing field: it is where "AI cannot approve
 * itself" and "AI cannot mark a payment successful" stop being documentation
 * and become data the state machine enforces.
 */
export interface TransactionTransition {
  readonly to: TransactionState;
  /** Domain event that justifies the move. Mirrors the audit event vocabulary. */
  readonly trigger: string;
  readonly allowedActors: readonly TransactionActor[];
}

const CANCEL_ACTORS = ["human_user", "transaction_service"] as const;

/**
 * The complete transition table. Any (from, to) pair absent from this map is an
 * invalid transition, including every attempt to skip a control:
 * PRODUCT_SELECTED -> AUTHORIZED, POLICY_CHECKED -> PAYMENT_CAPTURED,
 * APPROVAL_REQUIRED -> AUTHORIZED by anyone but the approval gate, and any
 * move at all out of a terminal state.
 */
export const TRANSACTION_TRANSITIONS: Readonly<
  Record<TransactionState, readonly TransactionTransition[]>
> = {
  INTENT_RECEIVED: [
    {
      to: "PRODUCT_SELECTED",
      trigger: "product_selected",
      // The single point in the whole lifecycle where an AI actor may act.
      allowedActors: ["buyer_agent", "product_decision_engine"],
    },
    {
      to: "BLOCKED",
      trigger: "intent_rejected",
      allowedActors: ["policy_engine", "transaction_service"],
    },
    { to: "CANCELLED", trigger: "cancelled", allowedActors: CANCEL_ACTORS },
  ],

  PRODUCT_SELECTED: [
    // Verification is server-side: the agent's claimed price is discarded here.
    {
      to: "PRODUCT_VERIFIED",
      trigger: "product_verified",
      allowedActors: ["merchant_service"],
    },
    {
      to: "BLOCKED",
      trigger: "product_verification_failed",
      allowedActors: ["merchant_service", "transaction_service"],
    },
    { to: "CANCELLED", trigger: "cancelled", allowedActors: CANCEL_ACTORS },
  ],

  PRODUCT_VERIFIED: [
    {
      to: "POLICY_CHECKED",
      trigger: "policy_evaluated",
      allowedActors: ["policy_engine"],
    },
    { to: "BLOCKED", trigger: "policy_denied", allowedActors: ["policy_engine"] },
    { to: "CANCELLED", trigger: "cancelled", allowedActors: CANCEL_ACTORS },
  ],

  POLICY_CHECKED: [
    { to: "AUTHORIZED", trigger: "authorized", allowedActors: ["policy_engine"] },
    {
      to: "APPROVAL_REQUIRED",
      trigger: "approval_required",
      allowedActors: ["policy_engine"],
    },
    { to: "BLOCKED", trigger: "policy_denied", allowedActors: ["policy_engine"] },
    { to: "CANCELLED", trigger: "cancelled", allowedActors: CANCEL_ACTORS },
  ],

  APPROVAL_REQUIRED: [
    // Only the human-backed approval gate can convert an approval into authority.
    { to: "AUTHORIZED", trigger: "approval_granted", allowedActors: ["approval_gate"] },
    { to: "BLOCKED", trigger: "approval_denied", allowedActors: ["approval_gate"] },
    { to: "CANCELLED", trigger: "approval_expired", allowedActors: CANCEL_ACTORS },
  ],

  AUTHORIZED: [
    {
      to: "PAYMENT_CREATED",
      trigger: "payment_order_created",
      allowedActors: ["razorpay_integration"],
    },
    {
      to: "PAYMENT_FAILED",
      trigger: "payment_order_creation_failed",
      allowedActors: ["razorpay_integration"],
    },
    { to: "CANCELLED", trigger: "cancelled", allowedActors: CANCEL_ACTORS },
  ],

  PAYMENT_CREATED: [
    {
      to: "PAYMENT_PENDING",
      trigger: "payment_attempt_started",
      allowedActors: ["razorpay_integration", "transaction_service"],
    },
    {
      to: "PAYMENT_FAILED",
      trigger: "payment_failed",
      allowedActors: ["razorpay_integration", "razorpay_webhook"],
    },
    { to: "CANCELLED", trigger: "cancelled", allowedActors: CANCEL_ACTORS },
  ],

  PAYMENT_PENDING: [
    // Success is only ever asserted by verified server-side evidence.
    {
      to: "PAYMENT_CAPTURED",
      trigger: "payment_captured",
      allowedActors: ["razorpay_webhook", "razorpay_integration"],
    },
    {
      to: "PAYMENT_FAILED",
      trigger: "payment_failed",
      allowedActors: ["razorpay_webhook", "razorpay_integration"],
    },
  ],

  PAYMENT_CAPTURED: [
    {
      to: "COMPLETED",
      trigger: "transaction_completed",
      allowedActors: ["transaction_service"],
    },
  ],

  PAYMENT_FAILED: [
    // Retry reuses the existing authorization; it never re-enters the AI path.
    {
      to: "PAYMENT_CREATED",
      trigger: "payment_retried",
      allowedActors: ["transaction_service"],
    },
    { to: "CANCELLED", trigger: "cancelled", allowedActors: CANCEL_ACTORS },
  ],

  COMPLETED: [],
  BLOCKED: [],
  CANCELLED: [],
};
