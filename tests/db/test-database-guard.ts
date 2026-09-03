import {
  TEST_SCHEMA,
  TEST_SCHEMA_MARKER_TABLE,
  TEST_SCHEMA_MARKER_VALUE,
  TEST_TABLES,
} from "./schema-identity";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The safety interlock in front of destructive test cleanup.
 *
 * The suite empties its tables between tests with a single
 * `TRUNCATE ... CASCADE`, because twelve `deleteMany` round trips to a hosted
 * database dominated the runtime. That statement is fast and it is also the
 * most destructive thing in this repository: pointed at the wrong schema it
 * would erase a real transaction history in one call, and CASCADE would follow
 * the foreign keys outward while doing it.
 *
 * A comment saying "only run this against the test schema" is not protection.
 * This module is. Nothing is truncated until the process has *proved*, against
 * the live database it is connected to, both of the things that make the
 * statement safe:
 *
 *  1. **The schema is disposable.** It carries a marker row that only
 *     `npm run db:test:setup` writes. No Prisma migration creates that table,
 *     so no development, staging or production database has one. The proof
 *     cannot be faked by claiming to be a test environment; it can only be
 *     earned by having been built to be thrown away.
 *
 *  2. **Every target is inside it.** The guard reads PostgreSQL's own catalog
 *     and confirms each table it is about to approve really exists in that
 *     schema, then returns the approved, schema-qualified names. Cleanup
 *     truncates what the guard hands back and nothing else, so it cannot name a
 *     table that was never cleared, and a half-built schema - where some tables
 *     are missing - is refused rather than partially emptied.
 *
 * `NODE_ENV` is checked first and counts for nothing on its own. It is a claim
 * about intent made by whoever launched the process, and it is exactly what is
 * wrong when someone runs the suite against a `.env.local` pointing at a live
 * database. The catalog cannot be talked into agreeing.
 *
 * Note on what is deliberately *not* checked: `current_schema()`. The Prisma
 * pg adapter schema-qualifies the SQL it generates instead of setting the
 * session's `search_path`, so `current_schema()` reports `public` on a
 * perfectly correct test connection and would say nothing about where writes
 * actually land. A check that is green when it should be red is worse than no
 * check, so the guard asks the catalog about named schemas instead.
 *
 * The guard fails closed in every direction: an unreachable database, a missing
 * marker table, an unexpected marker value, a missing target table, or any
 * error at all while checking, all end as a refusal to delete anything. A
 * failed verdict is cached alongside a successful one, so a flaky second
 * attempt cannot be retried into an approval.
 */

