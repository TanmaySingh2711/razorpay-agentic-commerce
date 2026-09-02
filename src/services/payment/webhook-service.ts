import { createHash } from "node:crypto";
import { assertServerOnly } from "@/lib/server-only";
import { createLogger } from "@/lib/logger";
import { getPrismaClient } from "@/integrations/persistence/client";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { applyTransactionEventWithin } from "@/services/transaction/transition-service";
import {
  isSupportedWebhookEvent,
  razorpayWebhookSchema,
  type AuthenticatedWebhookFacts,
  type SupportedWebhookEvent,
  type WebhookMismatch,
  type WebhookOutcome,
} from "@/domain/payment/webhook";
import type { PaymentProvider } from "@/domain/payment/provider";
import type { PrismaClient } from "@/generated/prisma/client";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";
import type { TransactionEvent } from "@/domain/transaction/events";

/**
 * Reconciliation from authoritative provider events.
 *
 * The browser callback told us a message was authentic. This tells us money
 * moved. They are different claims from different parties, and only the second
 * comes from the party that actually holds the money - so this is the file that
 * may reach PAYMENT_CAPTURED, and the callback path never can.
 *
 * The order of work is the design, and it is deliberately paranoid:
 *
 *   1. **Authenticate.** HMAC over the exact raw bytes. Until this passes, the
 *      body is a string from a stranger and it is not parsed.
 *   2. **Claim.** Insert the delivery id under a unique constraint. Two
 *      simultaneous deliveries are separated by PostgreSQL, not by timing.
 *   3. **Correlate.** Find *our* payment attempt from *our* stored order id.
 *   4. **Check the money.** Against the persisted amount, never the payload's.
 *   5. **Transition.** Through the state machine, which owns what is legal.
 *   6. **Audit.** What was observed, what was checked, what was decided.
 *
 * Steps 2 through 6 share one database transaction, and that is load-bearing
 * rather than tidy. If the claim committed on its own and the business effect
 * then failed, the delivery id would exist while nothing had happened - and
 * every later retry from the provider would be waved through as a duplicate,
 * turning a transient error into a payment this system never reconciled. Both
 * commit or neither does, so a retry after a failure still has work to do.
 *
 * A genuine signature is not correlation. Razorpay signing an event proves
 * Razorpay sent it; it says nothing about which of our transactions it belongs
 * to. Those are separate checks, and a mismatch is recorded and refused rather
 * than reconciled.
 */
assertServerOnly("src/services/payment/webhook-service.ts");

const log = createLogger({ category: "payment" });

/**
 * The webhook is its own actor.
 *
 * Not `payment_provider`, which is the browser-callback path, and certainly not
 * a human. The state machine grants `payment_webhook` transitions no other
 * actor has - notably the late capture out of PAYMENT_FAILED - because verified
 * provider evidence is the only thing that should be able to say money moved
 * after we recorded that it had not.
 */
const WEBHOOK_ACTOR = "payment_webhook" as const;

/** Bounds the body we will hash and parse, so a huge POST cannot be a lever. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

const UNIQUE_VIOLATION = "P2002";

export interface WebhookServiceDeps {
  readonly prisma: PrismaClient;
  readonly provider: PaymentProvider;
}

export function defaultWebhookDeps(): WebhookServiceDeps {
  return { prisma: getPrismaClient(), provider: createRazorpayProvider() };
}

/** Exactly what arrived, before any of it has been believed. */
export interface InboundWebhook {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly providerEventId: string | null;
}

/**
 * A digest of the body, stored instead of the body.
 *
 * Enough to prove two deliveries carried the same bytes, and useless to anyone
 * who steals the database. A webhook payload is not quite a secret, but it
 * describes someone's payment, and there is no reason to keep a copy once the
 * facts have been extracted from it.
 */
