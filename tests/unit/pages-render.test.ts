import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MerchantInsights } from "@/services/merchant-insights-service";
import type { TransactionOverview } from "@/services/transaction-overview-service";

/**
 * The two data-driven pages, rendered from fixed data.
 *
 * Both pages are server components that draw whatever their service returns,
 * and both contain real decisions: which action a purchase offers in each
 * state, whether a refund button or a refund status is shown, how unmet demand
 * is worded. Those decisions are asserted here against the markup, with the
 * services mocked at the module edge - the numbers themselves are proved
 * against PostgreSQL in `tests/db/`.
 */

const mocks = vi.hoisted(() => ({
  loadMerchantInsights: vi.fn(),
  loadTransactionOverview: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/services/merchant-insights-service", () => ({
  loadMerchantInsights: mocks.loadMerchantInsights,
}));
vi.mock("@/services/transaction-overview-service", () => ({
  loadTransactionOverview: mocks.loadTransactionOverview,
}));
// The pages only pass these to forms; nothing here submits one.
vi.mock("@/app/actions", () => ({
  approvePurchase: vi.fn(),
  rejectPurchase: vi.fn(),
  reserveStock: vi.fn(),
  refundPurchase: vi.fn(),
  checkRefundStatus: vi.fn(),
  submitRequest: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const TRANSACTION_ID = "01a068ee-b304-7756-83d6-3e709f3c1c37";
const inr = (amountMinor: string) => ({ amountMinor, currency: "INR" as const });

function insights(overrides: Partial<MerchantInsights> = {}): MerchantInsights {
  return {
    merchantName: "Keebworks India",
    windowDays: 30,
    generatedAt: "2026-10-01T10:00:00.000Z",
    currency: "INR",
    revenue: {
      capturedMinor: 1_399_400n,
      refundedMinor: 199_900n,
      netMinor: 1_199_500n,
      paidOrders: 6,
      averageOrderMinor: 233_233n,
    },
    funnel: [
      { label: "Asked the assistant", count: 19, ofTotal: 100 },
      { label: "Got a verified price", count: 8, ofTotal: 42 },
      { label: "Authorized to pay", count: 7, ofTotal: 37 },
      { label: "Paid", count: 6, ofTotal: 32 },
    ],
    outcomes: {
      PURCHASE_OPENED: 8,
      CLARIFICATION: 2,
      NO_MATCH: 7,
      NOT_A_PURCHASE: 1,
      REFUSED: 1,
      ERROR: 0,
      RATE_LIMITED: 0,
    },
    agent: {
      requests: 19,
      medianMs: 2_400,
      p90Ms: 4_700,
      averageModelCalls: 2.1,
      followUps: 1,
      followUpsConverted: 1,
    },
    unmet: [
      {
        category: "webcam",
        requests: 3,
        soldHere: false,
        medianBudgetMinor: 250_000n,
        cheapestMinor: null,
        belowCheapest: 0,
      },
      {
        category: "mouse",
        requests: 2,
        soldHere: true,
        medianBudgetMinor: 50_000n,
        cheapestMinor: 79_900n,
        belowCheapest: 2,
      },
    ],
    policy: {
      autoApproved: 6,
      approvalRequired: 2,
      approved: 1,
      rejected: 1,
      blocked: 0,
    },
    recovery: { withFailure: 1, recovered: 1, recoveredMinor: 239_900n },
    topProducts: [{ name: "Aurora TKL", orders: 1, revenueMinor: 249_900n }],
    recent: [
      {
        productName: "Volt Compact 60",
        amountMinor: 199_900n,
        state: "COMPLETED",
        refund: "PROCESSED",
        createdAt: "2026-10-01T09:00:00.000Z",
      },
      {
        productName: "Aurora TKL",
        amountMinor: null,
        state: "AUTHORIZED",
        refund: null,
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

async function merchantMarkup(data: MerchantInsights | null): Promise<string> {
  mocks.loadMerchantInsights.mockResolvedValueOnce(data);
  const { default: MerchantPage } = await import("@/app/merchant/page");
  return renderToStaticMarkup(await MerchantPage());
}

describe("the merchant insights page", () => {
  it("leads with net revenue: captured money less refunds", async () => {
    const markup = await merchantMarkup(insights());
    expect(markup).toContain("₹11,995.00");
    expect(markup).toContain("₹13,994.00 captured, ₹1,999.00 refunded");
    expect(markup).toContain("32%");
    expect(markup).toContain("2.4s");
  });

  it("words unmet demand as something a merchant can act on", async () => {
    const markup = await merchantMarkup(insights());
    expect(markup).toContain("Not in your catalog.");
    expect(markup).toContain(
      "2 wanted to spend less than your cheapest (₹799.00); the typical budget was ₹500.00.",
    );
  });

  it("gets singular and plural right in the follow-up sentence", async () => {
    expect(await merchantMarkup(insights())).toContain(
      "1 follow-up answer to a clarifying question; 1 of them became a purchase.",
    );
    expect(
      await merchantMarkup(
        insights({
          agent: {
            requests: 9,
            medianMs: 1,
            p90Ms: 2,
            averageModelCalls: null,
            followUps: 3,
            followUpsConverted: 2,
          },
        }),
      ),
    ).toContain(
      "3 follow-up answers to a clarifying question; 2 of them became purchases.",
    );
  });

  it("shows a refunded order as refunded, and an unpriced one without an amount", async () => {
    const markup = await merchantMarkup(insights());
    expect(markup).toMatch(/Volt Compact 60<\/td>.*?₹1,999\.00<\/td><td>Refunded/);
    expect(markup).toMatch(/Aurora TKL<\/td><td class="numeric">n\/a<\/td>/);
  });

  it("never prints a link to a purchase", async () => {
    const markup = await merchantMarkup(insights());
    expect(markup).not.toMatch(/\/shop\/[0-9a-f-]{36}|\/transaction\//);
  });

  it("stays useful with no activity at all", async () => {
    const markup = await merchantMarkup(
      insights({
        revenue: {
          capturedMinor: 0n,
          refundedMinor: 0n,
          netMinor: 0n,
          paidOrders: 0,
          averageOrderMinor: null,
        },
        funnel: [{ label: "Asked the assistant", count: 0, ofTotal: null }],
        agent: {
          requests: 0,
          medianMs: null,
          p90Ms: null,
          averageModelCalls: null,
          followUps: 0,
          followUpsConverted: 0,
        },
        unmet: [],
        topProducts: [],
        recent: [],
        recovery: { withFailure: 0, recovered: 0, recoveredMinor: 0n },
      }),
    );
    expect(markup).toContain("₹0.00");
    expect(markup).toContain("No unmatched requests yet.");
    expect(markup).not.toContain("Best sellers through the assistant");
    expect(markup).not.toContain("NaN");
  });

  it("says so plainly when the catalog was never seeded", async () => {
    expect(await merchantMarkup(null)).toContain("No merchant yet");
  });
});

function overview(overrides: Partial<TransactionOverview> = {}): TransactionOverview {
  return {
    transactionId: TRANSACTION_ID,
    state: "COMPLETED",
    createdAt: "2026-10-01T09:00:00.000Z",
    quote: {
      id: "quote-1",
      transactionId: TRANSACTION_ID,
      productId: "product-1",
      quantity: 1,
      unitAmount: inr("249900"),
      totalAmount: inr("249900"),
      currency: "INR",
      productVersion: 1,
      status: "CONSUMED",
      createdAt: "2026-10-01T09:00:00.000Z",
      expiresAt: "2026-10-01T09:05:00.000Z",
    },
    quoteUsable: true,
    product: {
      name: "Aurora TKL Mechanical Keyboard",
      quantity: 1,
      unitAmount: inr("249900"),
      attributes: { layout: "tkl-87" },
    },
    policy: {
      decision: "ALLOWED",
      reasonCode: "WITHIN_AUTO_APPROVE_LIMIT",
      autoApproveLimit: inr("300000"),
    },
    reservationStatus: "COMMITTED",
    reservationExpiresAt: null,
    reservationHeld: false,
    retry: null,
    timeline: [],
    passport: {
      transactionId: TRANSACTION_ID,
      title: "Agentic Purchase Safety Passport",
      subtitle: "Why this AI-assisted purchase was allowed to move forward.",
      aiAuthority: { label: "AI authority", value: "Product proposal only", note: "n" },
      financialAuthority: { label: "Financial authority", value: "Server", note: "n" },
      priceSource: "Price source: server-verified merchant data.",
      checks: [],
      retry: null,
      properties: [],
    },
    selection: {
      eligibleCount: 3,
      candidatesConsidered: 7,
      alternatives: [
        { name: "Volt Compact 60", unitAmount: inr("199900") },
        { name: "Nimbus 65", unitAmount: inr("289900") },
        { name: "Twin Price", unitAmount: inr("249900") },
      ],
      reasons: ["MATCHES_CATEGORY", "WITHIN_BUDGET", "IN_STOCK"],
      substituted: false,
      agent: {
        modelCalls: 2,
        toolCalls: 0,
        productsObserved: 7,
        durationMs: 3_912,
        turn: 1,
      },
    },
    refund: null,
    ...overrides,
  };
}

async function transactionMarkup(data: TransactionOverview | null): Promise<string> {
  mocks.loadTransactionOverview.mockResolvedValueOnce(data);
  const { default: TransactionPage } = await import("@/app/shop/[transactionId]/page");
  return renderToStaticMarkup(
    await TransactionPage({ params: Promise.resolve({ transactionId: TRANSACTION_ID }) }),
  );
}

describe("the purchase page offers exactly the action its state allows", () => {
  it("asks for a decision when approval is required, and nothing else", async () => {
    const markup = await transactionMarkup(
      overview({ state: "APPROVAL_REQUIRED", reservationStatus: null }),
    );
    expect(markup).toContain("Approve this purchase");
    expect(markup).toContain(">Reject<");
    expect(markup).not.toContain("Hold it for me");
    expect(markup).not.toContain("Refund this purchase");
  });

  it("offers to hold the item once authorized", async () => {
    const markup = await transactionMarkup(
      overview({ state: "AUTHORIZED", reservationStatus: null }),
    );
    expect(markup).toContain("Hold it for me");
    expect(markup).not.toContain("Approve this purchase");
  });

  it("refuses to offer Pay when the hold or the price is gone", async () => {
    const markup = await transactionMarkup(
      overview({
        state: "INVENTORY_RESERVED",
        reservationHeld: false,
        quoteUsable: false,
      }),
    );
    expect(markup).toContain("no longer held for you");
    expect(markup).not.toContain("Refund this purchase");
  });

  it("says why a retry is not available when every attempt is used", async () => {
    const markup = await transactionMarkup(
      overview({
        state: "PAYMENT_FAILED",
        retry: {
          transactionId: TRANSACTION_ID,
          transactionState: "PAYMENT_FAILED",
          attemptsUsed: 3,
          maxAttempts: 3,
          remaining: 0,
          available: false,
          denial: "ATTEMPT_LIMIT_REACHED",
          lastFailure: null,
        } as unknown as TransactionOverview["retry"],
      }),
    );
    expect(markup).toContain("Payment attempt 3 of 3 used.");
    expect(markup).toContain("You have used every payment attempt");
  });

  it("answers an unknown purchase with not-found", async () => {
    await expect(transactionMarkup(null)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("refunds on the purchase page", () => {
  it("offers a refund on a completed purchase that has none", async () => {
    const markup = await transactionMarkup(overview());
    expect(markup).toContain("Changed your mind?");
    expect(markup).toContain("Refund this purchase");
  });

  it("does not offer one before the purchase completed", async () => {
    const markup = await transactionMarkup(overview({ state: "PAYMENT_PENDING" }));
    expect(markup).not.toContain("Refund this purchase");
  });

  it("shows a processed refund as done, with no button left to press", async () => {
    const markup = await transactionMarkup(
      overview({
        refund: {
          status: "PROCESSED",
          amount: inr("249900"),
          requestedAt: "2026-10-01T09:30:00.000Z",
          processedAt: "2026-10-01T09:30:02.000Z",
        },
      }),
    );
    expect(markup).toContain(
      "The money has been returned to the original payment method.",
    );
    expect(markup).not.toContain("Refund this purchase");
    expect(markup).not.toContain("Check refund status");
  });

  it.each(["PENDING", "RECONCILIATION_REQUIRED", "REQUESTED"] as const)(
    "offers a status check, never a second refund, while one is %s",
    async (status) => {
      const markup = await transactionMarkup(
        overview({
          refund: {
            status,
            amount: inr("249900"),
            requestedAt: "2026-10-01T09:30:00.000Z",
            processedAt: null,
          },
        }),
      );
      expect(markup).toContain("Check refund status");
      expect(markup).not.toContain("Refund this purchase");
    },
  );

  it("lets the buyer try again after a failed refund", async () => {
    const markup = await transactionMarkup(
      overview({
        refund: {
          status: "FAILED",
          amount: inr("249900"),
          requestedAt: "2026-10-01T09:30:00.000Z",
          processedAt: null,
        },
      }),
    );
    expect(markup).toContain("could not process this refund");
    expect(markup).toContain("Refund this purchase");
  });
});

describe("the purchase page's place in the site", () => {
  it("is part of the Shop: the header marks Shop as the current page", async () => {
    const markup = await transactionMarkup(overview());
    expect(markup).toMatch(
      /<a class="nav-link"[^>]*href="\/shop"[^>]*aria-current="page"|<a class="nav-link"[^>]*aria-current="page"[^>]*href="\/shop"/,
    );
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe("the purchase page's copy", () => {
  it.each([
    ["APPROVAL_REQUIRED", { state: "APPROVAL_REQUIRED", reservationStatus: null }],
    ["AUTHORIZED", { state: "AUTHORIZED", reservationStatus: null }],
    ["COMPLETED", {}],
  ] as const)(
    "has no em or en dash, arrow or ellipsis character when %s",
    async (_state, overrides) => {
      const markup = (
        await transactionMarkup(overview(overrides as Partial<TransactionOverview>))
      ).replace(/<svg[\s\S]*?<\/svg>/g, "");
      expect(markup).not.toMatch(/[–—…←-⇿]/);
    },
  );
});

describe("how the assistant chose", () => {
  it("compares each alternative with the chosen price", async () => {
    const markup = await transactionMarkup(overview());
    expect(markup).toContain("₹500.00 less");
    expect(markup).toContain("₹400.00 more");
    expect(markup).toContain("same price");
    expect(markup).toContain("3.9s");
    expect(markup).toContain("the category you asked for, your budget, being in stock");
  });

  it("says when it was the only option, and when the server substituted", async () => {
    const only = await transactionMarkup(
      overview({
        selection: {
          eligibleCount: 1,
          candidatesConsidered: 4,
          alternatives: [],
          reasons: [],
          substituted: true,
          agent: null,
        },
      }),
    );
    expect(only).toContain("No other product met every rule");
    expect(only).toContain("out of stock, so the server chose");
    // No trace recorded: no row of invented numbers.
    expect(only).not.toContain("Model calls");
  });

  it("is absent before a product was selected", async () => {
    const markup = await transactionMarkup(
      overview({ state: "INTENT_RECEIVED", selection: null, product: null, quote: null }),
    );
    expect(markup).not.toContain("How the assistant chose");
    expect(markup).not.toContain("Verified price");
  });
});
