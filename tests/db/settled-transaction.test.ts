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
import {
  commitReservation,
  releaseReservation,
  reserveInventory,
} from "@/services/inventory/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import { createTrustedQuote } from "@/services/quote/quote-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { createTransaction } from "@/services/transaction/creation-service";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import {
  InvalidTransitionError,
  TerminalStateViolationError,
} from "@/domain/transaction/errors";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionState } from "@/domain/transaction/states";
import {
  fakePaymentProvider,
  type FakePaymentProvider,
} from "../support/fake-payment-provider";
import {
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
  uid,
} from "./harness";

/**
 * Money moves once, and a settled purchase is closed.
 *
 * The other payment suites each prove one mechanism works. This one proves the
 * opposite property, which is the more valuable half of a payment system: that
 * once the money has arrived, every path that could move it again is shut - and
 * shut by the server's own state, not by a browser choosing not to ask.
 *
 * The failure this guards against is not exotic. A buyer who leaves the tab
 * open, presses Pay a second time, refreshes a checkout page, or is handed a
 * stale retry link is doing something entirely ordinary; so is a provider
 * redelivering a webhook. Each of those is a second request against a
 * transaction that has already been paid, and every one of them must end in a
 * refusal that names the state rather than in a second order, a second attempt,
 * a second charge, or a second decrement of stock.
 *
 * Two settled states are covered, because the system genuinely has two:
 * `PAYMENT_CAPTURED`, where the provider has confirmed the money, and
 * `COMPLETED`, the terminal state. They are asserted separately rather than
 * treated as one "success" - collapsing them is the mistake the whole payment
 * design exists to avoid.
 *
 * Everything is driven through the real service boundaries against real
 * PostgreSQL. The provider's network is faked; its signature check is not.
 */

const QUOTE_TTL_SECONDS = 900;
const RESERVATION_TTL_SECONDS = 3600;
const PRICE = 279_900n;
const CEILING = 300_000n;
const NOW = new Date("2026-09-03T09:00:00.000Z");

const KEY_ID = "rzp_test_settledsuite";
const KEY_SECRET = "settled_suite_api_secret";
const WEBHOOK_SECRET = "settled_suite_webhook_secret";

/** The real adapter, used only for its cryptography. */
const realVerifier = createRazorpayProvider({
  keyId: KEY_ID,
  keySecret: KEY_SECRET,
  webhookSecret: WEBHOOK_SECRET,
  baseUrl: "https://unused.test/v1",
  fetchImpl: (() => Promise.reject(new Error("no network here"))) as never,
});

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
let provider: FakePaymentProvider;

function checkoutDeps(): CheckoutServiceDeps {
  return { prisma: testDb(), clock, provider, providerKeyId: KEY_ID };
}

function webhookDeps(): WebhookServiceDeps {
  return { prisma: testDb(), provider };
}

function retryDeps(): RetryServiceDeps {
  return {
    prisma: testDb(),
    clock,
    provider,
    reservation: { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
  };
}

function capturedBody(orderId: string, paymentId: string): string {
  return JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: Number(PRICE),
          currency: "INR",
          status: "captured",
        },
      },
    },
  });
}

async function statusOf(transactionId: string): Promise<TransactionState> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status as TransactionState;
}

interface Settled {
  readonly transactionId: string;
  readonly productId: string;
  readonly reservationId: string;
  readonly providerOrderId: string;
  /** The payment that actually settled. A redelivery must name this one. */
  readonly paymentId: string;
}

