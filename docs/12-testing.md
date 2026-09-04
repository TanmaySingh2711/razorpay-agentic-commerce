# 12 — Testing strategy

## The runner

**Vitest**, configured in [`vitest.config.mts`](../vitest.config.mts).

Chosen over Jest because this project's testable core is deliberately
framework-free TypeScript. Vitest runs it with no transform configuration, no
Babel step, and native ESM. Path aliases come from `tsconfig.json` via
`resolve.tsconfigPaths`, so a test import is byte-identical to an application
import — `@/domain/money` in both.

Tests run on the **Node** environment. Nothing in the foundation needs a DOM. A
browser environment will be added only when a component actually requires one.

No end-to-end browser tooling in Objective 1. Playwright would add a large
dependency and a CI burden to test a page that intentionally has no behaviour.

## Layers

| Layer             | Scope                                                                     | Status           |
| ----------------- | ------------------------------------------------------------------------- | ---------------- |
| **Unit / domain** | Pure rules: money, state machine, policy, budget, contracts, redaction    | **in place**     |
| **Service**       | Orchestration against real PostgreSQL with fake provider collaborators    | **in place**     |
| **API**           | Route handlers invoked directly as functions                              | **in place**     |
| **Integration**   | The Razorpay adapter against a `fetchImpl` double, with real cryptography | **in place**     |
| **Live smoke**    | Real Gemini and real Razorpay Test Mode, run deliberately and never in CI | separate scripts |

Route handlers are plain exported functions, so they are called directly in a
test with no server. `buildHealthPayload` is separated from `GET` for the same
reason: the interesting assertion is about the payload, not the transport.

## The core test matrix

Objective 17 completed the matrix below and audited every earlier suite against
it. The point of the table is that a reviewer can find where each behaviour is
actually proven, rather than trusting that a file with a promising name proves
it. Requirements sharing a row are proven by the same suite.

| Behaviour                                                       | Proven in                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Intent extraction; structured-output validation                 | `buyer-agent-orchestration`, `buyer-agent-authority`, **`model-schema-parity`** |
| Prompt injection; budget-bypass prompts                         | `buyer-agent-security`, `buyer-agent-orchestration`, `db/buyer-agent-flow`      |
| Catalog visibility, filters, authority, hostile text            | `db/catalog-api`, `catalog-query`, `catalog-contract`                           |
| Quote creation, expiry, price change, inventory change          | `db/purchase-quote`, `quote-rules`                                              |
| Concurrent inventory reservation; reservation lifecycle         | `db/approval-and-reservation`, `db/money-and-persistence`                       |
| Policy below / exactly at / above the limit; currency mismatch  | `policy-engine`, `db/policy-evaluation`                                         |
| Approval success, rejection, expiry, replay                     | `db/approval-and-reservation`, `approval-token-and-inventory-rules`             |
| State-machine valid and invalid paths; idempotent transition    | `transaction-state-machine`, `db/transition-service`                            |
| No direct state mutation; server-only boundary                  | `lint-architecture`                                                             |
| Order creation; duplicate order request; receipt reuse          | `db/payment-order`, `payment-order-rules`                                       |
| Valid and invalid payment signature                             | `db/checkout-verification`, `checkout-signature`                                |
| Valid, invalid, duplicate and out-of-order webhooks             | `db/webhook-reconciliation`, `webhook-signature`                                |
| Payment success and failure; failure classification             | `db/webhook-reconciliation`, `payment-failure-classification`                   |
| Controlled retry; retry limit; late capture after failure       | `db/payment-retry`, `payment-retry-rules`                                       |
| Stale-quote re-quote on retry; re-priced approval; rebound hold | **`db/payment-retry-requote`**                                                  |
| A settled purchase cannot be paid or fulfilled twice            | **`db/settled-transaction`**                                                    |
| Audit completeness and ordering                                 | `db/audit-timeline`, `audit-record-contract`, `decision-and-audit-contracts`    |
| Secret and reasoning safety in logs and audit records           | `logging-redaction`, `config-env`, and a "no secret" assertion in each suite    |
| The verification infrastructure itself                          | `verification-infrastructure`, `db/test-database-guard`                         |

