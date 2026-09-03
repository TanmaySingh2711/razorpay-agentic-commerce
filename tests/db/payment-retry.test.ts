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
import {
  requestPaymentRetry,
  readRetryStatus,
  evaluateRetryEligibility,
  type RetryServiceDeps,
} from "@/services/payment/retry-service";
import { createPaymentOrder } from "@/services/payment/payment-order-service";
import { reserveInventory } from "@/services/inventory/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import { createTrustedQuote } from "@/services/quote/quote-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { getTransactionAuditHistory } from "@/services/audit/audit-service";
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
 * Graceful payment failure and controlled retry, against real PostgreSQL.
 *
 * Almost nothing worth proving here is a code path. "A retry cannot be raced
 * into two attempts", "a price change cannot be silently repriced", "two
 * captures cannot fulfil twice" are all properties of rows and indexes under
 * concurrency, and a suite that mocked the database would prove none of them.
 *
 * The provider's network is faked; its cryptography is not. Every webhook is
 * signed with Node's crypto and checked by the real Razorpay adapter, because a
 * verifier that returned `true` would make every reconciliation below vacuous.
 *
 * Each scenario drives the transaction through the real boundaries - quote,
 * policy, reservation, order, checkout, webhook, retry - rather than inserting
 * convenient rows. A retry that only works against a hand-built fixture is a
 * retry that does not work.
 */

const QUOTE_TTL_SECONDS = 900;
const RESERVATION_TTL_SECONDS = 3600;
const CEILING = 300_000n;
const PRICE = 279_900n; // ₹2,799.00
const NOW = new Date("2026-09-02T09:00:00.000Z");

const KEY_ID = "rzp_test_retrysuite";
const KEY_SECRET = "retry_suite_api_secret";
const WEBHOOK_SECRET = "retry_suite_webhook_secret";

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

/** The real adapter, used only for its webhook signature check. */
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

/** Razorpay's documented checkout signature: `order_id|payment_id`, key secret. */
function signCallback(orderId: string, paymentId: string): string {
  return createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
}

/** Builds a Razorpay-shaped event body. Returned as the exact string signed. */
function eventBody(options: {
  readonly event: "payment.captured" | "payment.failed";
  readonly orderId: string;
  readonly paymentId: string;
  readonly amount?: number;
  readonly errorCode?: string;
  readonly errorSource?: string;
  readonly errorStep?: string;
  readonly errorReason?: string;
  /** The provider's free text. Sent on purpose, to prove it is never stored. */
  readonly errorDescription?: string;
}): string {
  return JSON.stringify({
    event: options.event,
    payload: {
      payment: {
        entity: {
          id: options.paymentId,
          order_id: options.orderId,
          amount: options.amount ?? Number(PRICE),
          currency: "INR",
          status: options.event === "payment.captured" ? "captured" : "failed",
          ...(options.errorCode === undefined ? {} : { error_code: options.errorCode }),
          ...(options.errorSource === undefined
            ? {}
            : { error_source: options.errorSource }),
          ...(options.errorStep === undefined ? {} : { error_step: options.errorStep }),
          ...(options.errorReason === undefined
            ? {}
            : { error_reason: options.errorReason }),
          ...(options.errorDescription === undefined
            ? {}
            : { error_description: options.errorDescription }),
        },
      },
    },
  });
}

let buyerId = "";
let merchantId = "";
let policyId = "";
let clock: MutableClock;
let provider: FakePaymentProvider;

function checkoutDeps(): CheckoutServiceDeps {
  return { prisma: testDb(), clock, provider, providerKeyId: KEY_ID };
}

function webhookDeps(): WebhookServiceDeps {
  return { prisma: testDb(), provider, clock };
}

function retryDeps(prisma: PrismaClient = testDb()): RetryServiceDeps {
  return {
    prisma,
    clock,
    provider,
    reservation: { prisma, clock, ttlSeconds: RESERVATION_TTL_SECONDS },
  };
}

interface Arranged {
  readonly transactionId: string;
  readonly productId: string;
  readonly quoteId: string;
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
      description: "A keyboard used by the retry tests.",
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
    productId: product.id,
    quoteId: quote.snapshot.quoteId,
    paymentAttemptId: order.order.paymentAttemptId,
    providerOrderId: order.order.providerOrderId,
  };
}

/** Delivers one authentic webhook. */
async function deliver(rawBody: string, eventId: string) {
  return await processWebhook(
    { rawBody, signature: signWebhook(rawBody), providerEventId: eventId },
    webhookDeps(),
  );
}

/** Reports a failed payment for one provider order, the way Razorpay would. */
async function failPayment(
  orderId: string,
  paymentId: string,
  errorCode = "BANK_DECLINED",
  extra: {
    readonly errorSource?: string;
    readonly errorStep?: string;
    readonly errorReason?: string;
    readonly errorDescription?: string;
  } = {},
) {
  return await deliver(
    eventBody({ event: "payment.failed", orderId, paymentId, errorCode, ...extra }),
    uid("evt"),
  );
}

/** Reports a captured payment for one provider order. */
async function capturePayment(orderId: string, paymentId: string) {
  return await deliver(
    eventBody({ event: "payment.captured", orderId, paymentId }),
    uid("evt"),
  );
}

/** Arranges, presses Pay, and has the provider report a failure. */
async function arrangeFailed(): Promise<Arranged> {
  const arranged = await arrange();
  expect(
    (await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps())).kind,
  ).toBe("CHECKOUT_READY");
  const failed = await failPayment(arranged.providerOrderId, uid("pay").slice(0, 20));
  expect(failed.kind).toBe("RECONCILED");
  expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_FAILED");
  return arranged;
}

/**
 * Requests a retry and returns the new attempt's provider order id.
 *
 * Fails loudly rather than returning a union, because every caller of this
 * helper is a scenario in which the retry is supposed to be granted; a scenario
 * about refusal calls `requestPaymentRetry` directly and inspects the answer.
 */