function digestOf(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * Reads the facts we act on out of an authenticated payload.
 *
 * Returns null when the payload is authentic but not shaped like a payment
 * event we understand. That is not an error: Razorpay emits many event types,
 * and a merchant can subscribe to more from a dashboard without touching this
 * code.
 */
function readFacts(
  rawBody: string,
  providerEventId: string,
): AuthenticatedWebhookFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const result = razorpayWebhookSchema.safeParse(parsed);
  if (!result.success) return null;

  const entity = result.data.payload.payment.entity;
  return {
    providerEventId,
    eventType: result.data.event,
    providerPaymentId: entity.id,
    providerOrderId: entity.order_id ?? null,
    // Razorpay sends integer paise. It becomes a bigint here and never a float,
    // and it is only ever compared against our own figure - never adopted.
    amountMinor: BigInt(entity.amount),
    currency: entity.currency.toUpperCase(),
    failureCode: entity.error_code ?? null,
  };
}

/**
 * The domain event a supported provider event maps to.
 *
 * Total over a closed set, so subscribing to a new provider event without
 * deciding what it means here is a compile error rather than a silent
 * fall-through into capture.
 */
function domainEventFor(event: SupportedWebhookEvent): TransactionEvent {
  return event === "payment.captured" ? "PAYMENT_CAPTURE_CONFIRMED" : "PAYMENT_FAILED";
}

interface CorrelatedAttempt {
  readonly id: string;
  readonly transactionId: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly providerPaymentId: string | null;
  readonly transactionStatus: string;
  readonly correlationId: string | null;
}

/**
 * Finds our payment attempt from the provider's order id.
 *
 * The order id is the right key because *we* created it and stored it before
 * the browser ever saw it, so it is a fact about our own records rather than
 * something a caller chose. The payment id in the payload is not used to find
 * anything: on a capture that arrives before the callback, we may be learning
 * it for the first time.
 */
async function correlate(
  tx: TransactionCapableClient,
  providerOrderId: string,
): Promise<CorrelatedAttempt | null> {
  const attempt = await tx.paymentAttempt.findFirst({
    where: { provider: "RAZORPAY", providerOrderId },
    select: {
      id: true,
      transactionId: true,
      amount: true,
      currency: true,
      providerPaymentId: true,
      transaction: { select: { status: true, correlationId: true } },
    },
  });
  if (attempt === null) return null;
  return {
    id: attempt.id,
    transactionId: attempt.transactionId,
    amount: attempt.amount,
    currency: attempt.currency,
    providerPaymentId: attempt.providerPaymentId,
    transactionStatus: attempt.transaction.status,
    correlationId: attempt.transaction.correlationId,
  };
}

/**
 * Compares what the provider asserts against what we persisted.
 *
 * The expected figures come from the payment attempt, which was built from the
 * trusted PurchaseQuote. The payload's amount is evidence, never authority: a
 * webhook quoting a different number is telling us something is wrong, not
 * telling us the price.
 */
function financialMismatch(
  facts: AuthenticatedWebhookFacts,
  attempt: CorrelatedAttempt,
): WebhookMismatch | null {
  // A payment id we already recorded must not be contradicted. Learning one for
  // the first time is fine; being told a different one for the same attempt is
  // two payments against one order, which we refuse rather than overwrite.
  if (
    attempt.providerPaymentId !== null &&
    attempt.providerPaymentId !== facts.providerPaymentId
  ) {
    return "PAYMENT_ID_CONFLICT";
  }
  if (facts.currency !== attempt.currency) return "CURRENCY_MISMATCH";
  if (facts.amountMinor !== attempt.amount) return "AMOUNT_MISMATCH";
  return null;
}

function eventKey(providerEventId: string): {
  provider_externalEventId: { provider: "RAZORPAY"; externalEventId: string };
} {
  return {
    provider_externalEventId: {
      provider: "RAZORPAY" as const,
      externalEventId: providerEventId,
    },
  };
}

