import { randomUUID } from "node:crypto";
import { assertServerOnly } from "@/lib/server-only";
import { createLogger } from "@/lib/logger";
import { systemClock, type Clock } from "@/lib/clock";
import { getRefundConfig } from "@/lib/env";
import { getPrismaClient } from "@/integrations/prisma-client";
import { createRazorpayProvider } from "@/integrations/razorpay-provider";
import { recordAuditEvent } from "@/services/audit-service";
import {
  assessRefund,
  refundReceiptFor,
  type RefundDenial,
  type RefundStatus,
  type RefundView,
} from "@/domain/refund";
import type { CurrencyCode } from "@/domain/money";
import type {
  PaymentProvider,
  ProviderRefund,
  ProviderRefundOutcome,
} from "@/domain/payment/provider";
import type { PrismaClient } from "@/generated/prisma/client";
import type { TransactionCapableClient } from "@/services/transition-service";

/**
 * Refunds: the buyer asks, the server decides, the provider returns the money.
 *
 * The same discipline as creating a payment order, pointed the other way:
 *
 *  - **Nothing financial comes from the caller.** The request names a
 *    transaction and nothing else. Which payment, how much and in which
 *    currency are all read from the captured PaymentAttempt.
 *  - **At most one refund.** A partial unique index permits one refund per
 *    transaction that has not FAILED, and the receipt is derived from the
 *    transaction and the refund's ordinal - so two concurrent clicks compute
 *    the same receipt, and the database lets exactly one row exist.
 *  - **Create once, recover by reading.** The provider's create endpoint is
 *    called at most once per refund row. An ambiguous answer is recorded as
 *    RECONCILIATION_REQUIRED and settled by looking the receipt up, never by
 *    asking again.
 *
 * The transaction itself stays COMPLETED. A refund is a second financial fact
 * about a purchase that genuinely happened; it does not rewrite the first.
 */
assertServerOnly("src/services/refund-service.ts");

const log = createLogger({ category: "payment" });

const UNIQUE_VIOLATION = "P2002";

/** The statuses a refund can still move out of. */
const OPEN_STATUSES: readonly RefundStatus[] = [
  "REQUESTED",
  "PENDING",
  "RECONCILIATION_REQUIRED",
];

export interface RefundServiceDeps {
  readonly prisma: PrismaClient;
  readonly provider: PaymentProvider;
  readonly clock: Clock;
  readonly windowDays: number;
}

export function defaultRefundDeps(): RefundServiceDeps {
  return {
    prisma: getPrismaClient(),
    provider: createRazorpayProvider(),
    clock: systemClock,
    windowDays: getRefundConfig().REFUND_WINDOW_DAYS,
  };
}

export type RefundResult =
  | {
      /** The provider accepted the refund. `status` says whether it is done yet. */
      readonly kind: "REFUND_STARTED";
      readonly refundId: string;
      readonly status: RefundStatus;
    }
  | { readonly kind: "DENIED"; readonly denial: RefundDenial }
  | {
      /** The provider definitively refused. The buyer may try again. */
      readonly kind: "PROVIDER_FAILED";
      readonly refundId: string;
      readonly failureCode: string;
    }
  | {
      /** Nobody knows yet whether the provider holds a refund. Never re-sent. */
      readonly kind: "RECONCILIATION_REQUIRED";
      readonly refundId: string;
    };

export interface RefundCommand {
  readonly transactionId: string;
  /** Identity of this logical request, for its audit records. */
  readonly operationId?: string;
}

/** The provider's word for a refund's state, mapped onto ours. */
function statusFromProvider(providerStatus: string): RefundStatus {
  const word = providerStatus.toLowerCase();
  if (word === "processed") return "PROCESSED";
  if (word === "failed") return "FAILED";
  return "PENDING";
}

/**
 * Moves an open refund to a new status, and only an open one.
 *
 * A conditional update rather than a read-then-write: a webhook for the same
 * refund can land at any moment, and whichever writer arrives second must find
 * the row already settled and change nothing. Returns whether this call moved
 * it.
 */
