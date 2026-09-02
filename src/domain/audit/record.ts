import { z } from "zod";
import { AUDIT_EVENT_TYPES, type AuditEventType } from "@/domain/audit-event";
import { TRANSACTION_ACTORS, type TransactionActor } from "@/domain/transaction/states";
import { isSensitiveKey } from "@/lib/redact";
import { MAX_PROVIDER_REFERENCE_LENGTH } from "@/domain/payment/rules";
import { ValidationError } from "@/domain/errors";
import type { JsonObject, JsonValue } from "@/lib/json";

/**
 * The shape of one audited fact, and the rules about what may become one.
 *
 * The audit trail answers "what did this system do with someone's money, and
 * why" — durably, in order, and completely enough to reconstruct a transaction
 * without access to anything else. That is a different job from operational
 * logging (`@/lib/logger`), which exists for operators and may be sampled,
 * rotated, reordered or dropped. Neither substitutes for the other, and a
 * user-facing explanation is never reassembled from log lines.
 *
 * Two design commitments run through this file.
 *
 * **Bounded vocabularies, not free text.** Actor, action and result are closed
 * unions, so the core financial semantics stay queryable and cannot drift into
 * prose that means whatever its author felt at the time.
 *
 * **Payloads are allow-listed per action, not accepted on trust.** Every action
 * declares exactly which trusted, server-derived fields it may carry. Anything
 * else is refused rather than quietly stored — hoping every future caller
 * behaves is not a security control.
 */

/** Who or what caused the event. Reuses the lifecycle's own actor vocabulary. */
export type AuditActor = TransactionActor;

export const AUDIT_RESULTS = ["SUCCESS", "FAILURE", "BLOCKED", "PENDING"] as const;

export type AuditResult = (typeof AUDIT_RESULTS)[number];

/**
 * Actor is not authority.
 *
 * Gemini is a legitimate *actor* — it produces recommendations, and the record
 * should say so. It is never the *authority* for a price, a policy outcome or a
 * lifecycle state; those come from server code reading PostgreSQL. Recording
 * the distinction is what lets a reader see that an AI proposed something and a
 * deterministic rule decided it.
 */
export const AI_ACTORS: readonly AuditActor[] = ["buyer_agent"];

export function isAiActor(actor: AuditActor): boolean {
  return AI_ACTORS.includes(actor);
}

// ---------------------------------------------------------------------------
// Trusted payloads, one allow-list per action
// ---------------------------------------------------------------------------

/** Integer minor units as a decimal string. `bigint` never crosses this boundary raw. */
const minorAmount = z.string().regex(/^-?\d+$/, "amounts are integer minor units");

const identifier = z.string().min(1).max(64);

/**
 * External provider references, bounded by the columns that store them.
 *
 * Wider than `identifier` on purpose: these values come from another company's
 * namespace, and one of them (`presentedOrderId`) is attacker-controlled. The
 * bound has to be at least as wide as whatever the request boundary lets in, or
 * the record of a rejected callback becomes impossible to write.
 */
const providerReference = z.string().min(1).max(MAX_PROVIDER_REFERENCE_LENGTH);
const currency = z.string().regex(/^[A-Z]{3}$/);
const isoInstant = z.iso.datetime();
const shortCode = z.string().min(1).max(64);

/** What the shopper asked for, after it became structured and bounded. */
const intentPayload = z.strictObject({
  requestType: shortCode.optional(),
  quantity: z.int().positive().optional(),
  maxBudgetMinor: minorAmount.nullable().optional(),
  currency: currency.nullable().optional(),
  budgetScope: shortCode.nullable().optional(),
  category: z.string().max(64).nullable().optional(),
  candidatesConsidered: z.int().nonnegative().optional(),
  question: z.string().max(300).optional(),
  reasons: z.array(shortCode).max(20).optional(),
});

/** A product proposal, and the server's verdict on it. */
const selectionPayload = z.strictObject({
  productId: identifier,
  quantity: z.int().positive(),
  reasons: z.array(shortCode).max(20).optional(),
  candidatesConsidered: z.int().nonnegative().optional(),
});

/** The authoritative product facts, re-read from PostgreSQL. */
const verificationPayload = z.strictObject({
  productId: identifier,
  unitAmountMinor: minorAmount,
  currency,
  availableQuantity: z.int().nonnegative(),
  productVersion: z.int().positive(),
});

/** The frozen financial snapshot. */
const quotePayload = z.strictObject({
  quoteId: identifier,
  productId: identifier,
  quantity: z.int().positive(),
  unitAmountMinor: minorAmount,
  totalAmountMinor: minorAmount,
  currency,
  productVersion: z.int().positive(),
  expiresAt: isoInstant,
  replacedQuoteId: identifier.nullable().optional(),
});

/** A quote leaving usefulness. */
const quoteSettlementPayload = z.strictObject({
  quoteId: identifier,
  totalAmountMinor: minorAmount.optional(),
  currency: currency.optional(),
  reasons: z.array(shortCode).max(10).optional(),
  expiredAt: isoInstant.optional(),
});

