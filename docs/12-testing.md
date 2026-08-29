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

| File                                                                                    | What it holds down                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`money.test.ts`](../tests/money.test.ts)                                               | Non-integer and unsafe amounts are rejected; addition is exact where float arithmetic is not; currencies cannot be mixed; budget ceilings are inclusive; formatting and parsing never touch a float.                                                                                         |
| [`transaction-state-machine.test.ts`](../tests/transaction-state-machine.test.ts)       | Every state has a table entry; terminal states have no exits; **AI actors hold exactly one edge in the entire lifecycle**; the agent cannot authorize, approve or capture; controls cannot be skipped; replays resolve to `already_applied`; retries are limited to the transaction service. |
| [`config-env.test.ts`](../tests/config-env.test.ts)                                     | The app boots from an empty environment; malformed values are rejected rather than defaulted; provider config fails lazily; error output names variables and never echoes a secret.                                                                                                          |
| [`logging-redaction.test.ts`](../tests/logging-redaction.test.ts)                       | Credentials, signatures and card data are scrubbed at depth; model reasoning fields are scrubbed; oversized strings truncated; level filtering; child context binding.                                                                                                                       |
| [`decision-and-audit-contracts.test.ts`](../tests/decision-and-audit-contracts.test.ts) | Decision reasons are length-bounded; AI decisions still carry an explicit `ruleApplied: null`; audit events require everything needed for reconstruction; unknown event types are rejected.                                                                                                  |
| [`health-route.test.ts`](../tests/health-route.test.ts)                                 | The app answers without any credential; the payload discloses no configuration or credential state.                                                                                                                                                                                          |

The AI-edge test deserves specific mention: it enumerates the whole transition
table and asserts the set of AI-triggerable edges equals
`["INTENT_RECEIVED->PRODUCT_SELECTED"]`. Widening AI authority therefore
requires deliberately editing a failing assertion.

## Conventions

- No `expect(true).toBe(true)`. Every test names a behaviour a reviewer would
  care about.
- Test names read as claims about the system, not as descriptions of the code.
- Domain tests take no fixtures, no mocks and no clock: the modules are pure.
- Where time matters, it is injected (`buildLogEntry(..., now)`,
  `buildHealthPayload(now)`) rather than mocked globally.

## Commands

```
npm run test        # single run
npm run test:watch  # watch mode
npm run verify      # typecheck + lint + test + build
```
