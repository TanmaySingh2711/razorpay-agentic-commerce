import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  decidePurchase,
  type ProductDecisionDeps,
} from "@/services/product-decision/product-decision-service";
import {
  createTrustedQuote,
  supersedeActiveQuotes,
  validateQuoteForUse,
  type QuoteServiceDeps,
} from "@/services/quote/quote-service";
import { createServiceCatalogReader } from "@/services/buyer-agent/catalog-reader";
import { getTransactionHistory } from "@/services/transaction/transition-service";
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
 * The trusted quote against real PostgreSQL.
 *
 * This is where the claims that only a database can settle are proven:
 * that the quote, the lifecycle state and the transition history commit
 * together or not at all; that a retry does not open a second purchase; that
 * two simultaneous requests cannot both win; and that quoting a product does
 * not touch its stock.
 *
 * Time is injected everywhere, so the expiry tests run instantly and can hit
 * the boundary millisecond exactly.
 */

const QUOTE_TTL_SECONDS = 300;
const NOW = new Date("2026-06-01T10:00:00.000Z");

const MERCHANT_SLUG = "quote-merchant";

interface Fixture {
  readonly buyerId: string;
  readonly merchantId: string;
  readonly inBudgetId: string;
  readonly overBudgetId: string;
  readonly outOfStockId: string;
  readonly cheapId: string;
}

let fixture: Fixture;
let clock: MutableClock;
let deps: ProductDecisionDeps;
let quoteDeps: QuoteServiceDeps;

/** A validated agent decision. Only ever *proposes*; the server decides. */
function decision(overrides: Partial<BuyerAgentDecision> = {}): BuyerAgentDecision {
  return {
    kind: "PRODUCT_SELECTED",
    correlationId: uid("corr"),
    selectedProductId: fixture.inBudgetId,
    quantity: 1,
    reasonCodes: ["WITHIN_BUDGET"],
    summary: "This fits.",
    constraints: {
      requestType: "PURCHASE",
      quantity: 1,
      maxBudget: { amountMinor: "300000", currency: "INR" },
      budgetScope: "PER_UNIT",
      hardRequirements: [],
      softPreferences: [],
    },
    observedProduct: {
      productId: fixture.inBudgetId,
      name: "Aurora TKL",
      amount: { amountMinor: "279900", currency: "INR" },
      availableQuantity: 5,
      version: 1,
      updatedAt: NOW.toISOString(),
    },
    ...overrides,
  } as BuyerAgentDecision;
}

async function seedFixture(): Promise<Fixture> {
  const db = testDb();
  const buyer = await db.buyerProfile.create({ data: { displayName: "Quote Buyer" } });
  const merchant = await db.merchant.create({
    data: { name: "Quote Merchant", slug: uid(MERCHANT_SLUG), status: "ACTIVE" },
  });

  const product = async (
    unitAmount: bigint,
    inventory: number,
    status: "AVAILABLE" | "OUT_OF_STOCK",
    attributes: Record<string, string | number | boolean> = { switchType: "mechanical" },
  ): Promise<string> => {
    const created = await db.product.create({
      data: {
        merchantId: merchant.id,
        sku: uid("SKU"),
        name: `Product ${uid("n")}`,
        description: "A keyboard.",
        category: "mechanical-keyboard",
        unitAmount,
        currency: "INR",
        inventory,
        status,
        attributes,
      },
    });
    return created.id;
  };

  return {
    buyerId: buyer.id,
    merchantId: merchant.id,
    inBudgetId: await product(279_900n, 5, "AVAILABLE"),
    overBudgetId: await product(349_900n, 5, "AVAILABLE"),
    outOfStockId: await product(275_000n, 0, "OUT_OF_STOCK"),
    cheapId: await product(149_900n, 9, "AVAILABLE"),
  };
}

