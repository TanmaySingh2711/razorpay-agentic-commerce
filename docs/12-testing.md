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

| Layer             | Scope                                                                        | Status                                |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| **Unit / domain** | Pure rules: money, state machine, contracts, redaction                       | **in place**                          |
| **Service**       | Orchestration with fake collaborators (fake merchant, fake Razorpay adapter) | enabled by the design; none exist yet |
| **API**           | Route handlers invoked directly as functions                                 | one in place (`health`)               |
| **Integration**   | Adapter against a Razorpay test double                                       | future objective                      |

Route handlers are plain exported functions, so they are called directly in a
test with no server. `buildHealthPayload` is separated from `GET` for the same
reason: the interesting assertion is about the payload, not the transport.

## What is covered today

39 tests across 6 files. Each targets a stated invariant, not a line of code.

| File                                                                                    | What it holds down                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`money.test.ts`](../tests/money.test.ts)                                               | Non-integer and unsafe amounts are rejected; addition is exact where float arithmetic is not; currencies cannot be mixed; budget ceilings are inclusive; formatting and parsing never touch a float.                                                                                                                                                                                                                                                             |
| [`transaction-state-machine.test.ts`](../tests/transaction-state-machine.test.ts)       | Every state has a table entry; terminal states have no exits; **AI actors hold exactly one edge in the entire lifecycle**; no payment vendor is named in the domain core; only a clock can expire a transaction; the agent cannot authorize, approve or capture; quote, policy, approval and reservation controls cannot be skipped; replays resolve to `already_applied`; retries are limited to the transaction service; inventory-holding states are correct. |
| [`config-env.test.ts`](../tests/config-env.test.ts)                                     | The app boots from an empty environment; malformed values are rejected rather than defaulted; provider config fails lazily; error output names variables and never echoes a secret.                                                                                                                                                                                                                                                                              |
| [`logging-redaction.test.ts`](../tests/logging-redaction.test.ts)                       | Credentials, signatures and card data are scrubbed at depth; model reasoning fields are scrubbed; oversized strings truncated; level filtering; child context binding.                                                                                                                                                                                                                                                                                           |
| [`decision-and-audit-contracts.test.ts`](../tests/decision-and-audit-contracts.test.ts) | Decision reasons are length-bounded; AI decisions still carry an explicit `ruleApplied: null`; audit events require everything needed for reconstruction; unknown event types are rejected.                                                                                                                                                                                                                                                                      |
| [`health-route.test.ts`](../tests/health-route.test.ts)                                 | The app answers without any credential; the payload discloses no configuration or credential state.                                                                                                                                                                                                                                                                                                                                                              |

Two tests deserve specific mention, because they turn architecture rules into
build failures:

- The **AI-edge test** enumerates the whole transition table and asserts the set
  of AI-triggerable edges equals `["INTENT_RECEIVED->PRODUCT_SELECTED"]`.
  Widening AI authority requires deliberately editing a failing assertion.
- The **vendor-neutrality test** asserts no actor in the domain core matches a
  payment brand. Leaking `razorpay` into the state machine fails the suite,
  which is what keeps the Payment Provider Interface a real boundary rather than
  a naming convention.

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
one. The image is pinned to PostgreSQL 17 to match staging, so the semantics
under test are identical.

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
separate `razorpay:smoke`, `gemini:smoke` and `checkout:smoke` scripts, run
deliberately.

## Two projects, one suite

The runner is split so each half gets the scheduling it needs:

| Project | Files         | Parallel | Why                                                        |
| ------- | ------------- | -------- | ---------------------------------------------------------- |
| `unit`  | `tests/*`     | yes      | No shared state. 10.5s serial to 5.9s parallel, 557 tests. |
| `db`    | `tests/db/**` | **no**   | All files share one schema and truncate it between tests.  |

Per-worker schemas would let the database files run concurrently too, but that
means provisioning and migrating N schemas per run and teaching the disposable-
schema guard about each - real complexity and a new way to be flaky, to save
about twenty seconds. Not taken.

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
