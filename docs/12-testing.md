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
The suites skip themselves when no database is configured, so the foundation
tests still pass with zero credentials. See [16](./16-database.md).

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

## Commands

```
npm run db:test:setup   # recreate + migrate the isolated test schema (once)
npm run test            # single run
npm run test:watch      # watch mode
npm run verify          # typecheck + lint + test + build
```