/** A deterministic policy decision, with the exact rule it was made under. */
const policyPayload = z.strictObject({
  quoteId: identifier,
  productId: identifier.optional(),
  buyerProfileId: identifier.optional(),
  policyId: identifier.nullable(),
  policyVersion: z.int().nullable(),
  decision: shortCode,
  quantity: z.int().positive().optional(),
  amountMinor: minorAmount,
  currency,
  autoApproveLimitMinor: minorAmount.nullable().optional(),
  operationId: identifier.optional(),
});

/** A human decision, bound to one exact purchase. Never the token. */
const approvalPayload = z.strictObject({
  approvalId: identifier,
  quoteId: identifier,
  amountMinor: minorAmount.optional(),
  currency: currency.optional(),
  quantity: z.int().positive().optional(),
  policyVersion: z.int().optional(),
  policyDecision: shortCode.optional(),
  decidedByBuyerId: identifier.optional(),
  expiresAt: isoInstant.optional(),
  expiredAt: isoInstant.optional(),
  operationId: identifier.optional(),
});

/** A claim on stock, and what became of it. */
const reservationPayload = z.strictObject({
  reservationId: identifier,
  quoteId: identifier.optional(),
  productId: identifier,
  quantity: z.int().positive(),
  amountMinor: minorAmount.optional(),
  currency: currency.optional(),
  expiresAt: isoInstant.optional(),
  expiredAt: isoInstant.optional(),
  releasedAt: isoInstant.optional(),
  committedAt: isoInstant.optional(),
  remainingInventory: z.int().nonnegative().optional(),
  operationId: identifier.optional(),
});

/** A lifecycle move, mirrored from the authoritative transition history. */
const transitionPayload = z.strictObject({
  fromStatus: shortCode,
  toStatus: shortCode,
  trigger: shortCode,
  sequence: z.int().positive(),
  transitionId: identifier.optional(),
});

/**
 * A payment interaction, recorded from trusted server state only.
 *
 * Note what is absent and must stay absent: the Razorpay key secret, the
 * webhook secret, any Authorization header, any card number or CVV, and the
 * provider's own error prose - which is free text that can echo request content
 * back into a record meant to be evidence. Only mapped, enumerable codes are
 * allowed through `failureCode`.
 *
 * `paymentAttemptId` and `providerOrderId` sit side by side on purpose. The
 * first is ours and is a key; the second is Razorpay's and is a reference. A
 * reader of the audit trail should be able to see both and never confuse which
 * system owns which.
 */
const paymentPayload = z.strictObject({
  /** Internal identity of the attempt. Ours. */
  paymentAttemptId: identifier.optional(),
  attemptNumber: z.int().positive().optional(),
  quoteId: identifier.optional(),
  reservationId: identifier.optional(),
  amountMinor: minorAmount.optional(),
  currency: currency.optional(),
  provider: shortCode.optional(),
  /** Our reference, and the provider's idempotency key for this order. */
  receipt: identifier.optional(),
  /** Provider references are external identifiers, never internal keys. */
  providerOrderId: providerReference.optional(),
  providerPaymentId: providerReference.optional(),
  /** The provider's own lifecycle word, kept for reconciliation. */
  providerStatus: shortCode.optional(),
  /** The policy that was in force when the external side effect was authorized. */
  policyVersion: z.int().nullable().optional(),
  policyDecision: shortCode.optional(),
  /** Set when a scoped human approval supplied the authority. */
  approvalId: identifier.optional(),
  /** A mapped, enumerable code. Never the provider's message. */
  failureCode: shortCode.optional(),
  /**
   * An identifier a *client* presented, recorded only when it disagreed with
   * what the server holds.
   *
   * Kept because "somebody posted this order id against that transaction" is
   * precisely the fact a security review needs, and it is an opaque provider
   * reference rather than a credential. It is never used for anything but the
   * record - no lookup, and certainly no signature.
   */
  presentedOrderId: providerReference.optional(),
  /** Why the server declined before any provider call was made. */
  refusal: shortCode.optional(),
  operationId: identifier.optional(),
  /**
   * The provider's own identifier for one webhook delivery.
   *
   * Recorded so a delivery in a provider dashboard can be lined up against
   * what this system did with it. It is an opaque reference, not a credential,
   * and it is never used to authenticate anything.
   */
  providerEventId: providerReference.optional(),
  /**
   * What the provider said the amount was, recorded only when it disagreed
   * with the trusted quote.
   *
   * Kept beside `amountMinor` - which is always ours - so a reader can see both
   * numbers and which one the system believed. The provider's figure is
   * evidence in the record; it is never the amount anything is decided on.
   */
  observedAmountMinor: minorAmount.optional(),
  observedCurrency: currency.optional(),
});

const genericPayload = z.strictObject({
  quoteId: identifier.optional(),
  amountMinor: minorAmount.optional(),
  currency: currency.optional(),
  reasons: z.array(shortCode).max(10).optional(),
});

/**
 * Action -> the only fields that action may record.
 *
 * Exhaustive over the vocabulary by construction: `Record<AuditEventType, …>`
 * means adding an event type without deciding what it may carry is a compile
 * error, not a payload that silently accepts anything.
 */
