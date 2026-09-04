# 14 — Objective 1 scope

> **Historical record.** This records what the _first_ objective built and deliberately left out. Almost everything listed here as absent has since been implemented. It is kept for the reasoning, not as a
> description of the current system — for that, see
> [28 — Final architecture](./28-final-architecture.md).

## What Objective 1 implemented

### Application foundation

- Next.js **16.3.3** (App Router, Turbopack), React 19, TypeScript 5, npm.
- **Modular monolith** — one application, one database, hard internal
  boundaries. Not microservices.
- **Node.js 24 LTS**, pinned in `package.json` `engines` and `.nvmrc`;
  `packageManager` pins npm.
- Strict TypeScript beyond the default: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`,
  `noUnusedLocals`, `noUnusedParameters`, `allowJs: false`.
- ESLint with `@typescript-eslint/no-explicit-any` as an **error**, `eqeqeq`,
  restricted `console`, and a custom rule banning `process.env` outside the
  config boundary.
- Prettier, Vitest, and `npm run verify` (typecheck + lint + test + build).

### Financial core (pure, tested)

| Module                                                   | What it guarantees                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`money.ts`](../src/domain/money.ts)                     | Integer minor units with explicit currency. No float can become a charge; currencies cannot be mixed.                                     |
| [`transaction/`](../src/domain/transaction/)             | 17 typed states, a complete actor-scoped transition table, and a pure adjudicator with idempotent replay handling. Vendor-neutral actors. |
| [`errors.ts`](../src/domain/errors.ts)                   | Eight-category taxonomy with separate internal and public faces.                                                                          |
| `identifiers.ts` _(removed — see below)_                 | Branded ids, so a `ProductId` cannot be passed where a `TransactionId` belongs. Covers quote, reservation and transition ids.             |
| [`decision-record.ts`](../src/domain/decision-record.ts) | The explainability contract, with a hard cap on the reason field.                                                                         |
| [`audit-event.ts`](../src/domain/audit-event.ts)         | The audit contract, over a closed event vocabulary.                                                                                       |

### Supporting foundation

- [`config/env.ts`](../src/config/env.ts) — typed, Zod-validated, tiered
  configuration. The app boots on an empty environment.
- [`lib/logger.ts`](../src/lib/logger.ts) and
  [`lib/redact.ts`](../src/lib/redact.ts) — structured operational logging with
  secret and chain-of-thought scrubbing.
- `lib/result.ts` _(removed — see below)_, [`lib/json.ts`](../src/lib/json.ts).
- `GET /api/health` — the only route.
- A landing page that states the architectural rule. No product UI.

### Architecture patch (applied after the initial foundation)

Locked decisions were folded in without rebuilding anything: Node 24 LTS,
modular monolith stated explicitly, PostgreSQL + Prisma as the persistence
architecture, AI Provider Adapter and Payment Provider Interface as named
boundaries, `DIRECT_URL` added to the config boundary, and the
state model extended to 17 states covering quote, reservation, payment
verification and expiry.

### Documentation

Fifteen documents in `docs/` covering purpose, architecture, all eleven module
boundaries, the AI/deterministic split, transaction flow, the state machine,
security and trust, API design, the data model, configuration, errors, logging,
explainability, audit, testing, structure, and the roadmap.

### Dependencies added

| Package    | Why                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `zod`      | Runtime validation is a structural requirement of this design: untrusted client input, untrusted LLM output, unverified webhook payloads and the config boundary all need schema validation, and Zod gives the inferred types too — avoiding duplicate type definitions. |
| `vitest`   | Test runner. Native TS and ESM, reuses the tsconfig path alias.                                                                                                                                                                                                          |
| `prettier` | Formatting.                                                                                                                                                                                                                                                              |

`vite-tsconfig-paths` was installed and then **removed** once Vitest 4 was
confirmed to resolve tsconfig paths natively — one fewer dependency.

Deliberately **not** installed: any agent framework, the Razorpay SDK, any
LLM/AI SDK, any state-management library, any database or ORM package.

## What Objective 1 deliberately did not implement

Confirmed absent from the codebase:

- **Buyer agent** — no LLM call, no provider SDK, no API key used or required.
- **Merchant catalog** — no products, no catalog service, no seed data.
- **Product decision engine** — no ranking, no recommendation logic.
- **Policy engine** — the contract and the state machine's policy edges exist;
  no rule evaluation does.
- **Human approval gate** — no approval flow, no UI.
- **Razorpay** — no SDK, no API call, no order creation, no Checkout, no
  signature verification, no webhook endpoint, no keys. **Nothing is faked or
  presented as integrated.**
- **Database** — PostgreSQL + Prisma are the locked _decision_, but no schema,
  no Prisma install, no model, no migration, no seed and no connection exist.
- **PurchaseQuote, InventoryReservation, TransactionStateTransition** —
  architecture, states, ids and audit vocabulary only. No behaviour, no
  persistence.
- **Transaction service** — no persistence, no orchestration. Only the pure
  state machine it will use.
- **Audit service** — the contract only; no writer, no store, no UI timeline.
- **Payment failure handling** — designed in
  [04](./04-transaction-flow.md) and expressible in the state machine; not
  implemented.
- **Authentication, rate limiting, CSRF** — conventions documented in
  [06](./06-security-and-trust-boundaries.md); not built.
- **Any "innovation" feature.**

## Validation performed

| Check               | Result                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `npm install`       | clean, 0 vulnerabilities                                                |
| `npm run typecheck` | passes                                                                  |
| `npm run lint`      | passes; the `process.env` rule verified to actually fire                |
| `npm run test`      | 39 tests, 6 files, all pass                                             |
| `npm run build`     | production build succeeds with **no environment file present**          |
| `npm run dev`       | starts clean; `/` returns 200, `/api/health` returns 200 with no errors |
| Secrets             | no `.env` exists anywhere; only `.env.example` is tracked               |

## Since removed as dead code

Two of the modules above never gained a caller as later objectives built on
top of this foundation: `identifiers.ts`'s branded-id types and `lib/result.ts`'s
generic `Result<T, E>` wrapper. Every engine that followed ended up returning
its own named discriminated union (e.g. `TransitionDecision`) instead of the
generic wrapper, and every id stayed a plain validated `string`. Both files
were deleted once a repository-wide sweep confirmed zero imports of either.
This is exactly the kind of drift this historical record exists to make
visible rather than hide.
