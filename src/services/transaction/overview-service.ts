import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { getTransactionAuditHistory } from "@/services/audit/audit-service";
import { readActiveQuote } from "@/services/quote/quote-reader";
import { readRecordedEvaluation } from "@/services/policy/policy-reader";
import { readRetryStatus } from "@/services/payment/retry-service";
import { toQuoteDto } from "@/domain/quote/rules";
import type { AuditTimelineEntry } from "@/services/audit/audit-service";
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
  /** Server-computed. The page never works out retry eligibility itself. */
  readonly retry: RetryStatusDto | null;
  readonly timeline: readonly AuditTimelineEntry[];
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
  const [active, evaluation, reservation, retry, timeline] = await Promise.all([
    readActiveQuote(deps.prisma, transactionId, now),
    readRecordedEvaluation(deps.prisma, transactionId),
    deps.prisma.inventoryReservation.findFirst({
      where: { transactionId },
      orderBy: { createdAt: "desc" },
      select: { status: true, expiresAt: true },
    }),
    readRetryStatus(transactionId, { prisma: deps.prisma, clock: deps.clock }),
    getTransactionAuditHistory(transactionId, { prisma: deps.prisma }),
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

  return {
    transactionId: transaction.id,
    state: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
    quote,
    quoteUsable: active?.usability.kind === "VALID",
    product,
    policy:
      evaluation.kind === "FOUND"
        ? {
            decision: evaluation.evaluation.decision,
            reasonCode: evaluation.evaluation.reasonCode,
            autoApproveLimit: {
              amountMinor: evaluation.evaluation.autoApproveLimitMinor.toString(),
              currency: quote?.currency ?? "INR",
            },
          }
        : null,
    reservationStatus: reservation?.status ?? null,
    reservationExpiresAt: reservation?.expiresAt.toISOString() ?? null,
    retry,
    timeline,
  };
}
