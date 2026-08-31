import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createBaseFixture,
  createQuote,
  createTransaction,
  databaseConfigured,
  disconnectTestDb,
  futureDate,
  resetTestData,
  testDb,
  uid,
  type BaseFixture,
} from "./harness";

/**
 * Creation and relation coverage for every persisted entity.
 *
 * These prove the mapping is real: rows land in PostgreSQL, identifiers are
 * generated, timestamps are populated, money round-trips as BIGINT, and the
 * relation graph can be traversed in both directions.
 */
describe.skipIf(!databaseConfigured)("entity persistence", () => {
  let fixture: BaseFixture;

  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  it("creates a buyer, merchant and product with generated ids and timestamps", async () => {
    const product = await testDb().product.findUniqueOrThrow({
      where: { id: fixture.productId },
    });

    // UUIDv7: 36 chars, version nibble 7.
    expect(product.id).toHaveLength(36);
    expect(product.id[14]).toBe("7");
    expect(product.createdAt).toBeInstanceOf(Date);
    expect(product.updatedAt).toBeInstanceOf(Date);
    expect(product.unitAmount).toBe(249_900n);
    expect(typeof product.unitAmount).toBe("bigint");
    expect(product.currency).toBe("INR");
    expect(product.version).toBe(1);
    expect(product.status).toBe("AVAILABLE");
  });

  it("creates an authorization policy scoped to a buyer", async () => {
    const policy = await testDb().authorizationPolicy.create({
      data: {
        buyerProfileId: fixture.buyerId,
        maxAutoApproveAmount: 200_000n,
        currency: "INR",
        autoPurchaseAllowed: true,
      },
    });
    expect(policy.maxAutoApproveAmount).toBe(200_000n);
    expect(policy.status).toBe("ACTIVE");
    expect(policy.version).toBe(1);
  });

  it("creates a transaction with no product, quote or amount yet", async () => {
    const transaction = await testDb().transaction.create({
      data: { buyerProfileId: fixture.buyerId, merchantId: fixture.merchantId },
    });
    // A transaction exists from INTENT_RECEIVED, long before anything is chosen.
    expect(transaction.status).toBe("INTENT_RECEIVED");
    expect(transaction.productId).toBeNull();
    expect(transaction.authorizedAmount).toBeNull();
    expect(transaction.currency).toBeNull();
    expect(transaction.completedAt).toBeNull();
  });

  it("creates a purchase quote whose total equals unit price times quantity", async () => {
    const transactionId = await createTransaction(fixture);
    const quote = await testDb().purchaseQuote.create({
      data: {
        transactionId,
        productId: fixture.productId,
        quantity: 2,
        unitAmount: 249_900n,
        totalAmount: 499_800n,
        currency: "INR",
        productVersion: 1,
        expiresAt: futureDate(),
      },
    });
    expect(quote.totalAmount).toBe(quote.unitAmount * BigInt(quote.quantity));
    expect(quote.status).toBe("ACTIVE");
    expect(quote.consumedAt).toBeNull();
  });

  it("creates an inventory reservation with an expiry", async () => {
    const transactionId = await createTransaction(fixture);
    const purchaseQuoteId = await createQuote(fixture, transactionId);
    const reservation = await testDb().inventoryReservation.create({
      data: {
        transactionId,
        purchaseQuoteId,
        productId: fixture.productId,
        quantity: 1,
        expiresAt: futureDate(),
      },
    });
    expect(reservation.status).toBe("ACTIVE");
    expect(reservation.committedAt).toBeNull();
    expect(reservation.releasedAt).toBeNull();
  });

  it("creates multiple payment attempts for one transaction", async () => {
    const transactionId = await createTransaction(fixture);
    const first = await testDb().paymentAttempt.create({
      data: { transactionId, attemptNumber: 1, amount: 249_900n, currency: "INR" },
    });
    const second = await testDb().paymentAttempt.create({
      data: {
        transactionId,
        attemptNumber: 2,
        amount: 249_900n,
        currency: "INR",
        status: "FAILED",
        failureCode: "PAYMENT_DECLINED",
        failureReason: "The payment was declined by the issuing bank.",
      },
    });

    // Provider references are absent until the provider is actually called.
    expect(first.providerOrderId).toBeNull();
    expect(first.providerPaymentId).toBeNull();
    expect(first.provider).toBe("RAZORPAY");
    expect(second.attemptNumber).toBe(2);
    expect(second.status).toBe("FAILED");
  });

  it("creates a one-time approval request bound to a quote and an amount", async () => {
    const transactionId = await createTransaction(fixture);
    const quote = await testDb().purchaseQuote.create({
      data: {
        transactionId,
        productId: fixture.productId,
        quantity: 1,
        unitAmount: 249_900n,
        totalAmount: 249_900n,
        currency: "INR",
        productVersion: 1,
        expiresAt: futureDate(),
      },
    });
    const approval = await testDb().approvalRequest.create({
      data: {
        transactionId,
        purchaseQuoteId: quote.id,
        requestedAmount: 249_900n,
        currency: "INR",
        policyLimitSnapshot: 200_000n,
        policyVersion: 1,
        reasonCode: "ABOVE_AUTO_APPROVE_LIMIT",
        nonceHash: "a".repeat(64),
        expiresAt: futureDate(),
      },
    });
    expect(approval.status).toBe("PENDING");
    expect(approval.requestedAmount).toBe(249_900n);
    // The plaintext token is never stored - only its digest.
    expect(approval.nonceHash).toHaveLength(64);
    expect(approval.decidedAt).toBeNull();
  });

  it("creates an ordered, immutable transition history", async () => {
    const transactionId = await createTransaction(fixture);
    await testDb().transactionStateTransition.createMany({
      data: [
        {
          transactionId,
          sequence: 1,
          fromStatus: null,
          toStatus: "INTENT_RECEIVED",
          actor: "human_user",
          trigger: "intent_received",
        },
        {
          transactionId,
          sequence: 2,
          fromStatus: "INTENT_RECEIVED",
          toStatus: "PRODUCT_SELECTED",
          actor: "buyer_agent",
          trigger: "product_selected",
        },
      ],
    });

    const history = await testDb().transactionStateTransition.findMany({
      where: { transactionId },
      orderBy: { sequence: "asc" },
    });
    expect(history.map((row) => row.toStatus)).toEqual([
      "INTENT_RECEIVED",
      "PRODUCT_SELECTED",
    ]);
    // Only the first transition may lack a previous state.
    expect(history[0]?.fromStatus).toBeNull();
    expect(history[1]?.fromStatus).toBe("INTENT_RECEIVED");
    expect(history[1]?.actor).toBe("buyer_agent");
  });

  it("creates audit events with structured metadata", async () => {
    const transactionId = await createTransaction(fixture);
    const event = await testDb().auditEvent.create({
      data: {
        transactionId,
        actor: "policy_engine",
        eventType: "policy_evaluated",
        result: "BLOCKED",
        reasonCode: "ABOVE_BUDGET",
        metadata: { quotedAmountMinor: "249900", budgetMinor: "200000", currency: "INR" },
        correlationId: uid("corr"),
      },
    });
    expect(event.result).toBe("BLOCKED");
    expect(event.metadata).toMatchObject({ currency: "INR" });
  });

  it("creates a webhook event keyed by provider and external id", async () => {
    const event = await testDb().webhookEvent.create({
      data: {
        provider: "RAZORPAY",
        externalEventId: uid("evt"),
        eventType: "payment.captured",
        payloadDigest: "b".repeat(64),
      },
    });
    expect(event.status).toBe("RECEIVED");
    expect(event.processedAt).toBeNull();
    expect(event.transactionId).toBeNull();
  });
});

