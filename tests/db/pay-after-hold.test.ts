import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPaymentOrder,
  type PaymentOrderServiceDeps,
} from "@/services/payment/payment-order-service";
import {
  startCheckout,
  type CheckoutServiceDeps,
} from "@/services/payment/checkout-service";
import {
  reserveInventory,
  type ReservationServiceDeps,
} from "@/services/inventory/reservation-service";
import {
  evaluateQuotePolicy,
  type PolicyServiceDeps,
} from "@/services/policy/policy-service";
import {
  createTrustedQuote,
  type QuoteServiceDeps,
} from "@/services/quote/quote-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { createTransaction } from "@/services/transaction/creation-service";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor } from "@/domain/transaction/states";
import {
  FAKE_PROVIDER_ORDER_ID,
  fakePaymentProvider,
} from "../support/fake-payment-provider";
import {
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
  uid,
} from "./harness";

/**
 * The exact production gap behind transaction `01a0687d-7b29-713c-bdc8-96e3a3693397`.
 *
 * The buyer reached AUTHORIZED, held the item (INVENTORY_RESERVED, reservation
 * ACTIVE, quote still VALID), refreshed the page, saw a Pay button, and pressed
 * it — and the server answered "This purchase is not ready for payment." with
 * `TRANSACTION_STATE_INVALID`, because nothing had ever called
 * `createPaymentOrder`: `startCheckout` requires an existing PaymentAttempt row
 * with a provider order, and holding stock never creates one.
 *
 * The fix is not a new invariant - every check below already existed and was
 * already correct - it is a missing call in the client's Pay-button handler,
 * which now creates the payment order before starting checkout, exactly as the
 * RETRY path already did for a failed attempt. What this file proves is the
 * server-side half of that fix: that the composed sequence a fixed Pay button
 * now drives actually reaches CHECKOUT_READY, and that every state the fix must
 * still refuse keeps refusing.
 */

const QUOTE_TTL_SECONDS = 300;
const RESERVATION_TTL_SECONDS = 600;
const CEILING = 300_000n;
const IN_BUDGET = 279_900n;
const NOW = new Date("2026-09-01T09:00:00.000Z");

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

let fixture: { buyerId: string; merchantId: string };
let clock: MutableClock;
let quoteDeps: QuoteServiceDeps;
let policyDeps: PolicyServiceDeps;
let reservationDeps: ReservationServiceDeps;

function paymentDeps(): PaymentOrderServiceDeps {
  return { prisma: testDb(), clock, provider: fakePaymentProvider({}) };
}

function checkoutDeps(): CheckoutServiceDeps {
  return {
    prisma: testDb(),
    clock,
    provider: fakePaymentProvider({}),
    providerKeyId: "rzp_test_payafterhold",
  };
}

async function createProduct(): Promise<string> {
  const created = await testDb().product.create({
    data: {
      merchantId: fixture.merchantId,
      sku: uid("SKU"),
      name: "Test Keyboard",
      description: "A keyboard used by the pay-after-hold tests.",
      category: "mechanical-keyboard",
      unitAmount: IN_BUDGET,
      currency: "INR",
      inventory: 20,
      status: "AVAILABLE",
      attributes: { switchType: "linear-red" },
    },
  });
  return created.id;
}

/** Walks a transaction through every real boundary to AUTHORIZED, then INVENTORY_RESERVED. */
async function arrangeReserved(): Promise<{ transactionId: string }> {
  const productId = await createProduct();
  const transaction = await createTransaction(
    {
      buyerProfileId: fixture.buyerId,
      merchantId: fixture.merchantId,
      correlationId: uid("corr"),
    },
    { prisma: testDb() },
  );

  const steps: readonly (readonly [TransactionEvent, TransactionActor])[] = [
    ["PRODUCT_SELECTION_CONFIRMED", "buyer_agent"],
    ["PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service"],
  ];
  for (const [event, actor] of steps) {
    const outcome = await applyTransactionEvent(
      { transactionId: transaction.id, event, actor },
      { prisma: testDb() },
    );
    expect(outcome.kind).toBe("APPLIED");
  }

  const quote = await createTrustedQuote(
    {
      transactionId: transaction.id,
      productId,
      quantity: 1,
      authority: OPEN_AUTHORITY,
      idempotencyKey: uid("quote"),
    },
    quoteDeps,
  );
  const evaluation = await evaluateQuotePolicy(
    { quoteId: quote.snapshot.quoteId, operationId: uid("op") },
    policyDeps,
  );
  expect(evaluation.kind).toBe("EVALUATED");
  // WITHIN_AUTO_APPROVE_LIMIT means AUTHORIZED is reached without a human
  // approval step - exactly the production transaction's own path.
  expect(await statusOf(transaction.id)).toBe("AUTHORIZED");

  const reserved = await reserveInventory(
    { transactionId: transaction.id, operationId: uid("op") },
    reservationDeps,
  );
  expect(reserved.kind).toBe("RESERVED");
  expect(await statusOf(transaction.id)).toBe("INVENTORY_RESERVED");

  return { transactionId: transaction.id };
}

