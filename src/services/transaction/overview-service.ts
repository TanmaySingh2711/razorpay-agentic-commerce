import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { getTransactionAuditHistory } from "@/services/audit/audit-service";
import { readActiveQuote } from "@/services/quote/quote-reader";
import { readRecordedEvaluation } from "@/services/policy/policy-reader";
import { readRetryStatus } from "@/services/payment/retry-service";
import {
  assembleSafetyPassport,
  readPassportRows,
} from "@/services/safety/passport-service";
import { toQuoteDto } from "@/domain/quote/rules";
import type { AuditTimelineEntry } from "@/services/audit/audit-service";
import type { SafetyPassportViewModel } from "@/domain/safety/passport";
import type { PrismaClient } from "@/generated/prisma/client";
import type { QuoteDto } from "@/domain/quote/rules";
import type { RetryStatusDto } from "@/domain/payment/retry";
import type { TransactionState } from "@/domain/transaction/states";
import type { MoneyDto } from "@/domain/money";

/**
 * Everything one page needs to show a purchase, read in one place.
 *
 * The transaction page is a server component, so it could reach for each of
 * these services itself. Gathering them here instead does three things worth
 * the file.
 *
 * It keeps the page **presentational**. A component that assembles its own data
 * from six services gradually acquires opinions about them, and opinions about
 * financial state belong in services, not in JSX.
 *
 * It makes the read **testable without a browser**. Everything a buyer sees is
 * derived from this one value, so a test can assert what a page will say by
 * asserting what this returns.
 *
 * And it is **strictly read-only**. Nothing here writes, transitions, reserves
 * or authorizes. Rendering a page must never be able to move money, and the
 * cheapest way to guarantee that is for the page's data source to have no
 * capacity to.
 */

export interface OverviewProduct {
  readonly name: string;
  readonly quantity: number;
  readonly unitAmount: MoneyDto;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface OverviewPolicy {
  readonly decision: string;
  readonly reasonCode: string;
  readonly autoApproveLimit: MoneyDto | null;
}

export interface TransactionOverview {
  readonly transactionId: string;
  readonly state: TransactionState;
  readonly createdAt: string;
  /** The server's frozen price. Null before a quote exists, or once superseded. */
  readonly quote: QuoteDto | null;
  /** True when that quote can still be used right now. */
  readonly quoteUsable: boolean;
  readonly product: OverviewProduct | null;
  readonly policy: OverviewPolicy | null;
  /** ACTIVE, RELEASED, COMMITTED or EXPIRED - whatever the hold actually is. */
  readonly reservationStatus: string | null;
  readonly reservationExpiresAt: string | null;
  /**
   * True only when the reservation both reads ACTIVE and has not yet reached
   * its own `expiresAt`, judged against this read's own clock.
   *
   * `reservationStatus` alone is not enough for a page to decide whether Pay
   * can legally proceed: expiry is swept lazily, by the next reservation
   * attempt for the same product, not by this read, so a lapsed hold can still
   * carry the column value ACTIVE for a while. This field is what makes the
   * page's own idea of "still held" agree with what `createPaymentOrder` and
   * `startCheckout` will actually accept, rather than a page computing that
   * itself with its own clock read.
   */
  readonly reservationHeld: boolean;
  /** Server-computed. The page never works out retry eligibility itself. */
  readonly retry: RetryStatusDto | null;
  readonly timeline: readonly AuditTimelineEntry[];
  /**
   * The reviewer-facing safety summary, derived from everything above plus the
   * transaction's quotes, approvals, holds and payment attempts.
   *
   * Built here rather than in the page for the same reason as the rest of this
   * value: a claim about whether a purchase was safe is a business judgement,
   * and business judgements do not belong in JSX. It is derived, never stored,
   * and no part of it comes from a language model.
   */
  readonly passport: SafetyPassportViewModel;
}

export interface OverviewDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
}

export function defaultOverviewDeps(): OverviewDeps {
  return { prisma: getPrismaClient(), clock: systemClock };
}

/** Only the attribute values that are safe and useful to render as text. */
function readableAttributes(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw);
    }
  }
  return out;
}

/**
 * Loads one transaction for display, or null when there is no such transaction.
 *
 * Null rather than a throw, and deliberately the same null an unknown id
 * produces: a page that distinguished "no such transaction" from "not yours"
 * would be an oracle for guessing ids.
 */
export async function loadTransactionOverview(
  transactionId: string,
  deps: OverviewDeps = defaultOverviewDeps(),
): Promise<TransactionOverview | null> {
  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true, createdAt: true },
  });
  if (transaction === null) return null;

  const now = deps.clock.now();
  const [active, evaluation, reservation, retry, timeline, passportRows] =
    await Promise.all([
      readActiveQuote(deps.prisma, transactionId, now),
      readRecordedEvaluation(deps.prisma, transactionId),
      deps.prisma.inventoryReservation.findFirst({
        where: { transactionId },
        orderBy: { createdAt: "desc" },
        select: { status: true, expiresAt: true },
      }),
      readRetryStatus(transactionId, { prisma: deps.prisma, clock: deps.clock }),
      getTransactionAuditHistory(transactionId, { prisma: deps.prisma }),
      // Runs alongside the rest rather than after it: the passport reads
      // different tables from everything above, so it costs no extra latency.
      readPassportRows(deps.prisma, transactionId),
    ]);

  const quote = active === null ? null : toQuoteDto(active.snapshot);

  // The quote snapshot deliberately carries no product name or attributes: it
  // freezes money, not marketing copy. The descriptive fields are read here,
  // separately, and are display-only - the amount shown to the buyer still
  // comes from the frozen quote and never from this row.
  const row =
    active === null
      ? null
      : await deps.prisma.product.findUnique({
          where: { id: active.snapshot.productId },
          select: { name: true, attributes: true },
        });

  const product =
    active === null
      ? null
      : {
          name: row?.name ?? "This item",
          quantity: active.snapshot.quantity,
          unitAmount: {
            amountMinor: active.snapshot.unitAmountMinor.toString(),
            currency: active.snapshot.currency,
          },
          attributes: readableAttributes(row?.attributes),
        };

  const policy: OverviewPolicy | null =
    evaluation.kind === "FOUND"
      ? {
          decision: evaluation.evaluation.decision,
          reasonCode: evaluation.evaluation.reasonCode,
          autoApproveLimit: {
            amountMinor: evaluation.evaluation.autoApproveLimitMinor.toString(),
            currency: quote?.currency ?? "INR",
          },
        }
      : null;

  const quoteUsable = active?.usability.kind === "VALID";

  return {
    transactionId: transaction.id,
    state: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
    quote,
    quoteUsable,
    product,
    policy,
    reservationStatus: reservation?.status ?? null,
    reservationExpiresAt: reservation?.expiresAt.toISOString() ?? null,
    reservationHeld:
      reservation !== null &&
      reservation.status === "ACTIVE" &&
      reservation.expiresAt.getTime() > now.getTime(),
    retry,
    timeline,
    passport: assembleSafetyPassport({
      transactionId: transaction.id,
      state: transaction.status,
      quoteUsable,
      policyDecision: policy?.decision ?? null,
      policyReasonCode: policy?.reasonCode ?? null,
      retry,
      timeline,
      rows: passportRows,
    }),
  };
}