describe.skipIf(!databaseConfigured)("relation graphs", () => {
  let fixture: BaseFixture;

  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  it("walks merchant to products and buyer to policies", async () => {
    await testDb().authorizationPolicy.create({
      data: {
        buyerProfileId: fixture.buyerId,
        maxAutoApproveAmount: 200_000n,
        currency: "INR",
      },
    });

    const merchant = await testDb().merchant.findUniqueOrThrow({
      where: { id: fixture.merchantId },
      include: { products: true },
    });
    const buyer = await testDb().buyerProfile.findUniqueOrThrow({
      where: { id: fixture.buyerId },
      include: { policies: true },
    });

    expect(merchant.products).toHaveLength(1);
    expect(buyer.policies).toHaveLength(1);
  });

  it("walks a transaction to every child collection", async () => {
    const transactionId = await createTransaction(fixture);
    const quote = await testDb().purchaseQuote.create({
      data: {
        transactionId,
        productId: fixture.productId,
        quantity: 1,
        unitAmount: 249_900n,
        totalAmount: 249_900n,
        currency: "INR",
        productVersion: 1,
        expiresAt: futureDate(),
      },
    });
    await testDb().inventoryReservation.create({
      data: {
        transactionId,
        purchaseQuoteId: quote.id,
        productId: fixture.productId,
        quantity: 1,
        expiresAt: futureDate(),
      },
    });
    await testDb().paymentAttempt.create({
      data: { transactionId, attemptNumber: 1, amount: 249_900n, currency: "INR" },
    });
    await testDb().approvalRequest.create({
      data: {
        transactionId,
        purchaseQuoteId: quote.id,
        requestedAmount: 249_900n,
        currency: "INR",
        policyLimitSnapshot: 200_000n,
        policyVersion: 1,
        reasonCode: "ABOVE_AUTO_APPROVE_LIMIT",
        expiresAt: futureDate(),
      },
    });
    await testDb().transactionStateTransition.create({
      data: {
        transactionId,
        sequence: 1,
        toStatus: "INTENT_RECEIVED",
        actor: "human_user",
        trigger: "intent_received",
      },
    });
    await testDb().auditEvent.create({
      data: {
        transactionId,
        actor: "transaction_service",
        eventType: "intent_received",
        result: "SUCCESS",
      },
    });
    await testDb().webhookEvent.create({
      data: {
        provider: "RAZORPAY",
        externalEventId: uid("evt"),
        eventType: "payment.captured",
        transactionId,
      },
    });

    // A deliberately wide include: acceptable in a test that is proving the
    // mapping, never a pattern for production query code.
    const transaction = await testDb().transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: {
        quotes: true,
        reservations: true,
        attempts: true,
        approvals: true,
        transitions: true,
        auditEvents: true,
        webhookEvents: true,
        buyerProfile: true,
        merchant: true,
      },
    });

    expect(transaction.quotes).toHaveLength(1);
    expect(transaction.reservations).toHaveLength(1);
    expect(transaction.attempts).toHaveLength(1);
    expect(transaction.approvals).toHaveLength(1);
    expect(transaction.transitions).toHaveLength(1);
    expect(transaction.auditEvents).toHaveLength(1);
    expect(transaction.webhookEvents).toHaveLength(1);
    expect(transaction.buyerProfile.id).toBe(fixture.buyerId);
    expect(transaction.merchant.id).toBe(fixture.merchantId);
  });

  it("supports several quotes per transaction, with one active", async () => {
    const transactionId = await createTransaction(fixture);
    const base = {
      transactionId,
      productId: fixture.productId,
      quantity: 1,
      unitAmount: 249_900n,
      totalAmount: 249_900n,
      currency: "INR",
      productVersion: 1,
    };
    await testDb().purchaseQuote.create({
      data: { ...base, status: "SUPERSEDED", expiresAt: futureDate() },
    });
    await testDb().purchaseQuote.create({ data: { ...base, expiresAt: futureDate() } });

    const active = await testDb().purchaseQuote.findMany({
      where: { transactionId, status: "ACTIVE" },
    });
    const all = await testDb().purchaseQuote.findMany({ where: { transactionId } });
    expect(all).toHaveLength(2);
    expect(active).toHaveLength(1);
  });
});