async function statusOf(transactionId: string): Promise<string> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status;
}

describe.skipIf(!databaseConfigured)("Pay after Hold it for me", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Hold Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: { name: "Hold Merchant", slug: uid("hold-merchant"), status: "ACTIVE" },
    });
    fixture = { buyerId: buyer.id, merchantId: merchant.id };
    await testDb().authorizationPolicy.create({
      data: {
        buyerProfileId: fixture.buyerId,
        maxAutoApproveAmount: CEILING,
        currency: "INR",
        autoPurchaseAllowed: true,
        status: "ACTIVE",
        version: 1,
      },
    });

    quoteDeps = { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS };
    policyDeps = { prisma: testDb(), clock, quote: quoteDeps };
    reservationDeps = { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS };
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it(
    "reproduces the exact production refusal: Pay with no prepared order fails " +
      "TRANSACTION_STATE_INVALID from a genuinely held, still-valid reservation",
    async () => {
      const { transactionId } = await arrangeReserved();

      // No createPaymentOrder call here - this is the pre-fix Pay-button
      // behaviour, and the same request the production transaction actually
      // sent. The reservation is active and the quote is valid; only the
      // payment order is missing.
      const started = await startCheckout({ transactionId }, checkoutDeps());

      expect(started).toMatchObject({
        kind: "REFUSED",
        refusal: "TRANSACTION_STATE_INVALID",
        detail: { state: "INVENTORY_RESERVED" },
      });
      // The reservation was never touched by this refusal.
      const reservation = await testDb().inventoryReservation.findFirstOrThrow({
        where: { transactionId },
      });
      expect(reservation.status).toBe("ACTIVE");
    },
  );

  it("the fixed sequence: hold, then prepare the order, then Pay reaches CHECKOUT_READY", async () => {
    const { transactionId } = await arrangeReserved();

    // What the fixed PayButton now does before starting checkout.
    const order = await createPaymentOrder({ transactionId }, paymentDeps());
    expect(order.kind).toBe("ORDER_CREATED");
    expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");

    const started = await startCheckout({ transactionId }, checkoutDeps());
    expect(started).toMatchObject({ kind: "CHECKOUT_READY" });
    if (started.kind !== "CHECKOUT_READY") return;
    expect(started.session.providerOrderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");
  });

  it("preparing the order twice converges rather than creating a second one", async () => {
    // A refreshed page, or a double click, must not mint a second Razorpay
    // order for the same purchase.
    const { transactionId } = await arrangeReserved();

    const first = await createPaymentOrder({ transactionId }, paymentDeps());
    const second = await createPaymentOrder({ transactionId }, paymentDeps());
    expect(first.kind).toBe("ORDER_CREATED");
    expect(second.kind).toBe("ORDER_CREATED");
    if (first.kind !== "ORDER_CREATED" || second.kind !== "ORDER_CREATED") return;
    expect(second.order.providerOrderId).toBe(first.order.providerOrderId);

    const attempts = await testDb().paymentAttempt.findMany({ where: { transactionId } });
    expect(attempts).toHaveLength(1);
  });

  it("still refuses to prepare an order once the stock hold has lapsed", async () => {
    // Held, then the hold's own clock runs out before Pay is ever pressed -
    // a genuinely invalid state, distinct from the missing-order gap above.
    const { transactionId } = await arrangeReserved();
    clock.advanceMs((RESERVATION_TTL_SECONDS + 1) * 1000);
    // Past the reservation window but still inside the quote's, so the only
    // thing that has failed is the stock hold - the same isolation
    // tests/db/payment-order.test.ts uses for this exact precondition.
    const quote = await testDb().purchaseQuote.findFirstOrThrow({
      where: { transactionId },
    });
    await testDb().purchaseQuote.update({
      where: { id: quote.id },
      data: { expiresAt: new Date(clock.now().getTime() + 60_000) },
    });

    const order = await createPaymentOrder({ transactionId }, paymentDeps());
    expect(order).toMatchObject({ kind: "REFUSED", refusal: "RESERVATION_EXPIRED" });
    // Still INVENTORY_RESERVED: a lapsed hold does not silently advance the
    // transaction, and no payment attempt was created for it.
    expect(await statusOf(transactionId)).toBe("INVENTORY_RESERVED");
    expect(
      await testDb().paymentAttempt.findMany({ where: { transactionId } }),
    ).toHaveLength(0);
  });

  it("still refuses Pay once the stock hold has lapsed, even after an order existed", async () => {
    const { transactionId } = await arrangeReserved();
    const order = await createPaymentOrder({ transactionId }, paymentDeps());
    expect(order.kind).toBe("ORDER_CREATED");

    clock.advanceMs((RESERVATION_TTL_SECONDS + 1) * 1000);
    const started = await startCheckout({ transactionId }, checkoutDeps());
    expect(started).toMatchObject({ kind: "REFUSED", refusal: "RESERVATION_NOT_HELD" });
  });
});
