import { config as loadEnv } from "dotenv";
import { createIsolatedPrismaClient } from "@/integrations/persistence/client";
import { createTransaction as createTransactionThroughBoundary } from "@/services/transaction/creation-service";
import { TEST_SCHEMA } from "./schema-identity";
import { assertDisposableTestSchema } from "./test-database-guard";
import { resolveTestDatabaseUrl } from "./test-database-url";
import type { PrismaClient } from "@/generated/prisma/client";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Shared harness for database integration tests.
 *
 * Every test in `tests/db/` runs against the `agentic_test` PostgreSQL schema
 * prepared by `npm run db:test:setup` - never against `public`, so the demo
 * catalog and any real transaction history cannot be disturbed.
 *
 * Tests are skipped rather than failed when no database is configured, so the
 * Objective 1 foundation suite still passes on a machine with no credentials.
 */
export { TEST_SCHEMA };

/**
 * Resolved once, at import. A throw here fails the file immediately with a
 * sentence about configuration, rather than surfacing as a connection error
 * inside somebody's `beforeEach`. See ./test-database-url.ts for why there is
 * deliberately no fallback to the application's own connection.
 */
const testConnectionString = resolveTestDatabaseUrl();

/** True when a database is configured and DB tests should run. */
export const databaseConfigured =
  testConnectionString !== undefined && testConnectionString.length > 0;

let client: PrismaClient | undefined;

export function testDb(): PrismaClient {
  if (!databaseConfigured) {
    throw new Error("No database configured; guard the suite with `describe.skipIf`.");
  }
  client ??= createIsolatedPrismaClient(testConnectionString as string, {
    schema: TEST_SCHEMA,
  });
  return client;
}

export async function disconnectTestDb(): Promise<void> {
  if (client === undefined) return;
  await client.$disconnect();
  client = undefined;
}

/** A fresh, independently-connected client. Used by the reconnect test. */
export function freshTestClient(): PrismaClient {
  return createIsolatedPrismaClient(testConnectionString as string, {
    schema: TEST_SCHEMA,
  });
}

/**
 * Empties the test schema between tests.
 *
 * A single TRUNCATE rather than twelve `deleteMany` calls: this suite runs
 * against a hosted database, so each statement is a network round trip, and the
 * per-test teardown dominated the suite's runtime.
 *
 * It is also the most destructive statement in the repository, so it is gated.
 * `assertDisposableTestSchema` must first prove - against the live database -
 * that this schema carries the disposable marker only `npm run db:test:setup`
 * writes, and that every table below really exists inside it. The approved,
 * schema-qualified targets are its *return value*, so this function cannot
 * truncate anything the guard did not clear. See ./test-database-guard.ts.
 *
 * CASCADE is safe *here* and only here: those tables are the whole test schema,
 * and the schema itself is dropped and rebuilt by `db:test:setup`. It says
 * nothing about production, where every foreign key is ON DELETE RESTRICT
 * precisely so financial history cannot be swept away. That protection is
 * asserted separately in constraints.test.ts.
 */
export async function resetTestData(): Promise<void> {
  const db = testDb();
  // Before, not after, and not in parallel: the guard is the precondition.
  const targets = await assertDisposableTestSchema(db);
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${targets.join(", ")} RESTART IDENTITY CASCADE`,
  );
}

/** Unique-ish suffix so parallel or repeated runs cannot collide on slugs/SKUs. */
export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface BaseFixture {
  readonly buyerId: string;
  readonly merchantId: string;
  readonly productId: string;
}

/** Creates the minimum graph most tests need: a buyer, a merchant, a product. */
export async function createBaseFixture(): Promise<BaseFixture> {
  const db = testDb();
  const buyer = await db.buyerProfile.create({ data: { displayName: "Test Buyer" } });
  const merchant = await db.merchant.create({
    data: { name: "Test Merchant", slug: uid("merchant") },
  });
  const product = await db.product.create({
    data: {
      merchantId: merchant.id,
      sku: uid("SKU"),
      name: "Test Mechanical Keyboard",
      description: "A keyboard used by the persistence tests.",
      category: "mechanical-keyboard",
      unitAmount: 249_900n,
      currency: "INR",
      inventory: 10,
      attributes: { switchType: "linear-red", layout: "tkl-87" },
    },
  });
  return { buyerId: buyer.id, merchantId: merchant.id, productId: product.id };
}

/**
 * Creates a transaction in its initial state for the given fixture.
 *
 * Deliberately routed through the real creation boundary rather than a raw
 * insert: every database test that needs a transaction therefore exercises the
 * one sanctioned way to make one, and would notice if that boundary stopped
 * pinning new transactions to INTENT_RECEIVED.
 */
export async function createTransaction(fixture: BaseFixture): Promise<string> {
  const created = await createTransactionThroughBoundary(
    {
      buyerProfileId: fixture.buyerId,
      merchantId: fixture.merchantId,
      correlationId: uid("corr"),
    },
    { prisma: testDb() },
  );
  return created.id;
}

/** An expiry safely in the future, for quotes, reservations and approvals. */
export function futureDate(minutes = 15): Date {
  return new Date(Date.now() + minutes * 60_000);
}

/**
 * Creates an ACTIVE quote for a transaction.
 *
 * Every InventoryReservation names the exact quote whose price it is holding
 * stock for, so a fixture that reserves needs one. Only one ACTIVE quote may
 * exist per transaction - a partial unique index enforces it - so call this
 * once per transaction, or reuse the id it returns.
 */
export async function createQuote(
  fixture: BaseFixture,
  transactionId: string,
  quantity = 1,
): Promise<string> {
  const created = await testDb().purchaseQuote.create({
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
  });
  return created.id;
}