Two properties are asserted repeatedly across suites rather than in one place,
because they are the ones a future change is most likely to erode: that
`PAYMENT_VERIFIED` and `PAYMENT_CAPTURED` are never collapsed into a generic
success, and that no amount, currency or authorization ever originates from the
model or the browser.

## Conventions

- No `expect(true).toBe(true)`. Every test names a behaviour a reviewer would
  care about.
- Test names read as claims about the system, not as descriptions of the code.
- Domain tests take no fixtures, no mocks and no clock: the modules are pure.
- Where time matters, it is injected (`buildLogEntry(..., now)`,
  `buildHealthPayload(now)`) rather than mocked globally.

## Database tests

`tests/db/` runs against a dedicated `agentic_test` PostgreSQL schema, never
against the demo data, and never against SQLite - the constraints being tested
are ones SQLite would silently accept. Prepare it with `npm run db:test:setup`.
The suites skip themselves when no database is configured **at all**, so the
foundation tests still pass on a fresh clone with zero credentials. See
[16](./16-database.md).

The schema lives in the local Docker PostgreSQL described by
`docker-compose.yml`, addressed by `TEST_DIRECT_URL`. That is not a preference,
it is roughly a fortyfold difference: the same five suites took **616s** against
the hosted database and **15s** locally, because every fixture makes dozens of
sequential round trips and a hosted database charges network latency for each
one. The image is pinned to PostgreSQL 17, so the tests run against real
PostgreSQL semantics rather than a substitute. The hosted Neon database now
reports 18.x, one major version ahead; nothing this schema uses differs between
the two, and `npm run db:verify:staging` re-asserts every constraint against the
hosted database itself.

`TEST_DIRECT_URL` is required and has **no fallback to `DIRECT_URL`**. The
suite empties its schema with `TRUNCATE ... CASCADE` between tests, and the
convenient fallback would silently aim that loop at whatever the application's
connection happens to be - on a developer machine, staging.
`tests/db/test-database-url.ts` therefore refuses three things at configuration
time: a missing test URL in a project that _is_ configured, a test URL naming
the same server as `DIRECT_URL`, and one naming the same server as
`DATABASE_URL`. A genuinely disposable remote database can still be used with
`ALLOW_REMOTE_TEST_DATABASE=1`. None of this replaces the disposable-schema
guard, which still proves against the live catalog that the schema it is about
to truncate carries the marker only `npm run db:test:setup` writes.