async function settle(
  client: TransactionCapableClient,
  refundId: string,
  status: RefundStatus,
  fields: { readonly providerRefundId?: string; readonly failureCode?: string },
  now: Date,
): Promise<boolean> {
  const moved = await client.refund.updateMany({
    where: { id: refundId, status: { in: [...OPEN_STATUSES] } },
    data: {
      status,
      processedAt: status === "PROCESSED" ? now : null,
      ...(fields.providerRefundId === undefined
        ? {}
        : { providerRefundId: fields.providerRefundId }),
      ...(fields.failureCode === undefined ? {} : { failureCode: fields.failureCode }),
    },
  });
  return moved.count > 0;
}

/** Records what the provider said about one refund, in one database transaction. */
async function applyProviderRefund(
  deps: RefundServiceDeps,
  params: {
    readonly refundId: string;
    readonly transactionId: string;
    readonly refund: ProviderRefund;
    readonly operationKey: string;
    readonly providerEventId?: string;
  },
): Promise<RefundStatus> {
  const status = statusFromProvider(params.refund.status);
  const now = deps.clock.now();
  await deps.prisma.$transaction(async (tx) => {
    const moved = await settle(
      tx,
      params.refundId,
      status,
      {
        providerRefundId: params.refund.providerRefundId,
        ...(status === "FAILED" ? { failureCode: "PROVIDER_REPORTED_FAILED" } : {}),
      },
      now,
    );
    if (!moved || status === "PENDING") return;
    await recordAuditEvent(tx, {
      transactionId: params.transactionId,
      action: status === "PROCESSED" ? "refund_processed" : "refund_failed",
      actor: "payment_provider",
      result: status === "PROCESSED" ? "SUCCESS" : "FAILURE",
      reasonCode: status === "PROCESSED" ? "REFUND_PROCESSED" : "REFUND_FAILED",
      operationKey: params.operationKey,
      trustedInputs: {
        refundId: params.refundId,
        providerRefundId: params.refund.providerRefundId,
        providerStatus: params.refund.status.slice(0, 64),
        ...(params.providerEventId === undefined
          ? {}
          : { providerEventId: params.providerEventId }),
      },
    });
  });
  return status;
}

/**
 * Starts a full refund of a completed purchase.
 *
 * Total: every path returns a result the page can explain, and none of them
 * can return money that was not taken or return it twice.
 */