/** Records a refusal on the receipt, without moving any money. */
async function markRejected(
  tx: TransactionCapableClient,
  providerEventId: string,
  errorCategory: string,
  transactionId?: string,
): Promise<void> {
  await tx.webhookEvent.update({
    where: eventKey(providerEventId),
    data: {
      status: "REJECTED",
      processedAt: new Date(),
      errorCategory,
      ...(transactionId === undefined ? {} : { transactionId }),
    },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Notes a redelivery, without touching the original outcome.
 *
 * Written outside the rolled-back transaction, and best-effort. The property
 * that matters is that the duplicate changed nothing; failing to annotate the
 * ledger must not turn a correct no-op into an error the provider retries.
 */
async function recordDuplicate(
  prisma: PrismaClient,
  providerEventId: string,
): Promise<void> {
  try {
    const existing = await prisma.webhookEvent.findUnique({
      where: eventKey(providerEventId),
      select: { transactionId: true, status: true },
    });
    log.info("webhook duplicate ignored", {
      providerEventId,
      previousStatus: existing?.status ?? "UNKNOWN",
    });
    const transactionId = existing?.transactionId ?? null;
    if (transactionId !== null) {
      await recordAuditEvent(prisma, {
        transactionId,
        action: "webhook_duplicate",
        actor: WEBHOOK_ACTOR,
        result: "SUCCESS",
        reasonCode: "WEBHOOK_REDELIVERED",
        operationKey: `webhook_duplicate:${providerEventId}`,
        trustedInputs: { providerEventId, provider: "RAZORPAY" },
      });
    }
  } catch {
    // Annotation is not the control. Swallowed on purpose.
  }
}

/**
 * Processes one inbound webhook.
 *
 * Total: every path returns an outcome the route can answer with, and none of
 * them tells an unauthenticated caller anything about why.
 */
export async function processWebhook(
  inbound: InboundWebhook,
  deps: WebhookServiceDeps = defaultWebhookDeps(),
): Promise<WebhookOutcome> {
  // --- 1. Authenticate, before anything is parsed or written. ---
  if (inbound.signature === null || inbound.signature.length === 0) {
    log.warn("webhook rejected", { rejection: "SIGNATURE_MISSING" });
    return { kind: "REJECTED", rejection: "SIGNATURE_MISSING" };
  }
  if (Buffer.byteLength(inbound.rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    log.warn("webhook rejected", { rejection: "BODY_TOO_LARGE" });
    return { kind: "REJECTED", rejection: "BODY_TOO_LARGE" };
  }
  if (
    !deps.provider.verifyWebhookSignature({
      rawBody: inbound.rawBody,
      signature: inbound.signature,
    })
  ) {
    // No audit row, deliberately. An audit event belongs to a transaction, and
    // an unauthenticated caller has not shown us one - so writing here would
    // let any stranger on the internet grow our tables. The operational log is
    // the right place, and it carries no signature material.
    log.warn("webhook rejected", { rejection: "SIGNATURE_INVALID" });
    return { kind: "REJECTED", rejection: "SIGNATURE_INVALID" };
  }

  // Authenticated from here down. The event id identifies the delivery, and
  // without one there is nothing to deduplicate against.
  if (inbound.providerEventId === null || inbound.providerEventId.length === 0) {
    return { kind: "REJECTED", rejection: "EVENT_ID_MISSING" };
  }
  const providerEventId = inbound.providerEventId;

  // --- 2. Parse, now that the bytes are known to be the provider's. ---
  const facts = readFacts(inbound.rawBody, providerEventId);
  if (facts === null) {
    return { kind: "REJECTED", rejection: "BODY_MALFORMED" };
  }
  const digest = digestOf(inbound.rawBody);

  try {
    return await deps.prisma.$transaction(async (tx): Promise<WebhookOutcome> => {
      // --- 3. Claim the delivery. The unique index is the deduplicator. ---
      await tx.webhookEvent.create({
        data: {
          provider: "RAZORPAY",
          externalEventId: providerEventId,
          eventType: facts.eventType.slice(0, 80),
          status: "RECEIVED",
          payloadDigest: digest,
        },
      });

      if (!isSupportedWebhookEvent(facts.eventType)) {
        // Authentic and irrelevant. Recorded so the ledger shows we saw it, and
        // acknowledged so the provider stops retrying something correct.
        await tx.webhookEvent.update({
          where: eventKey(providerEventId),
          data: {
            status: "PROCESSED",
            processedAt: new Date(),
            errorCategory: "UNSUPPORTED_EVENT",
          },
        });
        return { kind: "IGNORED", providerEventId, eventType: facts.eventType };
      }
      const eventType = facts.eventType;

      // --- 4. Correlate against our own records. ---
      const providerOrderId = facts.providerOrderId;
      if (providerOrderId === null) {
        await markRejected(tx, providerEventId, "ORDER_NOT_FOUND");
        return {
          kind: "MISMATCHED",
          providerEventId,
          mismatch: "ORDER_NOT_FOUND",
          transactionId: null,
        };
      }
      const attempt = await correlate(tx, providerOrderId);
      if (attempt === null) {
        await markRejected(tx, providerEventId, "ORDER_NOT_FOUND");
        return {
          kind: "MISMATCHED",
          providerEventId,
          mismatch: "ORDER_NOT_FOUND",
          transactionId: null,
        };
      }

      /**
       * The observation, recorded before the decision it leads to.
       *
       * The WebhookEvent ledger already proves the delivery arrived, but that
       * ledger is operational: it is keyed by provider event id and nobody
       * reading one transaction's history would find it. The audit trail is the
       * user-facing record, and it should be able to show that a provider event
       * arrived and then what was concluded from it - not only the conclusion.
       *
       * Written after correlation rather than at receipt, because an audit
       * event belongs to a transaction and before this point there is none to
       * attribute it to.
       */
      await recordAuditEvent(tx, {
        transactionId: attempt.transactionId,
        action: "webhook_received",
        actor: WEBHOOK_ACTOR,
        result: "PENDING",
        reasonCode: "WEBHOOK_RECEIVED",
        correlationId: attempt.correlationId,
        operationKey: `webhook_received:${providerEventId}`,
        trustedInputs: {
          paymentAttemptId: attempt.id,
          providerEventId,
          providerOrderId,
          providerPaymentId: facts.providerPaymentId,
          providerStatus: eventType === "payment.captured" ? "captured" : "failed",
          provider: "RAZORPAY",
        },
      });

      // --- 5. Check the money against trusted state. ---
      const mismatch = financialMismatch(facts, attempt);
      if (mismatch !== null) {
        await markRejected(tx, providerEventId, mismatch, attempt.transactionId);
        await recordAuditEvent(tx, {
          transactionId: attempt.transactionId,
          action: "webhook_mismatch",
          actor: WEBHOOK_ACTOR,
          result: "BLOCKED",
          reasonCode: mismatch,
          correlationId: attempt.correlationId,
          operationKey: `webhook_mismatch:${providerEventId}`,
          trustedInputs: {
            paymentAttemptId: attempt.id,
            providerEventId,
            providerOrderId,
            providerPaymentId: facts.providerPaymentId,
            // Ours first, then theirs, so the record shows both figures and
            // which one the system believed.
            amountMinor: attempt.amount.toString(),
            currency: attempt.currency,
            observedAmountMinor: facts.amountMinor.toString(),
            observedCurrency: facts.currency,
            provider: "RAZORPAY",
          },
        });
        return {
          kind: "MISMATCHED",
          providerEventId,
          mismatch,
          transactionId: attempt.transactionId,
        };
      }

      // --- 6. Reconcile through the state machine. ---
      const outcome = await applyTransactionEventWithin(tx, {
        transactionId: attempt.transactionId,
        event: domainEventFor(eventType),
        actor: WEBHOOK_ACTOR,
        // The provider's delivery id is the natural identity of this logical
        // operation, so a redelivery that somehow got past the claim still
        // converges instead of writing a second transition.
        idempotencyKey: `webhook:${providerEventId}`,
        details: { providerEventId, eventType },
      });

      const captured = eventType === "payment.captured";

      /**
       * Whether the state machine actually took this event.
       *
       * It is the only thing allowed to decide the attempt's status, and that
       * distinction is load-bearing. A stale `payment.failed` delivered behind
       * a capture is held by the state machine - the transaction stays
       * PAYMENT_CAPTURED, correctly - but writing the attempt from the event
       * alone would still stamp it FAILED, leaving the attempt and the
       * transaction it belongs to contradicting each other about whether the
       * money arrived. A financial record that disagrees with itself is worse
       * than one that is merely out of date.
       */
      const applied = outcome.kind === "APPLIED";

      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          // Learned here when the webhook beat the browser back. Always safe to
          // record: it is authenticated, and it was just checked against any id
          // we already held, so it can only be new - never a contradiction.
          providerPaymentId: facts.providerPaymentId,
          // The lifecycle follows the transition, never the event on its own.
          ...(!applied
            ? {}
            : captured
              ? { status: "CAPTURED" as const }
              : {
                  status: "FAILED" as const,
                  // A mapped code only. The provider's own prose is free text
                  // and can echo request content into a record meant to be
                  // evidence.
                  failureCode:
                    facts.failureCode?.slice(0, 64) ?? "PROVIDER_REPORTED_FAILURE",
                }),
        },
      });

      await recordAuditEvent(tx, {
        transactionId: attempt.transactionId,
        // A held event is recorded as acknowledged rather than as the thing it
        // reported. Writing `payment_failed` for a failure the system refused
        // to act on would make the audit trail read as though the payment had
        // failed, which is the opposite of what happened.
        action: applied
          ? captured
            ? "payment_captured"
            : "payment_failed"
          : "webhook_ignored",
        actor: WEBHOOK_ACTOR,
        result: applied && !captured ? "FAILURE" : "SUCCESS",
        reasonCode: !applied
          ? "SUPERSEDED_BY_CURRENT_STATE"
          : captured
            ? "PAYMENT_CAPTURE_CONFIRMED"
            : "PAYMENT_ATTEMPT_FAILED",
        correlationId: attempt.correlationId,
        operationKey: `webhook_reconciled:${providerEventId}`,
        trustedInputs: {
          paymentAttemptId: attempt.id,
          providerEventId,
          providerOrderId,
          providerPaymentId: facts.providerPaymentId,
          amountMinor: attempt.amount.toString(),
          currency: attempt.currency,
          provider: "RAZORPAY",
          ...(facts.failureCode === null
            ? {}
            : { failureCode: facts.failureCode.slice(0, 64) }),
        },
      });

      await tx.webhookEvent.update({
        where: eventKey(providerEventId),
        data: {
          status: "PROCESSED",
          processedAt: new Date(),
          transactionId: attempt.transactionId,
        },
      });

      return {
        kind: "RECONCILED",
        providerEventId,
        transactionId: attempt.transactionId,
        eventType,
        transactionState:
          outcome.kind === "APPLIED" ? outcome.to : attempt.transactionStatus,
        alreadyAccountedFor: outcome.kind !== "APPLIED",
      };
    });
  } catch (error) {
    // The claim collided: this delivery has been seen before. Nothing was
    // written by this call, because the whole transaction rolled back.
    if (isUniqueViolation(error)) {
      await recordDuplicate(deps.prisma, providerEventId);
      return { kind: "DUPLICATE", providerEventId };
    }
    // Anything else is a transient internal failure. The claim rolled back with
    // it, so the provider's next retry finds no record and can still do the
    // work. Rethrown so the route answers non-2xx rather than telling Razorpay
    // an unprocessed event was safely delivered.
    throw error;
  }
}
