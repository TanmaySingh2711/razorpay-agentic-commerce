import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  startCheckout,
  type CheckoutServiceDeps,
} from "@/services/payment/checkout-service";
import {
  processWebhook,
  type WebhookServiceDeps,
} from "@/services/payment/webhook-service";
import {
  requestPaymentRetry,
  type RetryServiceDeps,
} from "@/services/payment/retry-service";
import { createPaymentOrder } from "@/services/payment/payment-order-service";
import { reserveInventory } from "@/services/inventory/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import { createTrustedQuote } from "@/services/quote/quote-service";
import { requestApproval, decideApproval } from "@/services/approval/approval-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { createTransaction } from "@/services/transaction/creation-service";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { MAX_PAYMENT_ATTEMPTS } from "@/domain/payment/retry";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor } from "@/domain/transaction/states";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  fakePaymentProvider,
  type FakePaymentProvider,
} from "../support/fake-payment-provider";
import {
  databaseConfigured,
  disconnectTestDb,
  freshTestClient,
  resetTestData,
  testDb,
  uid,
} from "./harness";

/**
 * The controlled retry's own re-quote path, against real PostgreSQL.
 *
 * Before this file, a retry whose quote had gone stale - the ordinary case,
 * since the quote's TTL is shorter than the reservation's - could not be
 * exercised at all: `evaluateRetryEligibility` refused it outright and ended
 * the workflow, on the stated theory that there is "no legal path from
 * PAYMENT_FAILED back to quoting". That theory made this exact production
 * failure inevitable rather than rare: on a real Test Mode bank page, a
 * genuine decline plus the time to notice it and click Retry reliably outlasts
 * a five-minute quote.
 *
 * What is proved here is the replacement: a stale quote (or one made stale by
 * a price, currency or stock change) triggers a fresh, fully re-derived quote
 * and policy pass - never a silent reprice, never a second reservation, never
 * a bypassed retry limit - before the retry is allowed to touch the provider.
 */

const QUOTE_TTL_SECONDS = 300;
const RESERVATION_TTL_SECONDS = 600;
const CEILING = 300_000n;
const PRICE = 279_900n; // ₹2,799.00
const NOW = new Date("2026-09-03T09:00:00.000Z");

const KEY_ID = "rzp_test_requotesuite";
const KEY_SECRET = "requote_suite_api_secret";
const WEBHOOK_SECRET = "requote_suite_webhook_secret";

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

const realVerifier = createRazorpayProvider({
  keyId: KEY_ID,
  keySecret: KEY_SECRET,
  webhookSecret: WEBHOOK_SECRET,
  baseUrl: "https://unused.test/v1",
  fetchImpl: (() => Promise.reject(new Error("no network here"))) as never,
});

function signWebhook(rawBody: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
}

function eventBody(options: {
  readonly event: "payment.captured" | "payment.failed";
  readonly orderId: string;
  readonly paymentId: string;
  readonly amount: number;
}): string {
  return JSON.stringify({
    event: options.event,
    payload: {
      payment: {
        entity: {
          id: options.paymentId,
          order_id: options.orderId,
          amount: options.amount,
          currency: "INR",
          status: options.event === "payment.captured" ? "captured" : "failed",
          ...(options.event === "payment.failed" ? { error_code: "BANK_DECLINED" } : {}),
        },
      },
    },
  });
}

let buyerId = "";
let merchantId = "";
let clock: MutableClock;
let provider: FakePaymentProvider;

function checkoutDeps(): CheckoutServiceDeps {
  return { prisma: testDb(), clock, provider, providerKeyId: KEY_ID };
}

function webhookDeps(): WebhookServiceDeps {
  return { prisma: testDb(), provider, clock };
}

function retryDeps(prisma: PrismaClient = testDb()): RetryServiceDeps {
  const quote = { prisma, clock, ttlSeconds: QUOTE_TTL_SECONDS };
  return {
    prisma,
    clock,
    provider,
    reservation: { prisma, clock, ttlSeconds: RESERVATION_TTL_SECONDS },
    quote,
    policy: { prisma, clock, quote },
  };
}