/** Drives one purchase through every real boundary until the money has landed. */
async function arrangeCaptured(): Promise<Settled> {
  const product = await testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name: "Test Keyboard",
      description: "A keyboard used by the settlement tests.",
      category: "mechanical-keyboard",
      unitAmount: PRICE,
      currency: "INR",
      inventory: 5,
      status: "AVAILABLE",
      attributes: {},
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
    expect(
      (
        await applyTransactionEvent(
          { transactionId: transaction.id, event, actor },
          { prisma: testDb() },
        )
      ).kind,
    ).toBe("APPLIED");
  }

  const quoteDeps = { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS };
  const quote = await createTrustedQuote(
    {
      transactionId: transaction.id,
      productId: product.id,
      quantity: 1,
      authority: OPEN_AUTHORITY,
      idempotencyKey: uid("quote"),
    },
    quoteDeps,
  );

  expect(
    (
      await evaluateQuotePolicy(
        { quoteId: quote.snapshot.quoteId, operationId: uid("op") },
        { prisma: testDb(), clock, quote: quoteDeps },
      )
    ).kind,
  ).toBe("EVALUATED");

  const reserved = await reserveInventory(
    { transactionId: transaction.id, operationId: uid("op") },
    { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
  );
  if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");

  const order = await createPaymentOrder(
    { transactionId: transaction.id },
    { prisma: testDb(), clock, provider },
  );
  if (order.kind !== "ORDER_CREATED") throw new Error("expected an order");

  expect(
    (await startCheckout({ transactionId: transaction.id }, checkoutDeps())).kind,
  ).toBe("CHECKOUT_READY");

  const paymentId = uid("pay").slice(0, 20);
  const rawBody = capturedBody(order.order.providerOrderId, paymentId);
  const captured = await processWebhook(
    {
      rawBody,
      signature: createHmac("sha256", WEBHOOK_SECRET)
        .update(rawBody, "utf8")
        .digest("hex"),
      providerEventId: uid("evt"),
    },
    webhookDeps(),
  );
  expect(captured.kind).toBe("RECONCILED");
  expect(await statusOf(transaction.id)).toBe("PAYMENT_CAPTURED");

  return {
    transactionId: transaction.id,
    productId: product.id,
    reservationId: reserved.reservation.id,
    providerOrderId: order.order.providerOrderId,
    paymentId,
  };
}

/** Delivers one authentically signed webhook under a fresh provider event id. */
async function deliver(rawBody: string) {
  return processWebhook(
    {
      rawBody,
      signature: createHmac("sha256", WEBHOOK_SECRET)
        .update(rawBody, "utf8")
        .digest("hex"),
      providerEventId: uid("evt"),
    },
    webhookDeps(),
  );
}

/** Takes a captured purchase the rest of the way to the terminal state. */
async function arrangeCompleted(): Promise<Settled> {
  const settled = await arrangeCaptured();
  const committed = await commitReservation(settled.reservationId, {
    prisma: testDb(),
    clock,
    ttlSeconds: RESERVATION_TTL_SECONDS,
  });
  expect(committed.kind).toBe("COMMITTED");

  expect(
    (
      await applyTransactionEvent(
        {
          transactionId: settled.transactionId,
          event: "TRANSACTION_COMPLETED" as TransactionEvent,
          actor: "transaction_service",
        },
        { prisma: testDb() },
      )
    ).kind,
  ).toBe("APPLIED");
  expect(await statusOf(settled.transactionId)).toBe("COMPLETED");
  return settled;
}

/** Everything that would have to change for a second charge to have happened. */
async function moneyFootprint(transactionId: string) {
  const [attempts, transitions, reservations] = await Promise.all([
    testDb().paymentAttempt.count({ where: { transactionId } }),
    testDb().transactionStateTransition.count({ where: { transactionId } }),
    testDb().inventoryReservation.count({ where: { transactionId } }),
  ]);
  return { attempts, transitions, reservations, status: await statusOf(transactionId) };
}

