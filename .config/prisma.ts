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

/**
 * Where a command that connects would have gone, had one been configured.
 *
 * `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve, so
 * this fails closed: it cannot reach a real database by accident, and the
 * hostname says what to fix.
 */
const NO_DATABASE_CONFIGURED =
  "postgresql://unset:unset@set-DIRECT-URL-see-env-example.invalid:5432/unset";

/**
 * The connection schema commands use, or a deliberately unreachable placeholder.
 *
 * This used to throw when neither variable was set, which broke the one Prisma
 * command that needs no database at all: `prisma generate`. That runs from
 * `postinstall`, so `npm install` failed on a fresh clone with no environment
 * file - exactly the path a reviewer takes first, and exactly the path this
 * project promises works with no credentials. CI hit the same wall at `npm ci`.
 *
 * Nothing is weakened by returning a placeholder instead. Every command that
 * genuinely connects sets `DIRECT_URL` explicitly in the child environment it
 * spawns Prisma with - `scripts/prisma-cli.ts` after its local/staging target
 * checks, and `scripts/setup-test-schema.ts` for the disposable test schema -
 * so the placeholder is never the value a real migration, seed or studio
 * session uses. It is reachable only by invoking the Prisma CLI directly with
 * no environment at all, and then it refuses to connect anywhere.
 */
function migrationUrl(): string {
  // Prefer the direct connection for schema work; fall back to the pooled URL
  // only when no direct endpoint is configured (an unpooled single-URL setup).
  const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
  return url === undefined || url.length === 0 ? NO_DATABASE_CONFIGURED : url;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: migrationUrl(),
  },
});