interface Arranged {
  readonly transactionId: string;
  readonly productId: string;
  readonly quoteId: string;
  readonly reservationId: string;
  readonly providerOrderId: string;
}

async function createProduct(unitAmount: bigint, inventory = 10): Promise<string> {
  const created = await testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name: "Test Keyboard",
      description: "A keyboard used by the requote tests.",
      category: "mechanical-keyboard",
      unitAmount,
      currency: "INR",
      inventory,
      status: "AVAILABLE",
      attributes: {},
    },
  });
  return created.id;
}

/** Drives a transaction to PAYMENT_ORDER_CREATED through every real boundary. */
async function arrange(
  options: { readonly quantity?: number; readonly productId?: string } = {},
): Promise<Arranged> {
  const quantity = options.quantity ?? 1;
  const productId = options.productId ?? (await createProduct(PRICE));

  const transaction = await createTransaction(
    { buyerProfileId: buyerId, merchantId, correlationId: uid("corr") },
    { prisma: testDb() },
  );

  for (const [event, actor] of [
    ["PRODUCT_SELECTION_CONFIRMED", "buyer_agent"],
    ["PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service"],
  ] as const satisfies readonly (readonly [TransactionEvent, TransactionActor])[]) {
    const outcome = await applyTransactionEvent(
      { transactionId: transaction.id, event, actor },
      { prisma: testDb() },
    );
    expect(outcome.kind).toBe("APPLIED");
  }

  const quoteDeps = { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS };
  const quote = await createTrustedQuote(
    {
      transactionId: transaction.id,
      productId,
      quantity,
      authority: { ...OPEN_AUTHORITY, quantity },
      idempotencyKey: uid("quote"),
    },
    quoteDeps,
  );
  const evaluated = await evaluateQuotePolicy(
    { quoteId: quote.snapshot.quoteId, operationId: uid("op") },
    { prisma: testDb(), clock, quote: quoteDeps },
  );
  expect(evaluated.kind).toBe("EVALUATED");
  expect(evaluated.kind === "EVALUATED" && evaluated.decision.decision).toBe("ALLOWED");

  const reserved = await reserveInventory(
    { transactionId: transaction.id, operationId: uid("op") },
    { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
  );
  expect(reserved.kind).toBe("RESERVED");
  if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");

  const order = await createPaymentOrder(
    { transactionId: transaction.id },
    { prisma: testDb(), clock, provider },
  );
  if (order.kind !== "ORDER_CREATED") throw new Error("expected an order");

  return {
    transactionId: transaction.id,
    productId,
    quoteId: quote.snapshot.quoteId,
    reservationId: reserved.reservation.id,
    providerOrderId: order.order.providerOrderId,
  };
}

async function deliver(rawBody: string) {
  return await processWebhook(
    { rawBody, signature: signWebhook(rawBody), providerEventId: uid("evt") },
    webhookDeps(),
  );
}

/** Arranges, starts checkout, and has the provider report a failure. */
async function arrangeFailed(
  options: { readonly quantity?: number; readonly productId?: string } = {},
): Promise<Arranged> {
  const arranged = await arrange(options);
  expect(
    (await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps())).kind,
  ).toBe("CHECKOUT_READY");
  const failed = await deliver(
    eventBody({
      event: "payment.failed",
      orderId: arranged.providerOrderId,
      paymentId: uid("pay").slice(0, 20),
      amount: Number(PRICE),
    }),
  );
  expect(failed.kind).toBe("RECONCILED");
  expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_FAILED");
  return arranged;
}

async function statusOf(transactionId: string): Promise<string> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status;
}

async function attemptsOf(transactionId: string) {
  return await testDb().paymentAttempt.findMany({
    where: { transactionId },
    orderBy: { attemptNumber: "asc" },
  });
}

async function reservationsOf(transactionId: string) {
  return await testDb().inventoryReservation.findMany({
    where: { transactionId },
    orderBy: { createdAt: "asc" },
  });
}

