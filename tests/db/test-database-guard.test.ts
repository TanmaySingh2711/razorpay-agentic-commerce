import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DisposableSchemaGuardError,
  assertDisposableTestSchema,
  resetDisposableSchemaGuard,
} from "./test-database-guard";
import {
  TEST_SCHEMA,
  TEST_SCHEMA_MARKER_TABLE,
  TEST_SCHEMA_MARKER_VALUE,
  TEST_TABLES,
} from "./schema-identity";
import {
  createBaseFixture,
  databaseConfigured,
  disconnectTestDb,
  resetTestData,
  testDb,
} from "./harness";

/**
 * Tests for the interlock in front of destructive cleanup.
 *
 * A safety guard that has never been seen to refuse is not known to work. Each
 * test here removes one of the things the guard relies on and proves it stops -
 * and, most importantly, that `resetTestData()` stops with it and the data
 * survives.
 *
 * Everything destructive in this file is a rename or an update inside the
 * disposable schema, always undone in `finally`.
 */

const MARKER = `"${TEST_SCHEMA}"."${TEST_SCHEMA_MARKER_TABLE}"`;

/** Runs `body` with `table` renamed out of the way, then always renames it back. */
async function withTableHidden(table: string, body: () => Promise<void>): Promise<void> {
  const db = testDb();
  const hidden = `${table}_hidden_for_test`;
  await db.$executeRawUnsafe(
    `ALTER TABLE "${TEST_SCHEMA}"."${table}" RENAME TO "${hidden}"`,
  );
  try {
    resetDisposableSchemaGuard();
    await body();
  } finally {
    await db.$executeRawUnsafe(
      `ALTER TABLE "${TEST_SCHEMA}"."${hidden}" RENAME TO "${table}"`,
    );
    resetDisposableSchemaGuard();
  }
}

describe.skipIf(!databaseConfigured)("disposable test schema guard", () => {
  beforeEach(() => {
    resetDisposableSchemaGuard();
  });

  afterEach(() => {
    resetDisposableSchemaGuard();
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  describe("when the schema really is disposable", () => {
    it("passes against the schema built by db:test:setup", async () => {
      await expect(assertDisposableTestSchema(testDb())).resolves.toBeDefined();
    });

    it("approves exactly the schema-qualified cleanup targets", async () => {
      // The guard hands back the target list, so cleanup cannot widen it.
      const targets = await assertDisposableTestSchema(testDb());
      expect(targets).toEqual(TEST_TABLES.map((t) => `"${TEST_SCHEMA}"."${t}"`));
      expect(targets.every((t) => t.startsWith(`"${TEST_SCHEMA}".`))).toBe(true);
    });

    it("never approves the marker table itself", async () => {
      // Otherwise the first cleanup would destroy the proof that the second one
      // is allowed to run.
      const targets = await assertDisposableTestSchema(testDb());
      expect(targets.join(" ")).not.toContain(TEST_SCHEMA_MARKER_TABLE);
    });
  });

  describe("when identity cannot be proved", () => {
    it("refuses when the disposable marker table is absent", async () => {
      await withTableHidden(TEST_SCHEMA_MARKER_TABLE, async () => {
        await expect(assertDisposableTestSchema(testDb())).rejects.toBeInstanceOf(
          DisposableSchemaGuardError,
        );
      });
    });

    it("refuses when the marker carries an unexpected value", async () => {
      // Proves the check is the token, not merely the table's existence.
      const db = testDb();
      await db.$executeRawUnsafe(`UPDATE ${MARKER} SET marker = $1`, "not-the-marker");
      resetDisposableSchemaGuard();
      try {
        await expect(assertDisposableTestSchema(db)).rejects.toBeInstanceOf(
          DisposableSchemaGuardError,
        );
      } finally {
        await db.$executeRawUnsafe(
          `UPDATE ${MARKER} SET marker = $1`,
          TEST_SCHEMA_MARKER_VALUE,
        );
        resetDisposableSchemaGuard();
      }
    });

    it("refuses a half-built schema that is missing a cleanup target", async () => {
      await withTableHidden("audit_event", async () => {
        await expect(assertDisposableTestSchema(testDb())).rejects.toThrow(/audit_event/);
      });
    });

    it("caches a refusal rather than granting a retry", async () => {
      await withTableHidden(TEST_SCHEMA_MARKER_TABLE, async () => {
        await expect(assertDisposableTestSchema(testDb())).rejects.toThrow();
        // The marker is still gone; a second call must not be a second chance.
        await expect(assertDisposableTestSchema(testDb())).rejects.toBeInstanceOf(
          DisposableSchemaGuardError,
        );
      });
    });

    it("never reveals a connection string in its refusal", async () => {
      const url = process.env["TEST_DIRECT_URL"] ?? (process.env["DIRECT_URL"] as string);
      await withTableHidden(TEST_SCHEMA_MARKER_TABLE, async () => {
        const error: unknown = await assertDisposableTestSchema(testDb()).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        const thrown = error as Error;
        const text = `${thrown.name} ${thrown.message}`;
        expect(text).not.toContain(url);
        expect(text).not.toContain("postgres://");
        expect(text).not.toContain("postgresql://");
      });
    });
  });

  describe("the guard is actually in the destructive path", () => {
    it("stops resetTestData() from deleting anything when identity is unproven", async () => {
      // The end-to-end proof: not merely that the guard is callable, but that
      // the TRUNCATE never runs and the rows are still there afterwards.
      await resetTestData();
      const fixture = await createBaseFixture();

      await withTableHidden(TEST_SCHEMA_MARKER_TABLE, async () => {
        await expect(resetTestData()).rejects.toBeInstanceOf(DisposableSchemaGuardError);
      });

      const merchant = await testDb().merchant.findUnique({
        where: { id: fixture.merchantId },
      });
      expect(merchant).not.toBeNull();
    });
  });
});
