import { assertServerOnly } from "@/lib/server-only";
import { systemClock, type Clock } from "@/lib/clock";
import { getCatalogConfig } from "@/lib/env";
import { getPrismaClient } from "@/integrations/prisma-client";
import { AGENT_REQUEST_OUTCOMES } from "@/domain/agent-request";
import {
  buildFunnel,
  countOutcomes,
  median,
  percentile,
  unmetDemand,
  type FunnelStage,
  type UnmetDemand,
} from "@/domain/insights";
import type { AgentRequestOutcome } from "@/domain/agent-request";
import type { RefundStatus } from "@/domain/refund";
import type { TransactionState } from "@/domain/transaction/states";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The merchant's view of agentic commerce: what shoppers asked the agent for,
 * what it turned into, and what the merchant could change to sell more.
 *
 * Read-only, aggregate and identity-free. Nothing here writes, and nothing it
 * returns names a buyer, a transaction id or a sentence anybody typed: the
 * page it feeds is public in this demo, so it shows counts, amounts and
 * product names - the things a merchant's own storefront already shows.
 *
 * Every money figure is read from a row that proves it: revenue is captured
 * PaymentAttempts, refunds are PROCESSED Refund rows. A quote nobody paid is
 * not revenue, and an agent's opinion of a price appears nowhere.
 */
assertServerOnly("src/services/merchant-insights-service.ts");

/** The look-back window the dashboard reports on. */
export const INSIGHT_WINDOW_DAYS = 30;

/** Upper bound on rows read per query, so a busy day cannot make this page slow. */
const MAX_ROWS = 5_000;

export interface MerchantInsightsDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly merchantSlug: string;
}

export function defaultMerchantInsightsDeps(): MerchantInsightsDeps {
  return {
    prisma: getPrismaClient(),
    clock: systemClock,
    merchantSlug: getCatalogConfig().CATALOG_MERCHANT_SLUG,
  };
}

export interface RecentOrder {
  readonly productName: string;
  readonly amountMinor: bigint | null;
  readonly state: TransactionState;
  readonly refund: RefundStatus | null;
  readonly createdAt: string;
}

export interface MerchantInsights {
  readonly merchantName: string;
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly currency: "INR";
  readonly revenue: {
    readonly capturedMinor: bigint;
    readonly refundedMinor: bigint;
    readonly netMinor: bigint;
    readonly paidOrders: number;
    readonly averageOrderMinor: bigint | null;
  };
  readonly funnel: readonly FunnelStage[];
  readonly outcomes: Readonly<Record<AgentRequestOutcome, number>>;
  readonly agent: {
    readonly requests: number;
    readonly medianMs: number | null;
    readonly p90Ms: number | null;
    /** Average model round trips per request, to one decimal. */
    readonly averageModelCalls: number | null;
    /** Requests that were follow-up answers to a clarifying question. */
    readonly followUps: number;
    /** Of those follow-ups, how many opened a purchase. */
    readonly followUpsConverted: number;
  };
  readonly unmet: readonly UnmetDemand[];
  readonly policy: {
    readonly autoApproved: number;
    readonly approvalRequired: number;
    readonly approved: number;
    readonly rejected: number;
    readonly blocked: number;
  };
  readonly recovery: {
    /** Purchases that had at least one failed payment attempt. */
    readonly withFailure: number;
    /** Of those, how many were paid on a later attempt. */
    readonly recovered: number;
    readonly recoveredMinor: bigint;
  };
  readonly topProducts: readonly {
    readonly name: string;
    readonly orders: number;
    readonly revenueMinor: bigint;
  }[];
  readonly recent: readonly RecentOrder[];
}