| File                            | What it holds down                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enum-parity.test.ts`           | The Prisma enums and the domain state/actor lists cannot drift apart                                                                                                                                         |
| `entities.test.ts`              | All 12 entities persist, with UUIDv7 ids, timestamps, BIGINT money; the full relation graph traverses                                                                                                        |
| `constraints.test.ts`           | Negative stock, bad quote arithmetic, non-ISO currency, duplicate slug/SKU/attempt/webhook id, missing FKs, deleting referenced financial history, and garbage enum values are all refused **by PostgreSQL** |
| `updates.test.ts`               | Lifecycle status changes persist for every entity                                                                                                                                                            |
| `money-and-persistence.test.ts` | BigInt round-trips at full precision, DTO serialisation, the reconnect proof, and the concurrency foundation                                                                                                 |

Two deserve specific mention. The **reconnect test** writes a transaction and
its children, fully disconnects, opens a brand-new client, and re-reads them -
which no in-memory array, module mock or fixture cache could survive. The
**concurrency test** proves a conditional decrement is atomic and that the
inventory CHECK is a real backstop, without implementing the reservation
algorithm that Objective 8 owns.

## No live services, enforced

Automated verification never calls Gemini, Razorpay, Vercel or the hosted
database. Every external dependency already has a seam - the payment adapter
takes a `fetchImpl`, the AI provider is an interface with a fake - but nothing
used to _enforce_ it: `createRazorpayProvider()` defaults to global `fetch` and
the real API base, so a test that forgot to inject a fake would reach the live
provider with real credentials and still look green.

`tests/support/no-network.ts` is loaded as a Vitest setup file in every worker
and replaces global `fetch` with one that refuses anything but loopback, naming
the URL it stopped. Real Test Mode validation stays where it belongs: the
separate `razorpay:smoke`, `gemini:smoke`, `agent:smoke` and `checkout:smoke`
scripts, run deliberately. `agent:smoke` is the read-only Buyer Agent one: real
Gemini, real hosted catalog, no writes of any kind. See
[19](./19-buyer-agent.md).

## Two projects, one suite

The runner is split so each half gets the scheduling it needs:

| Project | Files         | Parallel | Why                                                    |
| ------- | ------------- | -------- | ------------------------------------------------------ |
| `unit`  | `tests/*`     | yes      | No shared state. 718 tests, seconds.                   |
| `db`    | `tests/db/**` | **no**   | 420 tests sharing one schema, truncated between tests. |

Per-worker schemas would let the database files run concurrently too, but that
means provisioning and migrating N schemas per run and teaching the disposable-
schema guard about each - real complexity and a new way to be flaky. Not taken.

### What the database half actually costs

Its runtime is round trips, not computation. Each test drives the real service
boundaries, so it makes dozens of statements, and every statement pays the
host-to-container latency of Docker Desktop's port forwarding - measured at
**1.6-2.6ms per trivial `SELECT 1`** on this machine, against about 34ms for the
twelve-table `TRUNCATE` that separates tests. That figure moves with the host,
not with the code: the same 400-odd tests have been observed at both roughly 50s and
roughly 180s on the same commit, either side of a Docker Desktop restart.

So a slow run is worth measuring before it is worth optimising. Compare a
`SELECT 1` round trip first; if it has changed, the suite is not what changed.
Confirmed once more after Objective 17: the same commit that had been taking
roughly 300s ran in 51-54s across four consecutive runs following a Docker
Desktop restart, with nothing in the repository changed in between.

### Repeat runs, and what a mass failure means

The suite is run several times end to end rather than once, because order,
timing and concurrency defects are exactly the ones a single green run hides.
Four consecutive full runs after Objective 17 gave **1090 passed, 0 failed, 0
skipped** every time, with wall times within three seconds of each other.

One earlier sweep did fail - 331 tests at once, identically in all three runs.
That was not a flake and not the code: Docker Desktop had stopped, and the
disposable-schema guard refused to truncate a database it could not read. It
was right to refuse. What it said was the problem, and
`describeMarkerFailure` in `tests/db/test-database-guard.ts` now separates "the
database is not running" from "this schema was never built", because the two
need opposite fixes and Prisma reports them almost identically. A wall of
failures naming the schema guard is worth reading twice before suspecting the
guard.

## Commands

```
npm run db:test:up      # start local PostgreSQL 17 (waits until healthy)
npm run db:test:health  # is it up and accepting connections?
npm run db:test:setup   # recreate + migrate the isolated test schema
npm run db:test:down    # stop it
npm run db:test:reset   # destroy the volume and rebuild from scratch
npm run db:dev:setup    # create + migrate + seed the local DEVELOPMENT database
npm run db:dev:health   # is the development database accepting connections?
npm run test            # single run
npm run test:watch      # watch mode
npm run verify          # typecheck + lint + test + build (fully local)
npm run format:check    # formatting, kept separate from verify
```

First-time setup:

1. `npm run db:test:up` - start the container.
2. Copy the `TEST_DIRECT_URL` line from `.env.example` into `.env.local`, then
   `npm run db:test:setup` for the disposable test schema.
3. Create `.env.development.local` with the local `DATABASE_URL`/`DIRECT_URL`
   from `.env.example`, then `npm run db:dev:setup` for the development
   database. `npm run dev` picks it up automatically - see
   [09](./09-configuration.md) for the precedence rules and which command
   reaches which database.
