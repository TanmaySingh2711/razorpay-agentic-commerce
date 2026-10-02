import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { startCheckout } from "@/services/checkout-service";
import { processWebhook, type WebhookServiceDeps } from "@/services/webhook-service";
import { createPaymentOrder } from "@/services/payment-order-service";
import { reserveInventory } from "@/services/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy-service";
import { createTrustedQuote } from "@/services/quote-service";
import { applyTransactionEvent } from "@/services/transition-service";
import { createTransaction } from "@/services/transaction-creation-service";
import {
  readRefund,
  reconcileRefund,
  requestRefund,
  type RefundServiceDeps,
} from "@/services/refund-service";
import { createRazorpayProvider } from "@/integrations/razorpay-provider";
import { refundReceiptFor } from "@/domain/refund";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/eligibility";
import {
  fakePaymentProvider,
  type FakePaymentProvider,
  type FakePaymentProviderOptions,
} from "../support/fake-payment-provider";
import {
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
  uid,
} from "./harness";

/**
 * Refunds, against real PostgreSQL.
 *
 * The properties that matter are the same ones that matter for taking money,
 * inverted: money goes back **at most once**, only for a purchase that
 * actually completed, in exactly the amount that was captured - and a lost
 * provider answer is settled by reading, never by asking again.
 *
 * The purchase each test refunds is driven to COMPLETED through every real
 * service boundary, including an authentically signed capture webhook. The
 * provider's network is faked; its signature check is not.
 */

const PRICE = 279_900n;
const CEILING = 300_000n;
const KEY_ID = "rzp_test_refundsuite";
const KEY_SECRET = "refund_suite_api_secret";
const WEBHOOK_SECRET = "refund_suite_webhook_secret";

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

function useProvider(options: FakePaymentProviderOptions = {}): void {
  provider = fakePaymentProvider({
    onVerify: (input) => realVerifier.verifyCheckoutSignature(input),
    onVerifyWebhook: (input) => realVerifier.verifyWebhookSignature(input),
    ...options,
  });
}

function refundDeps(windowDays = 7): RefundServiceDeps {
  return { prisma: testDb(), provider, clock, windowDays };
}

function webhookDeps(): WebhookServiceDeps {
  return { prisma: testDb(), provider, clock };
}

function sign(rawBody: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
}

async function deliver(rawBody: string, providerEventId = uid("evt")) {
  return processWebhook(
    { rawBody, signature: sign(rawBody), providerEventId },
    webhookDeps(),
  );
}

function refundEvent(
  event: "refund.processed" | "refund.failed",
  refund: { id: string; paymentId: string; receipt: string | null; amount?: number },
): string {
  return JSON.stringify({
    event,
    payload: {
      refund: {
        entity: {
          id: refund.id,
          payment_id: refund.paymentId,
          amount: refund.amount ?? Number(PRICE),
          currency: "INR",
          receipt: refund.receipt,
          status: event === "refund.processed" ? "processed" : "failed",
        },
      },
    },
  });
}

interface Completed {
  readonly transactionId: string;
  readonly paymentId: string;
}

/** One purchase, driven through every real boundary to COMPLETED. */
async function arrangeCompleted(): Promise<Completed> {
  const product = await testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name: "Refundable Keyboard",
      description: "A keyboard used by the refund tests.",
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
    const applied = await applyTransactionEvent(
      { transactionId: transaction.id, event, actor },
      { prisma: testDb() },
    );
    expect(applied.kind).toBe("APPLIED");
  }
  const quoteDeps = { prisma: testDb(), clock, ttlSeconds: 900 };
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
  const policy = await evaluateQuotePolicy(
    { quoteId: quote.snapshot.quoteId, operationId: uid("op") },
    { prisma: testDb(), clock, quote: quoteDeps },
  );
  expect(policy.kind).toBe("EVALUATED");
  const reserved = await reserveInventory(
    { transactionId: transaction.id, operationId: uid("op") },
    { prisma: testDb(), clock, ttlSeconds: 3600 },
  );
  if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");
  const order = await createPaymentOrder(
    { transactionId: transaction.id },
    { prisma: testDb(), clock, provider, providerKeyId: KEY_ID },
  );
  if (order.kind !== "ORDER_CREATED") throw new Error("expected an order");
  const started = await startCheckout(
    { transactionId: transaction.id },
    { prisma: testDb(), clock, provider, providerKeyId: KEY_ID },
  );
  expect(started.kind).toBe("CHECKOUT_READY");

  const paymentId = `pay_${uid("x").slice(2, 12)}`;
  const captured = await deliver(
    JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: order.order.providerOrderId,
            amount: Number(PRICE),
            currency: "INR",
            status: "captured",
          },
        },
      },
    }),
  );
  expect(captured.kind).toBe("RECONCILED");
  return { transactionId: transaction.id, paymentId };
}

