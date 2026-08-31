import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideApproval,
  requestApproval,
  type ApprovalServiceDeps,
} from "@/services/approval/approval-service";
import {
  commitReservation,
  readReservableStock,
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
  applyTransactionEvent,
  getTransactionHistory,
} from "@/services/transaction/transition-service";
import { createTransaction } from "@/services/transaction/creation-service";
import {
  FORBIDDEN_TOOL_NAMES,
  isRegisteredTool,
} from "@/services/buyer-agent/catalog-tools";
import { fixedClock, type MutableClock } from "@/lib/clock";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor } from "@/domain/transaction/states";
import {
  databaseConfigured,
  disconnectTestDb,
  freshTestClient,
  resetTestData,
  testDb,
  uid,
} from "./harness";

/**
 * The human approval gate and inventory reservation, against real PostgreSQL.
 *
 * Two claims here can only be proved by a database. One is that a single-use
 * token really is single-use when two requests arrive at the same instant. The
 * other is that with one unit left and two buyers, exactly one of them gets it.
 * Both are properties of concurrent writes, and a mocked datastore would let a
 * broken implementation pass.
 *
 * Time is injected, so every expiry test is an assertion rather than a wait.
 */

const QUOTE_TTL_SECONDS = 300;
const APPROVAL_TTL_SECONDS = 900;
const RESERVATION_TTL_SECONDS = 600;
const CEILING = 300_000n; // ₹3,000.00
const NOW = new Date("2026-07-01T09:00:00.000Z");

/** Above the ceiling, so policy asks a person. */
const OVER_BUDGET = 400_000n;
/** Below the ceiling, so policy authorizes outright. */
const IN_BUDGET = 279_900n;

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

const OPEN_AUTHORITY: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: null,
  currency: null,
  budgetScope: null,
  hardRequirements: [],
  category: null,
};

async function seedPolicy(
  overrides: { readonly maxAutoApproveAmount?: bigint; readonly version?: number } = {},
): Promise<string> {
  const created = await testDb().authorizationPolicy.create({
    data: {
      buyerProfileId: fixture.buyerId,
      maxAutoApproveAmount: overrides.maxAutoApproveAmount ?? CEILING,
      currency: "INR",
      autoPurchaseAllowed: true,
      status: "ACTIVE",
      version: overrides.version ?? 1,
    },
  });
  return created.id;
}

