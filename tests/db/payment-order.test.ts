import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPaymentOrder,
  type PaymentOrderServiceDeps,
} from "@/services/payment/payment-order-service";
import {
  releaseReservation,
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
import {
  decideApproval,
  requestApproval,
  type ApprovalServiceDeps,
} from "@/services/approval/approval-service";
import { applyTransactionEvent } from "@/services/transaction/transition-service";
import { getTransactionAuditHistory } from "@/services/audit/audit-service";
import { createTransaction } from "@/services/transaction/creation-service";
import { handleCreatePaymentOrder } from "@/app/api/payments/handler";
import { deriveReceipt } from "@/domain/payment/rules";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PaymentProvider } from "@/domain/payment/provider";
import {
  FAKE_PROVIDER_ORDER_ID,
  fakePaymentProvider,
} from "../support/fake-payment-provider";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor } from "@/domain/transaction/states";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
  uid,
} from "./harness";

/**
 * Server-side payment order creation, against real PostgreSQL and a fake
 * provider.
 *
 * The provider is faked deliberately and the database is not. Everything worth
 * proving here is a property of concurrent writes and of what survives a
 * rollback: that two simultaneous requests produce one order, that a lost
 * provider response leaves a recoverable row rather than a lie, and that a
 * transaction never reads PAYMENT_ORDER_CREATED without a provider reference
 * beside it. A mocked datastore would let all three break silently. Meanwhile a
 * real Razorpay call cannot be made to time out on demand, and hammering Test
 * Mode from a suite is both slow and rude - so the network is the part that is
 * simulated, and it is simulated at the port, not inside the adapter.
 *
 * The one live Test Mode call this objective needs lives in
 * `scripts/razorpay-smoke.ts` and is run by hand.
 */

const QUOTE_TTL_SECONDS = 300;
const APPROVAL_TTL_SECONDS = 900;
const RESERVATION_TTL_SECONDS = 600;
const CEILING = 300_000n; // ₹3,000.00
const IN_BUDGET = 279_900n; // ₹2,799.00
const OVER_BUDGET = 400_000n; // ₹4,000.00
const NOW = new Date("2026-09-01T09:00:00.000Z");

const PROVIDER_ORDER_ID = FAKE_PROVIDER_ORDER_ID;

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

// ---------------------------------------------------------------------------

/**
 * A client whose Nth interactive transaction rolls back after its statements
 * have run - the shape of a commit failure: the work happened, the commit did
 * not.
 *
 * `$transaction` is rebound to the real client explicitly. Reading it off the
 * proxy and calling it detached loses `this` and fails inside Prisma's engine,
 * which is a property of the stand-in rather than of the code under test.
 */
function clientFailingOnTransaction(db: PrismaClient, failOnNth: number): PrismaClient {
  let seen = 0;
  return new Proxy(db, {
    get(target, property, receiver: unknown) {
      if (property !== "$transaction") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const run = target.$transaction.bind(target) as unknown as (
        fn: (tx: unknown) => Promise<unknown>,
        ...args: unknown[]
      ) => Promise<unknown>;
      return async (
        body: (tx: unknown) => Promise<unknown>,
        ...rest: unknown[]
      ): Promise<unknown> => {
        seen += 1;
        if (seen !== failOnNth) return await run(body, ...rest);
        return await run(async (tx: unknown) => {
          await body(tx);
          throw new Error("simulated commit failure");
        });
      };
    },
  }) as PrismaClient;
}

interface Fixture {
  readonly buyerId: string;
  readonly merchantId: string;
}

let fixture: Fixture;
let clock: MutableClock;
let quoteDeps: QuoteServiceDeps;
let policyDeps: PolicyServiceDeps;
let approvalDeps: ApprovalServiceDeps;
let reservationDeps: ReservationServiceDeps;

function paymentDeps(
  provider: PaymentProvider,
  prisma: PrismaClient = testDb(),
): PaymentOrderServiceDeps {
  return { prisma, clock, provider };
}

async function seedPolicy(version = 1): Promise<string> {
  const created = await testDb().authorizationPolicy.create({
    data: {
      buyerProfileId: fixture.buyerId,
      maxAutoApproveAmount: CEILING,
      currency: "INR",
      autoPurchaseAllowed: true,
      status: "ACTIVE",
      version,
    },
  });
  return created.id;
}

async function createProduct(unitAmount: bigint, inventory = 20): Promise<string> {
  const created = await testDb().product.create({
    data: {
      merchantId: fixture.merchantId,
      sku: uid("SKU"),
      name: "Test Keyboard",
      description: "A keyboard used by the payment order tests.",
      category: "mechanical-keyboard",
      unitAmount,
      currency: "INR",
      inventory,
      status: "AVAILABLE",
      attributes: { switchType: "linear-red" },
    },
  });
  return created.id;
}

