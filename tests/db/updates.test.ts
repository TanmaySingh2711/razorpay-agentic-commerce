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
 * Lifecycle updates.
 *
 * Objective 2 proves only that these state changes *persist*. Who is allowed to
 * make each one, and in what order, is the transaction state machine's job -
 * Objective 3 wires it up. Nothing here should be read as endorsing a caller.
 */
describe.skipIf(!databaseConfigured)("persistence updates", () => {
  let fixture: BaseFixture;

  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  it("updates product inventory, status and version together", async () => {
    const before = await testDb().product.findUniqueOrThrow({
      where: { id: fixture.productId },
    });
    const after = await testDb().product.update({
      where: { id: fixture.productId },
      data: { inventory: 0, status: "OUT_OF_STOCK", version: { increment: 1 } },
    });

    expect(after.inventory).toBe(0);
    expect(after.status).toBe("OUT_OF_STOCK");
    // The version bump is what lets an existing quote be invalidated rather
    // than silently repriced.
    expect(after.version).toBe(before.version + 1);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it("supersedes an authorization policy rather than mutating it", async () => {
    const original = await testDb().authorizationPolicy.create({
      data: {
        buyerProfileId: fixture.buyerId,
        maxAutoApproveAmount: 200_000n,
        currency: "INR",
      },
    });
    await testDb().authorizationPolicy.update({
      where: { id: original.id },
      data: { status: "SUPERSEDED" },
    });
    const replacement = await testDb().authorizationPolicy.create({
      data: {
        buyerProfileId: fixture.buyerId,
        maxAutoApproveAmount: 500_000n,
        currency: "INR",
        version: original.version + 1,
      },
    });

    const policies = await testDb().authorizationPolicy.findMany({
      where: { buyerProfileId: fixture.buyerId },
      orderBy: { version: "asc" },
    });
    // Both survive, so an old decision can still be explained against the
    // policy version that actually applied to it.
    expect(policies).toHaveLength(2);
    expect(policies[0]?.status).toBe("SUPERSEDED");
    expect(replacement.status).toBe("ACTIVE");
  });

  it("persists a transaction status change and its authorized amount", async () => {
    const transactionId = await createTransaction(fixture);
    const updated = await testDb().transaction.update({
      where: { id: transactionId },
      data: {
        status: "AUTHORIZED",
        authorizedAmount: 249_900n,
        currency: "INR",
        productId: fixture.productId,
      },
    });
    expect(updated.status).toBe("AUTHORIZED");
    expect(updated.authorizedAmount).toBe(249_900n);
  });

  it("moves a quote through supersede and consume", async () => {
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

    const invalidated = await testDb().purchaseQuote.update({
      where: { id: quote.id },
      data: { status: "INVALIDATED", invalidatedAt: new Date() },
    });
    expect(invalidated.status).toBe("INVALIDATED");
    expect(invalidated.invalidatedAt).toBeInstanceOf(Date);

    const consumed = await testDb().purchaseQuote.update({
      where: { id: quote.id },
      data: { status: "CONSUMED", consumedAt: new Date() },
    });
    expect(consumed.consumedAt).toBeInstanceOf(Date);
    // The frozen amount is never touched by a status change.
    expect(consumed.totalAmount).toBe(249_900n);
  });

  it("commits and releases inventory reservations", async () => {
    const transactionId = await createTransaction(fixture);
    const purchaseQuoteId = await createQuote(fixture, transactionId, 2);
    const reservation = await testDb().inventoryReservation.create({
      data: {
        transactionId,
        purchaseQuoteId,
        productId: fixture.productId,
        quantity: 2,
        expiresAt: futureDate(),
      },
    });

    const committed = await testDb().inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: "COMMITTED", committedAt: new Date() },
    });
    expect(committed.status).toBe("COMMITTED");
    expect(committed.committedAt).toBeInstanceOf(Date);

    const released = await testDb().inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: "RELEASED", releasedAt: new Date() },
    });
    expect(released.releasedAt).toBeInstanceOf(Date);
  });

  it("records a payment attempt failing and a later attempt succeeding", async () => {
    const transactionId = await createTransaction(fixture);
    const first = await testDb().paymentAttempt.create({
      data: { transactionId, attemptNumber: 1, amount: 249_900n, currency: "INR" },
    });
    await testDb().paymentAttempt.update({
      where: { id: first.id },
      data: {
        status: "FAILED",
        failureCode: "PAYMENT_DECLINED",
        failureReason: "The payment was declined by the issuing bank.",
      },
    });
    const retry = await testDb().paymentAttempt.create({
      data: {
        transactionId,
        attemptNumber: 2,
        amount: 249_900n,
        currency: "INR",
        status: "CAPTURED",
        providerOrderId: uid("order"),
        providerPaymentId: uid("pay"),
      },
    });

    const attempts = await testDb().paymentAttempt.findMany({
      where: { transactionId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts.map((a) => a.status)).toEqual(["FAILED", "CAPTURED"]);
    // The retry carries the same amount: a retry never re-derives the price.
    expect(retry.amount).toBe(first.amount);
  });

  it("decides an approval request once", async () => {
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
        expiresAt: futureDate(),
      },
    });

    const approved = await testDb().approvalRequest.update({
      where: { id: approval.id },
      data: {
        status: "APPROVED",
        decidedAt: new Date(),
        decidedByBuyerId: fixture.buyerId,
      },
    });
    expect(approved.status).toBe("APPROVED");
    // A human, never an agent, occupies the decider slot.
    expect(approved.decidedByBuyerId).toBe(fixture.buyerId);

    const consumed = await testDb().approvalRequest.update({
      where: { id: approval.id },
      data: { status: "CONSUMED" },
    });
    expect(consumed.status).toBe("CONSUMED");
  });

  it("marks a webhook event processed and links it to a transaction", async () => {
    const transactionId = await createTransaction(fixture);
    const event = await testDb().webhookEvent.create({
      data: {
        provider: "RAZORPAY",
        externalEventId: uid("evt"),
        eventType: "payment.captured",
      },
    });
    const processed = await testDb().webhookEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date(), transactionId },
    });
    expect(processed.status).toBe("PROCESSED");
    expect(processed.transactionId).toBe(transactionId);
    expect(processed.receivedAt).toBeInstanceOf(Date);
  });
});