async function createProduct(unitAmount: bigint, inventory: number): Promise<string> {
  const created = await testDb().product.create({
    data: {
      merchantId: fixture.merchantId,
      sku: uid("SKU"),
      name: "Test Keyboard",
      description: "A keyboard used by the approval and reservation tests.",
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

/**
 * Walks a transaction through the real boundaries as far as its policy decision.
 *
 * Nothing here is assembled by raw insert: the creation service, the transition
 * service, the trusted-quote service and Objective 7's policy engine all run,
 * so every test below starts from a state the system can genuinely reach.
 */
async function arrange(options: {
  readonly unitAmount?: bigint;
  readonly inventory?: number;
  readonly quantity?: number;
  readonly buyerId?: string;
  /** Reuse an existing product, so two buyers can compete for the same stock. */
  readonly productId?: string;
}): Promise<{ transactionId: string; quoteId: string; productId: string }> {
  const quantity = options.quantity ?? 1;
  const productId =
    options.productId ??
    (await createProduct(options.unitAmount ?? OVER_BUDGET, options.inventory ?? 20));
  const buyerProfileId = options.buyerId ?? fixture.buyerId;

  const transaction = await createTransaction(
    { buyerProfileId, merchantId: fixture.merchantId, correlationId: uid("corr") },
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
      quantity,
      authority: { ...OPEN_AUTHORITY, quantity },
      idempotencyKey: uid("quote"),
    },
    quoteDeps,
  );

  const evaluation = await evaluateQuotePolicy(
    { quoteId: quote.snapshot.quoteId, operationId: uid("op") },
    policyDeps,
  );
  expect(evaluation.kind).toBe("EVALUATED");

  return { transactionId: transaction.id, quoteId: quote.snapshot.quoteId, productId };
}

/** Arranges a transaction that is waiting on a person, and opens the question. */
async function arrangeApproval(
  options: { readonly unitAmount?: bigint; readonly inventory?: number } = {},
): Promise<{
  transactionId: string;
  quoteId: string;
  productId: string;
  approvalId: string;
  token: string;
}> {
  const arranged = await arrange({ unitAmount: OVER_BUDGET, ...options });
  const requested = await requestApproval(
    { transactionId: arranged.transactionId, operationId: uid("op") },
    approvalDeps,
  );
  expect(requested.kind).toBe("APPROVAL_REQUESTED");
  if (requested.kind !== "APPROVAL_REQUESTED") throw new Error("expected an approval");

  return { ...arranged, approvalId: requested.approval.id, token: requested.token };
}

/** Drives an authorized transaction to a state that proves payment was captured. */
async function driveToCaptured(transactionId: string): Promise<void> {
  const steps: readonly (readonly [TransactionEvent, TransactionActor])[] = [
    ["PAYMENT_ORDER_CREATED", "payment_provider"],
    ["PAYMENT_STARTED", "payment_provider"],
    ["PAYMENT_CAPTURE_CONFIRMED", "payment_webhook"],
  ];
  for (const [event, actor] of steps) {
    const outcome = await applyTransactionEvent(
      { transactionId, event, actor },
      { prisma: testDb() },
    );
    expect(outcome.kind).toBe("APPLIED");
  }
}

describe.skipIf(!databaseConfigured)("approval gate and inventory reservation", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Approval Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: {
        name: "Approval Merchant",
        slug: uid("approval-merchant"),
        status: "ACTIVE",
      },
    });
    fixture = { buyerId: buyer.id, merchantId: merchant.id };
    await seedPolicy();

    quoteDeps = { prisma: testDb(), clock, ttlSeconds: QUOTE_TTL_SECONDS };
    policyDeps = { prisma: testDb(), clock, quote: quoteDeps };
    approvalDeps = { prisma: testDb(), clock, ttlSeconds: APPROVAL_TTL_SECONDS };
    reservationDeps = { prisma: testDb(), clock, ttlSeconds: RESERVATION_TTL_SECONDS };
  });

  afterEach(async () => {
    await disconnectTestDb();
  });

  // -------------------------------------------------------------------------
  // Creating approvals
  // -------------------------------------------------------------------------

  describe("an approval exists only when policy asked for one", () => {
    it("binds every value to persisted server state", async () => {
      const { transactionId, quoteId } = await arrange({ unitAmount: OVER_BUDGET });

      const result = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );

      expect(result.kind).toBe("APPROVAL_REQUESTED");
      if (result.kind !== "APPROVAL_REQUESTED") return;

      // Every field came from the database, not from the caller - who supplied
      // only two identifiers.
      expect(result.approval.transactionId).toBe(transactionId);
      expect(result.approval.quoteId).toBe(quoteId);
      expect(result.approval.requestedAmount).toEqual({
        amountMinor: OVER_BUDGET.toString(),
        currency: "INR",
      });
      expect(result.approval.policyVersion).toBe(1);
      expect(result.approval.policyLimit.amountMinor).toBe(CEILING.toString());
      expect(result.approval.reasonCode).toBe("EXCEEDS_AUTO_APPROVE_LIMIT");
      expect(result.approval.status).toBe("PENDING");
      // Capped at the quote's own expiry, which is sooner. An approval that
      // outlived the price it is bound to would promise a window the system
      // cannot honour.
      expect(new Date(result.approval.expiresAt).getTime()).toBe(
        NOW.getTime() + QUOTE_TTL_SECONDS * 1000,
      );
      expect(QUOTE_TTL_SECONDS).toBeLessThan(APPROVAL_TTL_SECONDS);

      const events = await testDb().auditEvent.findMany({
        where: { transactionId, eventType: "approval_requested" },
      });
      expect(events).toHaveLength(1);
    });

    it("creates none for a purchase policy already allowed", async () => {
      // Below the ceiling, so Objective 7 authorized it outright. There is no
      // question for a human to answer.
      const { transactionId } = await arrange({ unitAmount: IN_BUDGET });
      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("AUTHORIZED");

      const result = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );

      expect(result.kind).toBe("APPROVAL_NOT_REQUIRED");
      if (result.kind !== "APPROVAL_NOT_REQUIRED") return;
      expect(result.refusal).toBe("NOT_AWAITING_APPROVAL");
      expect(await testDb().approvalRequest.count()).toBe(0);
    });

    it("creates none for a blocked purchase", async () => {
      // A person cannot be asked to approve their way around a hard block.
      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: fixture.buyerId },
        data: { currency: "USD" },
      });
      const { transactionId } = await arrange({ unitAmount: IN_BUDGET });
      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("BLOCKED");

      const result = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );
      expect(result.kind === "APPROVAL_NOT_REQUIRED" && result.refusal).toBe(
        "NOT_AWAITING_APPROVAL",
      );
      expect(await testDb().approvalRequest.count()).toBe(0);
    });

    it("does not mint a second live token for the same transaction", async () => {
      const { transactionId } = await arrangeApproval();

      const second = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );

      // Deliberately not a re-issue: minting a replacement would silently
      // invalidate the token already sent to the human.
      expect(second.kind).toBe("APPROVAL_ALREADY_PENDING");
      expect(await testDb().approvalRequest.count()).toBe(1);
    });

    it("stores no plaintext token anywhere", async () => {
      const { token } = await arrangeApproval();

      // Amounts are BigInt, which JSON.stringify refuses outright.
      const dump = (value: unknown): string =>
        JSON.stringify(value, (_key, item: unknown) =>
          typeof item === "bigint" ? item.toString() : item,
        );

      const approvals = await testDb().approvalRequest.findMany();
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.nonceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(dump(approvals)).not.toContain(token);

      // And not in the audit trail either, which outlives everything.
      expect(dump(await testDb().auditEvent.findMany())).not.toContain(token);
      // Nor in the transition history.
      expect(dump(await testDb().transactionStateTransition.findMany())).not.toContain(
        token,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Answering
  // -------------------------------------------------------------------------

  describe("a human answers", () => {
    it("authorizes the exact purchase that was approved", async () => {
      const { transactionId, quoteId, approvalId, token } = await arrangeApproval();

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind).toBe("AUTHORIZED");
      if (result.kind !== "AUTHORIZED") return;
      expect(result.quoteId).toBe(quoteId);
      expect(result.authorizedAmount.amountMinor).toBe(OVER_BUDGET.toString());
      expect(result.transactionState).toBe("AUTHORIZED");

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("AUTHORIZED");

      const approval = await testDb().approvalRequest.findUniqueOrThrow({
        where: { id: approvalId },
      });
      expect(approval.status).toBe("CONSUMED");
      expect(approval.decidedByBuyerId).toBe(fixture.buyerId);

      const history = await getTransactionHistory(transactionId, { prisma: testDb() });
      expect(history.at(-1)?.toStatus).toBe("AUTHORIZED");
      expect(history.at(-1)?.actor).toBe("approval_gate");
    });

    it("approves one purchase without touching the buyer's policy", async () => {
      const { token } = await arrangeApproval();
      const before = await testDb().authorizationPolicy.findFirstOrThrow({
        where: { buyerProfileId: fixture.buyerId },
      });

      await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      const after = await testDb().authorizationPolicy.findFirstOrThrow({
        where: { buyerProfileId: fixture.buyerId },
      });
      // Agreeing to one ₹4,000 keyboard is not agreeing to a ₹4,000 limit.
      expect(after.maxAutoApproveAmount).toBe(before.maxAutoApproveAmount);
      expect(after.version).toBe(before.version);
      expect(after.autoPurchaseAllowed).toBe(before.autoPurchaseAllowed);
    });

    it("cancels the transaction on rejection", async () => {
      const { transactionId, approvalId, token } = await arrangeApproval();

      const result = await decideApproval(
        {
          token,
          decision: "REJECT",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind).toBe("REJECTED");
      expect(result.kind === "REJECTED" && result.transactionState).toBe("CANCELLED");

      const approval = await testDb().approvalRequest.findUniqueOrThrow({
        where: { id: approvalId },
      });
      expect(approval.status).toBe("REJECTED");
      const events = await testDb().auditEvent.findMany({
        where: { transactionId, eventType: "approval_denied" },
      });
      expect(events).toHaveLength(1);
    });

    it("refuses a token nobody issued", async () => {
      await arrangeApproval();

      const result = await decideApproval(
        {
          token: "not-a-real-token",
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind).toBe("REFUSED");
      // Says nothing about whether any approval exists.
      expect(result.kind === "REFUSED" && result.refusal).toBe("UNKNOWN_TOKEN");
    });

    it("refuses someone who is not the buyer", async () => {
      const { token } = await arrangeApproval();
      const other = await testDb().buyerProfile.create({
        data: { displayName: "Somebody Else" },
      });

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: other.id,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind === "REFUSED" && result.refusal).toBe("NOT_THE_BUYER");
      // Rolled back: a token presented by the wrong person is not spent.
      const approvals = await testDb().approvalRequest.findMany();
      expect(approvals[0]?.status).toBe("PENDING");
    });

    it("refuses a replayed token", async () => {
      const { token } = await arrangeApproval();
      const approve = {
        token,
        decision: "APPROVE" as const,
        decidedByBuyerId: fixture.buyerId,
      };

      const first = await decideApproval(
        { ...approve, operationId: uid("op") },
        approvalDeps,
      );
      expect(first.kind).toBe("AUTHORIZED");

      const second = await decideApproval(
        { ...approve, operationId: uid("op") },
        approvalDeps,
      );
      expect(second.kind).toBe("REFUSED");
      expect(second.kind === "REFUSED" && second.refusal).toBe("ALREADY_SETTLED");
    });

    it("refuses approval after a rejection", async () => {
      const { token } = await arrangeApproval();
      await decideApproval(
        {
          token,
          decision: "REJECT",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );
      expect(result.kind === "REFUSED" && result.refusal).toBe("ALREADY_SETTLED");
    });

    it("lets exactly one of two simultaneous uses of a token win", async () => {
      const { token } = await arrangeApproval();
      const clientA = freshTestClient();
      const clientB = freshTestClient();

      try {
        const attempt = (prisma: typeof clientA) =>
          decideApproval(
            {
              token,
              decision: "APPROVE",
              decidedByBuyerId: fixture.buyerId,
              operationId: uid("op"),
            },
            { prisma, clock, ttlSeconds: APPROVAL_TTL_SECONDS },
          );

        const results = await Promise.all([attempt(clientA), attempt(clientB)]);

        // The conditional UPDATE is the whole guard: one statement matched,
        // one matched nothing.
        expect(results.filter((r) => r.kind === "AUTHORIZED")).toHaveLength(1);
        expect(results.filter((r) => r.kind === "REFUSED")).toHaveLength(1);
        expect(
          await testDb().approvalRequest.count({ where: { status: "CONSUMED" } }),
        ).toBe(1);
      } finally {
        await clientA.$disconnect();
        await clientB.$disconnect();
      }
    });
  });

  describe("the approval window", () => {
    it("authorizes one millisecond before expiry and not at expiry itself", async () => {
      const first = await arrangeApproval();
      const window = await testDb().approvalRequest.findUniqueOrThrow({
        where: { id: first.approvalId },
      });
      const msUntilExpiry = window.expiresAt.getTime() - NOW.getTime();

      clock.advanceMs(msUntilExpiry - 1);
      const justInTime = await decideApproval(
        {
          token: first.token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );
      expect(justInTime.kind).toBe("AUTHORIZED");

      // And the boundary itself, on a fresh approval. Inclusive: at the stamped
      // instant the approval is already over.
      clock.set(NOW);
      const second = await arrangeApproval();
      clock.advanceMs(msUntilExpiry);
      const tooLate = await decideApproval(
        {
          token: second.token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );
      expect(tooLate.kind).toBe("REFUSED");
      if (tooLate.kind !== "REFUSED") return;
      expect(tooLate.refusal).toBe("EXPIRED");
    });

    it("retires a lapsed approval lazily, with no scheduler", async () => {
      const { transactionId, approvalId } = await arrangeApproval();
      const window = await testDb().approvalRequest.findUniqueOrThrow({
        where: { id: approvalId },
      });
      clock.set(new Date(window.expiresAt.getTime() + 1));

      // Asking again is what notices. The request itself refuses - the quote
      // lapsed alongside the approval - but the stale row is retired first,
      // because correctness must not wait for a scheduler that may be late or
      // may never have been run at all.
      const again = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );
      expect(again.kind).toBe("APPROVAL_NOT_REQUIRED");
      if (again.kind !== "APPROVAL_NOT_REQUIRED") return;
      expect(again.refusal).toBe("QUOTE_NOT_USABLE");

      const lapsed = await testDb().approvalRequest.findUniqueOrThrow({
        where: { id: approvalId },
      });
      expect(lapsed.status).toBe("EXPIRED");
      const events = await testDb().auditEvent.findMany({
        where: { transactionId, eventType: "approval_expired" },
      });
      expect(events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Approval is not authorization
  // -------------------------------------------------------------------------

  describe("the world may move while a person is deciding", () => {
    it("refuses when the price changed after the question was asked", async () => {
      const { token, productId } = await arrangeApproval();

      await testDb().product.update({
        where: { id: productId },
        data: { unitAmount: 499_900n, version: { increment: 1 } },
      });

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("QUOTE_NOT_USABLE");
      expect(result.reasons).toContain("PRICE_CHANGED");
      // Consent to ₹4,000 cannot reach ₹4,999.
      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: result.transactionId ?? "" },
      });
      expect(transaction.status).toBe("APPROVAL_REQUIRED");
    });

    it("refuses when the product became unavailable", async () => {
      const { token, productId } = await arrangeApproval();
      await testDb().product.update({
        where: { id: productId },
        data: { status: "OUT_OF_STOCK", inventory: 0, version: { increment: 1 } },
      });

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );
      expect(result.kind === "REFUSED" && result.refusal).toBe("QUOTE_NOT_USABLE");
    });

    it("never outlives the price it is bound to", async () => {
      const { token, approvalId } = await arrangeApproval();

      // The approval window is capped at the quote's expiry, so the two lapse
      // together. Before the cap existed, a person was handed the full approval
      // TTL and then refused partway through it because the quote underneath
      // had already gone - a deadline the system showed but could not honour.
      const approval = await testDb().approvalRequest.findUniqueOrThrow({
        where: { id: approvalId },
      });
      const quote = await testDb().purchaseQuote.findFirstOrThrow({
        where: { transactionId: approval.transactionId, status: "ACTIVE" },
      });
      expect(approval.expiresAt.getTime()).toBe(quote.expiresAt.getTime());

      clock.set(new Date(quote.expiresAt.getTime() + 1));
      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("EXPIRED");
    });

    it("refuses when the live quote is not the one that was approved", async () => {
      const { token, transactionId, quoteId, productId } = await arrangeApproval();

      // Bypassing the services deliberately. The matrix has no QUOTE_ISSUED edge
      // from APPROVAL_REQUIRED, so a transaction awaiting a person cannot be
      // re-quoted through any legal path - which is exactly why this check must
      // still exist and still refuse if that state is ever reached another way.
      const original = await testDb().purchaseQuote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      await testDb().purchaseQuote.updateMany({
        where: { transactionId, status: "ACTIVE" },
        data: { status: "SUPERSEDED", invalidatedAt: clock.now() },
      });
      const replacement = await testDb().purchaseQuote.create({
        data: {
          transactionId,
          productId,
          quantity: original.quantity,
          unitAmount: original.unitAmount,
          totalAmount: original.totalAmount,
          currency: original.currency,
          productVersion: original.productVersion,
          status: "ACTIVE",
          createdAt: clock.now(),
          expiresAt: new Date(clock.now().getTime() + 60_000),
        },
      });

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      // Same price, different quote. Consent names one exact quote.
      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("QUOTE_MISMATCH");
      expect(result.detail["approvedQuoteId"]).toBe(quoteId);
      expect(result.detail["activeQuoteId"]).toBe(replacement.id);
    });

    it("refuses when policy now blocks the purchase outright", async () => {
      const { token } = await arrangeApproval();

      // A currency mismatch is a hard block, not an approvable condition.
      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: fixture.buyerId },
        data: { currency: "USD" },
      });

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("POLICY_NOW_BLOCKS");
      expect(result.detail["reasonCode"]).toBe("POLICY_CURRENCY_MISMATCH");
    });

    it("refuses when the policy was revised after the question was asked", async () => {
      const { token } = await arrangeApproval();

      await testDb().authorizationPolicy.updateMany({
        where: { buyerProfileId: fixture.buyerId },
        data: { maxAutoApproveAmount: 100_000n, version: { increment: 1 } },
      });

      const result = await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("POLICY_VERSION_CHANGED");
      expect(result.detail["approvedUnderPolicyVersion"]).toBe(1);
      expect(result.detail["currentPolicyVersion"]).toBe(2);
    });

    it("leaves the token unspent when the world moved", async () => {
      const { token, productId } = await arrangeApproval();
      await testDb().product.update({
        where: { id: productId },
        data: { unitAmount: 499_900n, version: { increment: 1 } },
      });

      await decideApproval(
        {
          token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      // The refusal rolled the settle back: a person's one chance is not burned
      // because a price moved while they were reading.
      const approval = await testDb().approvalRequest.findFirstOrThrow();
      expect(approval.status).toBe("PENDING");
    });
  });

  // -------------------------------------------------------------------------
  // Reservation
  // -------------------------------------------------------------------------

  describe("claiming stock", () => {
    it("reserves for an authorized transaction and moves the lifecycle", async () => {
      const { transactionId, quoteId, productId } = await arrange({
        unitAmount: IN_BUDGET,
        inventory: 5,
      });

      const result = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );

      expect(result.kind).toBe("RESERVED");
      if (result.kind !== "RESERVED") return;
      expect(result.reservation.quoteId).toBe(quoteId);
      expect(result.reservation.quantity).toBe(1);
      expect(result.transactionState).toBe("INVENTORY_RESERVED");
      expect(new Date(result.reservation.expiresAt).getTime()).toBe(
        NOW.getTime() + RESERVATION_TTL_SECONDS * 1000,
      );

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("INVENTORY_RESERVED");

      // A claim, not a sale: on-hand stock is untouched, reservable falls.
      const stock = await readReservableStock(productId, reservationDeps);
      expect(stock.inventory).toBe(5);
      expect(stock.reserved).toBe(1);
      expect(stock.reservable).toBe(4);

      const events = await testDb().auditEvent.findMany({
        where: { transactionId, eventType: "inventory_reserved" },
      });
      expect(events).toHaveLength(1);
    });

    it("refuses a transaction that is not authorized", async () => {
      // Still waiting on a human. Holding stock now would let an unapproved
      // purchase starve real buyers.
      const { transactionId, productId } = await arrangeApproval({ inventory: 5 });

      const result = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("NOT_AUTHORIZED");
      expect(result.detail["state"]).toBe("APPROVAL_REQUIRED");
      expect((await readReservableStock(productId, reservationDeps)).reserved).toBe(0);
    });

    it("refuses when another buyer already holds the only unit", async () => {
      // The honest route to INSUFFICIENT_STOCK. A quote is a statement about a
      // price and stays valid while one unit remains on hand - what this buyer
      // has lost is the *claim* on it, which is exactly the distinction the
      // reserved counter exists to draw.
      const productId = await createProduct(IN_BUDGET, 1);
      const holder = await arrange({ productId });
      const claimed = await reserveInventory(
        { transactionId: holder.transactionId, operationId: uid("op") },
        reservationDeps,
      );
      expect(claimed.kind).toBe("RESERVED");

      const buyerB = await testDb().buyerProfile.create({
        data: { displayName: "Buyer B" },
      });
      await testDb().authorizationPolicy.create({
        data: {
          buyerProfileId: buyerB.id,
          maxAutoApproveAmount: CEILING,
          currency: "INR",
          autoPurchaseAllowed: true,
          status: "ACTIVE",
          version: 1,
        },
      });
      const contender = await arrange({ productId, buyerId: buyerB.id });

      const result = await reserveInventory(
        { transactionId: contender.transactionId, operationId: uid("op") },
        reservationDeps,
      );

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("INSUFFICIENT_STOCK");
      expect(result.detail["onHand"]).toBe(1);
      expect(result.detail["heldByOthers"]).toBe(1);

      // Nothing partial was written, and the loser stays merely authorized.
      const stock = await readReservableStock(productId, reservationDeps);
      expect(stock.inventory).toBe(1);
      expect(stock.reserved).toBe(1);
      expect(
        await testDb().inventoryReservation.count({ where: { status: "ACTIVE" } }),
      ).toBe(1);
      const loser = await testDb().transaction.findUniqueOrThrow({
        where: { id: contender.transactionId },
      });
      expect(loser.status).toBe("AUTHORIZED");
    });

    it("is idempotent on retry", async () => {
      const { transactionId, productId } = await arrange({
        unitAmount: IN_BUDGET,
        inventory: 5,
      });
      const operationId = uid("op");

      const first = await reserveInventory(
        { transactionId, operationId },
        reservationDeps,
      );
      const second = await reserveInventory(
        { transactionId, operationId },
        reservationDeps,
      );

      expect(first.kind).toBe("RESERVED");
      expect(second.kind).toBe("RESERVED");
      if (first.kind !== "RESERVED" || second.kind !== "RESERVED") return;
      expect(second.replayed).toBe(true);
      expect(second.reservation.id).toBe(first.reservation.id);

      // One claim, one unit held, one lifecycle move.
      expect(await testDb().inventoryReservation.count()).toBe(1);
      expect((await readReservableStock(productId, reservationDeps)).reserved).toBe(1);
      const history = await getTransactionHistory(transactionId, { prisma: testDb() });
      expect(history.filter((h) => h.toStatus === "INVENTORY_RESERVED")).toHaveLength(1);
    });

    it("refuses a transaction that was cancelled after it reserved", async () => {
      // Releasing is a separate operation, so a cancelled transaction still
      // owns its ACTIVE reservation row. Answering RESERVED here would report
      // that stock is legitimately held for a purchase that is over.
      const { transactionId } = await arrange({ unitAmount: IN_BUDGET, inventory: 3 });
      const claimed = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );
      expect(claimed.kind).toBe("RESERVED");

      const cancelled = await applyTransactionEvent(
        { transactionId, event: "TRANSACTION_CANCELLED", actor: "human_user" },
        { prisma: testDb() },
      );
      expect(cancelled.kind).toBe("APPLIED");

      const result = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("NOT_AUTHORIZED");
      expect(result.detail["state"]).toBe("CANCELLED");
    });

    it("lets the database refuse a second active claim on one transaction", async () => {
      const { transactionId, quoteId, productId } = await arrange({
        unitAmount: IN_BUDGET,
        inventory: 5,
      });
      await reserveInventory({ transactionId, operationId: uid("op") }, reservationDeps);

      // Bypassing the service entirely: the partial unique index is the backstop.
      await expect(
        testDb().inventoryReservation.create({
          data: {
            transactionId,
            purchaseQuoteId: quoteId,
            productId,
            quantity: 1,
            status: "ACTIVE",
            expiresAt: new Date(clock.now().getTime() + 60_000),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("the last unit", () => {
    it("goes to exactly one of two simultaneous buyers", async () => {
      // The test this whole design exists for.
      const productId = await createProduct(IN_BUDGET, 1);
      const buyerB = await testDb().buyerProfile.create({
        data: { displayName: "Buyer B" },
      });
      await testDb().authorizationPolicy.create({
        data: {
          buyerProfileId: buyerB.id,
          maxAutoApproveAmount: CEILING,
          currency: "INR",
          autoPurchaseAllowed: true,
          status: "ACTIVE",
          version: 1,
        },
      });

      const authorize = async (buyerProfileId: string): Promise<string> => {
        const transaction = await createTransaction(
          { buyerProfileId, merchantId: fixture.merchantId, correlationId: uid("corr") },
          { prisma: testDb() },
        );
        const steps: readonly (readonly [TransactionEvent, TransactionActor])[] = [
          ["PRODUCT_SELECTION_CONFIRMED", "buyer_agent"],
          ["PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service"],
        ];
        for (const [event, actor] of steps) {
          await applyTransactionEvent(
            { transactionId: transaction.id, event, actor },
            { prisma: testDb() },
          );
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
        const evaluated = await evaluateQuotePolicy(
          { quoteId: quote.snapshot.quoteId, operationId: uid("op") },
          policyDeps,
        );
        expect(evaluated.kind === "EVALUATED" && evaluated.transactionState).toBe(
          "AUTHORIZED",
        );
        return transaction.id;
      };

      const transactionA = await authorize(fixture.buyerId);
      const transactionB = await authorize(buyerB.id);

      // Two genuinely separate connections, issued at the same instant.
      const clientA = freshTestClient();
      const clientB = freshTestClient();

      try {
        const results = await Promise.all([
          reserveInventory(
            { transactionId: transactionA, operationId: uid("op") },
            { prisma: clientA, clock, ttlSeconds: RESERVATION_TTL_SECONDS },
          ),
          reserveInventory(
            { transactionId: transactionB, operationId: uid("op") },
            { prisma: clientB, clock, ttlSeconds: RESERVATION_TTL_SECONDS },
          ),
        ]);

        const reserved = results.filter((r) => r.kind === "RESERVED");
        const refused = results.filter((r) => r.kind === "REFUSED");

        expect(reserved).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0]?.kind === "REFUSED" && refused[0].refusal).toBe(
          "INSUFFICIENT_STOCK",
        );

        // No overselling: one unit on hand, one held, none left.
        const stock = await readReservableStock(productId, reservationDeps);
        expect(stock.inventory).toBe(1);
        expect(stock.reserved).toBe(1);
        expect(stock.reservable).toBe(0);
        expect(
          await testDb().inventoryReservation.count({ where: { status: "ACTIVE" } }),
        ).toBe(1);

        // And the two transactions disagree with each other, correctly: one
        // holds stock, the other is still merely authorized.
        const states = await testDb().transaction.findMany({
          where: { id: { in: [transactionA, transactionB] } },
          select: { status: true },
        });
        expect(states.map((s) => s.status).sort()).toEqual([
          "AUTHORIZED",
          "INVENTORY_RESERVED",
        ]);
      } finally {
        await clientA.$disconnect();
        await clientB.$disconnect();
      }
    });
  });

  describe("releasing and expiring", () => {
    it("gives the stock back, and does so only once", async () => {
      const { transactionId, productId } = await arrange({
        unitAmount: IN_BUDGET,
        inventory: 3,
      });
      const reserved = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );
      if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");

      const first = await releaseReservation(
        { reservationId: reserved.reservation.id, reasonCode: "USER_CANCELLED" },
        reservationDeps,
      );
      expect(first.kind).toBe("RELEASED");
      expect((await readReservableStock(productId, reservationDeps)).reservable).toBe(3);

      // Release runs on cancellation, failure and expiry - paths that are
      // retried and raced. A second call is a no-op, not a double refund.
      const second = await releaseReservation(
        { reservationId: reserved.reservation.id, reasonCode: "USER_CANCELLED" },
        reservationDeps,
      );
      expect(second.kind).toBe("ALREADY_SETTLED");
      const stock = await readReservableStock(productId, reservationDeps);
      expect(stock.reserved).toBe(0);
      expect(stock.inventory).toBe(3);
    });

    it("reports a reservation that never existed", async () => {
      const result = await releaseReservation(
        { reservationId: "01930000-0000-7000-8000-0000000000ff", reasonCode: "X" },
        reservationDeps,
      );
      expect(result.kind).toBe("NOT_FOUND");
    });

    it("frees lapsed stock lazily, with no background worker", async () => {
      const productId = await createProduct(IN_BUDGET, 1);
      const first = await arrange({ productId });
      const reserved = await reserveInventory(
        { transactionId: first.transactionId, operationId: uid("op") },
        reservationDeps,
      );
      if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");
      expect((await readReservableStock(productId, reservationDeps)).reservable).toBe(0);

      // The first buyer walks away. Their hold lapses.
      clock.advanceMs(RESERVATION_TTL_SECONDS * 1000 + 1);

      const buyerB = await testDb().buyerProfile.create({
        data: { displayName: "Buyer B" },
      });
      await testDb().authorizationPolicy.create({
        data: {
          buyerProfileId: buyerB.id,
          maxAutoApproveAmount: CEILING,
          currency: "INR",
          autoPurchaseAllowed: true,
          status: "ACTIVE",
          version: 1,
        },
      });
      const second = await arrange({ productId, buyerId: buyerB.id });

      // The second buyer's attempt is what notices the lapse. Correctness does
      // not wait for a scheduler that may be late or may never have been run.
      const outcome = await reserveInventory(
        { transactionId: second.transactionId, operationId: uid("op") },
        reservationDeps,
      );
      expect(outcome.kind).toBe("RESERVED");

      const lapsed = await testDb().inventoryReservation.findUniqueOrThrow({
        where: { id: reserved.reservation.id },
      });
      expect(lapsed.status).toBe("EXPIRED");
      expect(lapsed.releasedAt).toBeInstanceOf(Date);

      // The unit was freed and immediately re-claimed: one held, none spare.
      const stock = await readReservableStock(productId, reservationDeps);
      expect(stock.inventory).toBe(1);
      expect(stock.reserved).toBe(1);

      const events = await testDb().auditEvent.findMany({
        where: { eventType: "inventory_reservation_expired" },
      });
      expect(events).toHaveLength(1);

      // The expiry belongs to the buyer who walked away, not to the one whose
      // attempt happened to trigger the sweep - so it carries the first
      // transaction's identity, on both fields.
      const abandoned = await testDb().transaction.findUniqueOrThrow({
        where: { id: first.transactionId },
      });
      expect(events[0]?.transactionId).toBe(first.transactionId);
      expect(events[0]?.correlationId).toBe(abandoned.correlationId);
    });
  });

  describe("committing a claim into a sale", () => {
    it("refuses without proof that payment was captured", async () => {
      const { transactionId, productId } = await arrange({
        unitAmount: IN_BUDGET,
        inventory: 3,
      });
      const reserved = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );
      if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");

      const result = await commitReservation(reserved.reservation.id, reservationDeps);

      expect(result.kind).toBe("REFUSED");
      if (result.kind !== "REFUSED") return;
      expect(result.refusal).toBe("PAYMENT_NOT_CAPTURED");
      // Nothing sold, nothing released: the claim is intact.
      const stock = await readReservableStock(productId, reservationDeps);
      expect(stock.inventory).toBe(3);
      expect(stock.reserved).toBe(1);
    });

    it("sells the stock exactly once, and then cannot be released", async () => {
      const { transactionId, productId } = await arrange({
        unitAmount: IN_BUDGET,
        inventory: 3,
      });
      const reserved = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );
      if (reserved.kind !== "RESERVED") throw new Error("expected a reservation");

      await driveToCaptured(transactionId);

      const committed = await commitReservation(reserved.reservation.id, reservationDeps);
      expect(committed.kind).toBe("COMMITTED");
      if (committed.kind !== "COMMITTED") return;
      expect(committed.remainingInventory).toBe(2);

      // On-hand stock fell, and the hold lifted with it: the unit is gone, not held.
      const stock = await readReservableStock(productId, reservationDeps);
      expect(stock.inventory).toBe(2);
      expect(stock.reserved).toBe(0);
      expect(stock.reservable).toBe(2);

      // A replayed commit sells nothing more.
      const replay = await commitReservation(reserved.reservation.id, reservationDeps);
      expect(replay.kind === "REFUSED" && replay.refusal).toBe("NOT_ACTIVE");
      expect((await readReservableStock(productId, reservationDeps)).inventory).toBe(2);

      // And sold stock cannot be handed back into availability.
      const release = await releaseReservation(
        { reservationId: reserved.reservation.id, reasonCode: "USER_CANCELLED" },
        reservationDeps,
      );
      expect(release.kind).toBe("ALREADY_SETTLED");
      expect((await readReservableStock(productId, reservationDeps)).inventory).toBe(2);
    });
  });
});

/**
 * Reachability, asserted against the source rather than a comment.
 *
 * No database needed, but the same claim as everything above: nothing outside
 * this server-side path can approve a purchase or move stock.
 */
describe("no AI or browser authority over approval and inventory", () => {
  it("registers no tool that could approve, reserve, release or commit", () => {
    for (const name of [
      "approvePurchase",
      "approve_purchase",
      "createApproval",
      "create_approval",
      "consumeApproval",
      "consume_approval",
      "reserveInventory",
      "reserve_inventory",
      "releaseInventory",
      "release_inventory",
      "commitInventory",
      "commit_inventory",
      "bypass_approval",
    ]) {
      expect(isRegisteredTool(name)).toBe(false);
      expect(FORBIDDEN_TOOL_NAMES).toContain(name);
    }
  });

  it("keeps the buyer agent out of the approval and inventory services", () => {
    // The agent cannot call what it cannot import.
    for (const file of [
      "src/services/buyer-agent/buyer-agent-service.ts",
      "src/services/buyer-agent/catalog-tools.ts",
      "src/services/buyer-agent/catalog-reader.ts",
      "src/app/api/buyer-agent/handler.ts",
      "src/app/api/buyer-agent/route.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("approval-service");
      expect(source).not.toContain("reservation-service");
    }
  });

  it("never returns the approval token from a read path", () => {
    const contracts = readFileSync("src/domain/approval/contracts.ts", "utf8");
    // The DTO is the only shape an approval is ever read back as, and it has no
    // token field. The plaintext exists in exactly one result arm.
    const dto = contracts.slice(
      contracts.indexOf("export interface ApprovalRequestDto"),
      contracts.indexOf("export type ApprovalRequestResult"),
    );
    expect(dto).not.toContain("token");
    expect(dto).not.toContain("nonce");
  });
});