describe.skipIf(!databaseConfigured)("controlled retry: re-quoting a stale quote", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Requote Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: { name: "Requote Merchant", slug: uid("requote-merchant"), status: "ACTIVE" },
    });
    provider = fakePaymentProvider({
      onVerifyWebhook: (input) => realVerifier.verifyWebhookSignature(input),
    });
    buyerId = buyer.id;
    merchantId = merchant.id;
    await testDb().authorizationPolicy.create({
      data: {
        buyerProfileId: buyerId,
        maxAutoApproveAmount: CEILING,
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

  it("re-quotes a quote that merely expired - unchanged product facts - and reaches checkout-ready", async () => {
    const arranged = await arrangeFailed();
    // Past the quote's own TTL, well inside the reservation's - the ordinary
    // shape of this failure, not an edge case.
    clock.advanceMs((QUOTE_TTL_SECONDS + 30) * 1000);

    const result = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(result.kind).toBe("RETRY_STARTED");
    if (result.kind !== "RETRY_STARTED") throw new Error("unreachable");
    expect(result.amount.amountMinor).toBe(PRICE.toString());

    const started = await startCheckout(
      { transactionId: arranged.transactionId },
      checkoutDeps(),
    );
    expect(started.kind).toBe("CHECKOUT_READY");

    expect(await attemptsOf(arranged.transactionId)).toHaveLength(2);
    expect(await reservationsOf(arranged.transactionId)).toHaveLength(1);
  });

  it("uses the new DB price when the price moved, and re-runs policy against it", async () => {
    const arranged = await arrangeFailed();
    await testDb().product.update({
      where: { id: arranged.productId },
      data: { unitAmount: 249_900n, version: { increment: 1 } },
    });

    const result = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(result.kind).toBe("RETRY_STARTED");
    if (result.kind !== "RETRY_STARTED") throw new Error("unreachable");
    expect(result.amount.amountMinor).toBe("249900");

    const evaluated = await testDb().auditEvent.findMany({
      where: { transactionId: arranged.transactionId, eventType: "policy_evaluated" },
      orderBy: { createdAt: "asc" },
    });
    // One evaluation for the first purchase, one fresh evaluation for the retry.
    expect(evaluated).toHaveLength(2);
    expect((evaluated[1]?.metadata as Record<string, unknown>)["amountMinor"]).toBe(
      "249900",
    );
  });

  it("stops for a fresh approval when the new amount exceeds the ceiling, and does not create a second attempt until one is granted", async () => {
    const arranged = await arrangeFailed();
    // Repriced above the ceiling that let the first purchase through untouched.
    await testDb().product.update({
      where: { id: arranged.productId },
      data: { unitAmount: 350_000n, version: { increment: 1 } },
    });

    const first = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(first.kind).toBe("APPROVAL_REQUIRED");
    if (first.kind !== "APPROVAL_REQUIRED") throw new Error("unreachable");
    expect(first.amount.amountMinor).toBe("350000");
    expect(await statusOf(arranged.transactionId)).toBe("APPROVAL_REQUIRED");
    // Still exactly the one attempt from the first purchase - a retry that
    // needs approval must not spend one before it has it.
    expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
    expect(await reservationsOf(arranged.transactionId)).toHaveLength(1);

    // A second click while still awaiting approval must not proceed either -
    // the transaction is no longer at PAYMENT_FAILED or AUTHORIZED, so the
    // gate refuses it cleanly rather than attempting anything.
    const second = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(second.kind).toBe("DENIED");
    if (second.kind === "DENIED") expect(second.denial).toBe("TRANSACTION_STATE_INVALID");
    expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);

    // The human approves the fresh amount, exactly as a first purchase above
    // the ceiling would ask.
    const requested = await requestApproval(
      { transactionId: arranged.transactionId, operationId: uid("op") },
      { prisma: testDb(), clock, ttlSeconds: 900 },
    );
    expect(requested.kind).toBe("APPROVAL_REQUESTED");
    if (requested.kind !== "APPROVAL_REQUESTED") throw new Error("unreachable");
    const decided = await decideApproval(
      {
        token: requested.token,
        decision: "APPROVE",
        decidedByBuyerId: buyerId,
        operationId: uid("op"),
      },
      { prisma: testDb(), clock, ttlSeconds: 900 },
    );
    expect(decided.kind).toBe("AUTHORIZED");
    expect(await statusOf(arranged.transactionId)).toBe("AUTHORIZED");
    // Approval alone must not have created a payment attempt or a second hold.
    expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
    expect(await reservationsOf(arranged.transactionId)).toHaveLength(1);

    const retried = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(retried.kind).toBe("RETRY_STARTED");
    if (retried.kind !== "RETRY_STARTED") throw new Error("unreachable");
    expect(retried.amount.amountMinor).toBe("350000");
    expect(await attemptsOf(arranged.transactionId)).toHaveLength(2);
    // Still one reservation row throughout - rebound, never re-claimed.
    expect(await reservationsOf(arranged.transactionId)).toHaveLength(1);
  });

  it("safely refuses when the product can no longer be sold, spending no attempt and creating nothing new", async () => {
    const arranged = await arrangeFailed();
    await testDb().product.update({
      where: { id: arranged.productId },
      data: { status: "OUT_OF_STOCK" },
    });

    const result = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(result.kind).toBe("DENIED");
    if (result.kind !== "DENIED") throw new Error("unreachable");
    expect(result.denial).toBe("FINANCIAL_FACTS_CHANGED");
    expect(result.reservationReleased).toBe(true);
    expect(provider.createRequests).toHaveLength(1);

    expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
    const reservations = await reservationsOf(arranged.transactionId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe("RELEASED");
  });

  it("safely refuses when the product's currency changed, a second way the facts can move", async () => {
    // `INSUFFICIENT_STOCK` specifically is structurally unreachable here: the
    // still-ACTIVE reservation this path requires already counts this
    // transaction's own quantity inside `reservedQuantity`, and the database's
    // own CHECK constraint (`reservedQuantity <= inventory`) guarantees
    // `inventory` can never read below it while the hold survives.
    //
    // Currency is caught one layer later than price or availability: the
    // retry's own re-quote authority states no currency preference (it is not
    // the shopper restating one, only the same product and quantity), so
    // `createTrustedQuote` freely re-quotes in the product's new currency - and
    // it is the policy engine, comparing that quote's currency against the
    // buyer's INR-denominated policy, that then blocks it. Different mechanism,
    // same outcome this test is actually about: the retry is safely refused
    // and nothing further is created.
    const arranged = await arrangeFailed();
    await testDb().product.update({
      where: { id: arranged.productId },
      data: { currency: "USD", version: { increment: 1 } },
    });

    const result = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(result.kind).toBe("DENIED");
    if (result.kind !== "DENIED") throw new Error("unreachable");
    expect(result.denial).toBe("FINANCIAL_FACTS_CHANGED");
    expect(result.detail["reasonCode"]).toBe("UNSUPPORTED_CURRENCY");
    expect(result.reservationReleased).toBe(true);
    expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
  });

  it("still enforces the retry limit even when the quote has also gone stale", async () => {
    const arranged = await arrangeFailed();
    // Burn every remaining attempt with ordinary, same-price retries.
    for (let used = 1; used < MAX_PAYMENT_ATTEMPTS; used += 1) {
      const retried = await requestPaymentRetry(
        { transactionId: arranged.transactionId },
        retryDeps(),
      );
      expect(retried.kind).toBe("RETRY_STARTED");
      if (retried.kind !== "RETRY_STARTED") throw new Error("unreachable");
      const providerOrder = await testDb().paymentAttempt.findUniqueOrThrow({
        where: { id: retried.paymentAttemptId },
        select: { providerOrderId: true },
      });
      const failed = await deliver(
        eventBody({
          event: "payment.failed",
          orderId: providerOrder.providerOrderId ?? "",
          paymentId: uid("pay").slice(0, 20),
          amount: Number(PRICE),
        }),
      );
      expect(failed.kind).toBe("RECONCILED");
    }
    expect(await attemptsOf(arranged.transactionId)).toHaveLength(MAX_PAYMENT_ATTEMPTS);

    // Now also let the quote go stale, on top of the limit already being spent.
    clock.advanceMs((QUOTE_TTL_SECONDS + 30) * 1000);

    const final = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(final.kind).toBe("DENIED");
    if (final.kind !== "DENIED") throw new Error("unreachable");
    expect(final.denial).toBe("RETRY_LIMIT_REACHED");
    // The limit was the reason, not a re-quote that was never attempted -
    // exactly one quote exists per attempt cycle, no extra one for this call.
    const quotes = await testDb().purchaseQuote.findMany({
      where: { transactionId: arranged.transactionId },
    });
    expect(quotes).toHaveLength(1);
  });

  it("never reuses or revives the old quote - it stays superseded, permanently", async () => {
    const arranged = await arrangeFailed();
    await testDb().product.update({
      where: { id: arranged.productId },
      data: { unitAmount: 249_900n, version: { increment: 1 } },
    });

    const result = await requestPaymentRetry(
      { transactionId: arranged.transactionId },
      retryDeps(),
    );
    expect(result.kind).toBe("RETRY_STARTED");

    const oldQuote = await testDb().purchaseQuote.findUniqueOrThrow({
      where: { id: arranged.quoteId },
    });
    expect(oldQuote.status).toBe("SUPERSEDED");
    expect(oldQuote.totalAmount).toBe(PRICE);

    // A later, unrelated read must not flip it back - nothing in this system
    // ever un-supersedes a quote.
    await requestPaymentRetry({ transactionId: arranged.transactionId }, retryDeps());
    const stillSuperseded = await testDb().purchaseQuote.findUniqueOrThrow({
      where: { id: arranged.quoteId },
    });
    expect(stillSuperseded.status).toBe("SUPERSEDED");

    const activeQuotes = await testDb().purchaseQuote.findMany({
      where: { transactionId: arranged.transactionId, status: "ACTIVE" },
    });
    expect(activeQuotes).toHaveLength(1);
    expect(activeQuotes[0]?.id).not.toBe(arranged.quoteId);
  });

  it("creates no duplicate reservation, attempt or provider order under concurrent retry calls", async () => {
    const arranged = await arrangeFailed();
    clock.advanceMs((QUOTE_TTL_SECONDS + 30) * 1000);

    const clientA = freshTestClient();
    const clientB = freshTestClient();
    const outcomes = await Promise.allSettled([
      requestPaymentRetry({ transactionId: arranged.transactionId }, retryDeps(clientA)),
      requestPaymentRetry({ transactionId: arranged.transactionId }, retryDeps(clientB)),
    ]);
    await clientA.$disconnect();
    await clientB.$disconnect();

    const started = outcomes.filter(
      (o) => o.status === "fulfilled" && o.value.kind === "RETRY_STARTED",
    );
    // Exactly one call wins the re-quote itself: `createTrustedQuote`'s own
    // concurrency guard is the partial unique index permitting only one
    // ACTIVE quote per transaction, so the loser's insert violates it and
    // that call rejects outright - caught safely at the HTTP boundary
    // (`respond()`), never left unhandled, and never silently swallowed. What
    // matters is not that both calls succeed, only that neither duplicates a
    // reservation, an attempt or a provider order - that is what the rest of
    // this test asserts.
    expect(started.length).toBeGreaterThanOrEqual(1);

    const attempts = await attemptsOf(arranged.transactionId);
    // The original failed attempt, plus exactly one new one - never two.
    expect(attempts).toHaveLength(2);
    const reservations = await reservationsOf(arranged.transactionId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe("ACTIVE");
    expect(provider.createRequests).toHaveLength(2);
  });
});
