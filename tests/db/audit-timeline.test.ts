import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  getTransactionAuditHistory,
  recordAuditEvent,
  type AuditTimelineEntry,
} from "@/services/audit/audit-service";
import {
  decideApproval,
  requestApproval,
  type ApprovalServiceDeps,
} from "@/services/approval/approval-service";
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
  validateQuoteForUse,
  type QuoteServiceDeps,
} from "@/services/quote/quote-service";
import {
  applyTransactionEvent,
  getTransactionHistory,
} from "@/services/transaction/transition-service";
import { createTransaction } from "@/services/transaction/creation-service";
import {
  decidePurchase,
  type ProductDecisionDeps,
} from "@/services/product-decision/product-decision-service";
import { createServiceCatalogReader } from "@/services/buyer-agent/catalog-reader";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
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
 * The audit trail against real PostgreSQL.
 *
 * What only a database can settle here is ordering and atomicity. Timestamps
 * have millisecond resolution and rows are written microseconds apart, so two
 * entries can genuinely share an instant - and a timeline that relied on
 * timestamps alone would then render the same transaction in a different order
 * on different reads. The tie-break is tested by forcing a tie rather than by
 * hoping the clock produces one.
 */

const QUOTE_TTL_SECONDS = 300;
const APPROVAL_TTL_SECONDS = 900;
const RESERVATION_TTL_SECONDS = 600;
const CEILING = 300_000n;
const NOW = new Date("2026-07-01T09:00:00.000Z");

const IN_BUDGET = 279_900n;
const OVER_BUDGET = 400_000n;

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
  category: null,
  hardRequirements: [],
};

async function seedPolicy(
  maxAutoApproveAmount = CEILING,
  currency = "INR",
): Promise<void> {
  await testDb().authorizationPolicy.create({
    data: {
      buyerProfileId: fixture.buyerId,
      maxAutoApproveAmount,
      currency,
      autoPurchaseAllowed: true,
      status: "ACTIVE",
      version: 1,
    },
  });
}

