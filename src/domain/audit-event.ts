import { z } from "zod";
import { TRANSACTION_ACTORS } from "@/domain/transaction/states";

/**
 * The audit trail: an append-only, user-facing record of what the system did
 * with someone's money.
 *
 * This is a different system from the operational log (`@/lib/logger`). Logs
 * exist for operators, are sampled, rotated and discarded, and may be noisy.
 * Audit events are a product feature: durable, ordered, complete, and sufficient
 * on their own to reconstruct a transaction end to end. Neither substitutes for
 * the other, and audit events are never written by the logger.
 */
export const AUDIT_EVENT_TYPES = [
  "intent_received",
  /** The agent's free text became a validated, bounded structured intent. */
  "intent_interpreted",
  /** The request was too ambiguous to price, and a question went back. */
  "clarification_requested",
  /** The server's own candidate set contained nothing that could be bought. */
  "no_candidate_matched",
  "product_selected",
  /** The agent proposed something the server refused to quote. */
  "product_selection_rejected",
  "product_verified",
  "product_verification_failed",
  "quote_created",
  /** A replacement quote was issued because the old one no longer held. */
  "quote_reissued",
  "quote_expired",
  /** The product moved underneath a quote: price, stock, currency or version. */
  "quote_invalidated",
  "policy_evaluated",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "approval_expired",
  /** A token was presented after the approval had already been settled. */
  "approval_replay_rejected",
  "inventory_reserved",
  "inventory_reservation_failed",
  "inventory_reservation_expired",
  /** A controlled retry's still-active hold was rebound to a freshly re-quoted price. */
  "inventory_reservation_requoted",
  "inventory_committed",
  "inventory_released",
  "payment_order_created",
  /** A human pressed Pay and a provider checkout session was authorized. */
  "payment_attempt_started",
  /** The buyer closed the provider's checkout without completing it. */
  "payment_checkout_dismissed",
  "payment_verified",
  /** A checkout callback was refused: bad signature, or a mismatched relationship. */
  "payment_callback_rejected",
  "payment_captured",
  "payment_failed",
  /** A person explicitly asked to pay again after a failure. */
  "payment_retry_requested",
  /**
   * The deterministic gate granted a retry: the quote was re-validated, the
   * policy re-run, the approval binding re-checked and the stock hold
   * confirmed. Written before any provider call, so the trail shows what was
   * decided independently of what the provider then did.
   */
  "payment_retry_authorized",
  /** The deterministic gate refused. `reasonCode` carries which rule refused. */
  "payment_retry_denied",
  /** Every permitted attempt has been used. Recorded once per transaction. */
  "payment_retry_limit_reached",
  /**
   * Two different payment attempts under one transaction were both captured.
   *
   * The worst case a retry workflow can produce, and it must never be silent:
   * one purchase, two real payments. Recorded as a distinct, blocked fact so
   * the anomaly is visible in the trail rather than hidden behind a duplicate
   * capture that changed nothing.
   */
  "payment_multiple_capture_detected",
  "webhook_received",
  "webhook_rejected",
  /** A redelivery of an event id already recorded. No second effect. */
  "webhook_duplicate",
  /** Authentic, but not an event type this system acts on. */
  "webhook_ignored",
  /**
   * Authentic, and it does not line up with what we stored - a payment for an
   * order we do not know, or an amount that disagrees with the trusted quote.
   * A security-relevant fact that must never move money.
   */
  "webhook_mismatch",
  "state_transitioned",
  "transaction_completed",
  "transaction_blocked",
  "transaction_cancelled",
  "transaction_expired",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_EVENT_RESULTS = ["success", "failure", "blocked", "pending"] as const;

export type AuditEventResult = (typeof AUDIT_EVENT_RESULTS)[number];

const auditDetailValueSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const auditEventSchema = z.object({
  eventId: z.string().min(1),
  transactionId: z.string().min(1),
  eventType: z.enum(AUDIT_EVENT_TYPES),
  actor: z.enum(TRANSACTION_ACTORS),
  occurredAt: z.iso.datetime(),
  result: z.enum(AUDIT_EVENT_RESULTS),
  /** Structured, redaction-safe context. No secrets, no card data, no raw LLM text. */
  details: z.record(z.string(), auditDetailValueSchema),
  /** Links this event to the structured decision that produced it, when there is one. */
  decisionId: z.string().min(1).nullable(),
  /** Ties every event of one logical request together across components. */
  correlationId: z.string().min(1).nullable(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
