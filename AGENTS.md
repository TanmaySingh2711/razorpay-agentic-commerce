<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Verification: local first

Automated verification runs entirely on this machine. It must stay that way.

- **Database tests use local Docker PostgreSQL 17**, addressed by
  `TEST_DIRECT_URL`. Start it with `npm run db:test:up`, prepare the schema once
  with `npm run db:test:setup`. There is no fallback to `DIRECT_URL`, because the
  suite truncates its schema between tests and that fallback would aim it at
  staging; `tests/db/test-database-url.ts` fails the run instead.
- **Never point automated tests at the hosted Prisma Postgres.** The suite reads
  `TEST_DIRECT_URL` only.
- **Database commands: plain name = local, `:staging` = cloud.** `db:migrate`,
  `db:migrate:deploy`, `db:status`, `db:seed` and `db:studio` all target the
  local development database. Their `:staging` variants - and
  `db:verify:staging` - are the only way to reach the hosted database, and they
  announce it. `db:test:*` owns the local disposable test database. Every one of
  these refuses the wrong target before it connects
  (`scripts/database-target-guard.ts`): a local command against a remote host, a
  staging command against localhost, and anything at all against
  `razorpay_agentic_test`.
- **`npm run dev` is local too.** `.env.development.local` holds the local
  development database and outranks `.env.local` for `next dev`, so development,
  tests and staging use three different databases and `.env.local` is never
  edited to switch between them. Prepare development data with
  `npm run db:dev:setup`, which refuses any non-loopback host. `.env.local` keeps
  the hosted credentials for the `:staging` commands and the `*:smoke` scripts;
  reaching staging must always be deliberate.
- **No live Gemini, Razorpay, Vercel or cloud calls in `npm run verify`.** A
  Vitest setup file blocks non-loopback `fetch`. Use the fakes in
  `tests/support/`. Real Test Mode checks live in the separate `*:smoke` scripts
  and are run deliberately, never as part of verification.
- **While implementing or debugging, run focused tests only** - the files
  covering the changed code and its direct dependents, plus targeted
  `tsc --noEmit`, `eslint` and `prettier --check`. Do not rerun the whole suite
  to chase one failure.
- **When an objective is complete, run one full local `npm run verify`**, then
  `npm run format:check` separately. The full run is about two minutes, so it is
  a reasonable end-of-objective gate rather than something to avoid.
- **Never** weaken a test to make it pass: no deleted tests, no relaxed
  assertions, no SQLite standing in for PostgreSQL, no mocked-away concurrency,
  no timeout raised without a measurement that proves the timeout itself is
  wrong, no sleeps.
