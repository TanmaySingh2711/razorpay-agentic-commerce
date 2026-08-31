import { PrismaPg } from "@prisma/adapter-pg";
import { getDatabaseConfig } from "@/config/env";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * The single database entry point for the entire application.
 *
 * Everything that touches PostgreSQL goes through here. There is no second
 * client, no per-module connection, and no direct `pg` usage elsewhere.
 *
 * Three things this file is responsible for:
 *
 *  1. **Server-only.** A guard throws if the module is ever evaluated in a
 *     browser bundle. The database URL is a secret; importing this from a
 *     client component is a bug that must fail loudly at the boundary rather
 *     than quietly ship credentials.
 *
 *  2. **The pooled connection.** Runtime queries use `DATABASE_URL`, the pooled
 *     endpoint. Migrations use `DIRECT_URL` and are configured separately in
 *     `prisma.config.ts` - the CLI never comes through this file.
 *
 *  3. **One client per process.** Next.js dev hot-reload re-evaluates modules
 *     on every edit; without memoisation that opens a new pool each time until
 *     PostgreSQL refuses connections. The instance is cached on `globalThis`,
 *     which survives module re-evaluation.
 *
 * Prisma 7 requires a driver adapter, so the `pg` pool is explicit rather than
 * hidden inside a Rust engine.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "src/integrations/persistence/client.ts was imported in a browser bundle. " +
      "Database access is server-only; call it from a route handler or server component.",
  );
}

/**
 * How long one interactive transaction may run, and how long a caller waits for
 * a connection to start one.
 *
 * Prisma defaults to 5 seconds, which is tuned for a database on the same
 * machine. This system's transactions are deliberately large - claiming stock
 * is an availability check, a reservation insert, an audit record, a
 * conditional state update and a history row, all of which must commit together
 * or not at all - and against a *hosted* PostgreSQL each of those dozen or so
 * statements is a network round trip. Measured, that transaction takes upwards
 * of five seconds under ordinary latency.
 *
 * So this is not a timeout raised to quieten a test. At the default, a real
 * buyer reserving stock over a hosted database gets a P2028 and no reservation;
 * the tests simply found it first. The alternative - splitting the transaction
 * to fit the default - would trade a configuration value for the atomicity that
 * makes overselling impossible, which is not a trade worth making.
 *
 * It stays bounded rather than generous: these transactions hold row locks on a
 * product, and a lock held for a minute is its own outage.
 */
const TRANSACTION_TIMEOUT_MS = 15_000;
const TRANSACTION_MAX_WAIT_MS = 5_000;

const TRANSACTION_OPTIONS = {
  timeout: TRANSACTION_TIMEOUT_MS,
  maxWait: TRANSACTION_MAX_WAIT_MS,
} as const;

function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter, transactionOptions: { ...TRANSACTION_OPTIONS } });
}

const globalForPrisma = globalThis as typeof globalThis & {
  __agenticCommercePrisma?: PrismaClient;
};

/**
 * Returns the process-wide client, creating it on first use.
 *
 * Lazy rather than eagerly constructed at import time: the Objective 1
 * foundation must still boot, build and run its tests with no database
 * configured, and `getDatabaseConfig()` throws when `DATABASE_URL` is absent.
 * Importing this module is therefore always safe; only calling it requires a
 * database.
 */
export function getPrismaClient(): PrismaClient {
  const existing = globalForPrisma.__agenticCommercePrisma;
  if (existing !== undefined) return existing;

  const client = createPrismaClient(getDatabaseConfig().DATABASE_URL);
  globalForPrisma.__agenticCommercePrisma = client;
  return client;
}

/**
 * Builds an isolated client against an explicit connection string.
 *
 * Used by the test harness, which needs a connection it can dispose of, and by
 * the reconnect test, which must prove data survives a real disconnect. Not for
 * application code - use `getPrismaClient()` there.
 */
export function createIsolatedPrismaClient(
  connectionString: string,
  options: { readonly schema?: string } = {},
): PrismaClient {
  const adapter =
    options.schema === undefined
      ? new PrismaPg({ connectionString })
      : new PrismaPg({ connectionString }, { schema: options.schema });
  // The same transaction settings as production. A test client that tolerated
  // longer transactions than the real one would prove nothing about the real
  // one.
  return new PrismaClient({ adapter, transactionOptions: { ...TRANSACTION_OPTIONS } });
}

/**
 * Closes the process-wide client and clears the cache. Intended for tests and
 * for graceful shutdown; application request paths should never disconnect.
 */
export async function disconnectPrismaClient(): Promise<void> {
  const existing = globalForPrisma.__agenticCommercePrisma;
  if (existing === undefined) return;
  await existing.$disconnect();
  delete globalForPrisma.__agenticCommercePrisma;
}