export class DisposableSchemaGuardError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to run destructive test cleanup: ${reason}. ` +
        `Destructive cleanup is only permitted against the disposable "${TEST_SCHEMA}" ` +
        "schema created by `npm run db:test:setup`.",
    );
    this.name = "DisposableSchemaGuardError";
  }
}

interface MarkerRow {
  readonly marker: string | null;
}

interface TableRow {
  readonly table_name: string;
}

function quoted(table: string): string {
  return `"${TEST_SCHEMA}"."${table}"`;
}

/**
 * Says why the marker could not be read, in terms of what to do about it.
 *
 * Two entirely different situations arrive here, and Prisma describes them
 * almost identically - a bare "Invalid `prisma.$queryRawUnsafe()` invocation:"
 * with the useful part missing. Observed when Docker Desktop stopped mid-run:
 * every database test failed with a sentence that pointed at the disposable
 * schema, when the actual problem was that nothing was listening on the port.
 * Reading it, the obvious next move is to distrust the guard - the one thing
 * standing between a stray run and a real database.
 *
 * The two are distinguishable, just not from the message. A query that reached
 * PostgreSQL and was refused by it carries a driver-adapter cause naming the
 * SQL state; a query that never got there has none, and only a connection-level
 * `code` such as `ECONNREFUSED`.
 *
 * This changes no decision. The guard still refuses in every case, and refusal
 * is still the only outcome; it changes what the reader is told to do.
 */
export function describeMarkerFailure(error: unknown): string {
  const cause = (
    error as {
      meta?: {
        driverAdapterError?: { cause?: { kind?: string; originalCode?: string } };
      };
    }
  ).meta?.driverAdapterError?.cause;

  if (cause === undefined) {
    return (
      "the test database could not be reached, so the disposable-schema marker " +
      "could not be read. Start it with `npm run db:test:up` and prepare the " +
      "schema with `npm run db:test:setup`"
    );
  }

  if (cause.kind === "TableDoesNotExist" || cause.originalCode === "42P01") {
    return (
      `the "${TEST_SCHEMA}" schema has no marker table, so it was not built by ` +
      "`npm run db:test:setup` - run that before the database tests"
    );
  }

  const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : "";
  return `the disposable-schema marker could not be read (${detail})`;
}

async function verify(client: PrismaClient): Promise<readonly string[]> {
  // Cheap first refusal. Necessary, never sufficient.
  if (process.env["NODE_ENV"] === "production") {
    throw new DisposableSchemaGuardError("NODE_ENV is production");
  }

  // Widened to `string` on purpose: TypeScript would otherwise narrow the
  // constant to its literal and call this check unreachable, deleting the very
  // protection that has to survive someone editing schema-identity.ts.
  const configuredSchema: string = TEST_SCHEMA;
  if (configuredSchema.length === 0 || configuredSchema === "public") {
    throw new DisposableSchemaGuardError(
      `the configured test schema is "${configuredSchema}"`,
    );
  }

  // A list that could empty its own proof would let the second run of a suite
  // proceed unguarded. Checked here rather than trusted.
  if ((TEST_TABLES as readonly string[]).includes(TEST_SCHEMA_MARKER_TABLE)) {
    throw new DisposableSchemaGuardError(
      "the cleanup target list includes the disposable-schema marker table",
    );
  }

  let markers: readonly MarkerRow[];
  try {
    markers = await client.$queryRawUnsafe<MarkerRow[]>(
      `SELECT marker FROM ${quoted(TEST_SCHEMA_MARKER_TABLE)}`,
    );
  } catch (error) {
    // The schema's identity is unproven, so nothing may be deleted - but *why*
    // it is unproven decides what the reader should do next, and the two causes
    // are not distinguishable from Prisma's own message. See below.
    throw new DisposableSchemaGuardError(describeMarkerFailure(error));
  }

  if (markers.length !== 1) {
    throw new DisposableSchemaGuardError(
      `the disposable-schema marker table holds ${markers.length} rows, expected exactly 1`,
    );
  }
  if (markers[0]?.marker !== TEST_SCHEMA_MARKER_VALUE) {
    throw new DisposableSchemaGuardError(
      "the disposable-schema marker does not carry the expected value",
    );
  }

  // PostgreSQL's own catalog, asked over the same connection the TRUNCATE will
  // use. `relkind = 'r'` restricts this to ordinary tables, so a view or a
  // foreign table sharing a name cannot stand in for one.
  let tables: readonly TableRow[];
  try {
    tables = await client.$queryRawUnsafe<TableRow[]>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r'`,
      TEST_SCHEMA,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new DisposableSchemaGuardError(
      `the test schema's tables could not be listed (${detail})`,
    );
  }

  const present = new Set(tables.map((row) => row.table_name));
  const missing = TEST_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new DisposableSchemaGuardError(
      `${missing.length} cleanup target(s) do not exist in the schema (${missing.join(", ")})`,
    );
  }

  return TEST_TABLES.map(quoted);
}

/**
 * Cached verdict, success or failure.
 *
 * Success is cached so the guard costs two round trips per process rather than
 * two per test. Failure is cached so a refusal cannot be retried into an
 * approval by a transient reconnect.
 */
let verdict: Promise<readonly string[]> | undefined;

/**
 * Proves destructive cleanup is safe here, and returns what it may empty.
 *
 * The approved, schema-qualified table names are the return value rather than a
 * separate constant the caller could ignore: the only way to get a target list
 * is to pass the guard. Call it before anything destructive.
 *
 * No error raised here ever contains a connection string. The guard reports
 * *what* it could not prove, never the credentials it used to try.
 */
export async function assertDisposableTestSchema(
  client: PrismaClient,
): Promise<readonly string[]> {
  verdict ??= verify(client);
  return verdict;
}

/**
 * Clears the cached verdict.
 *
 * Exists so the guard's own tests can take the marker away and prove that the
 * guard then refuses. Test-only, which is why it lives in `tests/`: application
 * code cannot reach it.
 */
export function resetDisposableSchemaGuard(): void {
  verdict = undefined;
}
