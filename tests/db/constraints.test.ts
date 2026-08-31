import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createBaseFixture,
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
 * Database-level integrity.
 *
 * Every assertion here is about PostgreSQL refusing something, not about
 * application code declining to ask. That distinction is the point: these
 * invariants hold against a direct psql session, a buggy service, or a future
 * objective that forgets a validation - which is exactly when they matter.
 *
 * This is also why the suite runs on PostgreSQL rather than SQLite: SQLite
 * would silently accept several of these.
 */
describe.skipIf(!databaseConfigured)("database constraints", () => {
  let fixture: BaseFixture;

  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  describe("CHECK constraints", () => {
    it("refuses negative product inventory", async () => {
      await expect(
        testDb().product.update({
          where: { id: fixture.productId },
          data: { inventory: -1 },
        }),
      ).rejects.toThrow();
    });

    it("allows inventory to reach exactly zero", async () => {
      const product = await testDb().product.update({
        where: { id: fixture.productId },
        data: { inventory: 0 },
      });
      expect(product.inventory).toBe(0);
    });

    it("refuses a negative product price", async () => {
      await expect(
        testDb().product.update({
          where: { id: fixture.productId },
          data: { unitAmount: -1n },
        }),
      ).rejects.toThrow();
    });

    it("refuses a zero or negative quote quantity", async () => {
      const transactionId = await createTransaction(fixture);
      for (const quantity of [0, -3]) {
        await expect(
          testDb().purchaseQuote.create({
            data: {
              transactionId,
              productId: fixture.productId,
              quantity,
              unitAmount: 249_900n,
              totalAmount: 249_900n * BigInt(quantity),
              currency: "INR",
              productVersion: 1,
              expiresAt: futureDate(),
            },
          }),
        ).rejects.toThrow();
      }
    });

    it("refuses a quote whose total disagrees with unit price times quantity", async () => {
      const transactionId = await createTransaction(fixture);
      await expect(
        testDb().purchaseQuote.create({
          data: {
            transactionId,
            productId: fixture.productId,
            quantity: 2,
            unitAmount: 249_900n,
            // Deliberately wrong: a single unit's price for two units.
            totalAmount: 249_900n,
            currency: "INR",
            productVersion: 1,
            expiresAt: futureDate(),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses an expiry that precedes creation", async () => {
      const transactionId = await createTransaction(fixture);
      await expect(
        testDb().purchaseQuote.create({
          data: {
            transactionId,
            productId: fixture.productId,
            quantity: 1,
            unitAmount: 249_900n,
            totalAmount: 249_900n,
            currency: "INR",
            productVersion: 1,
            expiresAt: new Date(Date.now() - 60_000),
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses a currency that is not an uppercase ISO-4217 code", async () => {
      for (const currency of ["inr", "IN", "INRR", "₹₹₹"]) {
        await expect(
          testDb().product.update({
            where: { id: fixture.productId },
            data: { currency },
          }),
        ).rejects.toThrow();
      }
    });

    it("refuses a non-positive payment attempt number", async () => {
      const transactionId = await createTransaction(fixture);
      await expect(
        testDb().paymentAttempt.create({
          data: { transactionId, attemptNumber: 0, amount: 100n, currency: "INR" },
        }),
      ).rejects.toThrow();
    });

    it("refuses a transition beyond the first that has no previous state", async () => {
      const transactionId = await createTransaction(fixture);
      await expect(
        testDb().transactionStateTransition.create({
          data: {
            transactionId,
            sequence: 2,
            fromStatus: null,
            toStatus: "PRODUCT_SELECTED",
            actor: "buyer_agent",
            trigger: "product_selected",
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("uniqueness", () => {
    it("refuses a duplicate merchant slug", async () => {
      const slug = uid("merchant");
      await testDb().merchant.create({ data: { name: "First", slug } });
      await expect(
        testDb().merchant.create({ data: { name: "Second", slug } }),
      ).rejects.toThrow();
    });

    it("refuses a duplicate SKU within one merchant, but allows it across merchants", async () => {
      const sku = uid("SKU");
      const productData = {
        sku,
        name: "Keyboard",
        description: "d",
        category: "mechanical-keyboard",
        unitAmount: 100_000n,
        currency: "INR",
        inventory: 1,
      };
      await testDb().product.create({
        data: { ...productData, merchantId: fixture.merchantId },
      });
      await expect(
        testDb().product.create({
          data: { ...productData, merchantId: fixture.merchantId },
        }),
      ).rejects.toThrow();

      const other = await testDb().merchant.create({
        data: { name: "Other", slug: uid("merchant") },
      });
      const ok = await testDb().product.create({
        data: { ...productData, merchantId: other.id },
      });
      expect(ok.sku).toBe(sku);
    });

    it("refuses a duplicate attempt number within one transaction", async () => {
      const transactionId = await createTransaction(fixture);
      await testDb().paymentAttempt.create({
        data: { transactionId, attemptNumber: 1, amount: 100n, currency: "INR" },
      });
      await expect(
        testDb().paymentAttempt.create({
          data: { transactionId, attemptNumber: 1, amount: 100n, currency: "INR" },
        }),
      ).rejects.toThrow();
    });

    it("refuses a duplicate webhook event id from the same provider", async () => {
      const externalEventId = uid("evt");
      await testDb().webhookEvent.create({
        data: { provider: "RAZORPAY", externalEventId, eventType: "payment.captured" },
      });
      await expect(
        testDb().webhookEvent.create({
          data: { provider: "RAZORPAY", externalEventId, eventType: "payment.captured" },
        }),
      ).rejects.toThrow();
    });

    it("refuses a duplicate provider payment reference", async () => {
      const transactionId = await createTransaction(fixture);
      const providerPaymentId = uid("pay");
      await testDb().paymentAttempt.create({
        data: {
          transactionId,
          attemptNumber: 1,
          amount: 100n,
          currency: "INR",
          providerPaymentId,
        },
      });
      await expect(
        testDb().paymentAttempt.create({
          data: {
            transactionId,
            attemptNumber: 2,
            amount: 100n,
            currency: "INR",
            providerPaymentId,
          },
        }),
      ).rejects.toThrow();
    });

    it("still allows many attempts with no provider reference yet", async () => {
      // PostgreSQL treats NULLs as distinct in a unique index, which is the
      // behaviour required here: an attempt exists before the provider is called.
      const transactionId = await createTransaction(fixture);
      await testDb().paymentAttempt.create({
        data: { transactionId, attemptNumber: 1, amount: 100n, currency: "INR" },
      });
      const second = await testDb().paymentAttempt.create({
        data: { transactionId, attemptNumber: 2, amount: 100n, currency: "INR" },
      });
      expect(second.providerOrderId).toBeNull();
    });
  });

  describe("referential integrity", () => {
    it("refuses a transaction pointing at a buyer that does not exist", async () => {
      await expect(
        testDb().transaction.create({
          data: {
            buyerProfileId: "01930000-0000-7000-8000-0000000000ff",
            merchantId: fixture.merchantId,
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses to delete a product referenced by financial history", async () => {
      const transactionId = await createTransaction(fixture);
      await testDb().purchaseQuote.create({
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
      // ON DELETE RESTRICT: history wins over convenience.
      await expect(
        testDb().product.delete({ where: { id: fixture.productId } }),
      ).rejects.toThrow();
    });

    it("refuses to delete a transaction that has audit history", async () => {
      const transactionId = await createTransaction(fixture);
      await testDb().auditEvent.create({
        data: {
          transactionId,
          actor: "transaction_service",
          eventType: "intent_received",
          result: "SUCCESS",
        },
      });
      await expect(
        testDb().transaction.delete({ where: { id: transactionId } }),
      ).rejects.toThrow();
    });

    it("refuses to delete a merchant that has products", async () => {
      await expect(
        testDb().merchant.delete({ where: { id: fixture.merchantId } }),
      ).rejects.toThrow();
    });
  });

  describe("enum integrity", () => {
    it("refuses an arbitrary string where a status enum is expected", async () => {
      await expect(
        testDb().$executeRawUnsafe(
          `UPDATE "agentic_test"."product" SET "status" = 'TOTALLY_MADE_UP' WHERE "id" = $1`,
          fixture.productId,
        ),
      ).rejects.toThrow();
    });

    it("refuses an invalid transaction status written as raw SQL", async () => {
      const transactionId = await createTransaction(fixture);
      await expect(
        testDb().$executeRawUnsafe(
          `UPDATE "agentic_test"."transaction" SET "status" = 'NOT_A_STATE' WHERE "id" = $1`,
          transactionId,
        ),
      ).rejects.toThrow();
    });
  });
});