interface Arranged {
  readonly transactionId: string;
  readonly quoteId: string;
  readonly productId: string;
  readonly reservationId: string;
}

/**
 * Walks a transaction through every real boundary as far as INVENTORY_RESERVED.
 *
 * Nothing is assembled by raw insert. The creation service, the transition
 * service, the trusted-quote service, Objective 7's policy engine, Objective
 * 8's approval gate and reservation service all run, so every test starts from
 * a state the system can genuinely reach - and a regression in any of them
 * shows up here rather than being papered over by a hand-built row.
 */
async function arrange(
  options: {
    readonly unitAmount?: bigint;
    readonly inventory?: number;
    readonly needsApproval?: boolean;
  } = {},
): Promise<Arranged> {
  const unitAmount = options.unitAmount ?? IN_BUDGET;
  const productId = await createProduct(unitAmount, options.inventory ?? 20);

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

  if (options.needsApproval === true) {
    const requested = await requestApproval(
      { transactionId: transaction.id, operationId: uid("op") },
      approvalDeps,
    );
    expect(requested.kind).toBe("APPROVAL_REQUESTED");
    if (requested.kind !== "APPROVAL_REQUESTED") throw new Error("no approval");

    const decided = await decideApproval(
      {
        token: requested.token,
        decision: "APPROVE",
        decidedByBuyerId: fixture.buyerId,
        operationId: uid("op"),
      },
      approvalDeps,
    );
    expect(decided.kind).toBe("AUTHORIZED");
  }

  const reserved = await reserveInventory(
    { transactionId: transaction.id, operationId: uid("op") },
    reservationDeps,
  );
  expect(reserved.kind).toBe("RESERVED");
  if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");

  return {
    transactionId: transaction.id,
    quoteId: quote.snapshot.quoteId,
    productId,
    reservationId: reserved.reservation.id,
  };
}

async function statusOf(transactionId: string): Promise<string> {
  const row = await testDb().transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true },
  });
  return row.status;
}

async function attemptsFor(transactionId: string) {
  return await testDb().paymentAttempt.findMany({
    where: { transactionId },
    orderBy: { attemptNumber: "asc" },
  });
}

