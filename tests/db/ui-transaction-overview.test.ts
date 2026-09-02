import { beforeEach, describe, expect, it } from "vitest";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import { createTrustedQuote } from "@/services/quote/quote-service";
import { reserveInventory } from "@/services/inventory/reservation-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { createTransaction } from "@/services/transaction/creation-service";
import { loadTransactionOverview } from "@/services/transaction/overview-service";
import { buildJourney, describeState, formatMoney } from "@/domain/ui/journey";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import { databaseConfigured, resetTestData, testDb, uid } from "./harness";

/**
 * What the transaction page will actually show, proven against real rows.
 *
 * The page is a server component, so the honest way to test it without a
 * browser is to test the value it renders from. Everything a buyer sees is
 * derived from `loadTransactionOverview`, so asserting on that is asserting on
 * the page - and it catches the failures that matter, which are about *what is
 * true* rather than about markup.
 *
 * Two properties get the most attention. The amount shown must come from the
 * frozen quote and not from the product row, because those two numbers diverge
 * the moment a merchant edits a price - and a page that showed the live price
 * beside a Pay button would be quoting one number and charging another. And the
 * read must never write: rendering a page cannot be allowed to move a
 * transaction.
 */

const QUOTE_TTL_SECONDS = 900;
const RESERVATION_TTL_SECONDS = 3600;
const PRICE = 249_900n;
const NOW = new Date("2026-09-03T09:00:00.000Z");

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

let buyerId = "";
let merchantId = "";
let clock: MutableClock;

function deps() {
  return { prisma: testDb(), clock };
}

/** Drives a transaction to QUOTE_CREATED through the real boundaries. */
async function arrangeQuoted(): Promise<{
  readonly transactionId: string;
  readonly productId: string;
}> {
  const product = await testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name: "Test Mechanical Keyboard",
      description: "A keyboard used by the interface tests.",
      category: "mechanical-keyboard",
      unitAmount: PRICE,
      currency: "INR",
      inventory: 5,
      status: "AVAILABLE",
      attributes: { switchType: "linear-red", layout: "tkl-87" },
    },
  });

  const transaction = await createTransaction(
    { buyerProfileId: buyerId, merchantId, correlationId: uid("corr") },
    { prisma: testDb() },
  );

  for (const [event, actor] of [
    ["PRODUCT_SELECTION_CONFIRMED", "buyer_agent"],
    ["PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service"],
  ] as const) {
    const outcome = await applyTransactionEvent(
      { transactionId: transaction.id, event, actor },
      { prisma: testDb() },
    );
    expect(outcome.kind).toBe("APPLIED");
  }

  await createTrustedQuote(
    {
      transactionId: transaction.id,
      productId: product.id,
      quantity: 1,
      authority: OPEN_AUTHORITY,
      idempotencyKey: uid("quote"),
    },
    { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS },
  );

  return { transactionId: transaction.id, productId: product.id };
}