async function createProduct(unitAmount: bigint, inventory = 10): Promise<string> {
  const created = await testDb().product.create({
    data: {
      merchantId: fixture.merchantId,
      sku: uid("SKU"),
      name: "Audited Keyboard",
      description: "A keyboard used by the audit tests.",
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

/** Walks a transaction to a quote through the real boundaries. */
async function arrange(options: {
  readonly unitAmount?: bigint;
  readonly inventory?: number;
  readonly productId?: string;
}): Promise<{ transactionId: string; quoteId: string; productId: string }> {
  const productId =
    options.productId ??
    (await createProduct(options.unitAmount ?? IN_BUDGET, options.inventory));

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

  return { transactionId: transaction.id, quoteId: quote.snapshot.quoteId, productId };
}

function actions(timeline: readonly AuditTimelineEntry[]): readonly string[] {
  return timeline.map((entry) => entry.action);
}

function auditOnly(
  timeline: readonly AuditTimelineEntry[],
): readonly AuditTimelineEntry[] {
  return timeline.filter((entry) => entry.source === "AUDIT");
}

describe.skipIf(!databaseConfigured)("the audit timeline", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
    const buyer = await testDb().buyerProfile.create({
      data: { displayName: "Audit Buyer" },
    });
    const merchant = await testDb().merchant.create({
      data: { name: "Audit Merchant", slug: uid("audit-merchant"), status: "ACTIVE" },
    });
    fixture = { buyerId: buyer.id, merchantId: merchant.id };

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

  describe("the successful path", () => {
    it("tells the whole story, in order", async () => {
      await seedPolicy();
      const { transactionId, quoteId, productId } = await arrange({ inventory: 5 });

      const evaluated = await evaluateQuotePolicy(
        { quoteId, operationId: uid("op") },
        policyDeps,
      );
      expect(evaluated.kind === "EVALUATED" && evaluated.transactionState).toBe(
        "AUTHORIZED",
      );

      const reserved = await reserveInventory(
        { transactionId, operationId: uid("op") },
        reservationDeps,
      );
      expect(reserved.kind).toBe("RESERVED");

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });

      // Both halves of the record, merged: what was decided, and how the
      // lifecycle moved because of it.
      expect(actions(timeline)).toEqual([
        "state_transitioned", // -> PRODUCT_SELECTED
        "state_transitioned", // -> PRODUCT_VERIFIED
        "quote_created",
        "state_transitioned", // -> QUOTE_CREATED
        "policy_evaluated",
        "state_transitioned", // -> POLICY_EVALUATED
        "state_transitioned", // -> AUTHORIZED
        "inventory_reserved",
        "state_transitioned", // -> INVENTORY_RESERVED
      ]);

      const policy = timeline.find((entry) => entry.action === "policy_evaluated");
      expect(policy?.actor).toBe("policy_engine");
      expect(policy?.result).toBe("SUCCESS");
      expect(policy?.reasonCode).toBe("WITHIN_AUTO_APPROVE_LIMIT");
      expect(policy?.conciseExplanation).toContain("₹2799.00");
      expect(policy?.conciseExplanation).toContain("₹3000.00");
      expect(policy?.trustedInputs["amountMinor"]).toBe("279900");
      expect(policy?.trustedInputs["currency"]).toBe("INR");
      expect(policy?.trustedInputs["policyVersion"]).toBe(1);

      const quote = timeline.find((entry) => entry.action === "quote_created");
      expect(quote?.actor).toBe("quote_service");
      expect(quote?.trustedInputs["productId"]).toBe(productId);
      expect(quote?.trustedInputs["totalAmountMinor"]).toBe("279900");
      expect(quote?.conciseExplanation).toContain("₹2799.00");

      const reservation = timeline.find((entry) => entry.action === "inventory_reserved");
      expect(reservation?.actor).toBe("inventory_service");
      expect(reservation?.conciseExplanation).toContain("1 unit");
    });

    it("is chronologically ordered and never goes backwards", async () => {
      await seedPolicy();
      const { transactionId, quoteId } = await arrange({ inventory: 5 });
      await evaluateQuotePolicy({ quoteId, operationId: uid("op") }, policyDeps);
      await reserveInventory({ transactionId, operationId: uid("op") }, reservationDeps);

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });

      for (let i = 1; i < timeline.length; i += 1) {
        const previous = timeline[i - 1]?.occurredAt ?? "";
        const current = timeline[i]?.occurredAt ?? "";
        expect(previous <= current).toBe(true);
      }
    });

    it("breaks a timestamp tie deterministically", async () => {
      await seedPolicy();
      const { transactionId } = await arrange({});

      // Timestamps have millisecond resolution, so two rows written in quick
      // succession can genuinely land on the same instant. Forcing the tie is
      // the only way to test the rule that resolves it, rather than hoping the
      // clock cooperates.
      const tiedAt = new Date("2026-07-01T09:30:00.000Z");
      for (let i = 0; i < 4; i += 1) {
        await testDb().auditEvent.create({
          data: {
            transactionId,
            actor: "transaction_service",
            eventType: "transaction_cancelled",
            result: "SUCCESS",
            reasonCode: "USER_CANCELLED",
            metadata: {},
            createdAt: tiedAt,
          },
        });
      }

      const first = await getTransactionAuditHistory(transactionId, { prisma: testDb() });
      const tied = first.filter((entry) => entry.occurredAt === tiedAt.toISOString());
      expect(tied).toHaveLength(4);

      // UUIDv7 ids are themselves time-ordered, so the tie-break is also the
      // order the rows were created in - stable, and meaningful.
      expect(tied.map((entry) => entry.eventId)).toEqual(
        [...tied].map((entry) => entry.eventId).sort(),
      );

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const again = await getTransactionAuditHistory(transactionId, {
          prisma: testDb(),
        });
        expect(again.map((entry) => entry.eventId)).toEqual(
          first.map((entry) => entry.eventId),
        );
      }
    });

    it("puts a decision before the transition it caused when both share an instant", async () => {
      const { transactionId } = await arrange({});
      const tiedAt = new Date("2026-07-01T09:45:00.000Z");

      await testDb().auditEvent.create({
        data: {
          transactionId,
          actor: "policy_engine",
          eventType: "policy_evaluated",
          result: "SUCCESS",
          reasonCode: "WITHIN_AUTO_APPROVE_LIMIT",
          metadata: {},
          createdAt: tiedAt,
        },
      });
      await testDb().transactionStateTransition.updateMany({
        where: { transactionId },
        data: { createdAt: tiedAt },
      });

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const tied = timeline.filter((entry) => entry.occurredAt === tiedAt.toISOString());

      // A decision is what causes the move that follows it, so at an identical
      // instant the audit entry reads first.
      expect(tied[0]?.source).toBe("AUDIT");
      expect(tied.slice(1).every((entry) => entry.source === "STATE_TRANSITION")).toBe(
        true,
      );
      // And transitions among themselves stay in authoritative sequence order.
      const sequences = tied
        .filter((entry) => entry.sequence !== null)
        .map((entry) => entry.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => (a ?? 0) - (b ?? 0)));
    });

    it("places a decision before the state change it caused", async () => {
      await seedPolicy();
      const { transactionId, quoteId } = await arrange({ inventory: 5 });
      await evaluateQuotePolicy({ quoteId, operationId: uid("op") }, policyDeps);

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const policyAt = actions(timeline).indexOf("policy_evaluated");
      const authorizedAt = timeline.findIndex(
        (entry) => entry.trustedInputs["toStatus"] === "AUTHORIZED",
      );
      expect(policyAt).toBeGreaterThanOrEqual(0);
      expect(authorizedAt).toBeGreaterThan(policyAt);
    });
  });

  describe("the blocked path", () => {
    it("records the rule, the amount and the refusal", async () => {
      // A policy in another currency is a hard block.
      await seedPolicy(CEILING, "USD");
      const { transactionId, quoteId } = await arrange({});

      const evaluated = await evaluateQuotePolicy(
        { quoteId, operationId: uid("op") },
        policyDeps,
      );
      expect(evaluated.kind === "EVALUATED" && evaluated.transactionState).toBe(
        "BLOCKED",
      );

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const policy = timeline.find((entry) => entry.action === "policy_evaluated");

      expect(policy?.result).toBe("BLOCKED");
      expect(policy?.reasonCode).toBe("POLICY_CURRENCY_MISMATCH");
      expect(policy?.trustedInputs["policyVersion"]).toBe(1);
      expect(policy?.trustedInputs["amountMinor"]).toBe("279900");
      expect(policy?.trustedInputs["currency"]).toBe("INR");
      expect(policy?.conciseExplanation).toContain("different currencies");

      // And the lifecycle move is in the same story.
      expect(
        timeline.some((entry) => entry.trustedInputs["toStatus"] === "BLOCKED"),
      ).toBe(true);
    });
  });

  describe("the approval path", () => {
    it("records the request, the human decision and everything after it", async () => {
      await seedPolicy();
      const { transactionId, quoteId } = await arrange({
        unitAmount: OVER_BUDGET,
        inventory: 5,
      });
      await evaluateQuotePolicy({ quoteId, operationId: uid("op") }, policyDeps);

      const requested = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );
      if (requested.kind !== "APPROVAL_REQUESTED")
        throw new Error("expected an approval");

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

      await reserveInventory({ transactionId, operationId: uid("op") }, reservationDeps);

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const audited = actions(auditOnly(timeline));

      expect(audited).toEqual([
        "quote_created",
        "policy_evaluated",
        "approval_requested",
        "approval_granted",
        "inventory_reserved",
      ]);

      const requestEvent = timeline.find((e) => e.action === "approval_requested");
      expect(requestEvent?.actor).toBe("approval_gate");
      expect(requestEvent?.result).toBe("PENDING");
      expect(requestEvent?.trustedInputs["amountMinor"]).toBe("400000");
      expect(requestEvent?.conciseExplanation).toContain("₹4000.00");

      const granted = timeline.find((e) => e.action === "approval_granted");
      expect(granted?.result).toBe("SUCCESS");
      expect(granted?.trustedInputs["decidedByBuyerId"]).toBe(fixture.buyerId);
      expect(granted?.conciseExplanation).toContain("A person approved ₹4000.00");

      // The policy recheck that ran at approval time is on the record too.
      expect(granted?.trustedInputs["policyDecision"]).toBe("APPROVAL_REQUIRED");
      expect(granted?.trustedInputs["policyVersion"]).toBe(1);
    });

    it("records a rejection and the cancellation it caused", async () => {
      await seedPolicy();
      const { transactionId, quoteId } = await arrange({ unitAmount: OVER_BUDGET });
      await evaluateQuotePolicy({ quoteId, operationId: uid("op") }, policyDeps);

      const requested = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );
      if (requested.kind !== "APPROVAL_REQUESTED")
        throw new Error("expected an approval");

      await decideApproval(
        {
          token: requested.token,
          decision: "REJECT",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const denied = timeline.find((entry) => entry.action === "approval_denied");
      expect(denied?.result).toBe("BLOCKED");
      expect(denied?.conciseExplanation).toContain("refused");
      expect(
        timeline.some((entry) => entry.trustedInputs["toStatus"] === "CANCELLED"),
      ).toBe(true);
    });

    it("never records the approval token", async () => {
      await seedPolicy();
      const { transactionId, quoteId } = await arrange({ unitAmount: OVER_BUDGET });
      await evaluateQuotePolicy({ quoteId, operationId: uid("op") }, policyDeps);
      const requested = await requestApproval(
        { transactionId, operationId: uid("op") },
        approvalDeps,
      );
      if (requested.kind !== "APPROVAL_REQUESTED")
        throw new Error("expected an approval");

      await decideApproval(
        {
          token: requested.token,
          decision: "APPROVE",
          decidedByBuyerId: fixture.buyerId,
          operationId: uid("op"),
        },
        approvalDeps,
      );

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      expect(JSON.stringify(timeline)).not.toContain(requested.token);
    });
  });

  describe("the quote's own lifecycle", () => {
    it("records why a quote stopped being usable", async () => {
      await seedPolicy();
      const { transactionId, quoteId, productId } = await arrange({});

      await testDb().product.update({
        where: { id: productId },
        data: { unitAmount: 499_900n, version: { increment: 1 } },
      });
      const validation = await validateQuoteForUse(quoteId, quoteDeps);
      expect(validation.kind).toBe("INVALIDATED");

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const invalidated = timeline.find((entry) => entry.action === "quote_invalidated");

      expect(invalidated?.result).toBe("FAILURE");
      expect(invalidated?.trustedInputs["reasons"]).toContain("PRICE_CHANGED");
      expect(invalidated?.conciseExplanation).toContain("PRICE_CHANGED");
    });

    it("records a re-quote as its own event naming the quote it replaced", async () => {
      await seedPolicy();
      const { transactionId, quoteId, productId } = await arrange({});

      const replacement = await createTrustedQuote(
        {
          transactionId,
          productId,
          quantity: 1,
          authority: OPEN_AUTHORITY,
          idempotencyKey: uid("requote"),
          replaceExisting: true,
        },
        quoteDeps,
      );

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const reissued = timeline.find((entry) => entry.action === "quote_reissued");
      expect(reissued?.trustedInputs["quoteId"]).toBe(replacement.snapshot.quoteId);
      expect(reissued?.trustedInputs["replacedQuoteId"]).toBe(quoteId);
      expect(reissued?.conciseExplanation).toContain("Re-quoted");
    });
  });

  describe("the full decision path", () => {
    it("records each decision before the state change it caused", async () => {
      // Exercised through decidePurchase rather than by driving transitions by
      // hand: the ordering rule has to hold on the path the application
      // actually takes, and a fixture that skips that path cannot see it.
      await seedPolicy();
      const productId = await createProduct(IN_BUDGET, 5);
      const merchantSlug = (
        await testDb().merchant.findUniqueOrThrow({
          where: { id: fixture.merchantId },
          select: { slug: true },
        })
      ).slug;

      const deps: ProductDecisionDeps = {
        prisma: testDb(),
        catalog: createServiceCatalogReader({ prisma: testDb(), merchantSlug }),
        clock,
        quoteTtlSeconds: QUOTE_TTL_SECONDS,
      };

      const decision = {
        kind: "PRODUCT_SELECTED",
        correlationId: uid("corr"),
        selectedProductId: productId,
        quantity: 1,
        reasonCodes: ["WITHIN_BUDGET"],
        summary: "This fits.",
        constraints: {
          requestType: "PURCHASE",
          quantity: 1,
          maxBudget: { amountMinor: "300000", currency: "INR" },
          budgetScope: "PER_UNIT",
          category: null,
          hardRequirements: [],
          softPreferences: [],
        },
        observedProduct: {
          productId,
          name: "Audited Keyboard",
          amount: { amountMinor: IN_BUDGET.toString(), currency: "INR" },
          availableQuantity: 5,
          version: 1,
          updatedAt: NOW.toISOString(),
        },
      } as unknown as BuyerAgentDecision;

      const result = await decidePurchase(decision, deps);
      expect(result.kind).toBe("QUOTE_CREATED");
      if (result.kind !== "QUOTE_CREATED") return;

      const timeline = await getTransactionAuditHistory(result.transactionId, {
        prisma: testDb(),
      });

      expect(actions(timeline)).toEqual([
        "intent_interpreted",
        "product_selected",
        "state_transitioned", // -> PRODUCT_SELECTED
        "product_verified",
        "state_transitioned", // -> PRODUCT_VERIFIED
        "quote_created",
        "state_transitioned", // -> QUOTE_CREATED
      ]);

      // The agent is the actor for the intent, and never for anything priced.
      const intent = timeline.find((entry) => entry.action === "intent_interpreted");
      expect(intent?.actor).toBe("buyer_agent");
      const verified = timeline.find((entry) => entry.action === "product_verified");
      expect(verified?.actor).toBe("merchant_service");
      expect(verified?.trustedInputs["unitAmountMinor"]).toBe(IN_BUDGET.toString());
    });

    it("keeps each decision atomic with the transition it explains", async () => {
      // A retry writes neither a second audit entry nor a second transition.
      await seedPolicy();
      const productId = await createProduct(IN_BUDGET, 5);
      const merchantSlug = (
        await testDb().merchant.findUniqueOrThrow({
          where: { id: fixture.merchantId },
          select: { slug: true },
        })
      ).slug;
      const deps: ProductDecisionDeps = {
        prisma: testDb(),
        catalog: createServiceCatalogReader({ prisma: testDb(), merchantSlug }),
        clock,
        quoteTtlSeconds: QUOTE_TTL_SECONDS,
      };
      const correlationId = uid("corr");
      const decision = {
        kind: "PRODUCT_SELECTED",
        correlationId,
        selectedProductId: productId,
        quantity: 1,
        reasonCodes: ["WITHIN_BUDGET"],
        summary: "This fits.",
        constraints: {
          requestType: "PURCHASE",
          quantity: 1,
          maxBudget: { amountMinor: "300000", currency: "INR" },
          budgetScope: "PER_UNIT",
          category: null,
          hardRequirements: [],
          softPreferences: [],
        },
        observedProduct: {
          productId,
          name: "Audited Keyboard",
          amount: { amountMinor: IN_BUDGET.toString(), currency: "INR" },
          availableQuantity: 5,
          version: 1,
          updatedAt: NOW.toISOString(),
        },
      } as unknown as BuyerAgentDecision;

      const first = await decidePurchase(decision, deps);
      const second = await decidePurchase(decision, deps);
      expect(first.kind).toBe("QUOTE_CREATED");
      expect(second.kind).toBe("QUOTE_CREATED");
      if (first.kind !== "QUOTE_CREATED") return;

      const timeline = await getTransactionAuditHistory(first.transactionId, {
        prisma: testDb(),
      });
      expect(actions(timeline).filter((a) => a === "product_selected")).toHaveLength(1);
      expect(actions(timeline).filter((a) => a === "product_verified")).toHaveLength(1);
      expect(actions(timeline).filter((a) => a === "state_transitioned")).toHaveLength(3);
    });
  });

  describe("safety properties", () => {
    it("does not duplicate an event when the same operation is retried", async () => {
      await seedPolicy();
      const { transactionId, quoteId } = await arrange({});
      const operationId = uid("op");

      await evaluateQuotePolicy({ quoteId, operationId }, policyDeps);
      await evaluateQuotePolicy({ quoteId, operationId }, policyDeps);

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      expect(
        timeline.filter((entry) => entry.action === "policy_evaluated"),
      ).toHaveLength(1);
    });

    it("keeps two transactions' histories entirely separate", async () => {
      await seedPolicy();
      const first = await arrange({});
      const second = await arrange({});
      await evaluateQuotePolicy(
        { quoteId: first.quoteId, operationId: uid("op") },
        policyDeps,
      );

      const firstTimeline = await getTransactionAuditHistory(first.transactionId, {
        prisma: testDb(),
      });
      const secondTimeline = await getTransactionAuditHistory(second.transactionId, {
        prisma: testDb(),
      });

      expect(firstTimeline.some((e) => e.action === "policy_evaluated")).toBe(true);
      expect(secondTimeline.some((e) => e.action === "policy_evaluated")).toBe(false);
      const secondIds = new Set(secondTimeline.map((e) => e.eventId));
      for (const entry of firstTimeline) expect(secondIds.has(entry.eventId)).toBe(false);
      expect(firstTimeline.every((e) => e.transactionId === first.transactionId)).toBe(
        true,
      );
    });

    it("leaves the authoritative transition history untouched", async () => {
      await seedPolicy();
      const { transactionId, quoteId } = await arrange({ inventory: 5 });
      await evaluateQuotePolicy({ quoteId, operationId: uid("op") }, policyDeps);
      await reserveInventory({ transactionId, operationId: uid("op") }, reservationDeps);

      const transitions = await getTransactionHistory(transactionId, {
        prisma: testDb(),
      });
      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const mirrored = timeline.filter((entry) => entry.source === "STATE_TRANSITION");

      // Composed, not duplicated: one entry per authoritative transition, in
      // the same order, with the same sequence numbers.
      expect(mirrored).toHaveLength(transitions.length);
      expect(mirrored.map((entry) => entry.sequence)).toEqual(
        transitions.map((transition) => transition.sequence),
      );
      expect(mirrored.map((entry) => entry.trustedInputs["toStatus"])).toEqual(
        transitions.map((transition) => transition.toStatus),
      );

      // And the transaction's own column still agrees with the last transition.
      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe(transitions.at(-1)?.toStatus);
    });

    it("participates in a caller's transaction, and rolls back with it", async () => {
      const { transactionId } = await arrange({});
      const before = (
        await getTransactionAuditHistory(transactionId, { prisma: testDb() })
      ).length;

      await expect(
        testDb().$transaction(async (tx) => {
          await recordAuditEvent(tx, {
            transactionId,
            action: "transaction_cancelled",
            actor: "transaction_service",
            result: "SUCCESS",
            trustedInputs: {},
          });
          // Whatever the business action was, it failed after the audit write.
          throw new Error("the business action failed");
        }),
      ).rejects.toThrow("the business action failed");

      // No orphan record: the audit row went with it.
      const after = await getTransactionAuditHistory(transactionId, { prisma: testDb() });
      expect(after).toHaveLength(before);
    });

    it("refuses a secret before anything is written", async () => {
      const { transactionId } = await arrange({});
      const before = (
        await getTransactionAuditHistory(transactionId, { prisma: testDb() })
      ).length;

      await expect(
        recordAuditEvent(testDb(), {
          transactionId,
          action: "policy_evaluated",
          actor: "policy_engine",
          result: "SUCCESS",
          trustedInputs: {
            quoteId: "q1",
            policyId: null,
            policyVersion: 1,
            decision: "ALLOWED",
            amountMinor: "1",
            currency: "INR",
            geminiApiKey: "AIza-not-a-real-key",
          },
        }),
      ).rejects.toThrow(/secret or model reasoning/);

      const after = await getTransactionAuditHistory(transactionId, { prisma: testDb() });
      expect(after).toHaveLength(before);
    });

    it("converges when two callers race on the same operation", async () => {
      const { transactionId } = await arrange({});
      const operationKey = `race:${uid("op")}`;
      const clientA = freshTestClient();
      const clientB = freshTestClient();

      try {
        const write = (prisma: typeof clientA) =>
          prisma.$transaction((tx) =>
            recordAuditEvent(tx, {
              transactionId,
              action: "transaction_cancelled",
              actor: "transaction_service",
              result: "SUCCESS",
              reasonCode: "USER_CANCELLED",
              trustedInputs: {},
              operationKey,
            }),
          );

        const results = await Promise.all([write(clientA), write(clientB)]);

        // One wrote it, one converged - and crucially neither transaction was
        // aborted by a unique violation, which would have rolled back whatever
        // business action it was auditing.
        expect(results.filter((r) => r.kind === "RECORDED")).toHaveLength(1);
        expect(results.filter((r) => r.kind === "ALREADY_RECORDED")).toHaveLength(1);
        expect(new Set(results.map((r) => r.eventId)).size).toBe(1);
        expect(await testDb().auditEvent.count({ where: { operationKey } })).toBe(1);
      } finally {
        await clientA.$disconnect();
        await clientB.$disconnect();
      }
    });

    it("still renders a row whose event type it does not recognise", async () => {
      // eventType is a VARCHAR, so a legacy or hand-written row is possible.
      // The timeline must render it rather than emitting an undefined sentence.
      const { transactionId } = await arrange({});
      await testDb().auditEvent.create({
        data: {
          transactionId,
          actor: "system",
          eventType: "an_event_type_from_the_future",
          result: "SUCCESS",
          metadata: {},
        },
      });

      const timeline = await getTransactionAuditHistory(transactionId, {
        prisma: testDb(),
      });
      const unknown = timeline.find(
        (entry) => String(entry.action) === "an_event_type_from_the_future",
      );
      expect(unknown).toBeDefined();
      expect(typeof unknown?.conciseExplanation).toBe("string");
      expect(unknown?.conciseExplanation).toContain("no explanation rule");
    });

    it("exposes no way to edit or delete history", async () => {
      // Append-only is a property of the API surface, not a convention.
      const auditModule: Record<string, unknown> =
        await import("@/services/audit/audit-service");
      for (const name of Object.keys(auditModule)) {
        expect(name).not.toMatch(/^(update|delete|remove|purge|edit)/i);
      }
    });
  });
});
