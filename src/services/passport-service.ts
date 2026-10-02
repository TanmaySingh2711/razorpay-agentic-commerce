import { assertServerOnly } from "@/lib/server-only";
import { MAX_PAYMENT_ATTEMPTS } from "@/domain/payment/retry";
import { buildSafetyPassport, countPassportEvidence } from "@/domain/safety/passport";
import type {
  PassportAttemptFact,
  PassportQuoteFact,
  PassportTimelineEntry,
  SafetyPassportFacts,
  SafetyPassportViewModel,
} from "@/domain/safety/passport";
import type { CurrencyCode } from "@/domain/money";
import type { PaymentFailureCategory } from "@/domain/payment/failure";
import type { PolicyDecisionKind } from "@/domain/policy/decision";
import type { RetryStatusDto } from "@/domain/payment/retry";
import type { TransactionState } from "@/domain/transaction/states";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The read half of the Safety Passport.
 *
 * Two responsibilities and no others: fetch the authoritative rows the passport
 * is entitled to speak about, and hand them to the pure builder. There is no
 * interpretation here — every claim is decided in `@/domain/safety/passport`,
 * where it can be tested without a database.
 *
 * ## Strictly read-only, like the overview it feeds
 *
 * Nothing in this file writes, transitions, reserves or authorizes. A page that
 * could move money by rendering would be a defect regardless of how good the
 * summary looked, so the passport's data source has no capacity to.
 *
 * ## No new table
 *
 * Deliberately zero schema change. The passport is a *view* of records that
 * Objectives 1–19 already made authoritative; a new table would be a second
 * place the truth lives, and the first time the two disagreed the passport
 * would be worse than useless — it would be confidently wrong.
 */
assertServerOnly("src/services/safety/passport-service.ts");

/** The extra rows the passport needs beyond what the overview already reads. */
export interface PassportRows {
  readonly quotes: readonly PassportQuoteFact[];
  /** The quote the trusted amount is taken from, or null when none exists. */
  readonly trustedQuote: PassportQuoteFact | null;
  readonly approvalStatuses: readonly string[];
  readonly reservationStatuses: readonly string[];
  readonly attempts: readonly PassportAttemptFact[];
}

/**
 * Quote statuses that can never be the transaction's trusted amount.
 *
 * A superseded quote is one a re-quote replaced, and an invalidated one is a
 * price the server withdrew. Neither is the number this purchase is about, and
 * showing either as the trusted amount would misreport a re-quoted retry as
 * still being about its old price.
 */
const NOT_TRUSTWORTHY: ReadonlySet<string> = new Set(["SUPERSEDED", "INVALIDATED"]);

/**
 * Reads every row the passport speaks about, in one round of parallel queries.
 *
 * Quotes are read in full rather than just the live one, because two of the
 * passport's claims are historical: whether a retry was re-quoted, and whether
 * every payment attempt carries an amount this transaction actually quoted.
 * Neither can be decided from the current quote alone.
 */
export async function readPassportRows(
  prisma: PrismaClient,
  transactionId: string,
): Promise<PassportRows> {
  const [quotes, approvals, reservations, attempts] = await Promise.all([
    prisma.purchaseQuote.findMany({
      where: { transactionId },
      orderBy: { createdAt: "desc" },
      select: { status: true, totalAmount: true, currency: true },
    }),
    prisma.approvalRequest.findMany({
      where: { transactionId },
      orderBy: { createdAt: "asc" },
      select: { status: true },
    }),
    prisma.inventoryReservation.findMany({
      where: { transactionId },
      orderBy: { createdAt: "asc" },
      select: { status: true },
    }),
    prisma.paymentAttempt.findMany({
      where: { transactionId },
      orderBy: { attemptNumber: "asc" },
      select: {
        attemptNumber: true,
        status: true,
        amount: true,
        currency: true,
        failureCategory: true,
      },
    }),
  ]);

  const quoteFacts: readonly PassportQuoteFact[] = quotes.map((quote) => ({
    status: quote.status,
    totalAmount: {
      amountMinor: quote.totalAmount.toString(),
      currency: quote.currency as CurrencyCode,
    },
  }));

  // Newest first, so the first live-looking quote is the current one. A
  // transaction whose every quote was superseded genuinely has no trusted
  // amount, and the passport says so rather than reaching for a withdrawn one.
  const trustedQuote =
    quoteFacts.find((quote) => quote.status === "ACTIVE") ??
    quoteFacts.find((quote) => !NOT_TRUSTWORTHY.has(quote.status)) ??
    null;

  return {
    quotes: quoteFacts,
    trustedQuote,
    approvalStatuses: approvals.map((approval) => approval.status),
    reservationStatuses: reservations.map((reservation) => reservation.status),
    attempts: attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      amount: {
        amountMinor: attempt.amount.toString(),
        currency: attempt.currency as CurrencyCode,
      },
      failureCategory: attempt.failureCategory as PaymentFailureCategory | null,
    })),
  };
}

export interface PassportAssembly {
  readonly transactionId: string;
  readonly state: TransactionState;
  readonly quoteUsable: boolean;
  readonly policyDecision: string | null;
  readonly policyReasonCode: string | null;
  readonly retry: RetryStatusDto | null;
  /** The transaction's merged audit and lifecycle history, already loaded. */
  readonly timeline: readonly PassportTimelineEntry[];
  readonly rows: PassportRows;
}

/** The three decisions the policy engine can return. Anything else is not one. */
const POLICY_DECISIONS: ReadonlySet<string> = new Set([
  "ALLOWED",
  "APPROVAL_REQUIRED",
  "BLOCKED",
]);

/**
 * Turns loaded rows into passport facts.
 *
 * Pure, and separate from the read above so a test can drive the whole mapping
 * without a database when the question is presentation rather than persistence.
 */
export function toSafetyPassportFacts(input: PassportAssembly): SafetyPassportFacts {
  const decision =
    input.policyDecision !== null && POLICY_DECISIONS.has(input.policyDecision)
      ? (input.policyDecision as PolicyDecisionKind)
      : null;

  return {
    transactionId: input.transactionId,
    state: input.state,
    trustedAmount: input.rows.trustedQuote?.totalAmount ?? null,
    trustedQuoteStatus: input.rows.trustedQuote?.status ?? null,
    quoteUsable: input.quoteUsable,
    quotes: input.rows.quotes,
    policyDecision: decision,
    policyReasonCode: input.policyReasonCode,
    approvalStatuses: input.rows.approvalStatuses,
    reservationStatuses: input.rows.reservationStatuses,
    attempts: input.rows.attempts,
    maxAttempts: input.retry?.maxAttempts ?? MAX_PAYMENT_ATTEMPTS,
    retryAvailable: input.retry?.available ?? null,
    retryDenial: input.retry?.denial ?? null,
    evidence: countPassportEvidence(input.timeline),
  };
}

/** Rows plus history in, finished passport out. */
export function assembleSafetyPassport(input: PassportAssembly): SafetyPassportViewModel {
  return buildSafetyPassport(toSafetyPassportFacts(input));
}
