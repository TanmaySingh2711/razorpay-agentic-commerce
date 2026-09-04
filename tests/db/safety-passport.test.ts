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
import { createPaymentOrder } from "@/services/payment/payment-order-service";
import { decideApproval, requestApproval } from "@/services/approval/approval-service";
import { reserveInventory } from "@/services/inventory/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import {
  decidePurchase,
  type ProductDecisionDeps,
} from "@/services/product-decision/product-decision-service";
import { createServiceCatalogReader } from "@/services/buyer-agent/catalog-reader";
import { loadTransactionOverview } from "@/services/transaction/overview-service";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type {
  PassportCheck,
  PassportCheckId,
  SafetyPassportViewModel,
} from "@/domain/safety/passport";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
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
 * The Safety Passport, proved against the rows it claims to summarise.
 *
 * `tests/safety-passport.test.ts` proves the mapping from facts to claims. This
 * file proves the other half, which no pure test can: that the facts the
 * passport is handed are the ones the real boundaries actually write. Every
 * transaction below is driven through the genuine services against real
 * PostgreSQL - quote, policy, approval, reservation, payment order, checkout
 * and webhook - and the passport is then read back from
 * `loadTransactionOverview`, exactly as the page reads it.
 *
 * That distinction matters because the failure mode being guarded against is
 * not a wrong branch; it is a passport that is confidently green about a fact
 * nothing recorded. A test that fabricated its own audit events could not catch
 * that. These do not fabricate anything: the counts come from rows the services
 * wrote while doing their ordinary work.
 *
 * The provider's network is faked. Its signature checks are the real ones.
 */

const QUOTE_TTL_SECONDS = 900;
const APPROVAL_TTL_SECONDS = 900;
const RESERVATION_TTL_SECONDS = 3600;
const PRICE = 279_900n;
const CEILING = 300_000n;
const NOW = new Date("2026-09-03T09:00:00.000Z");

const KEY_ID = "rzp_test_passportsuite";
const KEY_SECRET = "passport_suite_api_secret";
const WEBHOOK_SECRET = "passport_suite_webhook_secret";

/** The real adapter, used only for its cryptography. */
const realVerifier = createRazorpayProvider({
  keyId: KEY_ID,
  keySecret: KEY_SECRET,
  webhookSecret: WEBHOOK_SECRET,
  baseUrl: "https://unused.test/v1",
  fetchImpl: (() => Promise.reject(new Error("no network here"))) as never,
});

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

function eventBody(
  event: "payment.captured" | "payment.failed",
  orderId: string,
  paymentId: string,
): string {
  return JSON.stringify({
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: Number(PRICE),
          currency: "INR",
          status: event === "payment.captured" ? "captured" : "failed",
          ...(event === "payment.failed" ? { error_code: "BAD_REQUEST_ERROR" } : {}),
        },
      },
    },
  });
}

/** Delivers one authentically signed webhook under the given provider event id. */
async function deliver(rawBody: string, providerEventId: string) {
  return await processWebhook(
    {
      rawBody,
      signature: createHmac("sha256", WEBHOOK_SECRET)
        .update(rawBody, "utf8")
        .digest("hex"),
      providerEventId,
    },
    webhookDeps(),
  );
}

async function statusOf(transactionId: string): Promise<TransactionState> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status as TransactionState;
}

async function passportOf(transactionId: string): Promise<SafetyPassportViewModel> {
  const overview = await loadTransactionOverview(transactionId, {
    prisma: testDb(),
    clock,
  });
  if (overview === null) throw new Error("expected a transaction");
  return overview.passport;
}

