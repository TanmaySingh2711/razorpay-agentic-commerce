import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadMerchantInsights } from "@/services/insights/merchant-insights-service";
import { recordAgentRequest } from "@/services/insights/agent-request-log";
import { fixedClock } from "@/lib/clock";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
import {
  createBaseFixture,
  createQuote,
  createTransaction,
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
  uid,
  type BaseFixture,
} from "./harness";

/**
 * The merchant dashboard's numbers, against real PostgreSQL.
 *
 * What matters: revenue is captured money less processed refunds - never a
 * quote nobody paid - and nothing that identifies a buyer or a purchase ever
 * leaves the service, because the page it feeds is public in this demo.
 */

let fixture: BaseFixture;
let merchantSlug = "";

function noMatch(category: string, budgetMinor: bigint | null): BuyerAgentDecision {
  return {
    kind: "NO_MATCH",
    correlationId: uid("corr"),
    reasonCodes: ["NO_PRODUCT_IN_CATEGORY"],
    summary: "Nothing matched.",
    constraints: {
      requestType: "PURCHASE",
      quantity: 1,
      maxBudget:
        budgetMinor === null
          ? null
          : { amountMinor: budgetMinor.toString(), currency: "INR" },
      budgetScope: budgetMinor === null ? null : "PER_UNIT",
      category,
      hardRequirements: [],
      softPreferences: [],
    },
    trace: {
      modelCalls: 2,
      toolCalls: 0,
      productsObserved: 0,
      prefetched: true,
      durationMs: 2_000,
      turn: 1,
    },
  };
}

/** A purchase whose money was captured, optionally refunded. */
async function paid(
  amount: bigint,
  options: { refunded?: boolean; failedFirst?: boolean } = {},
) {
  const transactionId = await createTransaction(fixture);
  await createQuote(fixture, transactionId);
  let attemptNumber = 1;
  if (options.failedFirst === true) {
    await testDb().paymentAttempt.create({
      data: { transactionId, attemptNumber, amount, currency: "INR", status: "FAILED" },
    });
    attemptNumber += 1;
  }
  const attempt = await testDb().paymentAttempt.create({
    data: {
      transactionId,
      attemptNumber,
      amount,
      currency: "INR",
      status: "CAPTURED",
      providerPaymentId: `pay_${uid("x").slice(2, 12)}`,
    },
  });
  if (options.refunded === true) {
    await testDb().refund.create({
      data: {
        transactionId,
        paymentAttemptId: attempt.id,
        amount,
        currency: "INR",
        status: "PROCESSED",
        processedAt: new Date(),
        receipt: `rf_${uid("r")}`,
        requestedByBuyerId: fixture.buyerId,
      },
    });
  }
  return transactionId;
}