describe.skipIf(!databaseConfigured)("payment order creation", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Payment Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: { name: "Payment Merchant", slug: uid("pay-merchant"), status: "ACTIVE" },
    });
    fixture = { buyerId: buyer.id, merchantId: merchant.id };
    await seedPolicy();

    quoteDeps = { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS };
    policyDeps = { prisma: testDb(), clock, quote: quoteDeps };
    approvalDeps = { prisma: testDb(), clock, ttlSeconds: APPROVAL_TTL_SECONDS };
    reservationDeps = { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS };
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

  // -------------------------------------------------------------------------
  // Preconditions: nothing external happens until every control has passed
  // -------------------------------------------------------------------------

  describe("no provider call is made until every control has passed", () => {
    it("refuses a transaction that is not holding reserved stock", async () => {
      const provider = fakePaymentProvider({});
      const transaction = await createTransaction(
        {
          buyerProfileId: fixture.buyerId,
          merchantId: fixture.merchantId,
          correlationId: uid("corr"),
        },
        { prisma: testDb() },
      );

      const result = await createPaymentOrder(
        { transactionId: transaction.id },
        paymentDeps(provider),
      );

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "TRANSACTION_STATE_INVALID",
        detail: { state: "INTENT_RECEIVED" },
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("refuses an unknown transaction", async () => {
      const provider = fakePaymentProvider({});
      const result = await createPaymentOrder(
        { transactionId: "01999999-0000-7000-8000-000000000000" },
        paymentDeps(provider),
      );

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "TRANSACTION_NOT_FOUND",
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("refuses an expired quote without contacting the provider", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      clock.advanceMs((QUOTE_TTL_SECONDS + 1) * 1000);

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "QUOTE_NOT_USABLE",
        detail: { usability: "EXPIRED" },
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("refuses a quote the product has moved underneath", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId, productId } = await arrange();

      // The merchant re-prices. The frozen quote is no longer an honest price.
      await testDb().product.update({
        where: { id: productId },
        data: { unitAmount: IN_BUDGET + 50_000n, version: { increment: 1 } },
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "QUOTE_NOT_USABLE",
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("refuses when the inventory reservation has been released", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId, reservationId } = await arrange();

      const released = await releaseReservation(
        { reservationId, reasonCode: "USER_CANCELLED" },
        reservationDeps,
      );
      expect(released.kind).toBe("RELEASED");

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "NO_ACTIVE_RESERVATION",
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("refuses a reservation whose hold has lapsed", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      // Past the reservation window but still inside the quote's, so the only
      // thing that has failed is the stock hold.
      clock.advanceMs((RESERVATION_TTL_SECONDS + 1) * 1000);
      const quote = await testDb().purchaseQuote.findFirstOrThrow({
        where: { transactionId },
      });
      await testDb().purchaseQuote.update({
        where: { id: quote.id },
        data: { expiresAt: new Date(clock.now().getTime() + 60_000) },
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "RESERVATION_EXPIRED",
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("refuses a reservation that names a different quote", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId, reservationId } = await arrange();

      // A reservation pointing at somebody else's quote is not this purchase's
      // hold, whatever its transaction column says.
      const other = await arrange();
      await testDb().inventoryReservation.update({
        where: { id: reservationId },
        data: { purchaseQuoteId: other.quoteId },
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "RESERVATION_MISMATCH",
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("stops when the current policy blocks the purchase outright", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      // The buyer withdraws their policy after authorizing. Deny by default:
      // with no active policy there is no authority to spend.
      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: fixture.buyerId },
        data: { status: "SUPERSEDED" },
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "NOT_AUTHORIZED",
        detail: { recheck: "POLICY_BLOCKS" },
      });
      expect(provider.createRequests).toHaveLength(0);
      expect(await statusOf(transactionId)).toBe("INVENTORY_RESERVED");
    });

    it("stops when the buyer revised their policy after authorizing", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: fixture.buyerId },
        data: { version: 2 },
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "NOT_AUTHORIZED",
        detail: { recheck: "POLICY_VERSION_CHANGED" },
      });
      expect(provider.createRequests).toHaveLength(0);
    });

    it("records the refusal in the audit trail without moving the transaction", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();
      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: fixture.buyerId },
        data: { status: "SUPERSEDED" },
      });

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      const history = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const refusal = history.find((entry) => entry.action === "payment_order_created");
      expect(refusal?.result).toBe("BLOCKED");
      expect(refusal?.reasonCode).toBe("NOT_AUTHORIZED");
      expect(await statusOf(transactionId)).toBe("INVENTORY_RESERVED");
    });
  });

  // -------------------------------------------------------------------------
  // A human-approved purchase above the automatic ceiling
  // -------------------------------------------------------------------------

  describe("an above-ceiling purchase a person approved", () => {
    it("proceeds on the strength of its exact scoped approval", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId, quoteId } = await arrange({
        unitAmount: OVER_BUDGET,
        needsApproval: true,
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      // Re-running the engine still answers APPROVAL_REQUIRED - the amount
      // really is above the ceiling - and the approval is what supplies the
      // missing authority.
      expect(result.kind).toBe("ORDER_CREATED");
      if (result.kind !== "ORDER_CREATED") return;
      expect(result.order.amount.amountMinor).toBe(OVER_BUDGET.toString());
      expect(result.quoteId).toBe(quoteId);
    });

    it("names the approval it leaned on in the audit record", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange({
        unitAmount: OVER_BUDGET,
        needsApproval: true,
      });
      const approval = await testDb().approvalRequest.findFirstOrThrow({
        where: { transactionId },
      });

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      const history = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const created = history.find(
        (entry) => entry.action === "payment_order_created" && entry.result === "SUCCESS",
      );
      expect(created?.trustedInputs["approvalId"]).toBe(approval.id);
    });

    it("refuses when the approval was granted for a different amount", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange({
        unitAmount: OVER_BUDGET,
        needsApproval: true,
      });

      // The person agreed to one number; the approval now claims another.
      await testDb().approvalRequest.updateMany({
        where: { transactionId },
        data: { requestedAmount: OVER_BUDGET - 1n },
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "REFUSED",
        refusal: "NOT_AUTHORIZED",
        detail: { recheck: "APPROVAL_REQUIRED" },
      });
      expect(provider.createRequests).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Financial authority
  // -------------------------------------------------------------------------

  describe("the amount comes from the trusted quote and nowhere else", () => {
    it("sends the quote total unchanged, in minor units", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId, quoteId } = await arrange();

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      const quote = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      const sent = provider.createRequests[0];
      expect(sent?.amountMinor).toBe(quote.totalAmount);
      expect(sent?.amountMinor).toBe(IN_BUDGET);
      // ₹2,799.00 = 279900 paise. Multiplying again would send ₹2,79,900.
      expect(sent?.amountMinor).not.toBe(IN_BUDGET * 100n);
      expect(sent?.currency).toBe(quote.currency);
    });

    it("carries only internal references in the provider notes", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId, quoteId, reservationId } = await arrange();

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(provider.createRequests[0]?.notes).toEqual({
        transactionId,
        quoteId,
        reservationId,
      });
    });

    it("rejects a request that tries to name its own amount", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      const response = await handleCreatePaymentOrder(
        new Request("https://test.local/api/payments/order", {
          method: "POST",
          body: JSON.stringify({ transactionId, amount: 100, currency: "INR" }),
        }),
        paymentDeps(provider),
      );

      // Refused outright rather than silently ignored: a caller probing for a
      // cheaper price must be told no, not left unable to tell.
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PAYMENT_ORDER_REQUEST_INVALID");
      expect(provider.createRequests).toHaveLength(0);
    });

    it("accepts the minimal request and never returns the key secret", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      const response = await handleCreatePaymentOrder(
        new Request("https://test.local/api/payments/order", {
          method: "POST",
          body: JSON.stringify({ transactionId }),
        }),
        paymentDeps(provider),
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(PROVIDER_ORDER_ID);
      expect(text).not.toContain("RAZORPAY_KEY_SECRET");
      expect(text.toLowerCase()).not.toContain("secret");
    });
  });

  // -------------------------------------------------------------------------
  // A successful order
  // -------------------------------------------------------------------------

  describe("a confirmed order", () => {
    it("stores the provider order id as a reference and keeps our own key", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result.kind).toBe("ORDER_CREATED");
      if (result.kind !== "ORDER_CREATED") return;

      const [attempt] = await attemptsFor(transactionId);
      expect(attempt?.providerOrderId).toBe(PROVIDER_ORDER_ID);
      // The internal id is ours and is unchanged by anything the provider said.
      expect(attempt?.id).toBe(result.order.paymentAttemptId);
      expect(attempt?.id).not.toBe(PROVIDER_ORDER_ID);
      expect(attempt?.receipt).toBe(deriveReceipt(attempt?.id ?? ""));
      expect(attempt?.attemptNumber).toBe(1);
      expect(attempt?.provider).toBe("RAZORPAY");
    });

    it("moves the transaction to PAYMENT_ORDER_CREATED through the state machine", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({ transactionState: "PAYMENT_ORDER_CREATED" });
      expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");

      const transition = await testDb().transactionStateTransition.findFirstOrThrow({
        where: { transactionId, toStatus: "PAYMENT_ORDER_CREATED" },
      });
      expect(transition.fromStatus).toBe("INVENTORY_RESERVED");
      expect(transition.actor).toBe("payment_provider");
      expect(transition.reasonCode).toBe("PAYMENT_ORDER_CREATED");
      // Not PAYMENT_PENDING: handing checkout to the buyer is a later objective.
      expect(transition.toStatus).not.toBe("PAYMENT_PENDING");
    });

    it("audits the order with trusted facts and no secret", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId, quoteId, reservationId } = await arrange();

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));
      if (result.kind !== "ORDER_CREATED") throw new Error("expected an order");

      const history = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const created = history.find((entry) => entry.action === "payment_order_created");
      expect(created?.result).toBe("SUCCESS");
      expect(created?.actor).toBe("payment_provider");
      expect(created?.trustedInputs).toMatchObject({
        paymentAttemptId: result.order.paymentAttemptId,
        quoteId,
        reservationId,
        amountMinor: IN_BUDGET.toString(),
        currency: "INR",
        provider: "RAZORPAY",
        providerOrderId: PROVIDER_ORDER_ID,
        receipt: result.order.receipt,
        policyVersion: 1,
      });
      expect(created?.conciseExplanation).toContain("payment order was created");

      // The audit payload is allow-listed; nothing resembling a credential can
      // be in it, and the check is written so a future field cannot sneak one in.
      const serialized = JSON.stringify(created?.trustedInputs).toLowerCase();
      for (const forbidden of ["secret", "authorization", "cookie", "password", "key_"]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it("places the audit record before the transition it explains", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      const history = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const auditIndex = history.findIndex(
        (entry) => entry.action === "payment_order_created",
      );
      const transitionIndex = history.findIndex(
        (entry) =>
          entry.source === "STATE_TRANSITION" &&
          entry.trustedInputs["toStatus"] === "PAYMENT_ORDER_CREATED",
      );
      expect(auditIndex).toBeGreaterThanOrEqual(0);
      expect(auditIndex).toBeLessThan(transitionIndex);
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate prevention
  // -------------------------------------------------------------------------

  describe("one purchase, one provider order", () => {
    it("returns the existing order when the same request is repeated", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      const first = await createPaymentOrder({ transactionId }, paymentDeps(provider));
      const second = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(first.kind).toBe("ORDER_CREATED");
      expect(second.kind).toBe("ORDER_CREATED");
      if (first.kind !== "ORDER_CREATED" || second.kind !== "ORDER_CREATED") return;
      expect(second.order.providerOrderId).toBe(first.order.providerOrderId);
      expect(second.replayed).toBe(true);
      expect(provider.createRequests).toHaveLength(1);
      expect(await attemptsFor(transactionId)).toHaveLength(1);
    });

    it("a differing operationId does not buy a second order", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      await createPaymentOrder(
        { transactionId, operationId: uid("op") },
        paymentDeps(provider),
      );
      await createPaymentOrder(
        { transactionId, operationId: uid("op") },
        paymentDeps(provider),
      );

      // The claim identity is derived from the transaction and its quote, so a
      // caller cannot mint a fresh one by changing a string it controls.
      expect(provider.createRequests).toHaveLength(1);
    });

    it("creates exactly one order when two requests race", async () => {
      const { transactionId } = await arrange();
      let inFlight = 0;
      let observedOverlap = false;

      const provider = fakePaymentProvider({});
      const slowProvider: PaymentProvider = {
        ...provider,
        async createOrder(request) {
          inFlight += 1;
          if (inFlight > 1) observedOverlap = true;
          // Hold the "network" open long enough for the second caller to reach
          // the claim, which is the window a duplicate would appear in.
          await new Promise((resolve) => setTimeout(resolve, 60));
          inFlight -= 1;
          return await provider.createOrder(request);
        },
      };

      const [left, right] = await Promise.all([
        createPaymentOrder({ transactionId }, paymentDeps(slowProvider)),
        createPaymentOrder({ transactionId }, paymentDeps(slowProvider)),
      ]);

      expect(observedOverlap).toBe(false);
      expect(provider.createRequests).toHaveLength(1);
      expect(await attemptsFor(transactionId)).toHaveLength(1);

      // One caller owns creation; the other converges or is told to wait. What
      // neither may be is a second order.
      const kinds = [left.kind, right.kind].sort();
      expect(kinds).toContain("ORDER_CREATED");
      for (const kind of kinds) {
        expect(["ORDER_CREATED", "CREATION_IN_PROGRESS"]).toContain(kind);
      }
    });

    it("keeps the receipt stable across a retry, so the provider can deduplicate", async () => {
      const { transactionId } = await arrange();
      const provider = fakePaymentProvider({
        onCreate: () => ({
          kind: "FAILED",
          failure: {
            category: "PROVIDER_UNAVAILABLE",
            code: "SERVER_ERROR",
            httpStatus: 503,
          },
        }),
      });

      await createPaymentOrder({ transactionId }, paymentDeps(provider));
      const [attempt] = await attemptsFor(transactionId);
      const receipt = attempt?.receipt;

      // A retry finds the same claim row, so it presents the same receipt.
      const retryProvider = fakePaymentProvider({});
      await createPaymentOrder({ transactionId }, paymentDeps(retryProvider));
      expect(retryProvider.createRequests[0]?.receipt).toBe(receipt);
    });
  });

  // -------------------------------------------------------------------------
  // Provider failures
  // -------------------------------------------------------------------------

  describe("provider failures", () => {
    const definiteFailures = [
      { category: "AUTHENTICATION_FAILED", code: "AUTH", status: 401, retryable: false },
      {
        category: "INVALID_REQUEST",
        code: "BAD_REQUEST_ERROR",
        status: 400,
        retryable: false,
      },
      { category: "RATE_LIMITED", code: "RATE", status: 429, retryable: true },
      {
        category: "PROVIDER_UNAVAILABLE",
        code: "SERVER_ERROR",
        status: 502,
        retryable: true,
      },
    ] as const;

    for (const failure of definiteFailures) {
      it(`reports ${failure.category} without moving the transaction`, async () => {
        const { transactionId } = await arrange();
        const provider = fakePaymentProvider({
          onCreate: () => ({
            kind: "FAILED",
            failure: {
              category: failure.category,
              code: failure.code,
              httpStatus: failure.status,
            },
          }),
        });

        const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

        expect(result).toMatchObject({
          kind: "PROVIDER_FAILED",
          category: failure.category,
          retryable: failure.retryable,
        });
        expect(await statusOf(transactionId)).toBe("INVENTORY_RESERVED");

        const [attempt] = await attemptsFor(transactionId);
        expect(attempt?.status).toBe("FAILED");
        expect(attempt?.failureCode).toBe(failure.category);
        expect(attempt?.providerOrderId).toBeNull();
      });
    }

    it("keeps the inventory reservation after a transient failure", async () => {
      const { transactionId, reservationId } = await arrange();
      const provider = fakePaymentProvider({
        onCreate: () => ({
          kind: "FAILED",
          failure: {
            category: "PROVIDER_UNAVAILABLE",
            code: "SERVER_ERROR",
            httpStatus: 503,
          },
        }),
      });

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      // Releasing the stock here would punish a buyer for the provider's
      // outage. The hold expires on its own clock if nobody comes back.
      const reservation = await testDb().inventoryReservation.findUniqueOrThrow({
        where: { id: reservationId },
      });
      expect(reservation.status).toBe("ACTIVE");
    });

    it("stores a mapped failure reason rather than the provider's own message", async () => {
      const { transactionId } = await arrange();
      const provider = fakePaymentProvider({
        onCreate: () => ({
          kind: "FAILED",
          failure: {
            category: "INVALID_REQUEST",
            code: "BAD_REQUEST_ERROR",
            httpStatus: 400,
          },
        }),
      });

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      const [attempt] = await attemptsFor(transactionId);
      expect(attempt?.failureReason).toContain("did not create an order");
    });
  });

  // -------------------------------------------------------------------------
  // The ambiguity window
  // -------------------------------------------------------------------------

  describe("an unresolved provider outcome", () => {
    it("parks the attempt for reconciliation instead of retrying", async () => {
      const { transactionId } = await arrange();
      const provider = fakePaymentProvider({
        onCreate: () => ({
          kind: "UNKNOWN",
          failure: { category: "TIMEOUT", code: "TIMEOUT", httpStatus: null },
        }),
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result.kind).toBe("RECONCILIATION_REQUIRED");
      expect(provider.createRequests).toHaveLength(1);

      const [attempt] = await attemptsFor(transactionId);
      expect(attempt?.status).toBe("RECONCILIATION_REQUIRED");
      // The transaction must not claim an order it cannot prove exists.
      expect(await statusOf(transactionId)).toBe("INVENTORY_RESERVED");
    });

    it("audits the unknown outcome as pending, not as a failure", async () => {
      const { transactionId } = await arrange();
      const provider = fakePaymentProvider({
        onCreate: () => ({
          kind: "UNKNOWN",
          failure: { category: "TIMEOUT", code: "TIMEOUT", httpStatus: null },
        }),
      });

      await createPaymentOrder({ transactionId }, paymentDeps(provider));

      const history = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const entry = history.find((item) => item.action === "payment_order_created");
      expect(entry?.result).toBe("PENDING");
      expect(entry?.reasonCode).toBe("PROVIDER_OUTCOME_UNKNOWN");
      expect(entry?.conciseExplanation).toContain("No second order will be created");
    });

    it("converges on the order a lost response had actually created", async () => {
      const { transactionId } = await arrange();

      // First call: the order was created, the answer was lost.
      const lost = fakePaymentProvider({
        onCreate: () => ({
          kind: "UNKNOWN",
          failure: { category: "TIMEOUT", code: "TIMEOUT", httpStatus: null },
        }),
      });
      const first = await createPaymentOrder({ transactionId }, paymentDeps(lost));
      expect(first.kind).toBe("RECONCILIATION_REQUIRED");
      if (first.kind !== "RECONCILIATION_REQUIRED") return;

      // Second call: the provider now answers, and does so by recognising the
      // receipt rather than making anything new.
      const recovering = fakePaymentProvider({
        onCreate: () => ({
          kind: "ALREADY_EXISTS",
          order: {
            providerOrderId: PROVIDER_ORDER_ID,
            amountMinor: IN_BUDGET,
            currency: "INR",
            receipt: first.receipt,
            status: "created",
          },
        }),
      });
      const second = await createPaymentOrder({ transactionId }, paymentDeps(recovering));

      expect(second.kind).toBe("ORDER_CREATED");
      expect(recovering.createRequests[0]?.receipt).toBe(first.receipt);
      expect(await attemptsFor(transactionId)).toHaveLength(1);
      expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");
    });

    it("refuses to record an order whose amount is not the one requested", async () => {
      const { transactionId } = await arrange();
      const provider = fakePaymentProvider({
        onCreate: (request) => ({
          kind: "CREATED",
          order: {
            providerOrderId: PROVIDER_ORDER_ID,
            amountMinor: request.amountMinor + 1n,
            currency: request.currency,
            receipt: request.receipt,
            status: "created",
          },
        }),
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result).toMatchObject({
        kind: "RECONCILIATION_REQUIRED",
        reason: "PROVIDER_AMOUNT_MISMATCH",
      });
      expect(await statusOf(transactionId)).toBe("INVENTORY_RESERVED");
    });
  });

  // -------------------------------------------------------------------------
  // Atomicity of local finalization
  // -------------------------------------------------------------------------

  describe("local finalization is all or nothing", () => {
    it("never leaves a transaction at PAYMENT_ORDER_CREATED without a stored order", async () => {
      const { transactionId } = await arrange();
      const provider = fakePaymentProvider({});

      // The second transaction is the finalization; the first is the claim.
      const failing = clientFailingOnTransaction(testDb(), 2);

      const result = await createPaymentOrder(
        { transactionId },
        paymentDeps(provider, failing),
      );

      expect(result.kind).toBe("RECONCILIATION_REQUIRED");
      // The forbidden half-state: a transaction claiming a payment order that
      // no row can prove exists.
      expect(await statusOf(transactionId)).toBe("INVENTORY_RESERVED");

      const transitions = await testDb().transactionStateTransition.findMany({
        where: { transactionId, toStatus: "PAYMENT_ORDER_CREATED" },
      });
      expect(transitions).toHaveLength(0);

      // The reference the provider gave us survives the failure that lost it,
      // so reconciliation has something to work from.
      const [attempt] = await attemptsFor(transactionId);
      expect(attempt?.status).toBe("RECONCILIATION_REQUIRED");
      expect(attempt?.providerOrderId).toBe(PROVIDER_ORDER_ID);

      // And exactly one order was created, despite the failure.
      expect(provider.createRequests).toHaveLength(1);
    });

    it("finishes the local half on a retry, without a second provider order", async () => {
      const { transactionId } = await arrange();
      const provider = fakePaymentProvider({});

      // Simulate the aftermath of a lost finalization: the attempt already
      // holds the provider order id, but the transaction never moved.
      const claimed = await createPaymentOrder(
        { transactionId },
        paymentDeps(
          fakePaymentProvider({
            onCreate: () => ({
              kind: "UNKNOWN",
              failure: { category: "TIMEOUT", code: "TIMEOUT", httpStatus: null },
            }),
          }),
        ),
      );
      expect(claimed.kind).toBe("RECONCILIATION_REQUIRED");
      if (claimed.kind !== "RECONCILIATION_REQUIRED") return;
      await testDb().paymentAttempt.update({
        where: { id: claimed.paymentAttemptId },
        data: { providerOrderId: PROVIDER_ORDER_ID },
      });

      const result = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(result.kind).toBe("ORDER_CREATED");
      // No create call at all: the order already existed.
      expect(provider.createRequests).toHaveLength(0);
      expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");
    });
  });
  // -------------------------------------------------------------------------
  // Regressions: four defects found auditing this objective
  // -------------------------------------------------------------------------

  describe("a replay only answers for a transaction the order still serves", () => {
    it("refuses once the transaction has been cancelled", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      const created = await createPaymentOrder({ transactionId }, paymentDeps(provider));
      expect(created.kind).toBe("ORDER_CREATED");

      const cancelled = await applyTransactionEvent(
        { transactionId, event: "TRANSACTION_CANCELLED", actor: "human_user" },
        { prisma: testDb() },
      );
      expect(cancelled.kind).toBe("APPLIED");

      const after = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      // The provider order still exists, but this transaction is over. Saying
      // ORDER_CREATED here would be a green light read off a dead transaction.
      expect(after).toMatchObject({
        kind: "REFUSED",
        refusal: "TRANSACTION_STATE_INVALID",
        detail: { state: "CANCELLED" },
      });
      expect(provider.createRequests).toHaveLength(1);
    });

    it("still replays while the order is live and unpaid", async () => {
      const provider = fakePaymentProvider({});
      const { transactionId } = await arrange();

      const first = await createPaymentOrder({ transactionId }, paymentDeps(provider));
      const second = await createPaymentOrder({ transactionId }, paymentDeps(provider));

      expect(second.kind).toBe("ORDER_CREATED");
      if (first.kind !== "ORDER_CREATED" || second.kind !== "ORDER_CREATED") return;
      expect(second.order.providerOrderId).toBe(first.order.providerOrderId);
      expect(second.quoteId).toBe(first.quoteId);
    });
  });

  describe("two callers finalizing the same order", () => {
    it("converges instead of downgrading a succeeded order", async () => {
      const { transactionId } = await arrange();

      // The loser's receipt lookup finds the order while the winner is still
      // in flight, so both reach finalization for the same attempt.
      const inner = fakePaymentProvider({});
      const racing: PaymentProvider = {
        ...inner,
        async createOrder(request) {
          const outcome = await inner.createOrder(request);
          await new Promise((resolve) => setTimeout(resolve, 120));
          return outcome;
        },
        findOrderByReceipt(receipt) {
          return Promise.resolve({
            kind: "FOUND",
            order: {
              providerOrderId: PROVIDER_ORDER_ID,
              amountMinor: IN_BUDGET,
              currency: "INR",
              receipt,
              status: "created",
            },
          });
        },
      };

      const [left, right] = await Promise.all([
        createPaymentOrder({ transactionId }, paymentDeps(racing)),
        createPaymentOrder({ transactionId }, paymentDeps(racing)),
      ]);

      // Neither caller may be told the outcome is unknown: the order exists and
      // is recorded. The loser of the transition race converges on it.
      expect(left.kind).toBe("ORDER_CREATED");
      expect(right.kind).toBe("ORDER_CREATED");
      expect(inner.createRequests).toHaveLength(1);

      const [attempt] = await attemptsFor(transactionId);
      expect(attempt?.status).toBe("CREATED");
      expect(attempt?.providerOrderId).toBe(PROVIDER_ORDER_ID);
      expect(attempt?.failureCode).toBeNull();
      expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");

      // And no PENDING record claiming the outcome was unresolved.
      const history = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const pending = history.filter(
        (entry) => entry.action === "payment_order_created" && entry.result === "PENDING",
      );
      expect(pending).toHaveLength(0);
    });
  });

  describe("distinct provider failures are distinct audit records", () => {
    it("records the second failure of one attempt as well as the first", async () => {
      const { transactionId } = await arrange();
      const failing = () =>
        fakePaymentProvider({
          onCreate: () => ({
            kind: "FAILED",
            failure: {
              category: "PROVIDER_UNAVAILABLE",
              code: "SERVER_ERROR",
              httpStatus: 503,
            },
          }),
        });

      const first = await createPaymentOrder({ transactionId }, paymentDeps(failing()));
      const second = await createPaymentOrder({ transactionId }, paymentDeps(failing()));

      expect(first.kind).toBe("PROVIDER_FAILED");
      expect(second.kind).toBe("PROVIDER_FAILED");

      const history = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const failures = history.filter(
        (entry) => entry.action === "payment_order_created" && entry.result === "FAILURE",
      );
      // Two real provider calls really did fail. An operation key derived from
      // the attempt would have collapsed these into one record and hidden the
      // second entirely.
      expect(failures).toHaveLength(2);
    });
  });

  describe("a claim whose owner died", () => {
    it("does not wedge the transaction at CREATION_IN_PROGRESS forever", async () => {
      const { transactionId } = await arrange();

      // A database failure while recording a definite failure leaves the claim
      // at CREATED with no outcome - as if the owning process had died. The
      // second transaction is that failure record; the first is the claim.
      const failing = clientFailingOnTransaction(testDb(), 2);

      const stuck = await createPaymentOrder(
        { transactionId },
        paymentDeps(
          fakePaymentProvider({
            onCreate: () => ({
              kind: "FAILED",
              failure: {
                category: "PROVIDER_UNAVAILABLE",
                code: "SERVER_ERROR",
                httpStatus: 503,
              },
            }),
          }),
          failing,
        ),
      );
      // The caller still learns what happened rather than getting a 500.
      expect(stuck.kind).toBe("PROVIDER_FAILED");
      const [orphaned] = await attemptsFor(transactionId);
      expect(orphaned?.status).toBe("CREATED");
      expect(orphaned?.providerOrderId).toBeNull();

      // Immediately afterwards the claim looks live, so nothing may take it.
      const tooSoon = await createPaymentOrder(
        { transactionId },
        paymentDeps(fakePaymentProvider({})),
      );
      expect(tooSoon.kind).toBe("CREATION_IN_PROGRESS");

      // Once the lease has elapsed and the provider confirms no order exists
      // for the receipt, a later request may take the claim over.
      clock.advanceMs(120_000);
      const recovered = fakePaymentProvider({});
      const after = await createPaymentOrder({ transactionId }, paymentDeps(recovered));

      expect(after.kind).toBe("ORDER_CREATED");
      expect(recovered.createRequests).toHaveLength(1);
      expect(await statusOf(transactionId)).toBe("PAYMENT_ORDER_CREATED");
      // Still one attempt: the lease takes the claim over, it does not add one.
      expect(await attemptsFor(transactionId)).toHaveLength(1);
    });
  });
});