function checkOf(passport: SafetyPassportViewModel, id: PassportCheckId): PassportCheck {
  const found = passport.checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no passport check with id ${id}`);
  return found;
}

interface Arranged {
  readonly transactionId: string;
  readonly productId: string;
  readonly providerOrderId: string;
}

/**
 * Drives a purchase to a live quote through the real boundaries.
 *
 * Deliberately through `decidePurchase` rather than by applying transitions by
 * hand. The passport's "AI selection bounded to merchant catalog" claim rests
 * on the `product_verified` audit record, and only the product-decision
 * boundary writes it — a fixture that drove the state machine directly would
 * reach the same states with none of the evidence, and would prove the claim
 * against records the application never produces.
 *
 * No model is involved: `decidePurchase` takes an already-structured decision,
 * and it is the *server* half of that path — re-reading the catalog, verifying
 * the proposal, freezing the price — that is under test here.
 */
async function arrangeQuoted(): Promise<{ transactionId: string; productId: string }> {
  const product = await testDb().product.create({
    data: {
      merchantId,
      sku: uid("SKU"),
      name: "Passport Test Keyboard",
      description: "A keyboard used by the safety passport tests.",
      category: "mechanical-keyboard",
      unitAmount: PRICE,
      currency: "INR",
      inventory: 5,
      status: "AVAILABLE",
      attributes: {},
    },
  });

  const merchant = await testDb().merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { slug: true },
  });

  const deps: ProductDecisionDeps = {
    prisma: testDb(),
    catalog: createServiceCatalogReader({
      prisma: testDb(),
      merchantSlug: merchant.slug,
    }),
    clock,
    quoteTtlSeconds: QUOTE_TTL_SECONDS,
  };

  const decision = {
    kind: "PRODUCT_SELECTED",
    correlationId: uid("corr"),
    selectedProductId: product.id,
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
      productId: product.id,
      name: "Passport Test Keyboard",
      amount: { amountMinor: PRICE.toString(), currency: "INR" },
      availableQuantity: 5,
      version: 1,
      updatedAt: NOW.toISOString(),
    },
  } as unknown as BuyerAgentDecision;

  const result = await decidePurchase(decision, deps);
  if (result.kind !== "QUOTE_CREATED") {
    throw new Error(`expected a quote, got ${result.kind}`);
  }

  expect(
    (
      await evaluateQuotePolicy(
        { quoteId: result.quote.id, operationId: uid("op") },
        {
          prisma: testDb(),
          clock,
          quote: { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS },
        },
      )
    ).kind,
  ).toBe("EVALUATED");

  return { transactionId: result.transactionId, productId: product.id };
}

/** Quoted, held and with a provider order waiting. */
async function arrangeReady(): Promise<Arranged> {
  const { transactionId, productId } = await arrangeQuoted();

  const reserved = await reserveInventory(
    { transactionId, operationId: uid("op") },
    { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS },
  );
  if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");

  const order = await createPaymentOrder(
    { transactionId },
    { prisma: testDb(), clock, provider },
  );
  if (order.kind !== "ORDER_CREATED") throw new Error("expected an order");

  expect((await startCheckout({ transactionId }, checkoutDeps())).kind).toBe(
    "CHECKOUT_READY",
  );

  return { transactionId, productId, providerOrderId: order.order.providerOrderId };
}

describe.skipIf(!databaseConfigured)(
  "the safety passport, read from real records",
  () => {
    beforeEach(async () => {
      await resetTestData();
      clock = fixedClock(NOW);
      provider = fakePaymentProvider({
        onVerify: (input) => realVerifier.verifyCheckoutSignature(input),
        onVerifyWebhook: (input) => realVerifier.verifyWebhookSignature(input),
      });

      const buyer = await testDb().buyerProfile.create({
        data: { displayName: "Passport Test Buyer" },
      });
      const merchant = await testDb().merchant.create({
        data: { name: "Passport Test Merchant", slug: uid("merchant") },
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

    it("reports a completed purchase from the records the payment path wrote", async () => {
      const { transactionId, providerOrderId } = await arrangeReady();
      const captured = await deliver(
        eventBody("payment.captured", providerOrderId, uid("pay").slice(0, 20)),
        uid("evt"),
      );
      expect(captured.kind).toBe("RECONCILED");
      expect(await statusOf(transactionId)).toBe("COMPLETED");

      const passport = await passportOf(transactionId);

      expect(checkOf(passport, "AI_BOUNDED").status).toBe("VERIFIED");
      expect(checkOf(passport, "PRICE_VERIFIED").value).toMatch(/2,799\.00 INR/);
      expect(checkOf(passport, "POLICY").status).toBe("ALLOWED");
      expect(checkOf(passport, "HUMAN_APPROVAL").status).toBe("NOT_REQUIRED");
      expect(checkOf(passport, "INVENTORY").status).toBe("COMMITTED");
      expect(checkOf(passport, "PAYMENT_AMOUNT").status).toBe("VERIFIED");
      expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("CAPTURED");
      expect(checkOf(passport, "TRANSACTION").status).toBe("COMPLETED");

      // The claim that needs history rather than the current row.
      const committed = checkOf(passport, "INVENTORY_COMMITTED");
      expect(committed.value).toBe("Committed exactly once");
      expect(committed.tone).toBe("POSITIVE");

      expect(passport.properties.every((property) => property.evidenced)).toBe(true);
    });

    it("reports a redelivered webhook as deduplicated, not as a second settlement", async () => {
      const { transactionId, providerOrderId } = await arrangeReady();
      const paymentId = uid("pay").slice(0, 20);
      const body = eventBody("payment.captured", providerOrderId, paymentId);

      const eventId = uid("evt");
      expect((await deliver(body, eventId)).kind).toBe("RECONCILED");
      // The same provider event id again: a redelivery, which must change nothing.
      expect((await deliver(body, eventId)).kind).toBe("DUPLICATE");

      const passport = await passportOf(transactionId);
      const rows = passport.retry?.rows ?? [];
      expect(rows.find((row) => row.label === "Duplicate provider event")?.value).toBe(
        "DEDUPLICATED",
      );

      // Deduplicated means no second effect anywhere the passport speaks about.
      expect(checkOf(passport, "INVENTORY_COMMITTED").value).toBe(
        "Committed exactly once",
      );
      expect(
        passport.properties.find((property) => property.label === "Failure-safe")
          ?.evidenced,
      ).toBe(true);
    });

    it("reports an approval that was genuinely demanded, granted and consumed", async () => {
      // A ceiling below the price is what makes the policy engine demand a person.
      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: buyerId },
        data: { maxAutoApproveAmount: 1_000n },
      });

      const { transactionId } = await arrangeQuoted();
      expect(await statusOf(transactionId)).toBe("APPROVAL_REQUIRED");

      const beforeDecision = await passportOf(transactionId);
      expect(checkOf(beforeDecision, "POLICY").status).toBe("REQUIRED");
      expect(checkOf(beforeDecision, "HUMAN_APPROVAL").status).toBe("REQUIRED");
      expect(checkOf(beforeDecision, "HUMAN_APPROVAL").tone).not.toBe("POSITIVE");

      const requested = await requestApproval(
        { transactionId, operationId: uid("op") },
        { prisma: testDb(), clock, ttlSeconds: APPROVAL_TTL_SECONDS },
      );
      if (requested.kind !== "APPROVAL_REQUESTED") {
        throw new Error("expected an approval token");
      }
      const decided = await decideApproval(
        {
          token: requested.token,
          decision: "APPROVE",
          decidedByBuyerId: buyerId,
          operationId: uid("op"),
        },
        { prisma: testDb(), clock, ttlSeconds: APPROVAL_TTL_SECONDS },
      );
      expect(decided.kind).toBe("AUTHORIZED");

      const passport = await passportOf(transactionId);
      const approval = checkOf(passport, "HUMAN_APPROVAL");
      expect(approval.status).toBe("APPROVED");
      expect(approval.value).toBe("Approved once");
      expect(checkOf(passport, "TRANSACTION").value).toBe("AUTHORIZED");
      // Nothing has been paid, so nothing downstream may read as done.
      expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("NOT_REACHED");
      expect(checkOf(passport, "INVENTORY_COMMITTED").status).toBe("NOT_REACHED");
    });

    it("reports a purchase the policy refused without a success narrative", async () => {
      // No active policy at all. Absence is never permission, and the engine
      // blocks rather than assuming a default ceiling.
      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: buyerId },
        data: { status: "SUPERSEDED" },
      });

      const { transactionId } = await arrangeQuoted();
      expect(await statusOf(transactionId)).toBe("BLOCKED");

      const passport = await passportOf(transactionId);
      expect(checkOf(passport, "POLICY").status).toBe("BLOCKED");
      expect(checkOf(passport, "TRANSACTION").status).toBe("BLOCKED");
      expect(passport.subtitle).toMatch(/where it stopped/);
      expect(checkOf(passport, "INVENTORY").status).toBe("NOT_REACHED");
      expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("NOT_REACHED");
    });

    it("reports a failed payment as failed, with the hold still shown as held", async () => {
      const { transactionId, providerOrderId } = await arrangeReady();
      const failed = await deliver(
        eventBody("payment.failed", providerOrderId, uid("pay").slice(0, 20)),
        uid("evt"),
      );
      expect(failed.kind).toBe("RECONCILED");
      expect(await statusOf(transactionId)).toBe("PAYMENT_FAILED");

      const passport = await passportOf(transactionId);
      expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("FAILED");
      expect(checkOf(passport, "PROVIDER_CAPTURE").tone).toBe("NEGATIVE");
      expect(checkOf(passport, "INVENTORY").status).toBe("RESERVED");
      expect(checkOf(passport, "INVENTORY_COMMITTED").status).toBe("NOT_REACHED");
      expect(checkOf(passport, "TRANSACTION").status).toBe("FAILED");
      expect(passport.subtitle).toMatch(/where it stopped/);

      // Retry eligibility comes from the server's own gate, not from the panel.
      const rows = passport.retry?.rows ?? [];
      expect(rows.find((row) => row.label === "Retry eligibility")?.value).toBe(
        "AVAILABLE",
      );
    });

    it("shows a payment order waiting as pending, never as verified or captured", async () => {
      const { transactionId } = await arrangeReady();

      const passport = await passportOf(transactionId);
      expect(checkOf(passport, "CALLBACK_VERIFIED").status).toBe("PENDING");
      expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("PENDING");
      expect(checkOf(passport, "INVENTORY_COMMITTED").status).toBe("NOT_REACHED");
      expect(checkOf(passport, "PAYMENT_AMOUNT").status).toBe("VERIFIED");
      expect(passport.retry).toBeNull();
    });

    it("does not move the transaction by building its passport", async () => {
      const { transactionId } = await arrangeReady();
      const before = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      const [attemptsBefore, auditBefore] = await Promise.all([
        testDb().paymentAttempt.count({ where: { transactionId } }),
        testDb().auditEvent.count({ where: { transactionId } }),
      ]);

      for (let i = 0; i < 3; i += 1) await passportOf(transactionId);

      const after = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(await testDb().paymentAttempt.count({ where: { transactionId } })).toBe(
        attemptsBefore,
      );
      expect(await testDb().auditEvent.count({ where: { transactionId } })).toBe(
        auditBefore,
      );
    });
  },
);
