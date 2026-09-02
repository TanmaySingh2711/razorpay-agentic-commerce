import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  startCheckout,
  verifyCheckoutCallback,
  type CheckoutServiceDeps,
} from "@/services/payment/checkout-service";
import {
  processWebhook,
  type WebhookServiceDeps,
} from "@/services/payment/webhook-service";
import { createPaymentOrder } from "@/services/payment/payment-order-service";
import { reserveInventory } from "@/services/inventory/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import { createTrustedQuote } from "@/services/quote/quote-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { getTransactionAuditHistory } from "@/services/audit/audit-service";
import { createTransaction } from "@/services/transaction/creation-service";
import { handleRazorpayWebhook } from "@/app/api/webhooks/razorpay/handler";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor } from "@/domain/transaction/states";
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
 * Webhook reconciliation, against real PostgreSQL and real cryptography.
 *
 * The provider's network is faked; its signature scheme is not. Every signature
 * here is computed with Node's crypto and checked by the real Razorpay adapter,
 * because a fake verifier returning `true` would make every test below vacuous.
 *
 * The database is real because almost everything worth proving in this file is
 * a database property rather than a code path: that a unique index collapses a
 * redelivery, that two concurrent deliveries produce one effect, and — the one
 * that matters most — that a rolled-back transaction leaves *no* trace of the
 * event, so the provider's retry can still do the work.
 *
 * Delivery order is never assumed. Razorpay may send a capture before the
 * browser returns, after it, twice, or after a failure has already been
 * recorded, and each of those is exercised below as its own scenario.
 */

const QUOTE_TTL_SECONDS = 300;
const RESERVATION_TTL_SECONDS = 600;
const CEILING = 300_000n;
const IN_BUDGET = 279_900n; // ₹2,799.00
const NOW = new Date("2026-09-01T09:00:00.000Z");

const KEY_ID = "rzp_test_webhooksuite";
const KEY_SECRET = "webhook_suite_api_secret";
const WEBHOOK_SECRET = "webhook_suite_webhook_secret";
const PAYMENT_ID = "pay_TestModeWebhook01";

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

/** The real adapter, used only for its two signature checks. */
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

function signCallback(orderId: string, paymentId: string): string {
  return createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
}

