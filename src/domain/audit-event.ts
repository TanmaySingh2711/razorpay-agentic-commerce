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
  "product_selected",
  "product_verified",
  "product_verification_failed",
  "policy_evaluated",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "payment_order_created",
  "payment_attempt_started",
  "payment_captured",
  "payment_failed",
  "webhook_received",
  "webhook_rejected",
  "state_transitioned",
  "transaction_completed",
  "transaction_blocked",
  "transaction_cancelled",
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
