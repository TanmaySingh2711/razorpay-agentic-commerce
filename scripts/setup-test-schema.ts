import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import {
  TEST_SCHEMA,
  TEST_SCHEMA_MARKER_TABLE,
  TEST_SCHEMA_MARKER_VALUE,
} from "../tests/db/schema-identity";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Prepares an isolated PostgreSQL schema for database tests.
 *
 * Isolation strategy: a dedicated **schema** inside the same PostgreSQL
 * database, not a separate database and not SQLite.
 *
 *  - It exercises real PostgreSQL semantics - CHECK constraints, enums,
 *    BIGINT, unique indexes, referential actions - which is the whole point of
 *    testing persistence. SQLite would silently accept things PostgreSQL
 *    rejects, so tests would prove nothing about production.
 *  - It costs nothing extra. Provisioning a second hosted database would push
 *    a paid dependency onto anyone running the suite.
 *  - It cannot contaminate demo data: the schema is dropped and recreated on
 *    every setup, and `public` is never touched.
 *
 * Anyone who prefers a fully separate database can point TEST_DIRECT_URL at one;
 * this script honours it.
 *
 * Last, this script stamps the schema with a marker table. The suite truncates
 * tables between tests, and it refuses to do so unless it can first read that
 * marker back out of the schema it is about to empty. Only a schema built here
 * has one, so a suite accidentally pointed at a development or production
 * database fails closed instead of deleting it.
 */
export { TEST_SCHEMA };

function withSchema(rawUrl: string, schema: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function main(): void {
  const directUrl = process.env["TEST_DIRECT_URL"] ?? process.env["DIRECT_URL"];
  if (directUrl === undefined || directUrl.length === 0) {
    throw new Error(
      "DIRECT_URL (or TEST_DIRECT_URL) must be set to prepare the test schema.",
    );
  }

  const client = new Client({ connectionString: directUrl });

  const run = async (): Promise<void> => {
    await client.connect();
    // Dropped and recreated so every run starts from a known-empty schema.
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await client.end();

    // Apply the very same migrations the real database uses, into the test
    // schema. Testing against a hand-built schema would let the two drift.
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, DIRECT_URL: withSchema(directUrl, TEST_SCHEMA) },
    });

    // Stamped after the migrations, so the marker cannot be mistaken for
    // something a migration produced - and so a half-built schema, where
    // `migrate deploy` failed, never earns the right to be truncated.
    const stamp = new Client({ connectionString: directUrl });
    await stamp.connect();
    await stamp.query(
      `CREATE TABLE "${TEST_SCHEMA}"."${TEST_SCHEMA_MARKER_TABLE}" (
         marker     text PRIMARY KEY,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await stamp.query(
      `INSERT INTO "${TEST_SCHEMA}"."${TEST_SCHEMA_MARKER_TABLE}" (marker) VALUES ($1)`,
      [TEST_SCHEMA_MARKER_VALUE],
    );
    await stamp.end();

    console.log(`\nTest schema "${TEST_SCHEMA}" is ready and marked as disposable.`);
  };

  run().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

main();