async function refundRows(transactionId: string) {
  return testDb().refund.findMany({
    where: { transactionId },
    orderBy: { createdAt: "asc" },
  });
}

async function auditActions(transactionId: string): Promise<string[]> {
  const rows = await testDb().auditEvent.findMany({
    where: { transactionId, eventType: { startsWith: "refund_" } },
    orderBy: { createdAt: "asc" },
    select: { eventType: true },
  });
  return rows.map((row) => row.eventType);
}

async function statusOf(transactionId: string): Promise<string> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status;
}

describe.skipIf(!databaseConfigured)("refunds", () => {
  beforeEach(async () => {
    await resetTestData();
    // A clock at the real present: `completedAt` is stamped by the database
    // write, so the refund window is measured against real time.
    clock = fixedClock(new Date());
    useProvider();
    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Refund Test Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: { name: "Refund Test Merchant", slug: uid("merchant") },
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

  describe("a completed purchase", () => {
    it("is refunded exactly the captured amount, to the captured payment", async () => {
      const { transactionId, paymentId } = await arrangeCompleted();

      const result = await requestRefund({ transactionId }, refundDeps());

      expect(result).toMatchObject({ kind: "REFUND_STARTED", status: "PROCESSED" });
      expect(provider.refundRequests).toHaveLength(1);
      expect(provider.refundRequests[0]).toMatchObject({
        providerPaymentId: paymentId,
        amountMinor: PRICE,
        currency: "INR",
        receipt: refundReceiptFor(transactionId, 1),
      });
      const [row] = await refundRows(transactionId);
      expect(row?.status).toBe("PROCESSED");
      expect(row?.amount).toBe(PRICE);
      expect(row?.processedAt).not.toBeNull();
      expect(row?.providerRefundId).toMatch(/^rfnd_/);
      expect(await auditActions(transactionId)).toEqual([
        "refund_requested",
        "refund_processed",
      ]);
      // The purchase happened. Returning the money does not rewrite that.
      expect(await statusOf(transactionId)).toBe("COMPLETED");
      expect(await readRefund(testDb(), transactionId)).toMatchObject({
        status: "PROCESSED",
        amount: { amountMinor: PRICE.toString(), currency: "INR" },
      });
    });

    it("is never refunded twice, and a second request asks the provider nothing", async () => {
      const { transactionId } = await arrangeCompleted();
      await requestRefund({ transactionId }, refundDeps());

      const second = await requestRefund({ transactionId }, refundDeps());

      expect(second).toEqual({ kind: "DENIED", denial: "ALREADY_REFUNDED" });
      expect(provider.refundRequests).toHaveLength(1);
      expect(await refundRows(transactionId)).toHaveLength(1);
    });

    it("lets exactly one of two simultaneous requests through", async () => {
      const { transactionId } = await arrangeCompleted();

      const results = await Promise.all([
        requestRefund({ transactionId }, refundDeps()),
        requestRefund({ transactionId }, refundDeps()),
      ]);

      expect(results.filter((r) => r.kind === "REFUND_STARTED")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "DENIED")).toHaveLength(1);
      expect(provider.refundRequests).toHaveLength(1);
      expect(await refundRows(transactionId)).toHaveLength(1);
    });

    it("is refused once the refund window has closed", async () => {
      const { transactionId } = await arrangeCompleted();
      clock.advanceMs(8 * 86_400_000);

      const result = await requestRefund({ transactionId }, refundDeps(7));

      expect(result).toEqual({ kind: "DENIED", denial: "WINDOW_CLOSED" });
      expect(provider.refundRequests).toHaveLength(0);
      expect(await refundRows(transactionId)).toHaveLength(0);
      expect(await auditActions(transactionId)).toEqual(["refund_denied"]);
    });
  });

  describe("a purchase that did not complete", () => {
    it("has nothing to refund, and the provider is never asked", async () => {
      const transaction = await createTransaction(
        { buyerProfileId: buyerId, merchantId, correlationId: uid("corr") },
        { prisma: testDb() },
      );

      const result = await requestRefund({ transactionId: transaction.id }, refundDeps());

      expect(result).toEqual({ kind: "DENIED", denial: "NOT_COMPLETED" });
      expect(provider.refundRequests).toHaveLength(0);
    });

    it("answers an unknown transaction without writing anything", async () => {
      const result = await requestRefund(
        { transactionId: "01930000-0000-7000-8000-000000000000" },
        refundDeps(),
      );
      expect(result).toEqual({ kind: "DENIED", denial: "NOT_COMPLETED" });
      expect(await testDb().refund.count()).toBe(0);
    });
  });

  describe("when the provider refuses", () => {
    it("records the failure, and a later request may try again", async () => {
      useProvider({
        onRefund: () => ({
          kind: "FAILED",
          failure: {
            category: "INVALID_REQUEST",
            code: "BAD_REQUEST_ERROR",
            httpStatus: 400,
          },
        }),
      });
      const { transactionId } = await arrangeCompleted();

      const first = await requestRefund({ transactionId }, refundDeps());
      expect(first).toMatchObject({ kind: "PROVIDER_FAILED" });
      expect((await refundRows(transactionId))[0]?.status).toBe("FAILED");

      // The provider recovers; a failed refund does not block a new one.
      useProvider();
      const second = await requestRefund({ transactionId }, refundDeps());
      expect(second).toMatchObject({ kind: "REFUND_STARTED", status: "PROCESSED" });
      const rows = await refundRows(transactionId);
      expect(rows.map((row) => row.status)).toEqual(["FAILED", "PROCESSED"]);
      expect(rows[1]?.receipt).toBe(refundReceiptFor(transactionId, 2));
    });
  });

  describe("when nobody knows what the provider did", () => {
    const unknown: FakePaymentProviderOptions = {
      onRefund: () => ({
        kind: "UNKNOWN",
        failure: { category: "TIMEOUT", code: "TIMEOUT", httpStatus: null },
      }),
    };

    it("holds the refund for reconciliation and never sends a second one", async () => {
      useProvider(unknown);
      const { transactionId } = await arrangeCompleted();

      const first = await requestRefund({ transactionId }, refundDeps());
      expect(first).toMatchObject({ kind: "RECONCILIATION_REQUIRED" });
      expect((await refundRows(transactionId))[0]?.status).toBe(
        "RECONCILIATION_REQUIRED",
      );

      // An unresolved refund blocks a second: the provider may hold one.
      const again = await requestRefund({ transactionId }, refundDeps());
      expect(again).toEqual({ kind: "DENIED", denial: "ALREADY_REFUNDED" });
      expect(provider.refundRequests).toHaveLength(1);
      expect(await auditActions(transactionId)).toContain("refund_unresolved");
    });

    it("settles it by reading: found means processed", async () => {
      useProvider(unknown);
      const { transactionId, paymentId } = await arrangeCompleted();
      await requestRefund({ transactionId }, refundDeps());

      useProvider({
        onRefundLookup: (providerPaymentId, receipt) => ({
          kind: "FOUND",
          refund: {
            providerRefundId: "rfnd_Reconciled0001",
            providerPaymentId,
            amountMinor: PRICE,
            currency: "INR",
            receipt,
            status: "processed",
          },
        }),
      });
      expect(await reconcileRefund(transactionId, refundDeps())).toBe("PROCESSED");

      const [row] = await refundRows(transactionId);
      expect(row?.status).toBe("PROCESSED");
      expect(row?.providerRefundId).toBe("rfnd_Reconciled0001");
      expect(provider.refundRequests).toHaveLength(0);
      expect(provider.refundLookups[0]?.providerPaymentId).toBe(paymentId);
    });

    it("settles it by reading: absent means it was never made", async () => {
      useProvider(unknown);
      const { transactionId } = await arrangeCompleted();
      await requestRefund({ transactionId }, refundDeps());

      useProvider({ onRefundLookup: () => ({ kind: "NOT_FOUND" }) });
      expect(await reconcileRefund(transactionId, refundDeps())).toBe("FAILED");
      expect((await refundRows(transactionId))[0]?.failureCode).toBe(
        "NOT_FOUND_AT_PROVIDER",
      );
    });
  });

  describe("refund webhooks", () => {
    const pending: FakePaymentProviderOptions = {
      onRefund: (request) => ({
        kind: "CREATED",
        refund: {
          providerRefundId: "rfnd_Pending00001",
          providerPaymentId: request.providerPaymentId,
          amountMinor: request.amountMinor,
          currency: request.currency,
          receipt: request.receipt,
          status: "pending",
        },
      }),
    };

    it("moves a pending refund to processed, once", async () => {
      useProvider(pending);
      const { transactionId, paymentId } = await arrangeCompleted();
      const started = await requestRefund({ transactionId }, refundDeps());
      expect(started).toMatchObject({ kind: "REFUND_STARTED", status: "PENDING" });

      const body = refundEvent("refund.processed", {
        id: "rfnd_Pending00001",
        paymentId,
        receipt: refundReceiptFor(transactionId, 1),
      });
      const first = await deliver(body, "evt_refund_1");
      expect(first).toMatchObject({
        kind: "REFUND_RECONCILED",
        transactionId,
        alreadyAccountedFor: false,
      });
      expect((await refundRows(transactionId))[0]?.status).toBe("PROCESSED");

      // The same delivery again is a duplicate; a different delivery of the
      // same fact changes nothing further.
      expect((await deliver(body, "evt_refund_1")).kind).toBe("DUPLICATE");
      expect(await deliver(body, "evt_refund_2")).toMatchObject({
        kind: "REFUND_RECONCILED",
        alreadyAccountedFor: true,
      });
      expect(
        (await auditActions(transactionId)).filter((a) => a === "refund_processed"),
      ).toHaveLength(1);
      expect(await statusOf(transactionId)).toBe("COMPLETED");
    });

    it("cannot turn a processed refund into a failed one", async () => {
      const { transactionId, paymentId } = await arrangeCompleted();
      await requestRefund({ transactionId }, refundDeps());

      const late = await deliver(
        refundEvent("refund.failed", {
          id: "rfnd_TestMode0000001",
          paymentId,
          receipt: refundReceiptFor(transactionId, 1),
        }),
      );
      expect(late).toMatchObject({
        kind: "REFUND_RECONCILED",
        alreadyAccountedFor: true,
      });
      expect((await refundRows(transactionId))[0]?.status).toBe("PROCESSED");
    });

    it("refuses an event whose amount disagrees with what was asked", async () => {
      useProvider(pending);
      const { transactionId, paymentId } = await arrangeCompleted();
      await requestRefund({ transactionId }, refundDeps());

      const mismatched = await deliver(
        refundEvent("refund.processed", {
          id: "rfnd_Pending00001",
          paymentId,
          receipt: refundReceiptFor(transactionId, 1),
          amount: Number(PRICE) + 100,
        }),
      );
      expect(mismatched).toMatchObject({
        kind: "MISMATCHED",
        mismatch: "AMOUNT_MISMATCH",
      });
      expect((await refundRows(transactionId))[0]?.status).toBe("PENDING");
    });

    it("refuses an event for a refund this system never asked for", async () => {
      const outcome = await deliver(
        refundEvent("refund.processed", {
          id: "rfnd_Stranger0001",
          paymentId: "pay_Stranger0001",
          receipt: "rf_not_ours",
        }),
      );
      expect(outcome).toMatchObject({ kind: "MISMATCHED", mismatch: "REFUND_NOT_FOUND" });
    });

    it("rejects an unsigned refund event before reading it", async () => {
      const body = refundEvent("refund.processed", {
        id: "rfnd_Forged00001",
        paymentId: "pay_Forged00001",
        receipt: "rf_forged",
      });
      const outcome = await processWebhook(
        { rawBody: body, signature: "0".repeat(64), providerEventId: uid("evt") },
        webhookDeps(),
      );
      expect(outcome).toEqual({ kind: "REJECTED", rejection: "SIGNATURE_INVALID" });
    });
  });
});
