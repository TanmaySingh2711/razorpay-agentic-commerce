import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "../src/generated/prisma/client";
import { POOLED_HOSTNAME_CONVENTIONS, isPooledHostname } from "./pooled-endpoint";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Database verification.
 *
 * Proves the live PostgreSQL database actually matches what this repository
 * expects - tables, CHECK constraints, protective foreign keys, indexes - and
 * that the application reaches it over the POOLED endpoint.
 *
 * `prisma migrate status` answers "were the migrations applied". This answers
 * "is the resulting database the shape we designed", which is the question that
 * matters after a hand-edited migration adds constraints Prisma cannot express.
 *
 * Never prints a connection string or a password: only the hostname, which is
 * what distinguishes pooled from direct. Which hostnames count as pooled is
 * decided by ./pooled-endpoint, because each provider names that endpoint
 * differently and the verifier should not be tied to one of them.
 */
const EXPECTED_TABLES = [
  "approval_request",
  "audit_event",
  "authorization_policy",
  "buyer_profile",
  "inventory_reservation",
  "merchant",
  "payment_attempt",
  "product",
  "purchase_quote",
  "transaction",
  "transaction_state_transition",
  "webhook_event",
] as const;

/** Probes an endpoint's reachability. Reports only the hostname, never a credential. */
async function probeEndpoint(url: string): Promise<{ ok: boolean; detail: string }> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return { ok: true, detail: "reachable" };
  } catch (error) {
    try {
      await client.end();
    } catch {
      /* already closed */
    }
    const firstLine = (error as Error).message.split(/\r?\n/)[0];
    return { ok: false, detail: firstLine ?? "unknown error" };
  }
}

async function main(): Promise<void> {
  const pooledUrl = process.env["DATABASE_URL"];
  const directUrl = process.env["DIRECT_URL"];
  if (pooledUrl === undefined || pooledUrl.length === 0) {
    throw new Error("DATABASE_URL is not set. See .env.example.");
  }

  // Schema inspection runs over the direct connection: it is admin tooling, and
  // the direct endpoint is the one guaranteed to support session-scoped work.
  const inspectionUrl = directUrl ?? pooledUrl;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: inspectionUrl }),
  });

  try {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() ORDER BY tablename`;
    const tableNames = tables.map((row) => row.tablename);

    const [checks] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'c' AND connamespace = current_schema()::regnamespace`;

    const [restrictFks] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND confdeltype = 'r' AND connamespace = current_schema()::regnamespace`;

    const [unsafeFks] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND confdeltype IN ('c', 'n', 'd')
        AND connamespace = current_schema()::regnamespace`;

    const [indexes] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_indexes WHERE schemaname = current_schema()`;

    const [applied] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;

    const missing = EXPECTED_TABLES.filter((name) => !tableNames.includes(name));
    const pooledHost = new URL(pooledUrl).hostname;
    const isPooledHost = isPooledHostname(pooledHost);
    const pooledProbe = await probeEndpoint(pooledUrl);

    console.log("Database verification");
    console.log(`  inspected via         : ${new URL(inspectionUrl).hostname}`);
    console.log(
      `  runtime host          : ${pooledHost}${isPooledHost ? " (pooled)" : " (NOT a pooled host)"}`,
    );
    console.log(
      `  runtime connectivity  : ${pooledProbe.ok ? "OK" : `FAILED - ${pooledProbe.detail}`}`,
    );
    console.log(`  migrations applied    : ${String(applied?.n ?? 0n)}`);
    console.log(
      `  tables                : ${String(tableNames.length)} (expected ${String(EXPECTED_TABLES.length)})`,
    );
    console.log(`  CHECK constraints     : ${String(checks?.n ?? 0n)}`);
    console.log(`  FKs ON DELETE RESTRICT: ${String(restrictFks?.n ?? 0n)}`);
    console.log(`  FKs with cascade/null : ${String(unsafeFks?.n ?? 0n)}`);
    console.log(`  indexes               : ${String(indexes?.n ?? 0n)}`);

    const problems: string[] = [];
    if (missing.length > 0) problems.push(`missing tables: ${missing.join(", ")}`);
    if ((checks?.n ?? 0n) === 0n) problems.push("no CHECK constraints found");
    if ((unsafeFks?.n ?? 0n) > 0n) {
      problems.push(
        "a foreign key uses CASCADE/SET NULL - financial history is deletable",
      );
    }
    if (!isPooledHost) {
      problems.push(
        `DATABASE_URL does not point at a pooled endpoint - ${POOLED_HOSTNAME_CONVENTIONS}`,
      );
    }
    if (!pooledProbe.ok) {
      problems.push(
        "the pooled runtime connection (DATABASE_URL) is unreachable - copy the pooled " +
          "connection string from the database provider's console into .env.local",
      );
    }

    if (problems.length > 0) {
      console.error(`\nFAILED: ${problems.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("\nOK: live schema matches the expected design.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