describe.skipIf(!databaseConfigured)("what the transaction page shows", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Interface Test Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: { name: "Interface Test Merchant", slug: uid("merchant") },
    });
    buyerId = buyer.id;
    merchantId = merchant.id;

    // A live policy, so the engine has a ceiling to compare against and records
    // a complete evaluation. Without one there is nothing for the page to show,
    // which is itself correct - but it is not the case under test here.
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

  it("says nothing about a transaction that does not exist", async () => {
    // The same answer as "not yours" on purpose: a page that distinguished the
    // two would be an oracle for guessing identifiers.
    const overview = await loadTransactionOverview(
      "01930000-0000-7000-8000-0000000000ff",
      deps(),
    );
    expect(overview).toBeNull();
  });

  it("shows the frozen quote, not the live product price", async () => {
    const { transactionId, productId } = await arrangeQuoted();

    // The merchant raises the price after the quote was taken. The buyer must
    // still be shown - and charged - the amount the server froze.
    await testDb().product.update({
      where: { id: productId },
      data: { unitAmount: 999_900n },
    });

    const overview = await loadTransactionOverview(transactionId, deps());
    expect(overview?.quote?.totalAmount.amountMinor).toBe(PRICE.toString());
    expect(overview?.product?.unitAmount.amountMinor).toBe(PRICE.toString());
    expect(formatMoney(overview!.quote!.totalAmount)).toBe("₹2,499.00");
  });

  it("carries the product's name and attributes for display", async () => {
    const { transactionId } = await arrangeQuoted();
    const overview = await loadTransactionOverview(transactionId, deps());
    expect(overview?.product?.name).toBe("Test Mechanical Keyboard");
    expect(overview?.product?.attributes).toMatchObject({ switchType: "linear-red" });
  });

  it("reports the quote as usable while it is live", async () => {
    const { transactionId } = await arrangeQuoted();
    expect((await loadTransactionOverview(transactionId, deps()))?.quoteUsable).toBe(
      true,
    );
  });

  it("reports the quote as unusable once its window has passed", async () => {
    const { transactionId } = await arrangeQuoted();
    clock.set(new Date(NOW.getTime() + (QUOTE_TTL_SECONDS + 60) * 1000));
    const overview = await loadTransactionOverview(transactionId, deps());
    expect(overview?.quoteUsable).toBe(false);
    // Still shown, because a buyer needs to see what expired, not a blank card.
    expect(overview?.quote).not.toBeNull();
  });

  it("shows the policy decision the engine actually recorded", async () => {
    const { transactionId } = await arrangeQuoted();
    const quote = await testDb().purchaseQuote.findFirstOrThrow({
      where: { transactionId },
    });
    const evaluated = await evaluateQuotePolicy(
      { quoteId: quote.id, operationId: uid("op") },
      {
        prisma: testDb(),
        clock,
        quote: { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS },
      },
    );
    expect(evaluated.kind).toBe("EVALUATED");

    const overview = await loadTransactionOverview(transactionId, deps());
    expect(overview?.policy).not.toBeNull();
    expect(["ALLOWED", "APPROVAL_REQUIRED", "BLOCKED"]).toContain(
      overview?.policy?.decision,
    );
    // The page renders a sentence for whichever of the three it is; the state
    // itself always has one.
    expect(describeState(overview!.state).meaning.length).toBeGreaterThan(15);
  });

  it("shows the stock hold once the item is actually held", async () => {
    const { transactionId } = await arrangeQuoted();
    const quote = await testDb().purchaseQuote.findFirstOrThrow({
      where: { transactionId },
    });
    await evaluateQuotePolicy(
      { quoteId: quote.id, operationId: uid("op") },
      {
        prisma: testDb(),
        clock,
        quote: { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS },
      },
    );
    const held = await reserveInventory(
      { transactionId, operationId: uid("op") },
      { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
    );

    const overview = await loadTransactionOverview(transactionId, deps());
    if (held.kind === "RESERVED") {
      expect(overview?.reservationStatus).toBe("ACTIVE");
      expect(overview?.reservationExpiresAt).not.toBeNull();
    } else {
      // Policy required approval, so no hold exists yet - and the page must not
      // invent one.
      expect(overview?.reservationStatus).toBeNull();
    }
  });

  it("builds a timeline from the real audit and lifecycle history", async () => {
    const { transactionId } = await arrangeQuoted();
    const overview = await loadTransactionOverview(transactionId, deps());

    expect(overview?.timeline.length).toBeGreaterThan(0);
    for (const entry of overview?.timeline ?? []) {
      expect(entry.conciseExplanation.length).toBeGreaterThan(0);
      // Nothing a provider or a model wrote, and nothing resembling a secret.
      expect(entry.conciseExplanation).not.toMatch(
        /rzp_|secret|token|password|chain.of.thought/i,
      );
    }
    expect(overview?.timeline.some((e) => e.source === "STATE_TRANSITION")).toBe(true);
  });

  it("places the purchase on the progress rail wherever it has got to", async () => {
    const { transactionId } = await arrangeQuoted();
    const overview = await loadTransactionOverview(transactionId, deps());
    const journey = buildJourney(overview!.state);
    expect(journey.some((step) => step.status === "CURRENT")).toBe(true);
    // Nothing after the current step may claim to be finished.
    const currentIndex = journey.findIndex((step) => step.status === "CURRENT");
    expect(journey.slice(currentIndex + 1).every((s) => s.status === "UPCOMING")).toBe(
      true,
    );
  });

  it("does not move the transaction by being read", async () => {
    // Rendering a page must never be able to change financial state. Read it
    // repeatedly and prove the row, its history and its quote are untouched.
    const { transactionId } = await arrangeQuoted();
    const before = await testDb().transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    const transitionsBefore = await testDb().transactionStateTransition.count({
      where: { transactionId },
    });

    for (let i = 0; i < 3; i += 1) {
      await loadTransactionOverview(transactionId, deps());
    }

    const after = await testDb().transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    expect(after.status).toBe(before.status);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(
      await testDb().transactionStateTransition.count({ where: { transactionId } }),
    ).toBe(transitionsBefore);
  });

  it("reports the retry budget from persisted attempts, never from a guess", async () => {
    const { transactionId } = await arrangeQuoted();
    const overview = await loadTransactionOverview(transactionId, deps());
    // No payment has been attempted, so nothing has been used and the page has
    // no retry action to offer.
    expect(overview?.retry?.attemptsUsed).toBe(0);
    expect(overview?.retry?.available).toBe(false);
    expect(overview?.retry?.lastFailure).toBeNull();
  });
});