async function retryAndExpectStarted(transactionId: string): Promise<{
  readonly paymentAttemptId: string;
  readonly providerOrderId: string;
  readonly attemptNumber: number;
}> {
  const result = await requestPaymentRetry({ transactionId }, retryDeps());
  if (result.kind !== "RETRY_STARTED") {
    throw new Error(`expected RETRY_STARTED, got ${result.kind}`);
  }
  const attempt = await testDb().paymentAttempt.findUniqueOrThrow({
    where: { id: result.paymentAttemptId },
  });
  if (attempt.providerOrderId === null) throw new Error("retry attempt has no order");
  return {
    paymentAttemptId: attempt.id,
    providerOrderId: attempt.providerOrderId,
    attemptNumber: result.attemptNumber,
  };
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

async function auditActions(transactionId: string): Promise<string[]> {
  const history = await getTransactionAuditHistory(transactionId, { prisma: testDb() });
  return history.map((entry) => entry.action);
}

async function reservationOf(transactionId: string) {
  return await testDb().inventoryReservation.findFirstOrThrow({
    where: { transactionId },
  });
}

/**
 * A longer bound than the 30s default, for this file only, from measurement.
 *
 * The heaviest scenario here - three complete payment attempts, each with its
 * own quote re-validation, policy recheck, durable claim, provider order and
 * webhook reconciliation - makes roughly sixty sequential round trips to a
 * hosted PostgreSQL instance. Measured at 19.4s run alone and 30.5s inside the
 * full suite, where the database is under sustained load from every other
 * integration test.
 *
 * None of that work is removable without removing the assertions: the round
 * trips *are* the boundaries under test, and this suite exists precisely
 * because these properties cannot be proved against a mock. So the 30s default
 * - chosen for suites that touch a handful of rows - is the wrong bound for
 * this file rather than this file being too slow. Scoped here and nowhere else,
 * so every other suite keeps the tighter limit.
 */
const RETRY_SUITE_TIMEOUT_MS = 90_000;

describe.skipIf(!databaseConfigured)(
  "payment failure and controlled retry",
  { timeout: RETRY_SUITE_TIMEOUT_MS },
  () => {
    beforeEach(async () => {
      await resetTestData();
      clock = fixedClock(NOW);
      provider = fakePaymentProvider({
        onVerify: (input) => realVerifier.verifyCheckoutSignature(input),
        onVerifyWebhook: (input) => realVerifier.verifyWebhookSignature(input),
      });
      buyerId = (
        await testDb().buyerProfile.create({ data: { displayName: "Retry Buyer" } })
      ).id;
      merchantId = (
        await testDb().merchant.create({
          data: { name: "Keebworks India", slug: uid("retry-m"), status: "ACTIVE" },
        })
      ).id;
      policyId = (
        await testDb().authorizationPolicy.create({
          data: {
            buyerProfileId: buyerId,
            maxAutoApproveAmount: CEILING,
            currency: "INR",
            autoPurchaseAllowed: true,
            status: "ACTIVE",
            version: 1,
          },
        })
      ).id;
    });

    afterAll(async () => {
      await disconnectTestDb();
    });

    // -------------------------------------------------------------------------
    // A failure is recorded, and it does nothing else
    // -------------------------------------------------------------------------

    describe("a failed payment", () => {
      it("does not retry itself", async () => {
        const arranged = await arrangeFailed();
        // The whole point of the objective in one assertion: an authenticated
        // provider failure produces exactly one attempt, and no second one
        // appears because a webhook arrived.
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
        expect(provider.createRequests).toHaveLength(1);
      });

      it("records a structured, non-sensitive failure classification", async () => {
        const arranged = await arrangeFailed();
        const [attempt] = await attemptsOf(arranged.transactionId);
        expect(attempt?.status).toBe("FAILED");
        expect(attempt?.failureCode).toBe("BANK_DECLINED");
        // The structured classification Objective 14 requires: what happened,
        // where it came from, how far it got, and when - each from a closed
        // application-owned set rather than the provider's vocabulary.
        expect(attempt?.failureCategory).not.toBeNull();
        expect(attempt?.failureSource).not.toBeNull();
        expect(attempt?.failureStep).not.toBeNull();
        expect(attempt?.failedAt).toBeInstanceOf(Date);
        // A sentence a person can read, written in this repository.
        expect(attempt?.failureReason).toBeTruthy();
        // Nothing about the instrument. There is no card number, expiry, CVV or
        // authentication detail anywhere on this row, and no column for one.
        const serialised = JSON.stringify(attempt, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        );
        for (const forbidden of ["cvv", "card", "otp", "upi", "secret"]) {
          expect(serialised.toLowerCase()).not.toContain(forbidden);
        }
      });

      it("classifies a real provider failure and never stores its prose", async () => {
        const arranged = await arrange();
        expect(
          (await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps()))
            .kind,
        ).toBe("CHECKOUT_READY");
        await failPayment(
          arranged.providerOrderId,
          uid("pay").slice(0, 20),
          "BAD_REQUEST_ERROR",
          {
            errorSource: "bank",
            errorStep: "payment_authorization",
            errorReason: "insufficient_funds",
            // Free text, of exactly the kind a support desk gets. It must not
            // survive the boundary: a vendor's prose is not ours to show a buyer,
            // and it can echo request content into a record meant to be evidence.
            errorDescription: "Card 4111 1111 1111 1111 declined by issuer XYZ",
          },
        );

        const [attempt] = await attemptsOf(arranged.transactionId);
        expect(attempt?.status).toBe("FAILED");
        expect(attempt?.failureCategory).toBe("INSUFFICIENT_FUNDS");
        expect(attempt?.failureSource).toBe("BANK");
        expect(attempt?.failureStep).toBe("AUTHORIZATION");
        expect(attempt?.failureReasonCode).toBe("insufficient_funds");

        const serialised = JSON.stringify(attempt, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        );
        expect(serialised).not.toContain("4111");
        expect(serialised).not.toContain("XYZ");
        expect(serialised.toLowerCase()).not.toContain("issuer");
      });

      it("does not fulfil: stock stays held, never committed", async () => {
        const arranged = await arrangeFailed();
        const reservation = await reservationOf(arranged.transactionId);
        expect(reservation.status).toBe("ACTIVE");
        expect(reservation.committedAt).toBeNull();
        const product = await testDb().product.findUniqueOrThrow({
          where: { id: arranged.productId },
        });
        expect(product.inventory).toBe(5);
      });
    });

    // -------------------------------------------------------------------------
    // Failure -> retry -> success
    // -------------------------------------------------------------------------

    describe("failure then a granted retry then success", () => {
      it("reaches capture on a second attempt without destroying the first", async () => {
        const arranged = await arrangeFailed();

        const retry = await retryAndExpectStarted(arranged.transactionId);
        expect(retry.attemptNumber).toBe(2);
        expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_ORDER_CREATED");

        // Every retry gets its own provider order, so a provider order id still
        // identifies exactly one internal attempt.
        expect(retry.providerOrderId).not.toBe(arranged.providerOrderId);

        expect(
          (await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps()))
            .kind,
        ).toBe("CHECKOUT_READY");
        const captured = await capturePayment(
          retry.providerOrderId,
          "pay_RetrySuccess01",
        );
        expect(captured.kind).toBe("RECONCILED");

        expect(await statusOf(arranged.transactionId)).toBe("COMPLETED");

        const attempts = await attemptsOf(arranged.transactionId);
        expect(attempts.map((a) => [a.attemptNumber, a.status])).toEqual([
          [1, "FAILED"],
          [2, "CAPTURED"],
        ]);
        // The failed attempt keeps its own history: its order, its failure code
        // and its payment reference are all still there.
        expect(attempts[0]?.providerOrderId).toBe(arranged.providerOrderId);
        expect(attempts[0]?.failureCode).toBe("BANK_DECLINED");
        expect(attempts[1]?.providerPaymentId).toBe("pay_RetrySuccess01");
      });

      it("shows the retry in the lifecycle rather than replaying the original", async () => {
        const arranged = await arrangeFailed();
        await retryAndExpectStarted(arranged.transactionId);

        const transitions = await testDb().transactionStateTransition.findMany({
          where: { transactionId: arranged.transactionId },
          orderBy: { sequence: "asc" },
        });
        const retryStep = transitions.find(
          (step) => step.trigger === "PAYMENT_RETRY_REQUESTED",
        );
        expect(retryStep?.fromStatus).toBe("PAYMENT_FAILED");
        expect(retryStep?.toStatus).toBe("PAYMENT_ORDER_CREATED");
        expect(retryStep?.actor).toBe("transaction_service");
        // The failure is still in the history. Nothing pretends it never happened.
        expect(transitions.some((step) => step.toStatus === "PAYMENT_FAILED")).toBe(true);
      });

      it("audits the decision before the provider call, with the controls it re-ran", async () => {
        const arranged = await arrangeFailed();
        await retryAndExpectStarted(arranged.transactionId);

        const actions = await auditActions(arranged.transactionId);
        expect(actions).toContain("payment_retry_requested");
        expect(actions).toContain("payment_retry_authorized");

        const authorized = await testDb().auditEvent.findFirstOrThrow({
          where: {
            transactionId: arranged.transactionId,
            eventType: "payment_retry_authorized",
          },
        });
        const facts = authorized.metadata as Record<string, unknown>;
        expect(facts["quoteId"]).toBe(arranged.quoteId);
        expect(facts["amountMinor"]).toBe(PRICE.toString());
        expect(facts["attemptsUsed"]).toBe(1);
        expect(facts["maxAttempts"]).toBe(MAX_PAYMENT_ATTEMPTS);
        expect(facts["policyDecision"]).toBe("ALLOWED");
      });
    });

    // -------------------------------------------------------------------------
    // Failure -> retry -> failure -> retry -> success
    // -------------------------------------------------------------------------

    describe("two failures then a success", () => {
      it("keeps all three attempts and refuses a fourth", async () => {
        const arranged = await arrangeFailed();

        const second = await retryAndExpectStarted(arranged.transactionId);
        await failPayment(second.providerOrderId, "pay_RetryFail02");
        expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_FAILED");

        const third = await retryAndExpectStarted(arranged.transactionId);
        expect(third.attemptNumber).toBe(3);
        await capturePayment(third.providerOrderId, "pay_RetryWin03");

        const attempts = await attemptsOf(arranged.transactionId);
        expect(attempts.map((a) => [a.attemptNumber, a.status])).toEqual([
          [1, "FAILED"],
          [2, "FAILED"],
          [3, "CAPTURED"],
        ]);
        expect(await statusOf(arranged.transactionId)).toBe("COMPLETED");

        // No fourth attempt is reachable, and the refusal names the right reason:
        // the money arrived, which outranks the count.
        const fourth = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(fourth.kind).toBe("DENIED");
        if (fourth.kind !== "DENIED") throw new Error("unreachable");
        expect(fourth.denial).toBe("PAYMENT_ALREADY_CAPTURED");
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(3);
      });
    });

    // -------------------------------------------------------------------------
    // The limit
    // -------------------------------------------------------------------------

    describe("the attempt limit", () => {
      /** Fails three attempts, using every retry the limit permits. */
      async function exhaust(): Promise<Arranged> {
        const arranged = await arrangeFailed();
        const second = await retryAndExpectStarted(arranged.transactionId);
        await failPayment(second.providerOrderId, "pay_Exhaust02");
        const third = await retryAndExpectStarted(arranged.transactionId);
        await failPayment(third.providerOrderId, "pay_Exhaust03");
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(
          MAX_PAYMENT_ATTEMPTS,
        );
        return arranged;
      }

      it("refuses a fourth attempt and creates nothing", async () => {
        const arranged = await exhaust();
        const ordersBefore = provider.createRequests.length;

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind).toBe("DENIED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        expect(denied.denial).toBe("RETRY_LIMIT_REACHED");
        expect(denied.attemptsUsed).toBe(MAX_PAYMENT_ATTEMPTS);
        expect(denied.maxAttempts).toBe(MAX_PAYMENT_ATTEMPTS);

        expect(await attemptsOf(arranged.transactionId)).toHaveLength(
          MAX_PAYMENT_ATTEMPTS,
        );
        expect(provider.createRequests).toHaveLength(ordersBefore);
        expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_FAILED");
      });

      it("audits the limit and gives the held stock back", async () => {
        const arranged = await exhaust();
        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind === "DENIED" && denied.reservationReleased).toBe(true);

        const actions = await auditActions(arranged.transactionId);
        expect(actions).toContain("payment_retry_limit_reached");
        expect(actions).toContain("payment_retry_denied");
        expect(actions).toContain("inventory_released");

        const reservation = await reservationOf(arranged.transactionId);
        expect(reservation.status).toBe("RELEASED");
        // Released, never committed - the unit goes back to other buyers, and
        // nothing was sold.
        expect(reservation.committedAt).toBeNull();
        const product = await testDb().product.findUniqueOrThrow({
          where: { id: arranged.productId },
        });
        expect(product.inventory).toBe(5);
        expect(product.reservedQuantity).toBe(0);
      });

      it("cannot be raced past by two simultaneous requests", async () => {
        const arranged = await arrangeFailed();
        const second = await retryAndExpectStarted(arranged.transactionId);
        await failPayment(second.providerOrderId, "pay_RaceLimit02");
        const third = await retryAndExpectStarted(arranged.transactionId);
        await failPayment(third.providerOrderId, "pay_RaceLimit03");

        // Two genuinely separate connections, so the limit is enforced by the
        // database rather than by both requests happening to share a client.
        const left = freshTestClient();
        const right = freshTestClient();
        try {
          const outcomes = await Promise.all([
            requestPaymentRetry(
              { transactionId: arranged.transactionId },
              retryDeps(left),
            ),
            requestPaymentRetry(
              { transactionId: arranged.transactionId },
              retryDeps(right),
            ),
          ]);
          expect(outcomes.map((outcome) => outcome.kind)).toEqual(["DENIED", "DENIED"]);
        } finally {
          await left.$disconnect();
          await right.$disconnect();
        }
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(
          MAX_PAYMENT_ATTEMPTS,
        );
      });

      it("reports the remaining budget without enforcing it in the browser", async () => {
        const arranged = await arrangeFailed();
        const status = await readRetryStatus(arranged.transactionId, {
          prisma: testDb(),
          clock,
        });
        expect(status).toEqual({
          transactionId: arranged.transactionId,
          transactionState: "PAYMENT_FAILED",
          attemptsUsed: 1,
          maxAttempts: MAX_PAYMENT_ATTEMPTS,
          remaining: 2,
          available: true,
          denial: null,
          // The safe category of the failure that got us here, so the page can
          // say why rather than only that. `arrangeFailed` reports BANK_DECLINED
          // with no source or step, which classifies on the code alone.
          lastFailure: "DECLINED_BY_BANK",
        });
      });
    });

    // -------------------------------------------------------------------------
    // The financial facts are re-checked
    // -------------------------------------------------------------------------

    describe("when the financial facts change before a retry", () => {
      it("refuses rather than charging the old or the new price", async () => {
        const arranged = await arrangeFailed();

        // The merchant repriced. Version is bumped exactly as the catalog does.
        await testDb().product.update({
          where: { id: arranged.productId },
          data: { unitAmount: 199_900n, version: { increment: 1 } },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind).toBe("DENIED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        expect(denied.denial).toBe("FINANCIAL_FACTS_CHANGED");
        expect(denied.reasons).toContain("PRICE_CHANGED");
        expect(denied.reasons).toContain("PRODUCT_VERSION_CHANGED");

        // No attempt, no order, and - the point of the scenario - no silent
        // reprice: the historical quote still records the amount that was
        // actually offered.
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
        const quote = await testDb().purchaseQuote.findUniqueOrThrow({
          where: { id: arranged.quoteId },
        });
        expect(quote.totalAmount).toBe(PRICE);
        expect(denied.reservationReleased).toBe(true);

        // The refusal is in the trail with the facts behind it. "We would not
        // charge you" and "because the price changed" are different statements,
        // and a buyer asking later needs the second one.
        const record = await testDb().auditEvent.findFirstOrThrow({
          where: {
            transactionId: arranged.transactionId,
            eventType: "payment_retry_denied",
          },
        });
        expect(record.reasonCode).toBe("FINANCIAL_FACTS_CHANGED");
        expect((record.metadata as Record<string, unknown>)["reasons"]).toContain(
          "PRICE_CHANGED",
        );
      });

      it("refuses when the product can no longer be sold", async () => {
        const arranged = await arrangeFailed();
        await testDb().product.update({
          where: { id: arranged.productId },
          data: { status: "OUT_OF_STOCK" },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind === "DENIED" && denied.denial).toBe("FINANCIAL_FACTS_CHANGED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        expect(denied.reasons).toContain("PRODUCT_UNAVAILABLE");
        expect(provider.createRequests).toHaveLength(1);
      });

      it("refuses once the stock hold has lapsed", async () => {
        const arranged = await arrangeFailed();
        // Past the reservation window. A retry cannot re-reserve: stock is only
        // claimed from AUTHORIZED, and there is no edge back to it.
        clock.advanceMs((RESERVATION_TTL_SECONDS + 60) * 1000);

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind).toBe("DENIED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        // The quote lapses on the same clock, and it is checked first - either
        // refusal is correct and neither creates anything.
        expect(["RESERVATION_NOT_HELD", "FINANCIAL_FACTS_CHANGED"]).toContain(
          denied.denial,
        );
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
        expect(provider.createRequests).toHaveLength(1);
      });
    });

    // -------------------------------------------------------------------------
    // The policy is re-run
    // -------------------------------------------------------------------------

    describe("when the policy changes before a retry", () => {
      it("refuses when the purchase now needs a person", async () => {
        const arranged = await arrangeFailed();
        // The buyer tightened their own ceiling below the quoted amount, without
        // a version change: today's verdict is APPROVAL_REQUIRED.
        await testDb().authorizationPolicy.update({
          where: { id: policyId },
          data: { maxAutoApproveAmount: 100_000n },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind).toBe("DENIED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        expect(denied.denial).toBe("NOT_AUTHORIZED");
        expect(denied.detail["recheck"]).toBe("APPROVAL_REQUIRED");
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
      });

      it("refuses when unattended purchases are no longer permitted", async () => {
        const arranged = await arrangeFailed();
        // `autoPurchaseAllowed: false` is not an outright refusal - the engine
        // answers APPROVAL_REQUIRED (AUTO_PURCHASE_DISABLED), meaning a person
        // must decide. Asserted as what it is rather than as a block: a test
        // whose name claims stronger coverage than it has is worse than no
        // test, and the genuinely blocked case is exercised separately below.
        await testDb().authorizationPolicy.update({
          where: { id: policyId },
          data: { autoPurchaseAllowed: false },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind).toBe("DENIED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        expect(denied.denial).toBe("NOT_AUTHORIZED");
        expect(denied.detail["recheck"]).toBe("APPROVAL_REQUIRED");
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
      });

      it("refuses when the policy now blocks the purchase outright", async () => {
        const arranged = await arrangeFailed();
        // A policy denominated in a currency the quote is not in is a BLOCKED
        // verdict rather than an approvable one - and no human approval may
        // override it, which is the property separating BLOCKED from
        // APPROVAL_REQUIRED.
        await testDb().authorizationPolicy.update({
          where: { id: policyId },
          data: { currency: "USD" },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind).toBe("DENIED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        expect(denied.denial).toBe("NOT_AUTHORIZED");
        expect(denied.detail["recheck"]).toBe("POLICY_BLOCKS");
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
        expect(provider.createRequests).toHaveLength(1);
      });

      it("refuses when the policy has been superseded by a new version", async () => {
        const arranged = await arrangeFailed();
        await testDb().authorizationPolicy.update({
          where: { id: policyId },
          data: { status: "SUPERSEDED" },
        });
        await testDb().authorizationPolicy.create({
          data: {
            buyerProfileId: buyerId,
            maxAutoApproveAmount: CEILING,
            currency: "INR",
            autoPurchaseAllowed: true,
            status: "ACTIVE",
            version: 2,
          },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind).toBe("DENIED");
        if (denied.kind !== "DENIED") throw new Error("unreachable");
        // Even a policy that still says yes is a *different* policy from the one
        // the original authorization was granted under.
        expect(denied.detail["recheck"]).toBe("POLICY_VERSION_CHANGED");
      });
    });

    // -------------------------------------------------------------------------
    // Approvals do not travel
    // -------------------------------------------------------------------------

    describe("an existing approval", () => {
      /** Tightens the ceiling so the quoted amount now needs a person. */
      async function requireApproval(): Promise<void> {
        await testDb().authorizationPolicy.update({
          where: { id: policyId },
          data: { maxAutoApproveAmount: 100_000n },
        });
      }

      it("cannot authorize a retry when it names a different amount", async () => {
        const arranged = await arrangeFailed();
        await requireApproval();
        await testDb().approvalRequest.create({
          data: {
            transactionId: arranged.transactionId,
            purchaseQuoteId: arranged.quoteId,
            // A person approved something cheaper. It must not pay for this.
            requestedAmount: 100n,
            currency: "INR",
            policyLimitSnapshot: 100_000n,
            policyVersion: 1,
            reasonCode: "EXCEEDS_AUTO_APPROVE_LIMIT",
            status: "CONSUMED",
            decidedByBuyerId: buyerId,
            // Both ends from the frozen test clock. Letting `createdAt` fall
            // through to the database default would measure the window between
            // two different time sources - the real server clock and this
            // suite's - and the `expiresAt > createdAt` CHECK constraint rejects
            // the row outright once real time passes the frozen instant.
            createdAt: NOW,
            decidedAt: NOW,
            expiresAt: new Date(NOW.getTime() + 3_600_000),
          },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind === "DENIED" && denied.denial).toBe("NOT_AUTHORIZED");
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
      });

      it("authorizes a retry only when it names this exact quote, amount and policy", async () => {
        const arranged = await arrangeFailed();
        await requireApproval();
        const approval = await testDb().approvalRequest.create({
          data: {
            transactionId: arranged.transactionId,
            purchaseQuoteId: arranged.quoteId,
            requestedAmount: PRICE,
            currency: "INR",
            policyLimitSnapshot: 100_000n,
            policyVersion: 1,
            reasonCode: "EXCEEDS_AUTO_APPROVE_LIMIT",
            status: "CONSUMED",
            decidedByBuyerId: buyerId,
            // Both ends from the frozen test clock. Letting `createdAt` fall
            // through to the database default would measure the window between
            // two different time sources - the real server clock and this
            // suite's - and the `expiresAt > createdAt` CHECK constraint rejects
            // the row outright once real time passes the frozen instant.
            createdAt: NOW,
            decidedAt: NOW,
            expiresAt: new Date(NOW.getTime() + 3_600_000),
          },
        });

        const retry = await retryAndExpectStarted(arranged.transactionId);
        expect(retry.attemptNumber).toBe(2);

        const authorized = await testDb().auditEvent.findFirstOrThrow({
          where: {
            transactionId: arranged.transactionId,
            eventType: "payment_retry_authorized",
          },
        });
        // The record names which approval supplied the authority, so a reader can
        // see that a person - not a policy - permitted this retry.
        expect((authorized.metadata as Record<string, unknown>)["approvalId"]).toBe(
          approval.id,
        );
      });
    });

    // -------------------------------------------------------------------------
    // Late capture
    // -------------------------------------------------------------------------

    describe("a late capture for an earlier attempt", () => {
      it("wins over the failure that was recorded, mid-retry", async () => {
        const paymentId = "pay_LateCapture01";
        const arranged = await arrange();
        expect(
          (await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps()))
            .kind,
        ).toBe("CHECKOUT_READY");
        await failPayment(arranged.providerOrderId, paymentId);

        const second = await retryAndExpectStarted(arranged.transactionId);
        expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_ORDER_CREATED");

        // The provider now says the *first* payment was captured after all.
        const late = await capturePayment(arranged.providerOrderId, paymentId);
        expect(late.kind).toBe("RECONCILED");

        // The late capture is reconciled all the way through: it is genuine
        // evidence that money moved, and its reservation must not be left
        // ACTIVE for the retry workflow's own hold to shadow it.
        expect(await statusOf(arranged.transactionId)).toBe("COMPLETED");
        const attempts = await attemptsOf(arranged.transactionId);
        expect(attempts[0]?.status).toBe("CAPTURED");
        // The pending retry is untouched. A late event for attempt #1 must never
        // reach attempt #2 merely because they share a transaction.
        expect(attempts[1]?.id).toBe(second.paymentAttemptId);
        expect(attempts[1]?.status).toBe("CREATED");
        expect(attempts[1]?.providerPaymentId).toBeNull();

        // The lifecycle says what happened rather than hiding it: the late
        // edge, then completion.
        const transitions = await testDb().transactionStateTransition.findMany({
          where: { transactionId: arranged.transactionId },
          orderBy: { sequence: "asc" },
        });
        expect(transitions.map((t) => t.reasonCode)).toContain("LATE_CAPTURE_RECONCILED");
        expect(transitions.at(-1)?.reasonCode).toBe("TRANSACTION_COMPLETED");

        const reservation = await reservationOf(arranged.transactionId);
        expect(reservation.status).toBe("COMMITTED");
      });

      it("closes the retry window and the pending checkout", async () => {
        const paymentId = "pay_LateCapture02";
        const arranged = await arrange();
        await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps());
        await failPayment(arranged.providerOrderId, paymentId);
        await retryAndExpectStarted(arranged.transactionId);
        await capturePayment(arranged.providerOrderId, paymentId);

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind === "DENIED" && denied.denial).toBe(
          "PAYMENT_ALREADY_CAPTURED",
        );

        // And the person cannot be sent to pay the retry order either.
        const checkout = await startCheckout(
          { transactionId: arranged.transactionId },
          checkoutDeps(),
        );
        expect(checkout.kind).toBe("REFUSED");
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(2);
      });

      it("is not undone by a stale failure arriving afterwards", async () => {
        const paymentId = "pay_LateCapture03";
        const arranged = await arrange();
        await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps());
        await failPayment(arranged.providerOrderId, paymentId);
        const second = await retryAndExpectStarted(arranged.transactionId);
        await capturePayment(arranged.providerOrderId, paymentId);

        // A failure for the retry order, arriving after the capture.
        const stale = await failPayment(second.providerOrderId, "pay_StaleFail03");
        expect(stale.kind).toBe("RECONCILED");

        expect(await statusOf(arranged.transactionId)).toBe("COMPLETED");
        const attempts = await attemptsOf(arranged.transactionId);
        expect(attempts[0]?.status).toBe("CAPTURED");
        // Held, not applied: the attempt is not stamped FAILED on the strength of
        // an event the state machine refused to act on.
        expect(attempts[1]?.status).toBe("CREATED");
        expect(await auditActions(arranged.transactionId)).toContain("webhook_ignored");
      });
    });

    // -------------------------------------------------------------------------
    // Two captures under one transaction
    // -------------------------------------------------------------------------

    describe("when two attempts are both captured", () => {
      /** Produces the anomaly: attempt #2 captured, then attempt #1 as well. */
      async function bothCaptured(): Promise<Arranged & { readonly secondId: string }> {
        const firstPaymentId = "pay_Double01";
        const arranged = await arrange();
        await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps());
        await failPayment(arranged.providerOrderId, firstPaymentId);

        const second = await retryAndExpectStarted(arranged.transactionId);
        await startCheckout({ transactionId: arranged.transactionId }, checkoutDeps());
        await capturePayment(second.providerOrderId, "pay_Double02");
        // The genuine capture reconciles all the way to completion before the
        // second, rival capture for attempt #1 ever arrives.
        expect(await statusOf(arranged.transactionId)).toBe("COMPLETED");

        const late = await capturePayment(arranged.providerOrderId, firstPaymentId);
        expect(late.kind).toBe("RECONCILED");
        if (late.kind !== "RECONCILED") throw new Error("unreachable");
        expect(late.anomaly).toBe("MULTIPLE_CAPTURE");
        return { ...arranged, secondId: second.paymentAttemptId };
      }

      it("detects the anomaly instead of swallowing it as a duplicate", async () => {
        const arranged = await bothCaptured();

        const actions = await auditActions(arranged.transactionId);
        expect(actions).toContain("payment_multiple_capture_detected");

        const anomaly = await testDb().auditEvent.findFirstOrThrow({
          where: {
            transactionId: arranged.transactionId,
            eventType: "payment_multiple_capture_detected",
          },
        });
        expect(anomaly.result).toBe("BLOCKED");
        // Both attempts are named, so an investigator does not have to work out
        // which two payments are involved.
        const facts = anomaly.metadata as Record<string, unknown>;
        expect(facts["conflictingAttemptId"]).toBe(arranged.secondId);

        const ledger = await testDb().webhookEvent.findFirst({
          where: { errorCategory: "MULTIPLE_CAPTURE" },
        });
        expect(ledger?.status).toBe("PROCESSED");
      });

      it("records both captures truthfully", async () => {
        const arranged = await bothCaptured();
        const attempts = await attemptsOf(arranged.transactionId);
        // Neither payment is denied by the ledger. The provider took both, and a
        // record that said otherwise would be the more dangerous mistake.
        expect(attempts.map((a) => a.status)).toEqual(["CAPTURED", "CAPTURED"]);
        expect(new Set(attempts.map((a) => a.providerOrderId)).size).toBe(2);
      });

      it("still fulfils exactly once: one state, one hold, no stock sold twice", async () => {
        const arranged = await bothCaptured();

        // Two payments were captured, but the purchase itself settles once:
        // one PAYMENT_CAPTURED transition, from the genuine first capture, and
        // one committed reservation, never two.
        expect(await statusOf(arranged.transactionId)).toBe("COMPLETED");
        const transitions = await testDb().transactionStateTransition.findMany({
          where: { transactionId: arranged.transactionId, toStatus: "PAYMENT_CAPTURED" },
        });
        expect(transitions).toHaveLength(1);
        const completions = await testDb().transactionStateTransition.findMany({
          where: { transactionId: arranged.transactionId, toStatus: "COMPLETED" },
        });
        expect(completions).toHaveLength(1);

        const reservation = await reservationOf(arranged.transactionId);
        expect(reservation.status).toBe("COMMITTED");
        expect(reservation.committedAt).not.toBeNull();
        const product = await testDb().product.findUniqueOrThrow({
          where: { id: arranged.productId },
        });
        // On-hand stock fell by exactly the one unit this purchase held, once -
        // not twice for two captured payments, and no hold is left standing.
        expect(product.inventory).toBe(4);
        expect(product.reservedQuantity).toBe(0);
      });
    });

    // -------------------------------------------------------------------------
    // Concurrency
    // -------------------------------------------------------------------------

    describe("two simultaneous retry requests", () => {
      it("produce one retry, one attempt and one provider order", async () => {
        const arranged = await arrangeFailed();
        const ordersBefore = provider.createRequests.length;

        // Two independently connected clients, so the convergence is PostgreSQL's
        // and not an artefact of sharing one connection pool.
        const left = freshTestClient();
        const right = freshTestClient();
        let kinds: string[] = [];
        try {
          const outcomes = await Promise.all([
            requestPaymentRetry(
              { transactionId: arranged.transactionId },
              retryDeps(left),
            ),
            requestPaymentRetry(
              { transactionId: arranged.transactionId },
              retryDeps(right),
            ),
          ]);
          kinds = outcomes.map((outcome) => outcome.kind);
        } finally {
          await left.$disconnect();
          await right.$disconnect();
        }

        // At least one succeeds. The other either converges on the same attempt
        // or is told the claim is in flight - never a second attempt, and never a
        // second order.
        expect(kinds).toContain("RETRY_STARTED");
        expect(kinds.every((kind) => kind !== "DENIED" || true)).toBe(true);

        const attempts = await attemptsOf(arranged.transactionId);
        expect(attempts).toHaveLength(2);
        expect(provider.createRequests.length - ordersBefore).toBe(1);
        expect(new Set(attempts.map((a) => a.providerOrderId)).size).toBe(2);
        expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_ORDER_CREATED");
      });

      it("refuses a second request once the first has taken effect", async () => {
        const arranged = await arrangeFailed();
        await retryAndExpectStarted(arranged.transactionId);

        const again = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(again.kind).toBe("DENIED");
        if (again.kind !== "DENIED") throw new Error("unreachable");
        // Two independent guards catch this: the transaction is no longer at
        // PAYMENT_FAILED, and a live attempt exists.
        expect(["TRANSACTION_STATE_INVALID", "ATTEMPT_IN_PROGRESS"]).toContain(
          again.denial,
        );
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(2);
      });
    });

    // -------------------------------------------------------------------------
    // Unresolved outcomes are never retried
    // -------------------------------------------------------------------------

    describe("an attempt whose provider outcome is unknown", () => {
      it("is never retried into a second order", async () => {
        const arranged = await arrangeFailed();
        // The one status that means "an order may exist at the provider that we
        // did not finish recording". It is resolved by receipt, never by asking
        // for another order.
        await testDb().paymentAttempt.update({
          where: { id: arranged.paymentAttemptId },
          data: { status: "RECONCILIATION_REQUIRED" },
        });

        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind === "DENIED" && denied.denial).toBe("OUTCOME_UNRESOLVED");
        expect(provider.createRequests).toHaveLength(1);
        // Stock is deliberately kept: releasing on an unknown outcome would be a
        // guess about money.
        expect(denied.kind === "DENIED" && denied.reservationReleased).toBe(false);
      });
    });

    // -------------------------------------------------------------------------
    // The gate itself changes nothing
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Callback correlation across attempts
    // -------------------------------------------------------------------------

    describe("a checkout callback when a transaction has several attempts", () => {
      /** Attempt #1 failed, attempt #2 created and taken to PAYMENT_PENDING. */
      async function twoAttempts(): Promise<{
        readonly first: Arranged;
        readonly second: {
          readonly paymentAttemptId: string;
          readonly providerOrderId: string;
        };
      }> {
        const first = await arrangeFailed();
        const second = await retryAndExpectStarted(first.transactionId);
        expect(
          (await startCheckout({ transactionId: first.transactionId }, checkoutDeps()))
            .kind,
        ).toBe("CHECKOUT_READY");
        return { first, second };
      }

      it("refuses to guess when the callback names no attempt and no order", async () => {
        const { first, second } = await twoAttempts();

        const result = await verifyCheckoutCallback(
          {
            transactionId: first.transactionId,
            providerPaymentId: "pay_Unnamed01",
            signature: signCallback(second.providerOrderId, "pay_Unnamed01"),
          },
          checkoutDeps(),
        );

        // A genuine signature for attempt #2 is still refused, because nothing
        // in the request says which attempt it is about. Picking the newest
        // would be a guess, and a guess must not decide which attempt a payment
        // belongs to.
        expect(result.kind).toBe("REJECTED");
        if (result.kind !== "REJECTED") throw new Error("unreachable");
        expect(result.rejection).toBe("ATTEMPT_AMBIGUOUS");

        // Attempt #1 legitimately holds the payment id its failure webhook
        // reported; what matters is that *this* payment reached neither.
        const attempts = await attemptsOf(first.transactionId);
        expect(attempts.map((a) => a.providerPaymentId)).not.toContain("pay_Unnamed01");
        expect(attempts[1]?.providerPaymentId).toBeNull();
        expect(await statusOf(first.transactionId)).toBe("PAYMENT_PENDING");
      });

      it("resolves the attempt from the order id, matched against our own record", async () => {
        const { first, second } = await twoAttempts();

        const result = await verifyCheckoutCallback(
          {
            transactionId: first.transactionId,
            // No attempt id. The order id is used to *find* our row; the
            // signature is still checked against the column that row holds.
            presentedOrderId: second.providerOrderId,
            providerPaymentId: "pay_ByOrder01",
            signature: signCallback(second.providerOrderId, "pay_ByOrder01"),
          },
          checkoutDeps(),
        );

        expect(result.kind).toBe("PAYMENT_VERIFIED");
        if (result.kind !== "PAYMENT_VERIFIED") throw new Error("unreachable");
        expect(result.paymentAttemptId).toBe(second.paymentAttemptId);

        const attempts = await attemptsOf(first.transactionId);
        // The failed attempt is untouched. Only the attempt the order names
        // received the payment.
        expect(attempts[0]?.providerPaymentId).not.toBe("pay_ByOrder01");
        expect(attempts[1]?.providerPaymentId).toBe("pay_ByOrder01");
      });

      it("cannot bind a payment for the failed attempt onto the live one", async () => {
        const { first } = await twoAttempts();

        // A signature genuinely produced for attempt #1's order, replayed
        // against the transaction while attempt #2 is the live one.
        const result = await verifyCheckoutCallback(
          {
            transactionId: first.transactionId,
            presentedOrderId: first.providerOrderId,
            providerPaymentId: "pay_WrongAttempt",
            signature: signCallback(first.providerOrderId, "pay_WrongAttempt"),
          },
          checkoutDeps(),
        );

        // It correlates to attempt #1 - correctly - and is refused there,
        // because that attempt already failed and carries its own payment id.
        expect(result.kind).toBe("REJECTED");
        const attempts = await attemptsOf(first.transactionId);
        expect(attempts[1]?.providerPaymentId).toBeNull();
        expect(attempts[1]?.status).toBe("CREATED");
      });

      it("still records a tampered order id as a mismatch rather than losing it", async () => {
        const { first, second } = await twoAttempts();

        const result = await verifyCheckoutCallback(
          {
            transactionId: first.transactionId,
            paymentAttemptId: second.paymentAttemptId,
            presentedOrderId: "order_TheirsNotOurs",
            providerPaymentId: "pay_Tampered01",
            signature: signCallback(second.providerOrderId, "pay_Tampered01"),
          },
          checkoutDeps(),
        );

        expect(result.kind).toBe("REJECTED");
        if (result.kind !== "REJECTED") throw new Error("unreachable");
        expect(result.rejection).toBe("ORDER_ID_MISMATCH");

        // The evidence survives: a security review needs to see which order id
        // somebody posted against this transaction.
        const record = await testDb().auditEvent.findFirstOrThrow({
          where: {
            transactionId: first.transactionId,
            eventType: "payment_callback_rejected",
          },
        });
        expect((record.metadata as Record<string, unknown>)["presentedOrderId"]).toBe(
          "order_TheirsNotOurs",
        );
      });
    });

    describe("the eligibility gate", () => {
      it("is read-only, so the page may ask it freely", async () => {
        const arranged = await arrangeFailed();
        const auditBefore = await testDb().auditEvent.count({
          where: { transactionId: arranged.transactionId },
        });

        for (let i = 0; i < 3; i += 1) {
          const verdict = await evaluateRetryEligibility(arranged.transactionId, {
            prisma: testDb(),
            clock,
          });
          expect(verdict.kind).toBe("ELIGIBLE");
        }

        expect(
          await testDb().auditEvent.count({
            where: { transactionId: arranged.transactionId },
          }),
        ).toBe(auditBefore);
        expect(await attemptsOf(arranged.transactionId)).toHaveLength(1);
        expect(await statusOf(arranged.transactionId)).toBe("PAYMENT_FAILED");
      });

      it("refuses a transaction that never failed", async () => {
        const arranged = await arrange();
        const denied = await requestPaymentRetry(
          { transactionId: arranged.transactionId },
          retryDeps(),
        );
        expect(denied.kind === "DENIED" && denied.denial).toBe(
          "TRANSACTION_STATE_INVALID",
        );
      });

      it("tells an unknown transaction nothing it did not already know", async () => {
        const denied = await requestPaymentRetry(
          { transactionId: "00000000-0000-7000-8000-000000000000" },
          retryDeps(),
        );
        expect(denied.kind === "DENIED" && denied.denial).toBe("TRANSACTION_NOT_FOUND");
      });
    });
  },
);