describe.skipIf(!databaseConfigured)("trusted purchase quote", () => {
  beforeEach(async () => {
    await resetTestData();
    fixture = await seedFixture();
    clock = fixedClock(NOW);

    const merchantSlug = (
      await testDb().merchant.findUniqueOrThrow({
        where: { id: fixture.merchantId },
        select: { slug: true },
      })
    ).slug;

    deps = {
      prisma: testDb(),
      catalog: createServiceCatalogReader({ prisma: testDb(), merchantSlug }),
      clock,
      quoteTtlSeconds: QUOTE_TTL_SECONDS,
    };
    quoteDeps = { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS };
  });

  // Once per file, not once per test.
  //
  // `testDb()` builds a new PrismaClient - and with it a new `pg` connection
  // pool - whenever the cached one has been disconnected. Disconnecting after
  // every test therefore created a fresh pool per test, roughly a hundred and
  // forty of them across this suite, all against one hosted database. Under the
  // full run that churn left connections lingering long enough for a stray lock
  // to outlive its test, and `resetTestData()`'s TRUNCATE - which needs ACCESS
  // EXCLUSIVE on every table at once - deadlocked against one.
  //
  // Per-test isolation is unaffected: it comes from `resetTestData()` in
  // `beforeEach`, which still runs before every test. Only the connection is
  // now shared, which is what the harness's cache was always for.
  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("the happy path", () => {
    it("creates a trusted quote and walks the lifecycle to QUOTE_CREATED", async () => {
      const result = await decidePurchase(decision(), deps);

      expect(result.kind).toBe("QUOTE_CREATED");
      if (result.kind !== "QUOTE_CREATED") return;

      // The amount came from PostgreSQL, not from the proposal.
      expect(result.quote.unitAmount).toEqual({ amountMinor: "279900", currency: "INR" });
      expect(result.quote.totalAmount).toEqual({
        amountMinor: "279900",
        currency: "INR",
      });
      expect(result.quote.status).toBe("ACTIVE");
      expect(result.selectionReasons).toContain("WITHIN_BUDGET");

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: result.transactionId },
      });
      expect(transaction.status).toBe("QUOTE_CREATED");

      // Every step of the lifecycle is recorded, in order.
      const history = await getTransactionHistory(result.transactionId, {
        prisma: testDb(),
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        "PRODUCT_SELECTED",
        "PRODUCT_VERIFIED",
        "QUOTE_CREATED",
      ]);

      // The quote belongs to its transaction.
      const stored = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: result.quote.id },
      });
      expect(stored.transactionId).toBe(result.transactionId);
      expect(stored.expiresAt.getTime()).toBe(NOW.getTime() + QUOTE_TTL_SECONDS * 1000);
    });

    it("computes the total for a multi-unit order", async () => {
      const result = await decidePurchase(
        decision({
          quantity: 2,
          constraints: {
            requestType: "PURCHASE",
            quantity: 2,
            maxBudget: { amountMinor: "300000", currency: "INR" },
            budgetScope: "PER_UNIT",
            hardRequirements: [],
            softPreferences: [],
          },
        } as Partial<BuyerAgentDecision>),
        deps,
      );

      expect(result.kind).toBe("QUOTE_CREATED");
      if (result.kind !== "QUOTE_CREATED") return;
      // 279900 x 2, exactly.
      expect(result.quote.totalAmount.amountMinor).toBe("559800");
      expect(result.quote.quantity).toBe(2);
    });
  });

  describe("browsing buys nothing", () => {
    for (const requestType of ["BROWSE", "RECOMMEND"] as const) {
      it(`returns no quote for ${requestType}`, async () => {
        const result = await decidePurchase(
          decision({
            constraints: {
              requestType,
              quantity: 1,
              maxBudget: { amountMinor: "300000", currency: "INR" },
              budgetScope: "PER_UNIT",
              hardRequirements: [],
              softPreferences: [],
            },
          } as Partial<BuyerAgentDecision>),
          deps,
        );
        expect(result.kind).toBe("NO_QUOTE_REQUIRED");
        // And it opened no transaction.
        expect(await testDb().transaction.count()).toBe(0);
      });
    }
  });

  describe("the server's own candidate set decides", () => {
    it("rejects a product that is over budget, whatever the agent proposed", async () => {
      const result = await decidePurchase(
        decision({ selectedProductId: fixture.overBudgetId }),
        deps,
      );
      expect(result.kind).toBe("AI_SELECTION_REJECTED");
      if (result.kind !== "AI_SELECTION_REJECTED") return;
      expect(result.reasons).toContain("OVER_BUDGET");
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });

    it("rejects an out-of-stock product, then quotes an in-stock alternative", async () => {
      // The proposal is still refused - that guard is the trust model and is
      // asserted below through the audit trail. What changed is what happens
      // *after* the refusal: rather than leaving the shopper at a dead end, the
      // server picks a replacement from its own eligible set. The replacement
      // is the cheapest product that satisfies the whole authority, which in
      // this fixture is `cheapId` at ₹1499 rather than the ₹2799 one.
      const result = await decidePurchase(
        decision({ selectedProductId: fixture.outOfStockId }),
        deps,
      );

      expect(result.kind).toBe("QUOTE_CREATED");
      if (result.kind !== "QUOTE_CREATED") return;
      expect(result.quote.productId).toBe(fixture.cheapId);
      expect(result.quote.productId).not.toBe(fixture.outOfStockId);

      // The substitute is a real, in-stock, in-budget product - not a relaxation.
      const substitute = await testDb().product.findUniqueOrThrow({
        where: { id: result.quote.productId },
      });
      expect(substitute.status).toBe("AVAILABLE");
      expect(substitute.inventory).toBeGreaterThan(0);
      expect(Number(substitute.unitAmount)).toBeLessThanOrEqual(300_000);

      // The trail tells the whole story: the proposal was blocked, and the
      // product that replaced it names the one it replaced.
      const events = await testDb().auditEvent.findMany({
        where: { transactionId: result.transactionId },
        orderBy: { createdAt: "asc" },
      });
      const rejected = events.find((e) => e.eventType === "product_selection_rejected");
      expect(rejected?.result).toBe("BLOCKED");
      expect((rejected?.metadata as { productId?: string }).productId).toBe(
        fixture.outOfStockId,
      );

      const selected = events.find((e) => e.eventType === "product_selected");
      expect(selected?.reasonCode).toBe("PRODUCT_SUBSTITUTED_UNAVAILABLE");
      expect(
        (selected?.metadata as { substitutedForProductId?: string })
          .substitutedForProductId,
      ).toBe(fixture.outOfStockId);
    });

    it("does not substitute when the proposal failed for any reason but stock", async () => {
      // Over budget *and* available elsewhere: an alternative exists, but
      // offering it would answer a question the shopper never asked.
      const result = await decidePurchase(
        decision({ selectedProductId: fixture.overBudgetId }),
        deps,
      );
      expect(result.kind).toBe("AI_SELECTION_REJECTED");
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });

    it("stops cleanly when the item is out of stock and nothing else qualifies", async () => {
      // Every other product is put out of stock too, so there is genuinely no
      // in-stock alternative to offer. The engine settles this before it ever
      // reaches the substitution step - an empty eligible set is "nothing
      // matches", which is a more precise answer than "your product was
      // refused" and is what the shopper is told.
      await testDb().product.updateMany({
        where: { merchantId: fixture.merchantId },
        data: { inventory: 0, status: "OUT_OF_STOCK" },
      });

      const result = await decidePurchase(
        decision({ selectedProductId: fixture.outOfStockId }),
        deps,
      );

      expect(result.kind).toBe("NO_VALID_CANDIDATE");
      if (result.kind !== "NO_VALID_CANDIDATE") return;
      expect(result.reasons).toContain("NOT_PURCHASABLE");
      // Nothing was quoted, so nothing became payable.
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });

    it("rejects a hallucinated product id", async () => {
      const result = await decidePurchase(
        decision({ selectedProductId: "01930000-0000-7000-8000-0000000fffff" }),
        deps,
      );
      expect(result.kind).toBe("AI_SELECTION_REJECTED");
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });

    it("returns NO_VALID_CANDIDATE when nothing qualifies", async () => {
      await testDb().product.updateMany({
        where: { merchantId: fixture.merchantId },
        data: { inventory: 0, status: "OUT_OF_STOCK" },
      });
      const result = await decidePurchase(decision(), deps);
      expect(result.kind).toBe("NO_VALID_CANDIDATE");
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });

    it("asks rather than trusting a hard requirement it cannot check", async () => {
      const result = await decidePurchase(
        decision({
          constraints: {
            requestType: "PURCHASE",
            quantity: 1,
            maxBudget: { amountMinor: "300000", currency: "INR" },
            budgetScope: "PER_UNIT",
            hardRequirements: [
              { attribute: "goodForGaming", operator: "EQUALS", value: "true" },
            ],
            softPreferences: [],
          },
        } as Partial<BuyerAgentDecision>),
        deps,
      );
      expect(result.kind).toBe("HARD_REQUIREMENT_UNVERIFIABLE");
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });

    it("refuses an unresolved budget scope above quantity one", async () => {
      const result = await decidePurchase(
        decision({
          constraints: {
            requestType: "PURCHASE",
            quantity: 2,
            maxBudget: { amountMinor: "300000", currency: "INR" },
            budgetScope: null,
            hardRequirements: [],
            softPreferences: [],
          },
        } as Partial<BuyerAgentDecision>),
        deps,
      );
      expect(result.kind).toBe("CLARIFICATION_REQUIRED");
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });
  });

  describe("neither the model nor the client can set a price", () => {
    it("ignores an agent-claimed price of ₹1", async () => {
      const result = await decidePurchase(
        decision({
          observedProduct: {
            productId: fixture.inBudgetId,
            name: "Aurora TKL",
            amount: { amountMinor: "100", currency: "INR" },
            availableQuantity: 5,
            version: 1,
            updatedAt: NOW.toISOString(),
          },
        } as Partial<BuyerAgentDecision>),
        deps,
      );
      expect(result.kind).toBe("QUOTE_CREATED");
      if (result.kind !== "QUOTE_CREATED") return;
      // PostgreSQL says 279900, and PostgreSQL is the only voice that counts.
      expect(result.quote.unitAmount.amountMinor).toBe("279900");
    });

    it("ignores extra price-shaped fields smuggled onto the decision", async () => {
      const smuggled = {
        ...decision(),
        price: 1,
        unitAmountMinor: "100",
        totalAmountMinor: "100",
      } as unknown as BuyerAgentDecision;
      const result = await decidePurchase(smuggled, deps);
      expect(result.kind).toBe("QUOTE_CREATED");
      if (result.kind !== "QUOTE_CREATED") return;
      expect(result.quote.unitAmount.amountMinor).toBe("279900");
    });
  });

  describe("the product moves before the quote is written", () => {
    it("refuses when the fresh price no longer fits the budget", async () => {
      const catalog = deps.catalog;
      const priceRaisingCatalog = {
        ...catalog,
        // The candidate read sees ₹2,799; the row changes before the write.
        searchProducts: async (query: Parameters<typeof catalog.searchProducts>[0]) => {
          const page = await catalog.searchProducts(query);
          await testDb().product.update({
            where: { id: fixture.inBudgetId },
            data: { unitAmount: 349_900n, version: { increment: 1 } },
          });
          return page;
        },
      };

      const result = await decidePurchase(decision(), {
        ...deps,
        catalog: priceRaisingCatalog,
      });

      expect(result.kind).toBe("REEVALUATION_REQUIRED");
      if (result.kind !== "REEVALUATION_REQUIRED") return;
      expect(result.reasons).toContain("PRICE_CHANGED");
      // Nothing was quoted from the stale price.
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });

    it("refuses when stock disappears before the write", async () => {
      const catalog = deps.catalog;
      const stockLosingCatalog = {
        ...catalog,
        searchProducts: async (query: Parameters<typeof catalog.searchProducts>[0]) => {
          const page = await catalog.searchProducts(query);
          await testDb().product.update({
            where: { id: fixture.inBudgetId },
            data: { inventory: 0, status: "OUT_OF_STOCK" },
          });
          return page;
        },
      };

      const result = await decidePurchase(decision(), {
        ...deps,
        catalog: stockLosingCatalog,
      });
      expect(result.kind).toBe("REEVALUATION_REQUIRED");
      expect(await testDb().purchaseQuote.count()).toBe(0);
    });
  });

  describe("quoting does not reserve anything", () => {
    it("leaves the product's inventory untouched", async () => {
      const before = await testDb().product.findUniqueOrThrow({
        where: { id: fixture.inBudgetId },
        select: { inventory: true },
      });

      const result = await decidePurchase(decision(), deps);
      expect(result.kind).toBe("QUOTE_CREATED");

      const after = await testDb().product.findUniqueOrThrow({
        where: { id: fixture.inBudgetId },
        select: { inventory: true },
      });
      // A quote records a price. Holding stock is Objective 8's job.
      expect(after.inventory).toBe(before.inventory);
      expect(await testDb().inventoryReservation.count()).toBe(0);
    });

    it("evaluates no policy and creates no approval", async () => {
      await decidePurchase(decision(), deps);
      expect(await testDb().approvalRequest.count()).toBe(0);
      expect(await testDb().paymentAttempt.count()).toBe(0);
    });
  });

  describe("idempotency", () => {
    it("returns the same transaction and quote for a repeated request", async () => {
      const request = decision();

      const first = await decidePurchase(request, deps);
      const second = await decidePurchase(request, deps);

      expect(first.kind).toBe("QUOTE_CREATED");
      expect(second.kind).toBe("QUOTE_CREATED");
      if (first.kind !== "QUOTE_CREATED" || second.kind !== "QUOTE_CREATED") return;

      expect(second.transactionId).toBe(first.transactionId);
      expect(second.quote.id).toBe(first.quote.id);

      expect(await testDb().transaction.count()).toBe(1);
      expect(await testDb().purchaseQuote.count()).toBe(1);

      // And exactly one history row per lifecycle step, not two.
      const history = await getTransactionHistory(first.transactionId, {
        prisma: testDb(),
      });
      expect(history).toHaveLength(3);
    });

    it("survives two simultaneous requests for the same decision", async () => {
      const request = decision();

      const [a, b] = await Promise.allSettled([
        decidePurchase(request, deps),
        decidePurchase(request, deps),
      ]);

      // At least one must succeed, and neither may double-write.
      const succeeded = [a, b].filter((r) => r.status === "fulfilled");
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      expect(await testDb().transaction.count()).toBe(1);
      const activeQuotes = await testDb().purchaseQuote.count({
        where: { status: "ACTIVE" },
      });
      expect(activeQuotes).toBeLessThanOrEqual(1);

      const transaction = await testDb().transaction.findFirstOrThrow();
      const history = await getTransactionHistory(transaction.id, { prisma: testDb() });
      // No duplicate steps, and every sequence number is distinct.
      expect(new Set(history.map((h) => h.sequence)).size).toBe(history.length);
      expect(new Set(history.map((h) => h.toStatus)).size).toBe(history.length);
    });
  });

  describe("atomicity", () => {
    it("writes neither the quote nor the transition when the commit fails", async () => {
      const first = await decidePurchase(decision(), deps);
      expect(first.kind).toBe("QUOTE_CREATED");
      if (first.kind !== "QUOTE_CREATED") return;

      const quotesBefore = await testDb().purchaseQuote.count();
      const historyBefore = (
        await getTransactionHistory(first.transactionId, { prisma: testDb() })
      ).length;

      // An idempotency key longer than the history column allows. It passes
      // every application check, so the quote row is inserted and the status
      // update runs - and only then does PostgreSQL reject the history row.
      // That is a real rollback of a genuinely half-finished write, not a
      // simulated one.
      await expect(
        createTrustedQuote(
          {
            transactionId: first.transactionId,
            productId: fixture.inBudgetId,
            quantity: 1,
            authority: {
              quantity: 1,
              maxAmountMinor: 400_000n,
              currency: "INR",
              budgetScope: "PER_UNIT",
              hardRequirements: [],
              category: null,
            },
            idempotencyKey: "x".repeat(200),
            replaceExisting: true,
          },
          quoteDeps,
        ),
      ).rejects.toThrow();

      // No orphan quote, and no history row for a transition that did not stick.
      expect(await testDb().purchaseQuote.count()).toBe(quotesBefore);
      expect(
        (await getTransactionHistory(first.transactionId, { prisma: testDb() })).length,
      ).toBe(historyBefore);

      // The original quote was not superseded either - the whole thing rolled back.
      const original = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: first.quote.id },
      });
      expect(original.status).toBe("ACTIVE");
      expect(original.unitAmount).toBe(279_900n);
    });
  });

  describe("quote validation", () => {
    it("reports a fresh quote as valid", async () => {
      const result = await decidePurchase(decision(), deps);
      if (result.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      const verdict = await validateQuoteForUse(result.quote.id, quoteDeps);
      expect(verdict.kind).toBe("VALID");
    });

    it("reports an expired quote without any waiting", async () => {
      const result = await decidePurchase(decision(), deps);
      if (result.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      clock.advanceMs(QUOTE_TTL_SECONDS * 1000);

      const verdict = await validateQuoteForUse(result.quote.id, quoteDeps);
      expect(verdict.kind).toBe("EXPIRED");

      // And the row records that it lapsed.
      const stored = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: result.quote.id },
      });
      expect(stored.status).toBe("EXPIRED");
      // The financial snapshot is untouched.
      expect(stored.unitAmount).toBe(279_900n);
    });

    it("invalidates on a price change and never rewrites the old amount", async () => {
      const result = await decidePurchase(decision(), deps);
      if (result.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      await testDb().product.update({
        where: { id: fixture.inBudgetId },
        data: { unitAmount: 299_900n, version: { increment: 1 } },
      });

      const verdict = await validateQuoteForUse(result.quote.id, quoteDeps);
      expect(verdict.kind).toBe("INVALIDATED");
      if (verdict.kind !== "INVALIDATED") return;
      expect(verdict.reasons).toContain("PRICE_CHANGED");

      const stored = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: result.quote.id },
      });
      expect(stored.unitAmount).toBe(279_900n);
      expect(stored.status).toBe("INVALIDATED");
    });

    it("invalidates when stock falls below the quoted quantity, without touching stock", async () => {
      const result = await decidePurchase(decision(), deps);
      if (result.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      await testDb().product.update({
        where: { id: fixture.inBudgetId },
        data: { inventory: 0, status: "OUT_OF_STOCK" },
      });

      const verdict = await validateQuoteForUse(result.quote.id, quoteDeps);
      expect(verdict.kind).toBe("INVALIDATED");

      const product = await testDb().product.findUniqueOrThrow({
        where: { id: fixture.inBudgetId },
        select: { inventory: true },
      });
      // Validation reads stock. It never writes it.
      expect(product.inventory).toBe(0);
    });

    it("invalidates on a version bump alone", async () => {
      const result = await decidePurchase(decision(), deps);
      if (result.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      await testDb().product.update({
        where: { id: fixture.inBudgetId },
        data: { version: { increment: 1 }, attributes: { switchType: "membrane" } },
      });

      const verdict = await validateQuoteForUse(result.quote.id, quoteDeps);
      expect(verdict.kind).toBe("INVALIDATED");
      if (verdict.kind !== "INVALIDATED") return;
      expect(verdict.reasons).toContain("PRODUCT_VERSION_CHANGED");
    });

    it("reports an unknown quote as not found", async () => {
      const verdict = await validateQuoteForUse(
        "01930000-0000-7000-8000-0000000fffff",
        quoteDeps,
      );
      expect(verdict.kind).toBe("NOT_FOUND");
    });
  });

  describe("re-quoting", () => {
    /** An authority the fixture product satisfies at either price. */
    const authority = {
      quantity: 1,
      maxAmountMinor: 400_000n,
      currency: "INR" as const,
      budgetScope: "PER_UNIT" as const,
      hardRequirements: [],
      category: null,
    };

    it("issues a replacement quote and retires the old one, keeping both", async () => {
      const first = await decidePurchase(decision(), deps);
      if (first.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      // The price moves, so the frozen quote no longer describes reality.
      await testDb().product.update({
        where: { id: fixture.inBudgetId },
        data: { unitAmount: 299_900n, version: { increment: 1 } },
      });
      expect((await validateQuoteForUse(first.quote.id, quoteDeps)).kind).toBe(
        "INVALIDATED",
      );

      const replacement = await createTrustedQuote(
        {
          transactionId: first.transactionId,
          productId: fixture.inBudgetId,
          quantity: 1,
          authority,
          idempotencyKey: uid("requote"),
          replaceExisting: true,
        },
        quoteDeps,
      );

      // A new row with its own identity, at the new price.
      expect(replacement.snapshot.quoteId).not.toBe(first.quote.id);
      expect(replacement.snapshot.unitAmountMinor).toBe(299_900n);
      expect(replacement.alreadyExisted).toBe(false);

      // The old row survives untouched. Its amount records a price the merchant
      // once stood behind, and it is never edited.
      const old = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: first.quote.id },
      });
      expect(old.unitAmount).toBe(279_900n);
      // Already retired as INVALIDATED by the validation above; superseding
      // only touches ACTIVE rows. Either way it is no longer payable, and the
      // amount it froze is untouched - which is the invariant that matters.
      expect(old.status).not.toBe("ACTIVE");

      // Exactly one is payable.
      const active = await testDb().purchaseQuote.findMany({
        where: { transactionId: first.transactionId, status: "ACTIVE" },
      });
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(replacement.snapshot.quoteId);

      // And only the replacement validates.
      expect(
        (await validateQuoteForUse(replacement.snapshot.quoteId, quoteDeps)).kind,
      ).toBe("VALID");
      expect((await validateQuoteForUse(first.quote.id, quoteDeps)).kind).toBe(
        "INVALIDATED",
      );
    });

    it("records the re-issue in history without leaving the quoting phase", async () => {
      const first = await decidePurchase(decision(), deps);
      if (first.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      await createTrustedQuote(
        {
          transactionId: first.transactionId,
          productId: fixture.inBudgetId,
          quantity: 1,
          authority,
          idempotencyKey: uid("requote"),
          replaceExisting: true,
        },
        quoteDeps,
      );

      const history = await getTransactionHistory(first.transactionId, {
        prisma: testDb(),
      });

      // The transaction has not progressed - it is still quoting - but the
      // re-issue is on the record, with its own reason code.
      expect(history.map((h) => h.toStatus)).toEqual([
        "PRODUCT_SELECTED",
        "PRODUCT_VERIFIED",
        "QUOTE_CREATED",
        "QUOTE_CREATED",
      ]);
      expect(history.at(-1)?.fromStatus).toBe("QUOTE_CREATED");
      expect(history.at(-1)?.reasonCode).toBe("QUOTE_REISSUED");
      expect(history.at(-1)?.actor).toBe("quote_service");

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: first.transactionId },
      });
      expect(transaction.status).toBe("QUOTE_CREATED");

      // This quote was still ACTIVE when replaced, so it was superseded rather
      // than invalidated - and its amount is unchanged.
      const old = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: first.quote.id },
      });
      expect(old.status).toBe("SUPERSEDED");
      expect(old.unitAmount).toBe(279_900n);
    });

    it("does not re-price on an ordinary retry", async () => {
      const first = await decidePurchase(decision(), deps);
      if (first.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      await testDb().product.update({
        where: { id: fixture.inBudgetId },
        data: { unitAmount: 299_900n },
      });

      // Without replaceExisting, a retry returns what the shopper is already
      // looking at rather than silently quoting them a higher price.
      const retry = await createTrustedQuote(
        {
          transactionId: first.transactionId,
          productId: fixture.inBudgetId,
          quantity: 1,
          authority,
          idempotencyKey: uid("retry"),
        },
        quoteDeps,
      );
      expect(retry.alreadyExisted).toBe(true);
      expect(retry.snapshot.quoteId).toBe(first.quote.id);
      expect(retry.snapshot.unitAmountMinor).toBe(279_900n);
    });

    it("lets the database refuse a second active quote", async () => {
      const first = await decidePurchase(decision(), deps);
      if (first.kind !== "QUOTE_CREATED") throw new Error("expected a quote");

      // Bypassing the service entirely: the partial unique index is the
      // backstop, so the rule holds even where application ordering does not.
      await expect(
        testDb().purchaseQuote.create({
          data: {
            transactionId: first.transactionId,
            productId: fixture.inBudgetId,
            quantity: 1,
            unitAmount: 279_900n,
            totalAmount: 279_900n,
            currency: "INR",
            productVersion: 1,
            status: "ACTIVE",
            createdAt: clock.now(),
            expiresAt: new Date(clock.now().getTime() + 60_000),
          },
        }),
      ).rejects.toThrow();

      // Superseded rows may accumulate freely: the index constrains only ACTIVE.
      await supersedeActiveQuotes(testDb(), first.transactionId, clock.now());
      const second = await testDb().purchaseQuote.create({
        data: {
          transactionId: first.transactionId,
          productId: fixture.inBudgetId,
          quantity: 1,
          unitAmount: 279_900n,
          totalAmount: 279_900n,
          currency: "INR",
          productVersion: 1,
          status: "ACTIVE",
          createdAt: clock.now(),
          expiresAt: new Date(clock.now().getTime() + 60_000),
        },
      });
      expect(second.id).not.toBe(first.quote.id);
      expect(
        await testDb().purchaseQuote.count({
          where: { transactionId: first.transactionId },
        }),
      ).toBe(2);
    });
  });
});
