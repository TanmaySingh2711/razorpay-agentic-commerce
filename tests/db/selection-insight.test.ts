import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  decidePurchase,
  type ProductDecisionDeps,
} from "@/services/product-decision-service";
import { createServiceCatalogReader } from "@/services/catalog-reader";
import { loadTransactionOverview } from "@/services/transaction-overview-service";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
import {
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
  uid,
} from "./harness";

/**
 * "How the assistant chose", from the record the server wrote.
 *
 * The purchase page shows what else met every rule and what it cost, and how
 * much work the agent did. Both must come from the `product_selected` audit
 * record - the decision engine's own candidate list and the orchestrator's own
 * counters - and from nothing the model said. This suite drives a real
 * decision through `decidePurchase` and reads it back through the same
 * overview the page renders.
 */

const NOW = new Date("2026-09-03T09:00:00.000Z");

let buyerId = "";
let merchantId = "";
let merchantSlug = "";
let clock: MutableClock;

async function product(
  name: string,
  unitAmount: bigint,
  extra: Record<string, unknown> = {},
) {
  return testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name,
      description: `${name}, used by the selection tests.`,
      category: "mouse",
      unitAmount,
      currency: "INR",
      inventory: 5,
      status: "AVAILABLE",
      attributes: {},
      ...extra,
    },
  });
}

function deps(): ProductDecisionDeps {
  return {
    prisma: testDb(),
    catalog: createServiceCatalogReader({ prisma: testDb(), merchantSlug }),
    clock,
    quoteTtlSeconds: 900,
  };
}

function decisionFor(
  chosen: { id: string; name: string; unitAmount: bigint },
  trace?: BuyerAgentDecision["trace"],
): BuyerAgentDecision {
  return {
    kind: "PRODUCT_SELECTED",
    correlationId: uid("corr"),
    selectedProductId: chosen.id,
    quantity: 1,
    reasonCodes: ["WITHIN_BUDGET"],
    summary: "This fits.",
    constraints: {
      requestType: "PURCHASE",
      quantity: 1,
      maxBudget: { amountMinor: "300000", currency: "INR" },
      budgetScope: "PER_UNIT",
      category: "mouse",
      hardRequirements: [],
      softPreferences: [],
    },
    observedProduct: {
      productId: chosen.id,
      name: chosen.name,
      amount: { amountMinor: chosen.unitAmount.toString(), currency: "INR" },
      availableQuantity: 5,
      version: 1,
      updatedAt: NOW.toISOString(),
    },
    ...(trace === undefined ? {} : { trace }),
  };
}

async function open(decision: BuyerAgentDecision): Promise<string> {
  const result = await decidePurchase(decision, deps());
  if (result.kind !== "QUOTE_CREATED")
    throw new Error(`expected a quote, got ${result.kind}`);
  return result.transactionId;
}

const overviewOf = (transactionId: string) =>
  loadTransactionOverview(transactionId, { prisma: testDb(), clock });

describe.skipIf(!databaseConfigured)("how the assistant chose", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    const buyer = await testDb().buyerProfile.create({ data: { displayName: "Buyer" } });
    const merchant = await testDb().merchant.create({
      data: { name: "Selection Test Merchant", slug: uid("merchant") },
    });
    buyerId = buyer.id;
    merchantId = merchant.id;
    merchantSlug = merchant.slug;
    await testDb().authorizationPolicy.create({
      data: {
        buyerProfileId: buyerId,
        maxAutoApproveAmount: 300_000n,
        currency: "INR",
        autoPurchaseAllowed: true,
        status: "ACTIVE",
        version: 1,
      },
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("lists the other eligible products, cheapest first, at the catalog's prices", async () => {
    const cheap = await product("Dart Lite", 79_900n);
    const chosen = await product("Glide Wireless", 149_900n);
    const dearer = await product("Trace 2.4G", 179_900n);
    // Never eligible: over the ₹3,000 ceiling, out of stock, and another category.
    await product("Apex Pro", 499_900n);
    await product("Ghost", 99_900n, { inventory: 0, status: "OUT_OF_STOCK" });
    await product("Aurora TKL", 249_900n, { category: "mechanical-keyboard" });

    const overview = await overviewOf(await open(decisionFor(chosen)));

    expect(overview?.selection).toMatchObject({
      eligibleCount: 3,
      substituted: false,
      alternatives: [
        { name: cheap.name, unitAmount: { amountMinor: "79900", currency: "INR" } },
        { name: dearer.name, unitAmount: { amountMinor: "179900", currency: "INR" } },
      ],
    });
    // The chosen product is never listed as its own alternative.
    expect(overview?.selection?.alternatives.map((a) => a.name)).not.toContain(
      chosen.name,
    );
    expect(overview?.selection?.reasons).toContain("WITHIN_BUDGET");
  });

  it("caps the list at three, however many products qualify", async () => {
    const chosen = await product("Chosen", 100_000n);
    for (let i = 1; i <= 5; i += 1)
      await product(`Other ${String(i)}`, 100_000n + BigInt(i));

    const overview = await overviewOf(await open(decisionFor(chosen)));

    expect(overview?.selection?.eligibleCount).toBe(6);
    expect(overview?.selection?.alternatives).toHaveLength(3);
  });

  it("says so when the chosen product was the only one that qualified", async () => {
    const only = await product("Only One", 149_900n);
    const overview = await overviewOf(await open(decisionFor(only)));
    expect(overview?.selection).toMatchObject({ eligibleCount: 1, alternatives: [] });
  });

  it("reports the orchestrator's counters, and nothing when there were none", async () => {
    const chosen = await product("Glide Wireless", 149_900n);
    const traced = await overviewOf(
      await open(
        decisionFor(chosen, {
          modelCalls: 2,
          toolCalls: 0,
          productsObserved: 7,
          prefetched: true,
          durationMs: 3_912.4,
          turn: 2,
        }),
      ),
    );
    expect(traced?.selection?.agent).toEqual({
      modelCalls: 2,
      toolCalls: 0,
      productsObserved: 7,
      durationMs: 3_912,
      turn: 2,
    });

    // A decision built without a trace (an older record) shows no agent block
    // rather than a row of invented zeros.
    const untraced = await overviewOf(await open(decisionFor(chosen)));
    expect(untraced?.selection?.agent).toBeNull();
  });

  it("marks a substitution when the proposed product was out of stock", async () => {
    const gone = await product("Sold Out", 149_900n, {
      inventory: 0,
      status: "OUT_OF_STOCK",
    });
    const inStock = await product("In Stock", 159_900n);

    const overview = await overviewOf(await open(decisionFor(gone)));

    expect(overview?.selection?.substituted).toBe(true);
    expect(overview?.product?.name).toBe(inStock.name);
  });

  it("has no selection and no refund before a product is chosen", async () => {
    const { createTransaction } = await import("@/services/transaction-creation-service");
    const created = await createTransaction(
      { buyerProfileId: buyerId, merchantId, correlationId: uid("corr") },
      { prisma: testDb() },
    );
    const overview = await overviewOf(created.id);
    expect(overview?.selection).toBeNull();
    expect(overview?.refund).toBeNull();
  });
});
