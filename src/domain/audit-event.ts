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
  "inventory_committed",
  "inventory_released",
  "payment_order_created",
  "payment_attempt_started",
  "payment_verified",
  "payment_captured",
  "payment_failed",
  "webhook_received",
  "webhook_rejected",
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
