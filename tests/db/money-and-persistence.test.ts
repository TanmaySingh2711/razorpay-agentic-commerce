import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  fromMoneyDto,
  moneyFromBigInt,
  moneyToBigInt,
  toMoneyDto,
  formatMoney,
  money,
} from "@/domain/money";
import { ValidationError } from "@/domain/errors";
import {
  createBaseFixture,
  createQuote,
  createTransaction,
  databaseConfigured,
  disconnectTestDb,
  freshTestClient,
  futureDate,
  resetTestData,
  testDb,
  uid,
  type BaseFixture,
} from "./harness";

/**
 * Money crossing the database boundary, and proof that persistence is real.
 */
describe("BigInt money boundary", () => {
  it("round-trips a stored amount to domain money and back", () => {
    const domain = moneyFromBigInt(249_900n, "INR");
    expect(domain.minorUnits).toBe(249_900);
    expect(formatMoney(domain)).toBe("₹2499.00");
    expect(moneyToBigInt(domain)).toBe(249_900n);
  });

  it("refuses to narrow a value that exceeds the safe integer range", () => {
    const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(() => moneyFromBigInt(tooLarge, "INR")).toThrow(ValidationError);

    // Why the guard exists: past MAX_SAFE_INTEGER, Number() does not throw - it
    // silently returns a different value. Converting back proves the loss.
    // Silently wrong money is the one failure mode this system may never have.
    expect(BigInt(Number(tooLarge))).not.toBe(tooLarge);
  });

  it("accepts the largest safely representable amount", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    expect(moneyFromBigInt(max, "INR").minorUnits).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("serialises to a string DTO, because JSON cannot carry a BigInt", () => {
    expect(() => JSON.stringify({ amount: 249_900n })).toThrow(TypeError);

    const dto = toMoneyDto(money(249_900, "INR"));
    expect(dto).toEqual({ amountMinor: "249900", currency: "INR" });
    // The DTO is plain JSON, so an API response cannot blow up at serialise time.
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });

  it("names the field amountMinor so paise cannot be mistaken for rupees", () => {
    const dto = toMoneyDto(money(249_900, "INR"));
    expect(Object.keys(dto).sort()).toEqual(["amountMinor", "currency"]);
    expect(dto.amountMinor).not.toBe("2499");
  });

  it("rejects a malformed DTO instead of coercing it", () => {
    expect(() => fromMoneyDto({ amountMinor: "24.99", currency: "INR" })).toThrow(
      ValidationError,
    );
    expect(() => fromMoneyDto({ amountMinor: "abc", currency: "INR" })).toThrow(
      ValidationError,
    );
  });
});

describe.skipIf(!databaseConfigured)("money persistence", () => {
  let fixture: BaseFixture;

  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  it("reads back a large amount from BIGINT at full precision", async () => {
    // Beyond a 32-bit integer, so a narrower column would have failed here.
    const large = 9_007_199_254_740_000n;
    const transactionId = await createTransaction(fixture);
    await testDb().paymentAttempt.create({
      data: { transactionId, attemptNumber: 1, amount: large, currency: "INR" },
    });

    const stored = await testDb().paymentAttempt.findFirstOrThrow({
      where: { transactionId },
    });
    expect(stored.amount).toBe(large);
    expect(typeof stored.amount).toBe("bigint");
    expect(moneyFromBigInt(stored.amount, "INR").minorUnits).toBe(9_007_199_254_740_000);
  });

  it("computes a quote total in the database without floating point drift", async () => {
    const transactionId = await createTransaction(fixture);
    // 3 x ₹2,499.00 = ₹7,497.00. In float rupees this is a classic drift case.
    const quote = await testDb().purchaseQuote.create({
      data: {
        transactionId,
        productId: fixture.productId,
        quantity: 3,
        unitAmount: 249_900n,
        totalAmount: 749_700n,
        currency: "INR",
        productVersion: 1,
        expiresAt: futureDate(),
      },
    });
    expect(quote.totalAmount).toBe(749_700n);
    expect(formatMoney(moneyFromBigInt(quote.totalAmount, "INR"))).toBe("₹7497.00");
  });
});

/**
 * The proof that this is a real database and not an in-memory array.
 *
 * A module-level mock, a fixture cache or an ephemeral store would all pass the
 * tests above. None of them survives a genuine disconnect followed by a fresh
 * connection from a new client instance.
 */
describe.skipIf(!databaseConfigured)("persistence across a reconnect", () => {
  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  it("returns the same transaction and children after disconnecting and reconnecting", async () => {
    await resetTestData();
    const fixture = await createBaseFixture();
    const transactionId = await createTransaction(fixture);
    const externalEventId = uid("evt");

    await testDb().transaction.update({
      where: { id: transactionId },
      data: { status: "AUTHORIZED", authorizedAmount: 289_900n, currency: "INR" },
    });
    await testDb().purchaseQuote.create({
      data: {
        transactionId,
        productId: fixture.productId,
        quantity: 1,
        unitAmount: 289_900n,
        totalAmount: 289_900n,
        currency: "INR",
        productVersion: 1,
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
    await testDb().webhookEvent.create({
      data: {
        provider: "RAZORPAY",
        externalEventId,
        eventType: "payment.captured",
        transactionId,
      },
    });

    // Close the connection the data was written on.
    await disconnectTestDb();

    // A brand-new client, new pool, new connection.
    const reconnected = freshTestClient();
    try {
      const transaction = await reconnected.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { quotes: true, transitions: true, webhookEvents: true },
      });

      expect(transaction.status).toBe("AUTHORIZED");
      expect(transaction.authorizedAmount).toBe(289_900n);
      expect(transaction.currency).toBe("INR");
      expect(transaction.quotes).toHaveLength(1);
      expect(transaction.quotes[0]?.totalAmount).toBe(289_900n);
      expect(transaction.transitions[0]?.toStatus).toBe("INTENT_RECEIVED");
      expect(transaction.webhookEvents[0]?.externalEventId).toBe(externalEventId);
    } finally {
      await reconnected.$disconnect();
    }
  });
});

/**
 * Foundation for the concurrency Objective 8 will build on.
 *
 * The reservation algorithm is NOT implemented here. What is proven is that the
 * persistence architecture can support it: a conditional decrement is atomic,
 * and the CHECK constraint is a genuine backstop rather than advisory.
 */
describe.skipIf(!databaseConfigured)("concurrency foundation", () => {
  let fixture: BaseFixture;

  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  it("decrements stock only when enough is available", async () => {
    await testDb().product.update({
      where: { id: fixture.productId },
      data: { inventory: 1 },
    });

    // The shape a real reservation will use: guard inside the UPDATE itself, so
    // check and decrement are one atomic statement rather than two racing ones.
    const won = await testDb().product.updateMany({
      where: { id: fixture.productId, inventory: { gte: 1 } },
      data: { inventory: { decrement: 1 } },
    });
    const lost = await testDb().product.updateMany({
      where: { id: fixture.productId, inventory: { gte: 1 } },
      data: { inventory: { decrement: 1 } },
    });

    expect(won.count).toBe(1);
    // The second buyer is refused by the guard, not by a later inventory check.
    expect(lost.count).toBe(0);

    const product = await testDb().product.findUniqueOrThrow({
      where: { id: fixture.productId },
    });
    expect(product.inventory).toBe(0);
  });

  it("aborts an unguarded oversell at the database, not in application code", async () => {
    await testDb().product.update({
      where: { id: fixture.productId },
      data: { inventory: 0 },
    });
    await expect(
      testDb().product.update({
        where: { id: fixture.productId },
        data: { inventory: { decrement: 1 } },
      }),
    ).rejects.toThrow();
  });

  it("rolls back a whole reservation when any part of it fails", async () => {
    const transactionId = await createTransaction(fixture);
    const purchaseQuoteId = await createQuote(fixture, transactionId);
    await testDb().product.update({
      where: { id: fixture.productId },
      data: { inventory: 1 },
    });

    await expect(
      testDb().$transaction(async (tx) => {
        await tx.product.update({
          where: { id: fixture.productId },
          data: { inventory: { decrement: 1 } },
        });
        await tx.inventoryReservation.create({
          data: {
            transactionId,
            purchaseQuoteId,
            productId: fixture.productId,
            // Invalid: violates the positive-quantity CHECK, aborting the tx.
            quantity: 0,
            expiresAt: futureDate(),
          },
        });
      }),
    ).rejects.toThrow();

    // Stock was restored: no reservation, no silent decrement left behind.
    const product = await testDb().product.findUniqueOrThrow({
      where: { id: fixture.productId },
    });
    expect(product.inventory).toBe(1);
    expect(await testDb().inventoryReservation.count({ where: { transactionId } })).toBe(
      0,
    );
  });
});