const PAYLOAD_SCHEMAS: Record<AuditEventType, z.ZodType> = {
  intent_received: intentPayload,
  intent_interpreted: intentPayload,
  clarification_requested: intentPayload,
  no_candidate_matched: intentPayload,
  product_selected: selectionPayload,
  product_selection_rejected: selectionPayload,
  product_verified: verificationPayload,
  product_verification_failed: verificationPayload,
  quote_created: quotePayload,
  quote_reissued: quotePayload,
  quote_expired: quoteSettlementPayload,
  quote_invalidated: quoteSettlementPayload,
  policy_evaluated: policyPayload,
  approval_requested: approvalPayload,
  approval_granted: approvalPayload,
  approval_denied: approvalPayload,
  approval_expired: approvalPayload,
  approval_replay_rejected: approvalPayload,
  inventory_reserved: reservationPayload,
  inventory_reservation_failed: reservationPayload,
  inventory_reservation_expired: reservationPayload,
  inventory_committed: reservationPayload,
  inventory_released: reservationPayload,
  payment_order_created: paymentPayload,
  payment_attempt_started: paymentPayload,
  payment_checkout_dismissed: paymentPayload,
  payment_verified: paymentPayload,
  payment_callback_rejected: paymentPayload,
  payment_captured: paymentPayload,
  payment_failed: paymentPayload,
  webhook_received: paymentPayload,
  webhook_rejected: paymentPayload,
  webhook_duplicate: paymentPayload,
  webhook_ignored: paymentPayload,
  webhook_mismatch: paymentPayload,
  state_transitioned: transitionPayload,
  transaction_completed: genericPayload,
  transaction_blocked: genericPayload,
  transaction_cancelled: genericPayload,
  transaction_expired: genericPayload,
};

export function auditPayloadSchema(action: AuditEventType): z.ZodType {
  return PAYLOAD_SCHEMAS[action];
}

/** A payload that could not be recorded as written. */
export class AuditPayloadRejectedError extends ValidationError {
  constructor(action: AuditEventType, reason: string) {
    super({
      code: "AUDIT_PAYLOAD_REJECTED",
      message: `The audit payload for ${action} was refused: ${reason}`,
      publicMessage: "The request could not be processed.",
      details: { action, reason },
    });
  }
}

/**
 * Validates a payload against its action's allow-list.
 *
 * Refuses rather than trims, on both counts, and the reasoning differs:
 *
 *  - A **sensitive key** is refused loudly because silently dropping it would
 *    hide a real bug. A caller that tried to audit a token or an API key has a
 *    defect worth failing a test over, and stripping it would let that defect
 *    ship and recur somewhere the stripping does not reach.
 *  - An **unexpected field** is refused because an audit record is evidence.
 *    Storing whatever arrived would let this trail slowly become a dumping
 *    ground, which is exactly how a financial record stops being trustworthy.
 *
 * Failing closed here can abort a business transaction, since audit writes are
 * atomic with the actions they describe. That is the intended trade: payloads
 * are built by this repository's own code against these schemas, so a rejection
 * is a bug caught in tests rather than a condition users encounter.
 */
export function sanitizeAuditPayload(
  action: AuditEventType,
  payload: JsonObject,
): JsonObject {
  const offendingKey = findSensitiveKey(payload, 0);
  if (offendingKey !== null) {
    // Deliberately names the key and never the value.
    throw new AuditPayloadRejectedError(
      action,
      `it carries a field that may hold a secret or model reasoning (${offendingKey})`,
    );
  }

  const parsed = auditPayloadSchema(action).safeParse(payload);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "<root>"))),
    ].sort();
    throw new AuditPayloadRejectedError(
      action,
      `these fields are not part of its trusted-input contract: ${fields.join(", ")}`,
    );
  }
  return parsed.data as JsonObject;
}

const MAX_SCAN_DEPTH = 6;

function findSensitiveKey(value: JsonValue, depth: number): string | null {
  if (depth > MAX_SCAN_DEPTH) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findSensitiveKey(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) return key;
    const found = findSensitiveKey(entry, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The record itself
// ---------------------------------------------------------------------------

/**
 * One audited fact, as it is read back.
 *
 * `conciseExplanation` is **derived**, not stored. The persisted row carries the
 * reason code and the trusted facts; the sentence a person reads is rendered
 * from those at read time. Storing prose would create a second source of truth
 * that drifts the moment anybody rewords it, and would invite someone to put
 * narration where a code belongs.
 */
export interface AuditRecord {
  readonly eventId: string;
  readonly transactionId: string | null;
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly action: AuditEventType;
  readonly result: AuditResult;
  readonly reasonCode: string | null;
  readonly conciseExplanation: string;
  /** Server-derived facts only. Never an AI or client claim. */
  readonly trustedInputs: JsonObject;
  readonly correlationId: string | null;
  readonly operationKey: string | null;
  readonly decisionId: string | null;
}

export const auditActorSchema = z.enum(TRANSACTION_ACTORS);
export const auditActionSchema = z.enum(AUDIT_EVENT_TYPES);
export const auditResultSchema = z.enum(AUDIT_RESULTS);
