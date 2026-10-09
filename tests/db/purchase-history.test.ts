import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadPurchaseSummaries } from "@/services/purchase-history-service";
import {
  createBaseFixture,
  createQuote,
  createTransaction,
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
  uid,
  type BaseFixture,
} from "./harness";

/**
 * What a history row shows, read from the rows the purchase page reads.
 *
 * The browser only ever supplies ids. Product, amount, state and refund must
 * all come from PostgreSQL, in the order the browser remembered them, and an
 * id that is malformed or unknown must simply not appear.
 */

const deps = () => ({ prisma: testDb() });
let fixture: BaseFixture;

describe.skipIf(!databaseConfigured)("purchase history summaries", () => {
  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("reads product, quantity, quoted total and state from the database", async () => {
    const id = await createTransaction(fixture);
    await createQuote(fixture, id, 2);

    const [summary] = await loadPurchaseSummaries([id], deps());

    expect(summary).toMatchObject({
      transactionId: id,
      state: "INTENT_RECEIVED",
      productName: "Test Mechanical Keyboard",
      quantity: 2,
      total: { amountMinor: "499800", currency: "INR" },
      refund: null,
    });
    expect(Number.isNaN(Date.parse(summary?.createdAt ?? ""))).toBe(false);
  });

  it("shows no product and no amount before anything was priced", async () => {
    const id = await createTransaction(fixture);
    expect(await loadPurchaseSummaries([id], deps())).toEqual([
      expect.objectContaining({ productName: null, quantity: null, total: null }),
    ]);
  });

  it("reports the latest refund's status", async () => {
    const id = await createTransaction(fixture);
    await createQuote(fixture, id);
    const attempt = await testDb().paymentAttempt.create({
      data: {
        transactionId: id,
        attemptNumber: 1,
        amount: 249_900n,
        currency: "INR",
        status: "CAPTURED",
        providerPaymentId: `pay_${uid("x").slice(2, 12)}`,
      },
    });
    await testDb().refund.create({
      data: {
        transactionId: id,
        paymentAttemptId: attempt.id,
        amount: 249_900n,
        currency: "INR",
        status: "PROCESSED",
        processedAt: new Date(),
        receipt: `rf_${uid("r")}`,
        requestedByBuyerId: fixture.buyerId,
      },
    });

    const [summary] = await loadPurchaseSummaries([id], deps());
    expect(summary?.refund).toBe("PROCESSED");
  });

  it("keeps the order it was given, not the database's", async () => {
    const first = await createTransaction(fixture);
    const second = await createTransaction(fixture);
    const third = await createTransaction(fixture);

    const summaries = await loadPurchaseSummaries([third, first, second], deps());

    expect(summaries.map((summary) => summary.transactionId)).toEqual([
      third,
      first,
      second,
    ]);
  });

  it("skips ids that are malformed, unknown or repeated", async () => {
    const id = await createTransaction(fixture);
    const unknown = "01a068ee-b304-7756-83d6-000000000000";

    const summaries = await loadPurchaseSummaries(
      ["'; DROP TABLE transaction; --", unknown, id, id.toUpperCase()],
      deps(),
    );

    expect(summaries.map((summary) => summary.transactionId)).toEqual([id]);
  });

  it("does not touch the database for an empty or all-invalid list", async () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be queried");
        },
      },
    );
    await expect(
      loadPurchaseSummaries(["nope"], { prisma: throwing as never }),
    ).resolves.toEqual([]);
  });
});
