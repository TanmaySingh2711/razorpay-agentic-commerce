import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import {
  assertLocalHost,
  assertNotDisposableTestDatabase,
  databaseNameOf,
} from "./database-target-guard";
import { runPackageBin } from "./run-package-bin";

/**
 * Prepares the local development database.
 *
 * This is the counterpart to `setup-test-schema.ts`, and the difference between
 * them is the whole reason both exist:
 *
 *  - the **test** database is disposable. Its `agentic_test` schema is dropped
 *    and rebuilt on every setup, and truncated between individual tests.
 *  - the **development** database is not. It holds the demo catalog and
 *    whatever transactions you create while clicking through the app, and it
 *    must survive a test run. Nothing here drops a schema or truncates a table.
 *
 * They are separate PostgreSQL *databases* inside the same local container, so
 * the separation is not a convention anyone has to remember - a `TRUNCATE` in
 * the test suite cannot reach across a database boundary even if the schema
 * name matched, which it does not.
 *
 * Configuration comes from `.env.development.local`, which Next.js also loads
 * ahead of `.env.local` when running `next dev`. That is what makes
 * `npm run dev` local by default without anyone editing a file that holds
 * cloud credentials. See docs/09-configuration.md.
 *
 * ## The one refusal
 *
 * This script will not run against a remote host. It is the only local command
 * that applies migrations and seeds data, so it is exactly the command that
 * would do damage if it were ever pointed at staging - by a stale shell
 * variable, a copied connection string, or an `.env.development.local` someone
 * filled in from the wrong place. `assertLocalHost` fails closed before a
 * single statement is issued. Staging migrations remain a deliberate, separate
 * act through `npm run db:migrate:deploy`, which reads `.env.local`.
 */

loadEnv({ path: ".env.development.local", quiet: true });

const DEV_DATABASE = "razorpay_agentic_dev";

/** The same server, but the maintenance database, so `CREATE DATABASE` can run. */
function maintenanceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function ensureDatabaseExists(rawUrl: string): Promise<boolean> {
  const name = databaseNameOf(rawUrl) ?? "";
  const admin = new Client({ connectionString: maintenanceUrl(rawUrl) });
  await admin.connect();
  try {
    const existing = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [name],
    );
    if (existing.rowCount !== null && existing.rowCount > 0) return false;
    // PostgreSQL has no CREATE DATABASE IF NOT EXISTS, and the name is a
    // constant in this file rather than user input, so quoting it is enough.
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const directUrl = process.env["DIRECT_URL"];
  if (directUrl === undefined || directUrl.length === 0) {
    throw new Error(
      "DIRECT_URL is not set in .env.development.local. See .env.example for the " +
        "local development block.",
    );
  }

  const host = assertLocalHost(directUrl);
  assertNotDisposableTestDatabase(directUrl, "npm run db:dev:setup");
  const name = databaseNameOf(directUrl) ?? "";
  if (name !== DEV_DATABASE) {
    // Not a hard failure: someone may legitimately want a differently named
    // local database. Worth saying out loud, because the usual cause is a
    // connection string copied from the test configuration.
    console.warn(
      `Note: the development database is named "${name}", not "${DEV_DATABASE}".`,
    );
  }
  const created = await ensureDatabaseExists(directUrl);
  console.log(
    `Development database "${name}" on ${host}: ${created ? "created" : "already present"}.`,
  );

  // Migrations and seed both read DIRECT_URL from the environment, and dotenv
  // does not overwrite a variable that is already set - so passing it here wins
  // over the `.env.local` those tools load, without editing that file.
  const childEnv = { ...process.env, DIRECT_URL: directUrl, DATABASE_URL: directUrl };

  runPackageBin("prisma", ["migrate", "deploy"], { env: childEnv });
  runPackageBin("tsx", ["prisma/seed.ts"], { env: childEnv });

  console.log(
    `\nDevelopment database ready. \`npm run dev\` will use it, because Next.js ` +
      "loads .env.development.local ahead of .env.local.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