export async function requestRefund(
  command: RefundCommand,
  deps: RefundServiceDeps = defaultRefundDeps(),
): Promise<RefundResult> {
  const operationId = command.operationId ?? randomUUID();
  const now = deps.clock.now();

  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: command.transactionId },
    select: {
      id: true,
      status: true,
      completedAt: true,
      updatedAt: true,
      buyerProfileId: true,
      correlationId: true,
      attempts: {
        where: { status: "CAPTURED" },
        select: { id: true, amount: true, currency: true, providerPaymentId: true },
      },
      refunds: { select: { status: true } },
    },
  });
  if (transaction === null) return { kind: "DENIED", denial: "NOT_COMPLETED" };

  const assessment = assessRefund({
    transactionStatus: transaction.status,
    // `completedAt` is the precise instant when it is recorded. A completed
    // transaction written without it falls back to its last update, which for
    // a terminal state is the moment it completed.
    completedAt:
      transaction.completedAt ??
      (transaction.status === "COMPLETED" ? transaction.updatedAt : null),
    capturedAttempts: transaction.attempts.map((attempt) => ({
      id: attempt.id,
      amountMinor: attempt.amount,
      currency: attempt.currency,
      providerPaymentId: attempt.providerPaymentId,
    })),
    refundStatuses: transaction.refunds.map((refund) => refund.status),
    windowDays: deps.windowDays,
    now,
  });

  if (assessment.kind === "DENIED") {
    await recordAuditEvent(deps.prisma, {
      transactionId: transaction.id,
      action: "refund_denied",
      actor: "human_user",
      result: "BLOCKED",
      reasonCode: assessment.denial,
      correlationId: transaction.correlationId,
      operationKey: `refund_denied:${operationId}`,
      trustedInputs: { denial: assessment.denial, operationId },
    });
    return { kind: "DENIED", denial: assessment.denial };
  }

  // --- Claim the refund. The database decides who, if two arrive at once. ---
  const receipt = refundReceiptFor(transaction.id, transaction.refunds.length + 1);
  let refundId: string;
  try {
    refundId = await deps.prisma.$transaction(async (tx) => {
      const created = await tx.refund.create({
        data: {
          transactionId: transaction.id,
          paymentAttemptId: assessment.paymentAttemptId,
          amount: assessment.amountMinor,
          currency: assessment.currency,
          receipt,
          requestedByBuyerId: transaction.buyerProfileId,
        },
        select: { id: true },
      });
      await recordAuditEvent(tx, {
        transactionId: transaction.id,
        action: "refund_requested",
        actor: "human_user",
        result: "PENDING",
        reasonCode: "REFUND_REQUESTED",
        correlationId: transaction.correlationId,
        operationKey: `refund_requested:${created.id}`,
        trustedInputs: {
          refundId: created.id,
          paymentAttemptId: assessment.paymentAttemptId,
          amountMinor: assessment.amountMinor.toString(),
          currency: assessment.currency,
          receipt,
          operationId,
        },
      });
      return created.id;
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) {
      // Somebody else's request claimed this refund first - a double click, a
      // second tab. Theirs is the refund; this one is simply not a second.
      return { kind: "DENIED", denial: "ALREADY_REFUNDED" };
    }
    throw error;
  }

  // --- One call to the provider. ---
  const outcome: ProviderRefundOutcome = await deps.provider.createRefund({
    providerPaymentId: assessment.providerPaymentId,
    amountMinor: assessment.amountMinor,
    currency: assessment.currency as CurrencyCode,
    receipt,
    notes: { transactionId: transaction.id },
  });

  switch (outcome.kind) {
    case "CREATED":
    case "ALREADY_EXISTS": {
      const status = await applyProviderRefund(deps, {
        refundId,
        transactionId: transaction.id,
        refund: outcome.refund,
        operationKey: `refund_settled:${refundId}`,
      });
      log.info("refund accepted by provider", { transactionId: transaction.id, status });
      return { kind: "REFUND_STARTED", refundId, status };
    }
    case "FAILED": {
      await deps.prisma.$transaction(async (tx) => {
        await settle(tx, refundId, "FAILED", { failureCode: outcome.failure.code }, now);
        await recordAuditEvent(tx, {
          transactionId: transaction.id,
          action: "refund_failed",
          actor: "payment_provider",
          result: "FAILURE",
          reasonCode: outcome.failure.category,
          correlationId: transaction.correlationId,
          operationKey: `refund_settled:${refundId}`,
          trustedInputs: {
            refundId,
            failureCode: outcome.failure.code.slice(0, 64),
          },
        });
      });
      log.warn("refund refused by provider", {
        transactionId: transaction.id,
        category: outcome.failure.category,
      });
      return { kind: "PROVIDER_FAILED", refundId, failureCode: outcome.failure.code };
    }
    case "UNKNOWN": {
      await deps.prisma.$transaction(async (tx) => {
        await settle(tx, refundId, "RECONCILIATION_REQUIRED", {}, now);
        await recordAuditEvent(tx, {
          transactionId: transaction.id,
          action: "refund_unresolved",
          actor: "payment_provider",
          result: "PENDING",
          reasonCode: outcome.failure.category,
          correlationId: transaction.correlationId,
          operationKey: `refund_unresolved:${refundId}`,
          trustedInputs: { refundId, receipt },
        });
      });
      log.error("refund outcome unknown; reconciliation required", {
        transactionId: transaction.id,
      });
      return { kind: "RECONCILIATION_REQUIRED", refundId };
    }
  }
}

/**
 * Asks the provider where an open refund stands, by its receipt, and records
 * the answer. Read-only towards the provider: it can never create a refund.
 */