/** Returns null when the configured merchant does not exist (an unseeded database). */
export async function loadMerchantInsights(
  deps: MerchantInsightsDeps = defaultMerchantInsightsDeps(),
): Promise<MerchantInsights | null> {
  const { prisma } = deps;
  const merchant = await prisma.merchant.findUnique({
    where: { slug: deps.merchantSlug },
    select: { id: true, name: true },
  });
  if (merchant === null) return null;

  const now = deps.clock.now();
  const since = new Date(now.getTime() - INSIGHT_WINDOW_DAYS * 86_400_000);
  const inWindow = { merchantId: merchant.id, createdAt: { gte: since } };

  const [
    requests,
    captured,
    failedAttempts,
    refunds,
    authorizedTransitions,
    policyCounts,
    cheapest,
    recentRows,
  ] = await Promise.all([
    prisma.agentRequest.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        outcome: true,
        category: true,
        maxBudgetMinor: true,
        durationMs: true,
        modelCalls: true,
        turn: true,
      },
    }),
    prisma.paymentAttempt.findMany({
      where: { status: "CAPTURED", transaction: inWindow },
      take: MAX_ROWS,
      select: {
        amount: true,
        transactionId: true,
        // The product lives on the quote: a transaction is priced, and named,
        // by the quote it was paid against.
        transaction: {
          select: {
            quotes: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { product: { select: { name: true } } },
            },
          },
        },
      },
    }),
    prisma.paymentAttempt.findMany({
      where: { status: "FAILED", transaction: inWindow },
      take: MAX_ROWS,
      select: { transactionId: true },
    }),
    prisma.refund.findMany({
      where: { status: "PROCESSED", transaction: inWindow },
      take: MAX_ROWS,
      select: { amount: true },
    }),
    prisma.transactionStateTransition.findMany({
      where: { toStatus: "AUTHORIZED", transaction: inWindow },
      distinct: ["transactionId"],
      take: MAX_ROWS,
      select: { transactionId: true },
    }),
    Promise.all(
      (
        [
          "POLICY_ALLOWED",
          "POLICY_REQUIRES_APPROVAL",
          "APPROVAL_GRANTED",
          "APPROVAL_REJECTED",
          "POLICY_BLOCKED",
        ] as const
      ).map((reasonCode) =>
        prisma.transactionStateTransition.count({
          where: { reasonCode, transaction: inWindow },
        }),
      ),
    ),
    prisma.product.groupBy({
      by: ["category"],
      where: { merchantId: merchant.id, status: "AVAILABLE", inventory: { gt: 0 } },
      _min: { unitAmount: true },
    }),
    prisma.transaction.findMany({
      where: { ...inWindow, quotes: { some: {} } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        status: true,
        createdAt: true,
        quotes: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { totalAmount: true, product: { select: { name: true } } },
        },
        refunds: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
      },
    }),
  ]);

  // --- Revenue: captured money, less money actually returned. ---
  const capturedMinor = captured.reduce((sum, attempt) => sum + attempt.amount, 0n);
  const refundedMinor = refunds.reduce((sum, refund) => sum + refund.amount, 0n);
  const paidTransactions = new Set(captured.map((attempt) => attempt.transactionId));

  // --- The agent's requests. ---
  const answered = requests.filter((request) => request.outcome !== "RATE_LIMITED");
  const modelCalls = answered
    .map((request) => request.modelCalls)
    .filter((calls): calls is number => calls !== null);
  const followUps = answered.filter((request) => request.turn > 1);

  // --- Payment recovery: failed at least once, captured in the end. ---
  const failedTransactions = new Set(
    failedAttempts.map((attempt) => attempt.transactionId),
  );
  const recoveredAttempts = captured.filter((attempt) =>
    failedTransactions.has(attempt.transactionId),
  );

  // --- Best sellers by captured revenue. ---
  const byProduct = new Map<string, { orders: number; revenueMinor: bigint }>();
  for (const attempt of captured) {
    const name = attempt.transaction.quotes[0]?.product.name ?? "Unknown product";
    const entry = byProduct.get(name) ?? { orders: 0, revenueMinor: 0n };
    byProduct.set(name, {
      orders: entry.orders + 1,
      revenueMinor: entry.revenueMinor + attempt.amount,
    });
  }

  const cheapestByCategory = new Map<string, bigint>();
  for (const row of cheapest) {
    if (row._min.unitAmount !== null) {
      cheapestByCategory.set(row.category, row._min.unitAmount);
    }
  }

  const [autoApproved, approvalRequired, approved, rejected, blocked] = policyCounts;

  return {
    merchantName: merchant.name,
    windowDays: INSIGHT_WINDOW_DAYS,
    generatedAt: now.toISOString(),
    currency: "INR",
    revenue: {
      capturedMinor,
      refundedMinor,
      netMinor: capturedMinor - refundedMinor,
      paidOrders: paidTransactions.size,
      averageOrderMinor:
        paidTransactions.size === 0
          ? null
          : capturedMinor / BigInt(paidTransactions.size),
    },
    funnel: buildFunnel([
      { label: "Asked the assistant", count: answered.length },
      {
        label: "Got a verified price",
        count: answered.filter((request) => request.outcome === "PURCHASE_OPENED").length,
      },
      { label: "Authorized to pay", count: authorizedTransitions.length },
      { label: "Paid", count: paidTransactions.size },
    ]),
    outcomes: countOutcomes(
      requests.map((request) => request.outcome),
      AGENT_REQUEST_OUTCOMES,
    ),
    agent: {
      requests: answered.length,
      medianMs: median(answered.map((request) => request.durationMs)),
      p90Ms: percentile(
        answered.map((request) => request.durationMs),
        90,
      ),
      averageModelCalls:
        modelCalls.length === 0
          ? null
          : Math.round((modelCalls.reduce((a, b) => a + b, 0) / modelCalls.length) * 10) /
            10,
      followUps: followUps.length,
      followUpsConverted: followUps.filter(
        (request) => request.outcome === "PURCHASE_OPENED",
      ).length,
    },
    unmet: unmetDemand(
      answered
        .filter((request) => request.outcome === "NO_MATCH")
        .map((request) => ({
          category: request.category,
          maxBudgetMinor: request.maxBudgetMinor,
        })),
      cheapestByCategory,
    ),
    policy: {
      autoApproved: autoApproved ?? 0,
      approvalRequired: approvalRequired ?? 0,
      approved: approved ?? 0,
      rejected: rejected ?? 0,
      blocked: blocked ?? 0,
    },
    recovery: {
      withFailure: failedTransactions.size,
      recovered: new Set(recoveredAttempts.map((attempt) => attempt.transactionId)).size,
      recoveredMinor: recoveredAttempts.reduce(
        (sum, attempt) => sum + attempt.amount,
        0n,
      ),
    },
    topProducts: [...byProduct.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) =>
        a.revenueMinor === b.revenueMinor
          ? a.name.localeCompare(b.name)
          : a.revenueMinor > b.revenueMinor
            ? -1
            : 1,
      )
      .slice(0, 5),
    recent: recentRows.map((row) => ({
      productName: row.quotes[0]?.product.name ?? "Unknown product",
      amountMinor: row.quotes[0]?.totalAmount ?? null,
      state: row.status,
      refund: row.refunds[0]?.status ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
