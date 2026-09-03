import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma 7).
 *
 * In Prisma 7 the connection URL no longer lives in `schema.prisma`; the CLI
 * reads it from here. That is what lets this project route the two connections
 * correctly:
 *
 *   - CLI / migrations    -> DIRECT_URL   (the unpooled endpoint)
 *   - application runtime -> DATABASE_URL (the pooled endpoint)
 *
 * The split matters because connection poolers generally cannot run DDL, so a
 * migration issued over the pooled endpoint can fail or behave surprisingly.
 * Runtime traffic wants the opposite: pooling, so serverless invocations do not
 * exhaust PostgreSQL connections. The runtime connection is configured in
 * `src/integrations/persistence/client.ts`, not here.
 *
 * Prisma 7 does not auto-load env files, and this project keeps real values in
 * `.env.local` (git-ignored, per Objective 1), so it is loaded explicitly.
 */
loadEnv({ path: ".env.local", quiet: true });

function requireMigrationUrl(): string {
  // Prefer the direct connection for schema work; fall back to the pooled URL
  // only when no direct endpoint is configured (an unpooled single-URL setup).
  const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error(
      "Neither DIRECT_URL nor DATABASE_URL is set. Add them to .env.local - see .env.example.",
    );
  }
  return url;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: requireMigrationUrl(),
  },
});