export async function reconcileRefund(
  transactionId: string,
  deps: RefundServiceDeps = defaultRefundDeps(),
): Promise<RefundStatus | null> {
  const refund = await deps.prisma.refund.findFirst({
    where: { transactionId, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      receipt: true,
      status: true,
      paymentAttempt: { select: { providerPaymentId: true } },
    },
  });
  if (refund === null) return null;
  const providerPaymentId = refund.paymentAttempt.providerPaymentId;
  if (providerPaymentId === null) return refund.status;

  const lookup = await deps.provider.findRefundByReceipt(
    providerPaymentId,
    refund.receipt,
  );
  if (lookup.kind === "FAILED") return refund.status;
  if (lookup.kind === "NOT_FOUND") {
    // Only an unresolved create can be concluded from absence: the provider
    // authoritatively holds no refund for this receipt, so none was made.
    if (refund.status !== "RECONCILIATION_REQUIRED" && refund.status !== "REQUESTED") {
      return refund.status;
    }
    await deps.prisma.$transaction(async (tx) => {
      const moved = await settle(
        tx,
        refund.id,
        "FAILED",
        { failureCode: "NOT_FOUND_AT_PROVIDER" },
        deps.clock.now(),
      );
      if (!moved) return;
      await recordAuditEvent(tx, {
        transactionId,
        action: "refund_failed",
        actor: "payment_provider",
        result: "FAILURE",
        reasonCode: "NOT_FOUND_AT_PROVIDER",
        operationKey: `refund_settled:${refund.id}`,
        trustedInputs: { refundId: refund.id, failureCode: "NOT_FOUND_AT_PROVIDER" },
      });
    });
    return "FAILED";
  }
  return applyProviderRefund(deps, {
    refundId: refund.id,
    transactionId,
    refund: lookup.refund,
    operationKey: `refund_settled:${refund.id}`,
  });
}

/**
 * Applies a refund event the provider pushed to us, inside the webhook's own
 * database transaction.
 *
 * Correlated by **our receipt** first - it is the one identifier we chose and
 * stored before the provider ever answered, so it matches even when the event
 * outruns our own record of the provider's refund id. The amount must equal
 * what we asked to return; anything else is recorded as a mismatch and changes
 * nothing.
 */
export async function applyRefundWebhook(
  tx: TransactionCapableClient,
  event: {
    readonly providerEventId: string;
    readonly eventType: "refund.processed" | "refund.failed";
    readonly refund: ProviderRefund;
    readonly now: Date;
  },
): Promise<
  | { readonly kind: "APPLIED" | "ALREADY_SETTLED"; readonly transactionId: string }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "MISMATCH"; readonly transactionId: string }
> {
  const row = await tx.refund.findFirst({
    where:
      event.refund.receipt === null
        ? { providerRefundId: event.refund.providerRefundId }
        : {
            OR: [
              { receipt: event.refund.receipt },
              { providerRefundId: event.refund.providerRefundId },
            ],
          },
    select: { id: true, transactionId: true, amount: true, currency: true },
  });
  if (row === null) return { kind: "NOT_FOUND" };
  if (row.amount !== event.refund.amountMinor || row.currency !== event.refund.currency) {
    return { kind: "MISMATCH", transactionId: row.transactionId };
  }

  const status: RefundStatus =
    event.eventType === "refund.processed" ? "PROCESSED" : "FAILED";
  const moved = await settle(
    tx,
    row.id,
    status,
    {
      providerRefundId: event.refund.providerRefundId,
      ...(status === "FAILED" ? { failureCode: "PROVIDER_REPORTED_FAILED" } : {}),
    },
    event.now,
  );
  if (!moved) return { kind: "ALREADY_SETTLED", transactionId: row.transactionId };

  await recordAuditEvent(tx, {
    transactionId: row.transactionId,
    action: status === "PROCESSED" ? "refund_processed" : "refund_failed",
    actor: "payment_webhook",
    result: status === "PROCESSED" ? "SUCCESS" : "FAILURE",
    reasonCode: status === "PROCESSED" ? "REFUND_PROCESSED" : "REFUND_FAILED",
    operationKey: `refund_settled:${row.id}`,
    trustedInputs: {
      refundId: row.id,
      providerRefundId: event.refund.providerRefundId,
      providerStatus: event.refund.status.slice(0, 64),
      providerEventId: event.providerEventId,
    },
  });
  return { kind: "APPLIED", transactionId: row.transactionId };
}

/** The most recent refund on a transaction, for the page. */
export async function readRefund(
  prisma: PrismaClient,
  transactionId: string,
): Promise<RefundView | null> {
  const refund = await prisma.refund.findFirst({
    where: { transactionId },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      amount: true,
      currency: true,
      createdAt: true,
      processedAt: true,
    },
  });
  if (refund === null) return null;
  return {
    status: refund.status,
    amount: {
      amountMinor: refund.amount.toString(),
      currency: refund.currency as CurrencyCode,
    },
    requestedAt: refund.createdAt.toISOString(),
    processedAt: refund.processedAt?.toISOString() ?? null,
  };
}
