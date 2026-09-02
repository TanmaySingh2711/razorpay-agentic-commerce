import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  recordCheckoutDismissal,
  startCheckout,
  verifyCheckoutCallback,
  type CheckoutServiceDeps,
} from "@/services/payment/checkout-service";
import { createPaymentOrder } from "@/services/payment/payment-order-service";
import { reserveInventory } from "@/services/inventory/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import { createTrustedQuote } from "@/services/quote/quote-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { getTransactionAuditHistory } from "@/services/audit/audit-service";
import { createTransaction } from "@/services/transaction/creation-service";
import { handleCheckoutCallback, handleStartCheckout } from "@/app/api/payments/handler";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { MAX_PROVIDER_REFERENCE_LENGTH } from "@/domain/payment/rules";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor } from "@/domain/transaction/states";
import {
  FAKE_PROVIDER_ORDER_ID,
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
 * Standard Checkout and server-side callback verification, against real
 * PostgreSQL and real cryptography.
 *
 * The provider's *network* is faked; its *signature scheme* is not. Every
 * signature in this file is computed here with Node's crypto and checked by the
 * real Razorpay adapter, because the HMAC is the whole security boundary — a
 * fake that returned `true` would let every test below pass against a verifier
 * that did nothing.
 *
 * The database is real for the same reason it is in the payment-order suite:
 * the claims worth proving are about what a rollback leaves behind, what a
 * unique index refuses, and whether a replayed callback writes a second row.
 *
 * Two properties get the most attention, because they are the ones that lose
 * money when they break:
 *
 *  - the server verifies against **its own** order id, never the browser's;
 *  - a verified signature stops at `PAYMENT_VERIFIED` and never reaches
 *    `PAYMENT_CAPTURED`, `COMPLETED`, or a committed inventory decrement.
 */

const QUOTE_TTL_SECONDS = 300;
const RESERVATION_TTL_SECONDS = 600;
const CEILING = 300_000n;
const IN_BUDGET = 279_900n; // ₹2,799.00
const NOW = new Date("2026-09-01T09:00:00.000Z");

const KEY_ID = "rzp_test_checkoutsuite";
const KEY_SECRET = "checkout_suite_secret_value";
const PAYMENT_ID = "pay_TestModePayment01";

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

/** The real adapter, used only for its signature verification. */
const realVerifier = createRazorpayProvider({
  keyId: KEY_ID,
  keySecret: KEY_SECRET,
  baseUrl: "https://unused.test/v1",
  fetchImpl: (() => Promise.reject(new Error("no network here"))) as never,
});

/** The provider's documented scheme, computed independently of the adapter. */
function sign(orderId: string, paymentId: string, secret = KEY_SECRET): string {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

/**
 * A stand-in that fakes the network but performs the real cryptographic check,
 * while recording exactly which order id it was asked to verify against.
 */
function checkoutProvider(): FakePaymentProvider {
  return fakePaymentProvider({
    onVerify: (input) => realVerifier.verifyCheckoutSignature(input),
  });
}

let buyerId = "";
let merchantId = "";
let clock: MutableClock;
let provider: FakePaymentProvider;

function deps(): CheckoutServiceDeps {
  return { prisma: testDb(), clock, provider, providerKeyId: KEY_ID };
}

interface Arranged {
  readonly transactionId: string;
  readonly paymentAttemptId: string;
  readonly providerOrderId: string;
}

/**
 * Drives a transaction through every real boundary to PAYMENT_ORDER_CREATED.
 *
 * Nothing is hand-inserted: creation, transitions, quoting, policy, reservation
 * and Objective 10's order creation all run, so each test starts from a state
 * the system can genuinely reach.
 */
async function arrange(): Promise<Arranged> {
  const product = await testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name: "Test Keyboard",
      description: "A keyboard used by the checkout tests.",
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
  const evaluated = await evaluateQuotePolicy(
    { quoteId: quote.snapshot.quoteId, operationId: uid("op") },
    { prisma: testDb(), clock, quote: quoteDeps },
  );
  expect(evaluated.kind).toBe("EVALUATED");

  const reserved = await reserveInventory(
    { transactionId: transaction.id, operationId: uid("op") },
    { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
  );
  expect(reserved.kind).toBe("RESERVED");

  const order = await createPaymentOrder(
    { transactionId: transaction.id },
    { prisma: testDb(), clock, provider },
  );
  expect(order.kind).toBe("ORDER_CREATED");
  if (order.kind !== "ORDER_CREATED") throw new Error("expected an order");

  return {
    transactionId: transaction.id,
    paymentAttemptId: order.order.paymentAttemptId,
    providerOrderId: order.order.providerOrderId,
  };
}

/** Arranges, then presses Pay. */
async function arrangeStarted(): Promise<Arranged> {
  const arranged = await arrange();
  const started = await startCheckout({ transactionId: arranged.transactionId }, deps());
  expect(started.kind).toBe("CHECKOUT_READY");
  return arranged;
}

async function statusOf(transactionId: string): Promise<string> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status;
}

async function auditOf(transactionId: string) {
  return await getTransactionAuditHistory(transactionId, { prisma: testDb() });
}

/**
 * A longer bound than the 30s default, for this file only, from measurement.
 *
 * Every test here calls `arrangeStarted()`, which drives a transaction through
 * creation, transitions, quoting, policy, reservation, Objective 10's order
 * creation and `startCheckout` before the assertion under test runs. That is
 * several dozen sequential round trips to a hosted PostgreSQL instance, and it
 * is the arrangement rather than the assertion that costs the time: measured at
 * 8.8-10.5s per test with the file run alone, and 444s for the file inside the
 * full suite, where the database is under sustained load from every other
 * integration test. The slowest tests reached 35.3s there - past the default,
 * with nothing hanging and nothing wrong with the code under test.
 *
 * The arrangement is not removable. These tests exist to prove what real
 * PostgreSQL does with a real signature check, so reaching the state through
 * the real boundaries is the point; hand-inserting rows would prove a different
 * system. The 30s default - chosen for suites that touch a handful of rows - is
 * the wrong bound for this file rather than this file being too slow. Scoped
 * here and nowhere else, so every other suite keeps the tighter limit.
 */
const CHECKOUT_SUITE_TIMEOUT_MS = 90_000;

describe.skipIf(!databaseConfigured)(
  "checkout and callback verification",
  { timeout: CHECKOUT_SUITE_TIMEOUT_MS },
  () => {
    beforeEach(async () => {
      await resetTestData();
      clock = fixedClock(NOW);
      provider = checkoutProvider();
      buyerId = (
        await testDb().buyerProfile.create({ data: { displayName: "Checkout Buyer" } })
      ).id;
      merchantId = (
        await testDb().merchant.create({
          data: { name: "Keebworks India", slug: uid("checkout-m"), status: "ACTIVE" },
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
    // Starting checkout
    // -------------------------------------------------------------------------

    describe("checkout starts only on an explicit action", () => {
      it("leaves the transaction untouched until the Pay action runs", async () => {
        const { transactionId } = await arrange();

        // Arranging alone - which includes everything a page render could do -
        // must not have moved anything.
        expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");

        const started = await startCheckout({ transactionId }, deps());

        expect(started.kind).toBe("CHECKOUT_READY");
        expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");
      });

      it("records the transition through the state machine with its own history row", async () => {
        const { transactionId } = await arrangeStarted();

        const transition = await testDb().transactionStateTransition.findFirstOrThrow({
          where: { transactionId, toStatus: "PAYMENT_PENDING" },
        });
        expect(transition.fromStatus).toBe("PAYMENT_ORDER_CREATED");
        expect(transition.trigger).toBe("PAYMENT_STARTED");
        expect(transition.actor).toBe("payment_provider");
      });

      it("hands the browser the backend order id and the server's own amount", async () => {
        const { transactionId, providerOrderId, paymentAttemptId } = await arrange();

        const started = await startCheckout({ transactionId }, deps());
        expect(started.kind).toBe("CHECKOUT_READY");
        if (started.kind !== "CHECKOUT_READY") return;

        const attempt = await testDb().paymentAttempt.findUniqueOrThrow({
          where: { id: paymentAttemptId },
        });
        expect(started.session.providerOrderId).toBe(providerOrderId);
        expect(started.session.providerOrderId).toBe(FAKE_PROVIDER_ORDER_ID);
        expect(started.session.amountMinor).toBe(Number(attempt.amount));
        expect(started.session.amountMinor).toBe(Number(IN_BUDGET));
        // Already minor units. Multiplying again would charge a hundredfold.
        expect(started.session.amountMinor).not.toBe(Number(IN_BUDGET) * 100);
        expect(started.session.currency).toBe("INR");
        expect(started.session.merchantName).toBe("Keebworks India");
      });

      it("never puts the key secret in what the browser receives", async () => {
        const { transactionId } = await arrange();

        const response = await handleStartCheckout(
          new Request("https://test.local/api/payments/checkout", {
            method: "POST",
            body: JSON.stringify({ transactionId }),
          }),
          deps(),
        );

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(KEY_ID);
        expect(text).not.toContain(KEY_SECRET);
        expect(text).not.toContain("RAZORPAY_KEY_SECRET");
      });

      it("refuses to send a person to pay when the stock hold has lapsed", async () => {
        const { transactionId } = await arrange();
        clock.advanceMs((RESERVATION_TTL_SECONDS + 1) * 1000);

        const started = await startCheckout({ transactionId }, deps());

        expect(started).toMatchObject({
          kind: "REFUSED",
          refusal: "RESERVATION_NOT_HELD",
        });
        expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");
      });

      it("refuses a transaction with no payment order yet", async () => {
        const transaction = await createTransaction(
          { buyerProfileId: buyerId, merchantId, correlationId: uid("corr") },
          { prisma: testDb() },
        );

        const started = await startCheckout({ transactionId: transaction.id }, deps());

        expect(started).toMatchObject({
          kind: "REFUSED",
          refusal: "TRANSACTION_STATE_INVALID",
          detail: { state: "INTENT_RECEIVED" },
        });
      });

      it("re-issues the same session without moving the state twice", async () => {
        const { transactionId } = await arrangeStarted();

        const again = await startCheckout({ transactionId }, deps());

        expect(again.kind).toBe("CHECKOUT_READY");
        if (again.kind !== "CHECKOUT_READY") return;
        expect(again.replayed).toBe(true);
        expect(again.session.providerOrderId).toBe(FAKE_PROVIDER_ORDER_ID);

        const transitions = await testDb().transactionStateTransition.findMany({
          where: { transactionId, toStatus: "PAYMENT_PENDING" },
        });
        expect(transitions).toHaveLength(1);

        const started = (await auditOf(transactionId)).filter(
          (entry) => entry.action === "payment_attempt_started",
        );
        expect(started).toHaveLength(1);
      });
    });

    // -------------------------------------------------------------------------
    // Verifying the callback
    // -------------------------------------------------------------------------

    describe("a genuine callback", () => {
      it("verifies, stores the payment id and reaches PAYMENT_VERIFIED", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();

        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
            presentedOrderId: providerOrderId,
          },
          deps(),
        );

        expect(result.kind).toBe("PAYMENT_VERIFIED");
        if (result.kind !== "PAYMENT_VERIFIED") return;
        expect(result.providerPaymentId).toBe(PAYMENT_ID);
        expect(result.transactionState).toBe("PAYMENT_VERIFIED");

        const attempt = await testDb().paymentAttempt.findUniqueOrThrow({
          where: { id: paymentAttemptId },
        });
        expect(attempt.providerPaymentId).toBe(PAYMENT_ID);
        expect(attempt.status).toBe("VERIFIED");
        // The provider's id is a reference; ours is still the key.
        expect(attempt.id).not.toBe(PAYMENT_ID);
        expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
      });

      it("verifies against the order id the SERVER stored, not the one posted", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();

        await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
            // Deliberately omitted, so the only possible source is the database.
          },
          deps(),
        );

        expect(provider.verifyInputs).toHaveLength(1);
        expect(provider.verifyInputs[0]?.serverStoredOrderId).toBe(providerOrderId);
      });

      it("audits the verification and moves through the state machine", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();

        await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        const verified = (await auditOf(transactionId)).find(
          (entry) => entry.action === "payment_verified",
        );
        expect(verified?.result).toBe("SUCCESS");
        expect(verified?.reasonCode).toBe("PAYMENT_SIGNATURE_VERIFIED");
        expect(verified?.trustedInputs).toMatchObject({
          paymentAttemptId,
          providerOrderId,
          providerPaymentId: PAYMENT_ID,
          amountMinor: IN_BUDGET.toString(),
          currency: "INR",
        });
        // The sentence must not let a reader mistake this for a settled payment.
        expect(verified?.conciseExplanation).toContain("not yet proof that funds");

        const transition = await testDb().transactionStateTransition.findFirstOrThrow({
          where: { transactionId, toStatus: "PAYMENT_VERIFIED" },
        });
        expect(transition.trigger).toBe("PAYMENT_CALLBACK_VERIFIED");
        expect(transition.fromStatus).toBe("PAYMENT_PENDING");
      });
    });

    // -------------------------------------------------------------------------
    // Verification is not capture
    // -------------------------------------------------------------------------

    describe("a verified signature proves authenticity, not settlement", () => {
      it("does not reach PAYMENT_CAPTURED or COMPLETED, and commits no stock", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();
        const before = await testDb().product.findFirstOrThrow({ where: { merchantId } });

        await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        const state = await statusOf(transactionId);
        expect(state).toBe("PAYMENT_VERIFIED");
        expect(state).not.toBe("PAYMENT_CAPTURED");
        expect(state).not.toBe("COMPLETED");

        // Stock is still merely held. A signature is not a reason to sell.
        const reservation = await testDb().inventoryReservation.findFirstOrThrow({
          where: { transactionId },
        });
        expect(reservation.status).toBe("ACTIVE");
        expect(reservation.status).not.toBe("COMMITTED");

        const after = await testDb().product.findUniqueOrThrow({
          where: { id: before.id },
        });
        expect(after.inventory).toBe(before.inventory);
        expect(after.reservedQuantity).toBe(before.reservedQuantity);

        const forbidden = await testDb().transactionStateTransition.findMany({
          where: { transactionId, toStatus: { in: ["PAYMENT_CAPTURED", "COMPLETED"] } },
        });
        expect(forbidden).toHaveLength(0);
      });
    });

    // -------------------------------------------------------------------------
    // Rejections
    // -------------------------------------------------------------------------

    describe("callbacks that cannot be trusted", () => {
      it("rejects a tampered order id and uses ours regardless", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();

        // The attack: transaction A, a payment, and somebody else's order id,
        // with a signature that is perfectly valid for THAT order.
        const attackerOrder = "order_AttackerOwnOrder";
        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(attackerOrder, PAYMENT_ID),
            presentedOrderId: attackerOrder,
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "ORDER_ID_MISMATCH",
        });
        expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");

        const attempt = await testDb().paymentAttempt.findUniqueOrThrow({
          where: { id: paymentAttemptId },
        });
        expect(attempt.providerPaymentId).toBeNull();
        expect(providerOrderId).not.toBe(attackerOrder);
      });

      it("rejects a signature valid for another order even when no order id is posted", async () => {
        const { transactionId, paymentAttemptId } = await arrangeStarted();

        // No presented order id at all, so the mismatch check cannot fire: the
        // signature itself must be what fails, because the server signs with its
        // own order id.
        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign("order_SomewhereElse", PAYMENT_ID),
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "INVALID_SIGNATURE",
        });
        expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");
      });

      it("rejects an invalid signature and records it without revealing anything", async () => {
        const { transactionId, paymentAttemptId } = await arrangeStarted();

        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: "f".repeat(64),
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "INVALID_SIGNATURE",
        });
        expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");

        const rejected = (await auditOf(transactionId)).find(
          (entry) => entry.action === "payment_callback_rejected",
        );
        expect(rejected?.result).toBe("BLOCKED");
        expect(rejected?.reasonCode).toBe("INVALID_SIGNATURE");
        // No signature value may appear - neither the one presented nor the one
        // the server computed. Asserted as "no 64-character hex string anywhere"
        // rather than as "the word signature", because the reason code legitimately
        // names the failure and it is the *values* that must never leak.
        const serialized = JSON.stringify(rejected?.trustedInputs);
        expect(serialized).not.toContain("f".repeat(64));
        expect(serialized).not.toMatch(/[0-9a-f]{64}/i);
        expect(serialized).not.toContain(KEY_SECRET);
      });

      it("rejects a malformed payment reference", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();

        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: "pay id with spaces!",
            signature: sign(providerOrderId, "pay id with spaces!"),
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "MALFORMED_PAYMENT_ID",
        });
      });

      it("rejects a payment attempt belonging to another transaction", async () => {
        const mine = await arrangeStarted();
        const theirs = await arrangeStarted();

        const result = await verifyCheckoutCallback(
          {
            transactionId: mine.transactionId,
            paymentAttemptId: theirs.paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(theirs.providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "ATTEMPT_MISMATCH",
        });
        expect(await statusOf(mine.transactionId)).toBe("PAYMENT_PENDING");
        expect(await statusOf(theirs.transactionId)).toBe("PAYMENT_PENDING");
      });

      it("refuses to bind one payment id to two transactions", async () => {
        const first = await arrangeStarted();
        const second = await arrangeStarted();

        const verified = await verifyCheckoutCallback(
          {
            transactionId: first.transactionId,
            paymentAttemptId: first.paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(first.providerOrderId, PAYMENT_ID),
          },
          deps(),
        );
        expect(verified.kind).toBe("PAYMENT_VERIFIED");

        // The same payment, replayed against a different transaction whose order
        // id happens to be the same fake value - so the signature verifies.
        const stolen = await verifyCheckoutCallback(
          {
            transactionId: second.transactionId,
            paymentAttemptId: second.paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(second.providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        expect(stolen).toMatchObject({
          kind: "REJECTED",
          rejection: "PAYMENT_ID_ALREADY_USED",
        });
        expect(await statusOf(second.transactionId)).toBe("PAYMENT_PENDING");
      });

      it("rejects a callback that arrives after the payment window closed", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();
        // There is deliberately no cancel edge out of PAYMENT_PENDING: the state
        // machine will not let a purchase be abandoned while a payment is in
        // flight. Expiry is how this state actually ends without a payment, and
        // it is exactly when a straggling callback would turn up.
        const expired = await applyTransactionEvent(
          { transactionId, event: "PAYMENT_WINDOW_EXPIRED", actor: "system" },
          { prisma: testDb() },
        );
        expect(expired.kind).toBe("APPLIED");

        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "TRANSACTION_STATE_INVALID",
        });
        expect(await statusOf(transactionId)).toBe("EXPIRED");
      });
    });

    // -------------------------------------------------------------------------
    // Idempotency
    // -------------------------------------------------------------------------

    describe("a callback delivered more than once", () => {
      it("converges without a second transition or audit record", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();
        const claim = {
          transactionId,
          paymentAttemptId,
          providerPaymentId: PAYMENT_ID,
          signature: sign(providerOrderId, PAYMENT_ID),
        };

        const first = await verifyCheckoutCallback(claim, deps());
        const second = await verifyCheckoutCallback(claim, deps());

        expect(first.kind).toBe("PAYMENT_VERIFIED");
        expect(second.kind).toBe("PAYMENT_VERIFIED");
        if (second.kind !== "PAYMENT_VERIFIED") return;
        expect(second.replayed).toBe(true);
        expect(second.providerPaymentId).toBe(PAYMENT_ID);

        const transitions = await testDb().transactionStateTransition.findMany({
          where: { transactionId, toStatus: "PAYMENT_VERIFIED" },
        });
        expect(transitions).toHaveLength(1);

        const verifiedEvents = (await auditOf(transactionId)).filter(
          (entry) => entry.action === "payment_verified",
        );
        expect(verifiedEvents).toHaveLength(1);

        const attempts = await testDb().paymentAttempt.findMany({
          where: { transactionId },
        });
        expect(attempts).toHaveLength(1);
      });

      it("refuses a second, different payment for an already verified attempt", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();

        await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        const other = "pay_ADifferentPayment";
        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: other,
            signature: sign(providerOrderId, other),
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "CONFLICTING_PAYMENT",
        });
        const attempt = await testDb().paymentAttempt.findUniqueOrThrow({
          where: { id: paymentAttemptId },
        });
        expect(attempt.providerPaymentId).toBe(PAYMENT_ID);
      });
    });

    // -------------------------------------------------------------------------
    // What the browser may and may not say
    // -------------------------------------------------------------------------

    describe("the request boundary", () => {
      it("rejects a callback that tries to name its own amount or status", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();

        const response = await handleCheckoutCallback(
          new Request("https://test.local/api/payments/callback", {
            method: "POST",
            body: JSON.stringify({
              transactionId,
              paymentAttemptId,
              razorpay_payment_id: PAYMENT_ID,
              razorpay_signature: sign(providerOrderId, PAYMENT_ID),
              amount: 1,
              status: "PAYMENT_VERIFIED",
            }),
          }),
          deps(),
        );

        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe("CALLBACK_REQUEST_INVALID");
        // And nothing moved on the strength of it.
        expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");
      });

      it("answers a refused callback with 422 rather than a success shape", async () => {
        const { transactionId, paymentAttemptId } = await arrangeStarted();

        const response = await handleCheckoutCallback(
          new Request("https://test.local/api/payments/callback", {
            method: "POST",
            body: JSON.stringify({
              transactionId,
              paymentAttemptId,
              razorpay_payment_id: PAYMENT_ID,
              razorpay_signature: "0".repeat(64),
            }),
          }),
          deps(),
        );

        expect(response.status).toBe(422);
        const body = (await response.json()) as {
          data: { kind: string; rejection: string };
        };
        expect(body.data.kind).toBe("REJECTED");
        expect(body.data.rejection).toBe("INVALID_SIGNATURE");
      });
    });

    // -------------------------------------------------------------------------
    // Dismissal
    // -------------------------------------------------------------------------

    describe("closing the payment window", () => {
      it("records the dismissal and changes nothing else", async () => {
        const { transactionId } = await arrangeStarted();

        const result = await recordCheckoutDismissal({ transactionId }, deps());

        expect(result).toMatchObject({ kind: "DISMISSAL_RECORDED" });
        // Not verified, not failed, not cancelled. Nobody said anything happened.
        expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");

        const attempt = await testDb().paymentAttempt.findFirstOrThrow({
          where: { transactionId },
        });
        expect(attempt.providerPaymentId).toBeNull();
        expect(attempt.status).toBe("CREATED");

        const reservation = await testDb().inventoryReservation.findFirstOrThrow({
          where: { transactionId },
        });
        expect(reservation.status).toBe("ACTIVE");

        const dismissed = (await auditOf(transactionId)).find(
          (entry) => entry.action === "payment_checkout_dismissed",
        );
        expect(dismissed?.reasonCode).toBe("CHECKOUT_DISMISSED");
        expect(dismissed?.conciseExplanation).toContain("Nothing was charged");
      });

      it("ignores a dismissal that arrives after the payment was verified", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();
        await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        const result = await recordCheckoutDismissal({ transactionId }, deps());

        // A late window-close event must never contradict a verified payment.
        expect(result).toMatchObject({ kind: "IGNORED", reason: "PAYMENT_VERIFIED" });
        expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
      });
    });
    // -------------------------------------------------------------------------
    // Regressions: defects found auditing this objective
    // -------------------------------------------------------------------------

    describe("authenticity is proved before anything is confirmed", () => {
      it("refuses a replay whose signature is rubbish", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();
        const genuine = {
          transactionId,
          paymentAttemptId,
          providerPaymentId: PAYMENT_ID,
          signature: sign(providerOrderId, PAYMENT_ID),
        };
        expect((await verifyCheckoutCallback(genuine, deps())).kind).toBe(
          "PAYMENT_VERIFIED",
        );

        // Somebody who has learned the transaction and payment ids, but holds no
        // signature, must not be handed a success answer just because the payment
        // is already on record.
        const forged = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: "not-even-a-signature",
          },
          deps(),
        );

        expect(forged).toMatchObject({
          kind: "REJECTED",
          rejection: "INVALID_SIGNATURE",
        });
        // And the real payment is untouched by the attempt.
        expect(await statusOf(transactionId)).toBe("PAYMENT_VERIFIED");
      });

      it("refuses a replay that presents the wrong order id", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();
        await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
          },
          deps(),
        );

        const forged = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: sign(providerOrderId, PAYMENT_ID),
            presentedOrderId: "order_TotallyWrong",
          },
          deps(),
        );

        expect(forged).toMatchObject({
          kind: "REJECTED",
          rejection: "ORDER_ID_MISMATCH",
        });
      });

      it("still converges when the replay is genuine", async () => {
        const { transactionId, paymentAttemptId, providerOrderId } =
          await arrangeStarted();
        const claim = {
          transactionId,
          paymentAttemptId,
          providerPaymentId: PAYMENT_ID,
          signature: sign(providerOrderId, PAYMENT_ID),
          presentedOrderId: providerOrderId,
        };

        await verifyCheckoutCallback(claim, deps());
        const second = await verifyCheckoutCallback(claim, deps());

        expect(second.kind).toBe("PAYMENT_VERIFIED");
        if (second.kind !== "PAYMENT_VERIFIED") return;
        expect(second.replayed).toBe(true);
      });
    });

    describe("a tampered order id is always recordable", () => {
      it("audits a mismatch at the longest length the endpoint accepts", async () => {
        const { transactionId, paymentAttemptId } = await arrangeStarted();
        // Exactly the boundary the request schema permits. Before the bounds were
        // shared, anything past 64 characters made the audit write fail and be
        // swallowed - letting the attacker decide whether the security event was
        // recorded by choosing how long a value to send.
        const longOrderId = `order_${"A".repeat(MAX_PROVIDER_REFERENCE_LENGTH - 6)}`;
        expect(longOrderId).toHaveLength(MAX_PROVIDER_REFERENCE_LENGTH);

        const result = await verifyCheckoutCallback(
          {
            transactionId,
            paymentAttemptId,
            providerPaymentId: PAYMENT_ID,
            signature: "a".repeat(64),
            presentedOrderId: longOrderId,
          },
          deps(),
        );

        expect(result).toMatchObject({
          kind: "REJECTED",
          rejection: "ORDER_ID_MISMATCH",
        });

        const rejected = (await auditOf(transactionId)).filter(
          (entry) => entry.action === "payment_callback_rejected",
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.trustedInputs["presentedOrderId"]).toBe(longOrderId);
      });
    });

    describe("the audit trail cannot be flooded", () => {
      it("caps how many refused callbacks one transaction records", async () => {
        const { transactionId, paymentAttemptId } = await arrangeStarted();

        // Far more attempts than the cap. Each is a real request an
        // unauthenticated caller could make in a loop.
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const result = await verifyCheckoutCallback(
            {
              transactionId,
              paymentAttemptId,
              providerPaymentId: PAYMENT_ID,
              signature: "b".repeat(64),
            },
            deps(),
          );
          // Every one is still refused - the cap bounds the record, never the check.
          expect(result).toMatchObject({ kind: "REJECTED" });
        }

        const rejected = (await auditOf(transactionId)).filter(
          (entry) => entry.action === "payment_callback_rejected",
        );
        expect(rejected.length).toBeGreaterThan(0);
        expect(rejected.length).toBeLessThanOrEqual(25);
        expect(await statusOf(transactionId)).toBe("PAYMENT_PENDING");
      });

      it("records one dismissal per checkout session, however often it is sent", async () => {
        const { transactionId } = await arrangeStarted();

        for (let press = 0; press < 5; press += 1) {
          const result = await recordCheckoutDismissal({ transactionId }, deps());
          expect(result.kind).toBe("DISMISSAL_RECORDED");
        }

        // Closing the same window repeatedly is one fact, not five - and this
        // endpoint needs only a transaction id, so an unbounded row per request
        // would be an open invitation.
        const dismissed = (await auditOf(transactionId)).filter(
          (entry) => entry.action === "payment_checkout_dismissed",
        );
        expect(dismissed).toHaveLength(1);
      });
    });
  },
);