describe.skipIf(!databaseConfigured)("merchant insights", () => {
  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
    const merchant = await testDb().merchant.findUniqueOrThrow({
      where: { id: fixture.merchantId },
      select: { slug: true },
    });
    merchantSlug = merchant.slug;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const load = () =>
    loadMerchantInsights({
      prisma: testDb(),
      clock: fixedClock(new Date(Date.now() + 1_000)),
      merchantSlug,
    });

  it("counts revenue as captured money less processed refunds", async () => {
    await paid(249_900n);
    await paid(199_900n, { refunded: true });
    // A quote nobody paid is not revenue.
    await createQuote(fixture, await createTransaction(fixture));

    const insights = await load();

    expect(insights?.revenue).toEqual({
      capturedMinor: 449_800n,
      refundedMinor: 199_900n,
      netMinor: 249_900n,
      paidOrders: 2,
      averageOrderMinor: 224_900n,
    });
  });

  it("credits a payment recovered on a later attempt", async () => {
    await paid(249_900n, { failedFirst: true });
    await paid(199_900n);

    const insights = await load();
    expect(insights?.recovery).toEqual({
      withFailure: 1,
      recovered: 1,
      recoveredMinor: 249_900n,
    });
  });

  it("turns unmatched requests into demand the merchant can act on", async () => {
    // The fixture product is a keyboard at ₹2,499; these shoppers wanted less.
    await recordAgentRequest(
      {
        outcome: "NO_MATCH",
        decision: noMatch("mechanical-keyboard", 150_000n),
        durationMs: 0,
      },
      testDb(),
    );
    await recordAgentRequest(
      {
        outcome: "NO_MATCH",
        decision: noMatch("mechanical-keyboard", 300_000n),
        durationMs: 0,
      },
      testDb(),
    );
    await recordAgentRequest(
      { outcome: "NO_MATCH", decision: noMatch("webcam", null), durationMs: 0 },
      testDb(),
    );

    const insights = await load();

    expect(insights?.unmet).toEqual([
      {
        category: "mechanical-keyboard",
        requests: 2,
        soldHere: true,
        medianBudgetMinor: 150_000n,
        cheapestMinor: 249_900n,
        belowCheapest: 1,
      },
      {
        category: "webcam",
        requests: 1,
        soldHere: false,
        medianBudgetMinor: null,
        cheapestMinor: null,
        belowCheapest: 0,
      },
    ]);
    expect(insights?.outcomes.NO_MATCH).toBe(3);
  });

  it("builds the funnel from requests to paid orders", async () => {
    const transactionId = await paid(249_900n);
    await recordAgentRequest(
      { outcome: "PURCHASE_OPENED", transactionId, durationMs: 3_000 },
      testDb(),
    );
    await recordAgentRequest({ outcome: "CLARIFICATION", durationMs: 1_000 }, testDb());
    // Turned away before any model was called: not a request the funnel counts.
    await recordAgentRequest({ outcome: "RATE_LIMITED", durationMs: 0 }, testDb());

    const insights = await load();

    expect(insights?.funnel.map((stage) => [stage.label, stage.count])).toEqual([
      ["Asked the assistant", 2],
      ["Got a verified price", 1],
      ["Authorized to pay", 0],
      ["Paid", 1],
    ]);
    expect(insights?.agent.medianMs).toBe(1_000);
    expect(insights?.outcomes.RATE_LIMITED).toBe(1);
  });

  it("names products and amounts, and never a buyer or a purchase id", async () => {
    const transactionId = await paid(249_900n);
    const insights = await load();

    const serialised = JSON.stringify(insights, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialised).not.toContain(transactionId);
    expect(serialised).not.toContain(fixture.buyerId);
    expect(serialised).not.toContain("Test Buyer");
    expect(insights?.recent[0]?.productName).toBe("Test Mechanical Keyboard");
    expect(insights?.topProducts[0]).toEqual({
      name: "Test Mechanical Keyboard",
      orders: 1,
      revenueMinor: 249_900n,
    });
  });

  it("answers null for a merchant that does not exist", async () => {
    expect(
      await loadMerchantInsights({
        prisma: testDb(),
        clock: fixedClock(new Date()),
        merchantSlug: "no-such-merchant",
      }),
    ).toBeNull();
  });
});

describe.skipIf(!databaseConfigured)("the agent request log", () => {
  beforeEach(async () => {
    await resetTestData();
  });

  it("stores the structured shape of a request, never its words", async () => {
    await recordAgentRequest(
      { outcome: "NO_MATCH", decision: noMatch("Web-Cam!!", 300_000n), durationMs: 10 },
      testDb(),
    );
    const [row] = await testDb().agentRequest.findMany();
    expect(row).toMatchObject({
      outcome: "NO_MATCH",
      category: "web-cam",
      maxBudgetMinor: 300_000n,
      currency: "INR",
      modelCalls: 2,
      durationMs: 2_000,
      turn: 1,
    });
    expect(Object.keys(row ?? {})).not.toContain("message");
  });

  it("swallows a failed insert rather than failing the shopper's request", async () => {
    await expect(
      recordAgentRequest(
        // A transaction that does not exist violates the foreign key.
        {
          outcome: "PURCHASE_OPENED",
          transactionId: "01930000-0000-7000-8000-000000000000",
          durationMs: 1,
        },
        testDb(),
      ),
    ).resolves.toBeUndefined();
    expect(await testDb().agentRequest.count()).toBe(0);
  });
});