describe.skipIf(!databaseConfigured)("a settled transaction", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    provider = fakePaymentProvider({
      onVerify: (input) => realVerifier.verifyCheckoutSignature(input),
      onVerifyWebhook: (input) => realVerifier.verifyWebhookSignature(input),
    });

    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Settlement Test Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: { name: "Settlement Test Merchant", slug: uid("merchant") },
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

  describe("once the money has been captured", () => {
    it("refuses a second payment order, and asks the provider for nothing", async () => {
      const settled = await arrangeCaptured();
      const before = await moneyFootprint(settled.transactionId);
      const callsBefore = provider.createRequests.length;

      const second = await createPaymentOrder(
        { transactionId: settled.transactionId },
        { prisma: testDb(), clock, provider },
      );

      // Not a replay of the existing order either: a captured transaction is
      // past the point where "your order is ready, go pay" is a true sentence.
      expect(second.kind).toBe("REFUSED");
      expect(provider.createRequests.length).toBe(callsBefore);
      expect(await moneyFootprint(settled.transactionId)).toEqual(before);
    });

    it("refuses to open a second checkout session", async () => {
      const settled = await arrangeCaptured();
      const before = await moneyFootprint(settled.transactionId);

      const again = await startCheckout(
        { transactionId: settled.transactionId },
        checkoutDeps(),
      );

      // Never CHECKOUT_READY: that answer hands the browser an order id and a
      // key id, which is an invitation to pay for something already paid for.
      // Asserted as the exact refusal rather than "not ready", so a service
      // that started answering IGNORED - or throwing - would be noticed.
      expect(again).toMatchObject({
        kind: "REFUSED",
        refusal: "TRANSACTION_STATE_INVALID",
      });
      expect(await moneyFootprint(settled.transactionId)).toEqual(before);
    });

    it("refuses a retry, naming the capture rather than a generic state error", async () => {
      const settled = await arrangeCaptured();
      const before = await moneyFootprint(settled.transactionId);

      const retry = await requestPaymentRetry(
        { transactionId: settled.transactionId, operationId: uid("op") },
        retryDeps(),
      );

      expect(retry.kind).toBe("DENIED");
      if (retry.kind === "DENIED") expect(retry.denial).toBe("PAYMENT_ALREADY_CAPTURED");
      expect(await moneyFootprint(settled.transactionId)).toEqual(before);
    });

    it("cannot be walked backwards into paying again by a state event", async () => {
      // The service guards are one layer; the state machine is the other. Even
      // a caller that reached the transition service directly cannot re-open a
      // captured purchase for payment.
      const settled = await arrangeCaptured();

      // Each is refused loudly rather than reported as a soft outcome: an
      // invalid step against a paid transaction is a defect in the caller, and
      // a return value could be ignored where an exception cannot.
      for (const event of [
        "PAYMENT_INITIATED",
        "PAYMENT_ORDER_CREATED",
        "INVENTORY_RESERVED",
      ] as TransactionEvent[]) {
        await expect(
          applyTransactionEvent(
            { transactionId: settled.transactionId, event, actor: "payment_provider" },
            { prisma: testDb() },
          ),
          event,
        ).rejects.toBeInstanceOf(InvalidTransitionError);
      }
      expect(await statusOf(settled.transactionId)).toBe("PAYMENT_CAPTURED");
    });

    it("sells the stock exactly once, however often the commit is replayed", async () => {
      const settled = await arrangeCaptured();
      const stockBefore = await testDb().product.findUniqueOrThrow({
        where: { id: settled.productId },
        select: { inventory: true, reservedQuantity: true },
      });

      const first = await commitReservation(settled.reservationId, {
        prisma: testDb(),
        clock,
        ttlSeconds: RESERVATION_TTL_SECONDS,
      });
      expect(first.kind).toBe("COMMITTED");

      const afterFirst = await testDb().product.findUniqueOrThrow({
        where: { id: settled.productId },
        select: { inventory: true, reservedQuantity: true },
      });
      expect(afterFirst.inventory).toBe(stockBefore.inventory - 1);

      // Three replays, concurrently. The conditional UPDATE from ACTIVE is what
      // authorises the decrement, so only the first can find a claim to spend.
      const replays = await Promise.all(
        [0, 1, 2].map(() =>
          commitReservation(settled.reservationId, {
            prisma: testDb(),
            clock,
            ttlSeconds: RESERVATION_TTL_SECONDS,
          }),
        ),
      );
      expect(replays.every((result) => result.kind !== "COMMITTED")).toBe(true);

      const afterReplays = await testDb().product.findUniqueOrThrow({
        where: { id: settled.productId },
        select: { inventory: true, reservedQuantity: true },
      });
      expect(afterReplays).toEqual(afterFirst);
    });

    it("will not give committed stock back", async () => {
      // Releasing a sold unit would return it to the shelf while the buyer
      // still owns it, which is the overselling failure arriving late.
      const settled = await arrangeCaptured();
      expect(
        (
          await commitReservation(settled.reservationId, {
            prisma: testDb(),
            clock,
            ttlSeconds: RESERVATION_TTL_SECONDS,
          })
        ).kind,
      ).toBe("COMMITTED");

      const stock = await testDb().product.findUniqueOrThrow({
        where: { id: settled.productId },
        select: { inventory: true, reservedQuantity: true },
      });
      const released = await releaseReservation(
        { reservationId: settled.reservationId, reasonCode: "EXPIRED" },
        { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
      );
      expect(released.kind).not.toBe("RELEASED");
      expect(
        await testDb().product.findUniqueOrThrow({
          where: { id: settled.productId },
          select: { inventory: true, reservedQuantity: true },
        }),
      ).toEqual(stock);
    });
  });

  describe("once the transaction is complete", () => {
    it("cannot be completed a second time", async () => {
      const settled = await arrangeCompleted();
      const before = await moneyFootprint(settled.transactionId);

      // Refused as a terminal-state violation specifically, not as a generic
      // invalid step: "this purchase is over" and "that step does not follow"
      // are different facts, and only the first is true here.
      await expect(
        applyTransactionEvent(
          {
            transactionId: settled.transactionId,
            event: "TRANSACTION_COMPLETED" as TransactionEvent,
            actor: "transaction_service",
          },
          { prisma: testDb() },
        ),
      ).rejects.toBeInstanceOf(TerminalStateViolationError);

      expect(await moneyFootprint(settled.transactionId)).toEqual(before);
    });

    it("refuses a payment order, a checkout session and a retry alike", async () => {
      const settled = await arrangeCompleted();
      const before = await moneyFootprint(settled.transactionId);
      const callsBefore = provider.createRequests.length;

      const order = await createPaymentOrder(
        { transactionId: settled.transactionId },
        { prisma: testDb(), clock, provider },
      );
      const checkout = await startCheckout(
        { transactionId: settled.transactionId },
        checkoutDeps(),
      );
      const retry = await requestPaymentRetry(
        { transactionId: settled.transactionId, operationId: uid("op") },
        retryDeps(),
      );

      expect(order.kind).toBe("REFUSED");
      expect(checkout).toMatchObject({
        kind: "REFUSED",
        refusal: "TRANSACTION_STATE_INVALID",
      });
      expect(retry.kind).toBe("DENIED");
      expect(provider.createRequests.length).toBe(callsBefore);
      expect(await moneyFootprint(settled.transactionId)).toEqual(before);
    });

    it("absorbs a redelivery of the very capture that settled it", async () => {
      // A genuine redelivery: the same payment, signed again, under a new
      // provider event id so the event-level dedupe cannot be what saves us.
      // Providers do this routinely, and a terminal transaction must take it
      // without moving.
      const settled = await arrangeCompleted();
      const before = await moneyFootprint(settled.transactionId);

      const late = await deliver(
        capturedBody(settled.providerOrderId, settled.paymentId),
      );

      expect(late.kind).toBe("RECONCILED");
      expect(await moneyFootprint(settled.transactionId)).toEqual(before);
      expect(await statusOf(settled.transactionId)).toBe("COMPLETED");
    });

    it("refuses a different payment claimed against the order it already settled", async () => {
      // Not a redelivery: a second payment id for an order that is already
      // paid. Binding it would attach a stranger's payment to this purchase.
      const settled = await arrangeCompleted();
      const before = await moneyFootprint(settled.transactionId);

      const other = await deliver(
        capturedBody(settled.providerOrderId, uid("pay").slice(0, 20)),
      );

      expect(other.kind).toBe("MISMATCHED");
      expect(await moneyFootprint(settled.transactionId)).toEqual(before);
      expect(await statusOf(settled.transactionId)).toBe("COMPLETED");
    });

    it("keeps exactly one payment attempt and one reservation to its name", async () => {
      const settled = await arrangeCompleted();
      const footprint = await moneyFootprint(settled.transactionId);
      expect(footprint.attempts).toBe(1);
      expect(footprint.reservations).toBe(1);

      const attempt = await testDb().paymentAttempt.findFirstOrThrow({
        where: { transactionId: settled.transactionId },
      });
      expect(attempt.status).toBe("CAPTURED");
      expect(attempt.amount).toBe(PRICE);
    });
  });
});