/** Builds a Razorpay-shaped event body. Returned as the exact string signed. */
function eventBody(options: {
  readonly event: string;
  readonly orderId: string | null;
  readonly paymentId?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly errorCode?: string;
}): string {
  return JSON.stringify({
    event: options.event,
    payload: {
      payment: {
        entity: {
          id: options.paymentId ?? PAYMENT_ID,
          order_id: options.orderId,
          amount: options.amount ?? Number(IN_BUDGET),
          currency: options.currency ?? "INR",
          status: options.event === "payment.captured" ? "captured" : "failed",
          ...(options.errorCode === undefined ? {} : { error_code: options.errorCode }),
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
  return { prisma: testDb(), provider };
}

interface Arranged {
  readonly transactionId: string;
  readonly paymentAttemptId: string;
  readonly providerOrderId: string;
}

/** Drives a transaction through every real boundary to PAYMENT_ORDER_CREATED. */
async function arrange(): Promise<Arranged> {
  const product = await testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name: "Test Keyboard",
      description: "A keyboard used by the webhook tests.",
      category: "mechanical-keyboard",
      unitAmount: IN_BUDGET,
      currency: "INR",
      inventory: 20,
      status: "AVAILABLE",
      attributes: {},
    },
  });

  const transaction = await createTransaction(
    { buyerProfileId: buyerId, merchantId, correlationId: uid("corr") },
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
  expect(
    (
      await reserveInventory(
        { transactionId: transaction.id, operationId: uid("op") },
        { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
      )
    ).kind,
  ).toBe("RESERVED");

  const order = await createPaymentOrder(
    { transactionId: transaction.id },
    { prisma: testDb(), clock, provider },
  );
  if (order.kind !== "ORDER_CREATED") throw new Error("expected an order");

  return {
    transactionId: transaction.id,
    paymentAttemptId: order.order.paymentAttemptId,
    providerOrderId: order.order.providerOrderId,
  };
}

/** Arranges, then presses Pay, leaving the transaction at PAYMENT_PENDING. */
async function arrangePending(): Promise<Arranged> {
  const arranged = await arrange();
  expect(
    (await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps())).kind,
  ).toBe("CHECKOUT_READY");
  return arranged;
}

/** Arranges, presses Pay, and completes the browser callback. */
async function arrangeVerified(): Promise<Arranged> {
  const arranged = await arrangePending();
  const result = await verifyCheckoutCallback(
    {
      transactionId: arranged.transactionId,
      paymentAttemptId: arranged.paymentAttemptId,
      providerPaymentId: PAYMENT_ID,
      signature: signCallback(arranged.providerOrderId, PAYMENT_ID),
    },
    checkoutDeps(),
  );
  expect(result.kind).toBe("PAYMENT_VERIFIED");
  return arranged;
}

/** Delivers one authentic webhook. */
async function deliver(rawBody: string, eventId: string) {
  return await processWebhook(
    { rawBody, signature: signWebhook(rawBody), providerEventId: eventId },
    webhookDeps(),
  );
}

async function statusOf(transactionId: string): Promise<string> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status;
}

async function attemptOf(transactionId: string) {
  return await testDb().paymentAttempt.findFirstOrThrow({ where: { transactionId } });
}

async function auditOf(transactionId: string) {
  return await getTransactionAuditHistory(transactionId, { prisma: testDb() });
}

async function transitionsOf(transactionId: string) {
  return await testDb().transactionStateTransition.findMany({
    where: { transactionId },
    orderBy: { sequence: "asc" },
  });
}

describe.skipIf(!databaseConfigured)("webhook reconciliation", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    provider = fakePaymentProvider({
      onVerify: (input) => realVerifier.verifyCheckoutSignature(input),
      onVerifyWebhook: (input) => realVerifier.verifyWebhookSignature(input),
    });
    buyerId = (
      await testDb().buyerProfile.create({ data: { displayName: "Webhook Buyer" } })
    ).id;
    merchantId = (
      await testDb().merchant.create({
        data: { name: "Keebworks India", slug: uid("webhook-m"), status: "ACTIVE" },
      })
    ).id;
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

  // -------------------------------------------------------------------------
  // Ordering: the provider decides when events arrive, and we do not.
  // -------------------------------------------------------------------------

  describe("delivery order", () => {
    it("A. captures from PAYMENT_PENDING, without a browser callback", async () => {
      // The buyer's browser closed, crashed or lost signal after paying. The
      // money still moved, and a missed callback must not stop us learning it.
      const { transactionId, providerOrderId } = await arrangePending();

      const result = await deliver(
        eventBody({ event: "payment.captured", orderId: providerOrderId }),
        uid("evt"),
      );

      expect(result).toMatchObject({
        kind: "RECONCILED",
        transactionState: "PAYMENT_CAPTURED",
      });
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");

      // The arrival is recorded as an observation in its own right, before the
      // conclusion drawn from it, so the trail shows both.
      const trail = await auditOf(transactionId);
      expect(trail.filter((e) => e.action === "webhook_received")).toHaveLength(1);
      expect(trail.filter((e) => e.action === "payment_captured")).toHaveLength(1);

      // The payment id was learned here for the first time.
      const attempt = await attemptOf(transactionId);
      expect(attempt.providerPaymentId).toBe(PAYMENT_ID);
      expect(attempt.status).toBe("CAPTURED");
    });

    it("B. captures from PAYMENT_VERIFIED, the ordinary path", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();
      expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");

      const result = await deliver(
        eventBody({ event: "payment.captured", orderId: providerOrderId }),
        uid("evt"),
      );

      expect(result).toMatchObject({
        kind: "RECONCILED",
        transactionState: "PAYMENT_CAPTURED",
      });
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
    });

    it("C. stays captured when the same capture is redelivered", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();
      const body = eventBody({ event: "payment.captured", orderId: providerOrderId });
      const eventId = uid("evt");

      expect((await deliver(body, eventId)).kind).toBe("RECONCILED");
      const after = await transitionsOf(transactionId);

      const second = await deliver(body, eventId);

      expect(second).toMatchObject({ kind: "DUPLICATE" });
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
      // No second transition, and no second audit row for the capture.
      expect(await transitionsOf(transactionId)).toHaveLength(after.length);
      expect(
        (await auditOf(transactionId)).filter((e) => e.action === "payment_captured"),
      ).toHaveLength(1);
    });

    it("D. stays captured when a stale failure arrives afterwards", async () => {
      // The single most dangerous ordering: a failure event delayed behind a
      // capture. Money moved; a late 'failed' must not unwind that.
      const { transactionId, providerOrderId } = await arrangeVerified();
      expect(
        (
          await deliver(
            eventBody({ event: "payment.captured", orderId: providerOrderId }),
            uid("evt"),
          )
        ).kind,
      ).toBe("RECONCILED");

      const stale = await deliver(
        eventBody({
          event: "payment.failed",
          orderId: providerOrderId,
          errorCode: "BANK_DECLINED",
        }),
        uid("evt"),
      );

      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");

      // The attempt must agree with the transaction it belongs to. An earlier
      // version of this service wrote the attempt from the event rather than
      // from the transition, leaving attempt=FAILED under a transaction that
      // said PAYMENT_CAPTURED - a financial record contradicting itself, which
      // the transaction-state assertion above cannot catch on its own.
      const attempt = await attemptOf(transactionId);
      expect(attempt.status).toBe("CAPTURED");
      expect(attempt.failureCode).toBeNull();

      // The event is not discarded either - it is recorded as acknowledged
      // without action, because money events must never be silently dropped.
      expect(stale.kind).toBe("RECONCILED");
      if (stale.kind !== "RECONCILED") return;
      expect(stale.alreadyAccountedFor).toBe(true);
      expect(stale.transactionState).toBe("PAYMENT_CAPTURED");

      // And it reads as what happened, not as what it reported. Recording a
      // `payment_failed` here would make the trail say the payment failed.
      const trail = await auditOf(transactionId);
      expect(trail.filter((e) => e.action === "payment_failed")).toHaveLength(0);
      expect(trail.filter((e) => e.action === "webhook_ignored")).toHaveLength(1);
    });

    it("E. captures after a failure was already recorded", async () => {
      // Razorpay reported a failure, then the payment genuinely succeeded.
      // Only verified provider evidence may take this edge.
      const { transactionId, providerOrderId } = await arrangePending();
      expect(
        (
          await deliver(
            eventBody({
              event: "payment.failed",
              orderId: providerOrderId,
              errorCode: "BANK_DECLINED",
            }),
            uid("evt"),
          )
        ).kind,
      ).toBe("RECONCILED");
      expect(await statusOf(transactionId)).toBe("PAYMENT_FAILED");

      const late = await deliver(
        eventBody({ event: "payment.captured", orderId: providerOrderId }),
        uid("evt"),
      );

      expect(late).toMatchObject({
        kind: "RECONCILED",
        transactionState: "PAYMENT_CAPTURED",
      });
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
      // The history records how it got there, rather than overwriting it.
      const reasons = (await transitionsOf(transactionId)).map((t) => t.reasonCode);
      expect(reasons).toContain("LATE_CAPTURE_RECONCILED");
    });

    it("F. a browser callback arriving after capture cannot regress the state", async () => {
      const { transactionId, paymentAttemptId, providerOrderId } = await arrangePending();
      expect(
        (
          await deliver(
            eventBody({ event: "payment.captured", orderId: providerOrderId }),
            uid("evt"),
          )
        ).kind,
      ).toBe("RECONCILED");
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");

      // The browser finally comes back with a genuine, correctly signed callback.
      const callback = await verifyCheckoutCallback(
        {
          transactionId,
          paymentAttemptId,
          providerPaymentId: PAYMENT_ID,
          signature: signCallback(providerOrderId, PAYMENT_ID),
        },
        checkoutDeps(),
      );

      expect(callback.kind).toBe("PAYMENT_VERIFIED");
      // Authentic, and it moves nothing: capture already accounted for it.
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
      // And the answer says so. Reporting PAYMENT_VERIFIED as the transaction's
      // state here would be a lie to the browser about where the money got to.
      if (callback.kind !== "PAYMENT_VERIFIED") return;
      expect(callback.transactionState).toBe("PAYMENT_CAPTURED");
      expect(callback.replayed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency, at the database rather than in memory.
  // -------------------------------------------------------------------------

  describe("idempotency", () => {
    it("collapses two simultaneous deliveries of one event into one effect", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();
      const body = eventBody({ event: "payment.captured", orderId: providerOrderId });
      const eventId = uid("evt");

      // Two clients, so the two deliveries hold two separate connections and
      // race for real. Sharing one client would leave it to the connection
      // pool, which may serialise them - turning the one test that proves the
      // database is the deduplicator into a sequential test that cannot fail.
      const clientA = freshTestClient();
      const clientB = freshTestClient();
      const race = (prisma: typeof clientA) =>
        processWebhook(
          { rawBody: body, signature: signWebhook(body), providerEventId: eventId },
          { prisma, provider },
        );

      let first: Awaited<ReturnType<typeof race>>;
      let second: Awaited<ReturnType<typeof race>>;
      try {
        [first, second] = await Promise.all([race(clientA), race(clientB)]);
      } finally {
        await clientA.$disconnect();
        await clientB.$disconnect();
      }

      const kinds = [first.kind, second.kind].sort();
      expect(kinds).toEqual(["DUPLICATE", "RECONCILED"]);
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
      expect(
        (await auditOf(transactionId)).filter((e) => e.action === "payment_captured"),
      ).toHaveLength(1);
      expect(
        await testDb().webhookEvent.count({ where: { externalEventId: eventId } }),
      ).toBe(1);
    });

    it("records a failure once, however many times it is delivered", async () => {
      const { transactionId, providerOrderId } = await arrangePending();
      const body = eventBody({
        event: "payment.failed",
        orderId: providerOrderId,
        errorCode: "BANK_DECLINED",
      });
      const eventId = uid("evt");

      expect((await deliver(body, eventId)).kind).toBe("RECONCILED");
      expect((await deliver(body, eventId)).kind).toBe("DUPLICATE");

      expect(await statusOf(transactionId)).toBe("PAYMENT_FAILED");
      expect(
        (await auditOf(transactionId)).filter((e) => e.action === "payment_failed"),
      ).toHaveLength(1);
      const attempt = await attemptOf(transactionId);
      expect(attempt.status).toBe("FAILED");
      // Structured failure information survives for a later objective, and it
      // is a mapped code rather than the provider's prose.
      expect(attempt.failureCode).toBe("BANK_DECLINED");
    });

    it("leaves nothing behind when processing fails, so a retry can still work", async () => {
      // The invariant the single transaction exists for. If the claim committed
      // separately, this event id would be permanently "seen" while nothing had
      // happened - and every Razorpay retry would be waved through as a
      // duplicate, losing the capture for good.
      const { transactionId, providerOrderId } = await arrangeVerified();
      const body = eventBody({ event: "payment.captured", orderId: providerOrderId });
      const eventId = uid("evt");

      const failing = {
        ...webhookDeps(),
        prisma: new Proxy(testDb(), {
          get(target, property, receiver) {
            if (property === "$transaction") {
              return () => Promise.reject(new Error("transient database failure"));
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      } as WebhookServiceDeps;

      await expect(
        processWebhook(
          { rawBody: body, signature: signWebhook(body), providerEventId: eventId },
          failing,
        ),
      ).rejects.toThrow(/transient/);

      // No receipt was left behind by the failed attempt.
      expect(
        await testDb().webhookEvent.count({ where: { externalEventId: eventId } }),
      ).toBe(0);

      // The provider retries, and this time it lands.
      const retried = await deliver(body, eventId);
      expect(retried).toMatchObject({ kind: "RECONCILED" });
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
    });
  });

  // -------------------------------------------------------------------------
  // Authentic, but not necessarily ours.
  // -------------------------------------------------------------------------

  describe("correlation and financial validation", () => {
    it("refuses a capture for an order this server never created", async () => {
      const { transactionId } = await arrangeVerified();

      const result = await deliver(
        eventBody({ event: "payment.captured", orderId: "order_SomebodyElses" }),
        uid("evt"),
      );

      expect(result).toMatchObject({ kind: "MISMATCHED", mismatch: "ORDER_NOT_FOUND" });
      expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
    });

    it("refuses a capture whose amount disagrees with the trusted quote", async () => {
      // A genuine Razorpay signature over a smaller amount. The signature is
      // authentic; the claim is not consistent with what we priced.
      const { transactionId, providerOrderId } = await arrangeVerified();

      const result = await deliver(
        eventBody({ event: "payment.captured", orderId: providerOrderId, amount: 100 }),
        uid("evt"),
      );

      expect(result).toMatchObject({ kind: "MISMATCHED", mismatch: "AMOUNT_MISMATCH" });
      expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
      expect((await attemptOf(transactionId)).status).not.toBe("CAPTURED");

      // The disagreement is recorded, with both figures and no state change.
      const mismatches = (await auditOf(transactionId)).filter(
        (e) => e.action === "webhook_mismatch",
      );
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]?.trustedInputs["amountMinor"]).toBe(IN_BUDGET.toString());
      expect(mismatches[0]?.trustedInputs["observedAmountMinor"]).toBe("100");
    });

    it("refuses a capture in a different currency", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();

      const result = await deliver(
        eventBody({
          event: "payment.captured",
          orderId: providerOrderId,
          currency: "USD",
        }),
        uid("evt"),
      );

      expect(result).toMatchObject({ kind: "MISMATCHED", mismatch: "CURRENCY_MISMATCH" });
      expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
    });

    it("refuses a second, different payment id against a known attempt", async () => {
      // Two payments against one order. Overwriting would quietly rebind the
      // transaction to whichever payment arrived last.
      const { transactionId, providerOrderId } = await arrangeVerified();

      const result = await deliver(
        eventBody({
          event: "payment.captured",
          orderId: providerOrderId,
          paymentId: "pay_ADifferentPayment",
        }),
        uid("evt"),
      );

      expect(result).toMatchObject({
        kind: "MISMATCHED",
        mismatch: "PAYMENT_ID_CONFLICT",
      });
      expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
      expect((await attemptOf(transactionId)).providerPaymentId).toBe(PAYMENT_ID);
    });

    it("cannot bind one transaction's payment to another transaction", async () => {
      const a = await arrangeVerified();
      const b = await arrangePending();

      // A genuine capture for A's order, delivered while naming B's amount is
      // impossible - so the realistic attack is to aim A's event at B by using
      // B's order id with A's payment. Correlation follows the order id, so the
      // event lands on B and is refused on the payment relationship instead.
      const result = await deliver(
        eventBody({ event: "payment.captured", orderId: b.providerOrderId, amount: 1 }),
        uid("evt"),
      );

      expect(result).toMatchObject({ kind: "MISMATCHED", mismatch: "AMOUNT_MISMATCH" });
      expect(await statusOf(a.transactionId)).toBe("PAYMENT_VERIFIED");
      expect(await statusOf(b.transactionId)).toBe("PAYMENT_PENDING");
    });
  });

  // -------------------------------------------------------------------------
  // Events we do not act on, and the HTTP boundary.
  // -------------------------------------------------------------------------

  describe("unsupported events and the route", () => {
    it("acknowledges a correctly signed event it does not act on, changing nothing", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();

      const result = await deliver(
        eventBody({ event: "payment.authorized", orderId: providerOrderId }),
        uid("evt"),
      );

      expect(result).toMatchObject({ kind: "IGNORED", eventType: "payment.authorized" });
      expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
      expect((await attemptOf(transactionId)).status).not.toBe("CAPTURED");
    });

    it("answers 200 for a genuine event and 401 for a forged one", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();
      const body = eventBody({ event: "payment.captured", orderId: providerOrderId });

      const genuine = await handleRazorpayWebhook(
        new Request("https://staging.test/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-razorpay-signature": signWebhook(body),
            "x-razorpay-event-id": uid("evt"),
          },
          body,
        }),
        webhookDeps(),
      );
      expect(genuine.status).toBe(200);
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");

      const forged = await handleRazorpayWebhook(
        new Request("https://staging.test/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-razorpay-signature": "f".repeat(64),
            "x-razorpay-event-id": uid("evt"),
          },
          body: eventBody({ event: "payment.failed", orderId: providerOrderId }),
        }),
        webhookDeps(),
      );
      expect(forged.status).toBe(401);
      // The forgery changed nothing, and left no receipt behind.
      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
    });

    it("tells an unauthenticated caller nothing about why it failed", async () => {
      const { providerOrderId } = await arrangeVerified();
      const bodies = [
        eventBody({ event: "payment.captured", orderId: providerOrderId }),
        eventBody({ event: "payment.captured", orderId: "order_DoesNotExist" }),
        "not json",
      ];

      const payloads = await Promise.all(
        bodies.map(async (body) => {
          const response = await handleRazorpayWebhook(
            new Request("https://staging.test/api/webhooks/razorpay", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-razorpay-signature": "e".repeat(64),
                "x-razorpay-event-id": uid("evt"),
              },
              body,
            }),
            webhookDeps(),
          );
          return `${String(response.status)} ${await response.text()}`;
        }),
      );

      // Identical answers. A stranger cannot use this endpoint to discover
      // whether an order exists, or which of their guesses was closer.
      expect(new Set(payloads).size).toBe(1);
      expect(payloads[0]).not.toMatch(/order_/);
    });
  });

  // -------------------------------------------------------------------------
  // The boundary this objective must not cross.
  // -------------------------------------------------------------------------

  describe("capture is not completion", () => {
    it("stops at PAYMENT_CAPTURED, without completing or committing stock", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();
      // Reached through the reservation, not through Transaction.productId -
      // that column is only set by the agent flow, and this transaction was
      // arranged through the payment boundaries.
      const stockOf = async (): Promise<{
        inventory: number;
        reservedQuantity: number;
      }> => {
        const held = await testDb().inventoryReservation.findFirstOrThrow({
          where: { transactionId },
          select: { productId: true },
        });
        return await testDb().product.findUniqueOrThrow({
          where: { id: held.productId },
          select: { inventory: true, reservedQuantity: true },
        });
      };
      const before = await stockOf();

      await deliver(
        eventBody({ event: "payment.captured", orderId: providerOrderId }),
        uid("evt"),
      );

      expect(await statusOf(transactionId)).toBe("PAYMENT_CAPTURED");
      const row = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { status: true, completedAt: true },
      });
      expect(row.status).not.toBe("COMPLETED");
      expect(row.completedAt).toBeNull();

      // Stock stays reserved, not sold. Fulfilment is a later objective.
      expect(await stockOf()).toEqual(before);
      const reservation = await testDb().inventoryReservation.findFirstOrThrow({
        where: { transactionId },
      });
      expect(reservation.status).toBe("ACTIVE");
      expect(reservation.committedAt).toBeNull();
    });

    it("writes no secret into the audit trail", async () => {
      const { transactionId, providerOrderId } = await arrangeVerified();
      await deliver(
        eventBody({ event: "payment.captured", orderId: providerOrderId }),
        uid("evt"),
      );

      const serialised = JSON.stringify(await auditOf(transactionId));
      expect(serialised).not.toContain(WEBHOOK_SECRET);
      expect(serialised).not.toContain(KEY_SECRET);
      // No 64-character hex blob: no signature or HMAC material was recorded.
      expect(serialised).not.toMatch(/[0-9a-f]{64}/i);
    });
  });
});
