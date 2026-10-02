import type { MoneyDto } from "@/domain/money";

/**
 * Refunds: returning the money for a purchase that completed.
 *
 * The authoritative status list lives here; the `refund_status` database enum
 * mirrors it and `tests/db/enum-parity.test.ts` fails the build on drift.
 *
 * ## Who may ask
 *
 * Only the buyer, by pressing a button, through a server action. There is no
 * agent tool for it and there never should be: returning money is a financial
 * decision exactly like spending it, and the AI's single permitted action is
 * proposing a product. The amount is never an input either - it is copied from
 * the captured payment attempt, so a refund cannot be larger, smaller or in a
 * different currency than what was actually charged.
 */
export const REFUND_STATUSES = [
  "REQUESTED",
  "PENDING",
  "PROCESSED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Why a refund was not started. Closed, so the page can say something useful. */
export const REFUND_DENIALS = [
  /** Only a completed purchase has money to return. */
  "NOT_COMPLETED",
  /** No captured payment attempt carries a provider payment id. */
  "NO_CAPTURED_PAYMENT",
  /** More than one attempt captured - an anomaly a person must resolve. */
  "MULTIPLE_CAPTURES",
  /** A refund exists and has not failed. */
  "ALREADY_REFUNDED",
  /** The merchant's refund window has passed. */
  "WINDOW_CLOSED",
] as const;

export type RefundDenial = (typeof REFUND_DENIALS)[number];

/** The facts eligibility is decided from - all read from persisted rows. */
export interface RefundFacts {
  readonly transactionStatus: string;
  readonly completedAt: Date | null;
  readonly capturedAttempts: readonly {
    readonly id: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly providerPaymentId: string | null;
  }[];
  /** Statuses of every refund row for this transaction. */
  readonly refundStatuses: readonly RefundStatus[];
  readonly windowDays: number;
  readonly now: Date;
}

export type RefundAssessment =
  | {
      readonly kind: "ELIGIBLE";
      readonly paymentAttemptId: string;
      readonly providerPaymentId: string;
      readonly amountMinor: bigint;
      readonly currency: string;
    }
  | { readonly kind: "DENIED"; readonly denial: RefundDenial };

/**
 * Decides whether a refund may start. Pure and total.
 *
 * The order of the checks is the order of the questions a person would ask:
 * did it complete, was money taken exactly once, has it already been given
 * back, and is it still within the window.
 */
export function assessRefund(facts: RefundFacts): RefundAssessment {
  if (facts.transactionStatus !== "COMPLETED") {
    return { kind: "DENIED", denial: "NOT_COMPLETED" };
  }
  const captured = facts.capturedAttempts.filter(
    (attempt) => attempt.providerPaymentId !== null,
  );
  if (captured.length === 0) return { kind: "DENIED", denial: "NO_CAPTURED_PAYMENT" };
  if (captured.length > 1) return { kind: "DENIED", denial: "MULTIPLE_CAPTURES" };

  if (facts.refundStatuses.some((status) => status !== "FAILED")) {
    return { kind: "DENIED", denial: "ALREADY_REFUNDED" };
  }

  const completedAt = facts.completedAt;
  if (
    completedAt === null ||
    facts.now.getTime() - completedAt.getTime() > facts.windowDays * 86_400_000
  ) {
    return { kind: "DENIED", denial: "WINDOW_CLOSED" };
  }

  const [attempt] = captured;
  if (attempt === undefined || attempt.providerPaymentId === null) {
    return { kind: "DENIED", denial: "NO_CAPTURED_PAYMENT" };
  }
  return {
    kind: "ELIGIBLE",
    paymentAttemptId: attempt.id,
    providerPaymentId: attempt.providerPaymentId,
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
  };
}

/** One sentence per denial, for the buyer. Never a code. */
export function describeRefundDenial(denial: RefundDenial): string {
  switch (denial) {
    case "NOT_COMPLETED":
      return "Only a completed purchase can be refunded.";
    case "NO_CAPTURED_PAYMENT":
      return "There is no captured payment on this purchase to refund.";
    case "MULTIPLE_CAPTURES":
      return "This purchase needs a person to review its payments before any refund.";
    case "ALREADY_REFUNDED":
      return "A refund for this purchase already exists.";
    case "WINDOW_CLOSED":
      return "The refund window for this purchase has closed.";
  }
}

/** A refund as the transaction page shows it. */
export interface RefundView {
  readonly status: RefundStatus;
  readonly amount: MoneyDto;
  readonly requestedAt: string;
  readonly processedAt: string | null;
}

/** Plain words for each status. */
export function describeRefundStatus(status: RefundStatus): string {
  switch (status) {
    case "REQUESTED":
      return "Your refund has been recorded and is being sent to the payment provider.";
    case "PENDING":
      return "The payment provider accepted the refund and is returning the money.";
    case "PROCESSED":
      return "The money has been returned to the original payment method.";
    case "FAILED":
      return "The payment provider could not process this refund. You can try again.";
    case "RECONCILIATION_REQUIRED":
      return "We could not confirm the refund with the payment provider yet. It will not be sent twice; it is being checked.";
  }
}

/**
 * Our refund reference: stable, unique, and the provider's idempotency key.
 *
 * Derived from the transaction and the refund's ordinal rather than generated,
 * so two concurrent requests for the same refund compute the *same* receipt
 * and the database's unique index lets exactly one of them exist. `rf_` plus a
 * 32-character id plus `_n` stays inside the 40-character column and
 * Razorpay's own receipt limit.
 */
export function refundReceiptFor(transactionId: string, ordinal: number): string {
  return `rf_${transactionId.replace(/-/g, "")}_${String(ordinal)}`.slice(0, 40);
}
