# 14 — Objective 1 scope

## What Objective 1 implemented

### Application foundation

- Next.js **16.3.3** (App Router, Turbopack), React 19, TypeScript 5, npm.
- Strict TypeScript beyond the default: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`,
  `noUnusedLocals`, `noUnusedParameters`, `allowJs: false`.
- ESLint with `@typescript-eslint/no-explicit-any` as an **error**, `eqeqeq`,
  restricted `console`, and a custom rule banning `process.env` outside the
  config boundary.
- Prettier, Vitest, and `npm run verify` (typecheck + lint + test + build).

### Financial core (pure, tested)

| Module                                                   | What it guarantees                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`money.ts`](../src/domain/money.ts)                     | Integer minor units with explicit currency. No float can become a charge; currencies cannot be mixed.              |
| [`transaction/`](../src/domain/transaction/)             | 13 typed states, a complete actor-scoped transition table, and a pure adjudicator with idempotent replay handling. |
| [`errors.ts`](../src/domain/errors.ts)                   | Eight-category taxonomy with separate internal and public faces.                                                   |
| [`identifiers.ts`](../src/domain/identifiers.ts)         | Branded ids, so a `ProductId` cannot be passed where a `TransactionId` belongs.                                    |
| [`decision-record.ts`](../src/domain/decision-record.ts) | The explainability contract, with a hard cap on the reason field.                                                  |
| [`audit-event.ts`](../src/domain/audit-event.ts)         | The audit contract, over a closed event vocabulary.                                                                |

### Supporting foundation

- [`config/env.ts`](../src/config/env.ts) — typed, Zod-validated, tiered
  configuration. The app boots on an empty environment.
- [`lib/logger.ts`](../src/lib/logger.ts) and
  [`lib/redact.ts`](../src/lib/redact.ts) — structured operational logging with
  secret and chain-of-thought scrubbing.
- [`lib/result.ts`](../src/lib/result.ts), [`lib/json.ts`](../src/lib/json.ts).
- `GET /api/health` — the only route.
- A landing page that states the architectural rule. No product UI.

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
- **Database** — no schema, no ORM, no migration, no connection.
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
