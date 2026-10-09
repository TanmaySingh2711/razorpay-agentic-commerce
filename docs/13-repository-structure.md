# 13 — Repository structure

This is a **modular monolith**: one Next.js application, one deployable unit,
one database, with hard internal boundaries. It is not to be split into
services — see [02](./02-architecture.md) for why.

Every file listed exists and does something. **A folder exists only where two or
more files share a concern**; a single file sits one level up under a name that
says what it owns. The only exceptions are the route folders under `src/app/`,
which Next.js requires.

```
razorpay-agentic-commerce/
├── .config/                    tool configuration that need not sit in the root
│   ├── docker-compose.yml      the local PostgreSQL for dev and tests
│   ├── prisma.ts               Prisma 7 CLI config (direct connection), auto-discovered
│   └── vitest.config.mts       the two test projects and coverage; passed with --config
├── .github/workflows/ci.yml    CI: lint, type check, tests + one-click setup on 3 OSes
├── docs/                       architecture record (this directory)
├── prisma/
│   ├── migrations/             reviewable, committed schema history
│   ├── schema.prisma           the single schema definition
│   └── seed.ts                 idempotent demo seed
├── scripts/                    standalone CLI tooling, outside the app runtime
│   ├── setup.ts                `npm run setup`: the one-click setup, no dependencies
│   ├── run-dashboard.ps1       run_dashboard.bat's launcher: centres, waits, Esc stops
│   ├── start-database.ts       `predev`: starts Docker + PostgreSQL, prepares the dev database
│   ├── setup-dev-database.ts   local development DB, loopback only
│   ├── setup-test-schema.ts    creates + migrates the isolated test schema
│   ├── dev-demo-activity.ts    real-service shopper sessions for the local dev DB
│   ├── prisma-cli.ts           the guarded entry point for every db:* script
│   ├── database-target-guard.ts refuses a command aimed at the wrong database
│   ├── run-package-bin.ts      runs a dependency's CLI without a shell
│   ├── db-verify.ts            verifies the hosted DB matches the design
│   ├── pooled-endpoint.ts      pooled-vs-direct connection recognition
│   ├── gemini-smoke.ts         the one live Gemini call, outside npm test
│   ├── buyer-agent-smoke.ts    one live agent run, outside npm test
│   ├── razorpay-smoke.ts       one live Razorpay Test Mode call
│   ├── checkout-smoke-setup.ts prepares one real Test Mode checkout
│   └── checkout-smoke-check.ts inspects the result of that checkout
├── src/
│   ├── app/                    Next.js App Router — delivery layer only
│   │   ├── actions.ts          server actions the pages invoke
│   │   ├── api/buyer-agent/    AI buyer agent endpoint (handler.ts + route.ts)
│   │   ├── api/catalog/        agent-readable catalog endpoints
│   │   ├── api/health/         liveness endpoint
│   │   ├── api/payments/       order, checkout, callback, retry, dismissed
│   │   │   └── handler.ts      HTTP validation + response mapping (testable)
│   │   ├── api/webhooks/razorpay/  provider webhook intake and verification
│   │   ├── checkout/[transactionId]/    the page that offers Pay
│   │   ├── transaction/[transactionId]/ the authoritative purchase view
│   │   ├── page.tsx            overview: what this is, in one screen
│   │   ├── shop/page.tsx       the shop: the one input
│   │   ├── how-it-works/       four flowcharts (flows.ts), safety rules, the work behind it
│   │   ├── history/page.tsx    purchases this browser opened
│   │   ├── merchant/page.tsx   merchant insights: demand, conversion, recovery
│   │   ├── error.tsx           what a page shows when the server cannot finish it
│   │   ├── layout.tsx          root layout, self-hosted fonts
│   │   ├── globals.css         design tokens (black and red) + element defaults
│   │   ├── ui.css              component styles, loaded after globals.css
│   │   ├── site.css            header, page frames and the four main pages
│   │   ├── icon.tsx            generated tab icon (Next file convention)
│   │   └── favicon.ico         for browsers that request /favicon.ico directly
│   ├── components/
│   │   ├── site-header.tsx     logo, navigation, Test Mode badge, footer
│   │   ├── scroll-memory.tsx   Back/Forward return to where each page was left
│   │   ├── project-effort.tsx  "the work behind it", counted from the repository
│   │   ├── flowchart.tsx       flowcharts drawn as ordered lists
│   │   ├── count-up.tsx        figures that count up when scrolled into view
│   │   ├── purchase-history.tsx the history list, filters and Clear history
│   │   ├── remember-purchase.tsx saves an opened purchase to the history
│   │   ├── buyer-console.tsx   the shopping input and conversation
│   │   ├── pay-button.tsx      the one place a person spends money
│   │   ├── decision-form.tsx   approve / reject / hold / refund buttons
│   │   ├── awaiting-provider.tsx polls while the webhook is outstanding
│   │   └── safety-passport.tsx the deterministic safety summary
│   ├── domain/                 pure, framework-free core
│   │   ├── approval/           token minting, hashing, binding contracts
│   │   ├── audit/              payload allow-lists + human-readable explanations
│   │   ├── buyer-agent/        intent, decision, budget, validation, errors
│   │   ├── catalog/            public DTOs, categories, bounded query, errors
│   │   ├── payment/            provider port, checkout, webhook, retry, failure, rules
│   │   ├── policy/             decision vocabulary, the engine (pure), errors
│   │   ├── quote/              contracts, errors, expiry/validity rules
│   │   ├── transaction/        states, events, transitions, the state machine
│   │   ├── agent-request.ts    request outcomes + category normalisation
│   │   ├── audit-event.ts      the audit event vocabulary
│   │   ├── decision-record.ts  explainability contract
│   │   ├── eligibility.ts      deterministic candidate rules
│   │   ├── errors.ts           error taxonomy
│   │   ├── insights.ts         the merchant dashboard's arithmetic
│   │   ├── inventory.ts        reservation contracts and refusal wording
│   │   ├── journey.ts          what the buyer is shown at each state
│   │   ├── money.ts            integer minor units + currency
│   │   ├── rate-limit.ts       fixed windows + anonymous client keys
│   │   ├── refund.ts           refund eligibility, statuses, receipts
│   │   └── safety-passport.ts  the deterministic safety passport
│   ├── generated/prisma/       generated Prisma client (git-ignored artifact)
│   ├── integrations/           the only code that talks to the outside world
│   │   ├── ai-provider.ts      provider-neutral AiProvider port
│   │   ├── gemini-provider.ts  the ONLY @google/genai importer
│   │   ├── razorpay-provider.ts the ONLY Razorpay HTTP caller
│   │   └── prisma-client.ts    the ONLY database entry point, server-only
│   ├── lib/                    cross-cutting primitives
│   │   ├── env.ts              the ONLY reader of process.env
│   │   ├── api-response.ts     the shared HTTP success/error envelope
│   │   ├── rate-limited.ts     wraps a route in the rate limiter (429 + Retry-After)
│   │   ├── same-origin.ts      refuses cross-site state-changing requests
│   │   ├── checkout-script.ts  provider script loading, browser side
│   │   ├── clock.ts            injectable time, so expiry is testable
│   │   ├── json.ts             JSON value model
│   │   ├── logger.ts           structured operational logging
│   │   ├── project-stats.ts    the overview's figures, counted from the repo at build
│   │   ├── purchase-history.ts the browser-side history list and its rules
│   │   ├── redact.ts           secret and reasoning scrubbing
│   │   └── server-only.ts      module-scope browser-bundle guard
│   └── services/               one flat folder: each file is one application service
│       ├── buyer-agent-service.ts        agent orchestration
│       ├── buyer-agent-instructions.ts   developer instructions for the model
│       ├── catalog-tools.ts              the allowlisted tool registry
│       ├── catalog-reader.ts             the agent's read-only catalog port
│       ├── catalog-service.ts            catalog application service
│       ├── catalog-repository.ts         the catalog's ONLY Prisma read boundary
│       ├── product-decision-service.ts   AI proposal -> trusted quote
│       ├── quote-service.ts              trusted quote creation + validation
│       ├── quote-reader.ts               quote read boundary
│       ├── policy-service.ts             policy evaluation + recording
│       ├── policy-reader.ts              the policy's Prisma read boundary
│       ├── authorization-recheck.ts      re-derives authority before payment
│       ├── approval-service.ts           the human gate
│       ├── reservation-service.ts        stock holds, rebinds, commits
│       ├── payment-order-service.ts      server-side provider orders
│       ├── checkout-service.ts           session start + callback verification
│       ├── webhook-service.ts            provider event reconciliation
│       ├── retry-service.ts              bounded retry and re-quote
│       ├── refund-service.ts             refunds: once, server-derived, reconciled
│       ├── rate-limit-service.ts         abuse and cost ceilings (PostgreSQL)
│       ├── audit-service.ts              structured audit writing
│       ├── passport-service.ts           safety passport rows, read-only
│       ├── agent-request-log.ts          one structured row per agent request
│       ├── merchant-insights-service.ts  the merchant dashboard's read model
│       ├── purchase-history-service.ts   current state of remembered purchases
│       ├── transaction-creation-service.ts the ONLY creator of Transaction rows
│       ├── transition-service.ts         the ONLY writer of Transaction.status
│       └── transaction-overview-service.ts the read model the pages render
├── tests/
│   ├── unit/                   everything that needs no database, run in parallel
│   ├── db/                     integration suites against local PostgreSQL
│   └── support/                fakes + the offline guard
├── .env.example                tracked, credential-free template
├── .gitattributes              line endings for the .sh and .bat entry points
├── .nvmrc                      Node.js 24 LTS selection
├── LICENSE                     MIT
├── eslint.config.mjs           lint rules incl. the process.env ban
├── next.config.ts              security headers
├── package.json                scripts, dependencies and the Prettier settings
├── tsconfig.json               strict settings
├── setup.sh / setup.bat        one-click setup (macOS, Linux / Windows)
└── run_dashboard.bat           starts the app, opens the browser when ready, Esc stops (Windows)
```

## What is left in the root, and why

Only files a tool insists on finding there, or a person is meant to run:

| File                                             | Why it cannot move                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`, `package-lock.json`              | npm reads them from the project root.                                                                                              |
| `tsconfig.json`, `next.config.ts`                | Next.js loads both from the root, and writes `next-env.d.ts` there (not configurable).                                             |
| `eslint.config.mjs`                              | ESLint, and every editor's ESLint integration, look for the flat config in the root only.                                          |
| `.gitignore`, `.gitattributes`, `.nvmrc`         | Git and Node version managers read them from the root.                                                                             |
| `.env.example`                                   | Sits beside the `.env.local` it is copied to, which Next.js loads from the root.                                                   |
| `README.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md` | GitHub renders the first and detects the second; `next dev` rewrites `AGENTS.md` in place; assistants read the last two from here. |
| `setup.sh`, `setup.bat`, `run_dashboard.bat`     | Entry points meant to be double-clicked or run first, so they are where a person looks.                                            |

The Prisma and Vitest configs and the compose file live in `.config/`, and the
Prettier settings in `package.json`.

## What Git ignores

Four generated things and the secrets, and nothing else that exists in a working
copy:

| Path                                   | What produces it                                          |
| -------------------------------------- | --------------------------------------------------------- |
| `node_modules/`                        | `npm install`. It also holds the tool caches (`.cache/`). |
| `.next/`                               | `npm run dev` and `npm run build`.                        |
| `src/generated/`                       | `prisma generate`, run by `npm install`.                  |
| `coverage/`                            | `npm run test:coverage`.                                  |
| `next-env.d.ts`                        | Next.js, on every `dev`, `build` and `typegen`.           |
| `.env.local`, `.env.development.local` | You. They hold real keys and the local database address.  |

## Why each area exists

| Area                      | Reason it is a boundary                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                | The delivery layer. UI and route handlers, nothing else. Business logic here would make the rules untestable without a server and unreachable from anything but HTTP.                                                                                      |
| `src/lib/env.ts`          | The single reader of the environment. Isolating it makes "no secret required to boot" a checkable property and stops ad-hoc `process.env` access spreading.                                                                                                |
| `src/domain/`             | The financial core: pure, dependency-free, exhaustively testable. This is where the invariants live. It imports nothing that could pull in a framework, a provider, or a network call.                                                                     |
| `src/domain/transaction/` | Its own folder because the lifecycle has three genuinely separate concerns — the vocabulary (`states`), the policy (`transitions`), and the adjudicator (`state-machine`) — and the transition table is data a reviewer should be able to read on its own. |
| `src/services/`           | The application services. Flat on purpose: every file is named for the one thing it does, so there is nothing a subfolder would add but a longer import.                                                                                                   |
| `src/integrations/`       | The adapters. Vendor names (Gemini, Razorpay, Prisma) appear here and nowhere above it.                                                                                                                                                                    |
| `src/lib/`                | Cross-cutting primitives used by more than one layer. **Not a `utils.ts` dumping ground**: each file has one named responsibility, and anything domain-specific belongs in `domain/`.                                                                      |
| `prisma/`                 | Prisma's own convention: schema, migrations and seed together. Migrations are committed - they are reviewable schema history, not build output.                                                                                                            |
| `scripts/`                | Standalone Node CLI tooling that runs outside the Next.js runtime. Deliberately not in `src/`, because it is not part of the application.                                                                                                                  |
| `src/generated/`          | Build artifact from `prisma generate`. Git-ignored, lint-ignored, regenerated by `postinstall`.                                                                                                                                                            |
| `tests/`                  | Kept out of `src/` so the shipped surface is obvious and the test runner needs no exclusion rules.                                                                                                                                                         |
| `docs/`                   | The design record. It is the artefact that lets a later session continue without redesigning.                                                                                                                                                              |

## Where each module lives

Every module named in [02 — Architecture](./02-architecture.md) is implemented.
This is where each one is:

| Module                        | Home                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| Buyer Agent                   | `src/services/buyer-agent-service.ts`, `catalog-tools.ts`             |
| AI Provider Adapter           | `src/integrations/ai-provider.ts`, `gemini-provider.ts`               |
| Merchant Service + Catalog    | `src/services/catalog-service.ts`, `catalog-repository.ts`            |
| Product Decision Engine       | `src/services/product-decision-service.ts`                            |
| PurchaseQuote service         | `src/services/quote-service.ts`                                       |
| Policy / Authorization Engine | `src/domain/policy/`, `src/services/policy-service.ts`                |
| Human Approval Gate           | `src/services/approval-service.ts`                                    |
| Inventory reservation         | `src/services/reservation-service.ts`                                 |
| Transaction Service           | `src/services/transition-service.ts`                                  |
| Transaction State Machine     | `src/domain/transaction/`                                             |
| Payment Provider Interface    | `src/domain/payment/provider.ts`                                      |
| Razorpay adapter              | `src/integrations/razorpay-provider.ts`                               |
| Webhook handling              | `src/services/webhook-service.ts`                                     |
| Refunds                       | `src/domain/refund.ts`, `src/services/refund-service.ts`              |
| Rate limits                   | `src/domain/rate-limit.ts`, `src/services/rate-limit-service.ts`      |
| Merchant insights             | `src/domain/insights.ts`, `src/services/merchant-insights-service.ts` |
| Audit Service                 | `src/services/audit-service.ts`                                       |
| Safety Passport               | `src/domain/safety-passport.ts`, `src/services/passport-service.ts`   |
| Persistence (Prisma/Postgres) | `src/integrations/prisma-client.ts`                                   |
| UI components                 | `src/components/`                                                     |

The policy engine lives in `src/domain/` rather than `src/services/` because it
is pure: no database, no network, no clock, no model. That placement is the
security property, not a filing preference.

## Rules that keep it clean

- No source files in the repository root.
- No folder for a single file.
- No business logic in UI components.
- Payment logic never mixes with agent logic, and the agent has no dependency
  edge to the Razorpay adapter.
- Policy logic never lives in a route handler; handlers call one service.
- Database access is confined to `src/integrations/prisma-client.ts`,
  server-only. No Prisma import in a React component or anywhere under `app/`
  except through a service. A `typeof window` guard enforces this at runtime,
  and the built client bundle is checked for database host, credential and
  Prisma symbols.
- No second Prisma client, no `db2.ts`, no `prismaHelper.ts`, and no generic
  repository framework. The connection is centralised; nothing else is.
- **No module may assign `Transaction.status` directly.** Every lifecycle change
  goes through `applyTransactionEvent`, and every new transaction through
  `createTransaction`. There is no `setTransactionStatus`, and none may be added.
  Both boundaries are enforced by ESLint. See
  [17](./17-transaction-state-machine.md).
- **No route handler returns a Prisma row.** Responses are mapped through an
  explicit DTO, so exposing a column is a decision rather than a side effect.
  See [18](./18-agent-readable-catalog.md).
- No vendor name in `src/domain/`. A test asserts the state machine's actors
  contain no payment brand.
- No `utils.ts`. A file is named for what it owns.
- No duplicate type definitions: a type lives with the module that owns it and
  is imported, never re-declared.
- Path alias `@/*` is configured once in `tsconfig.json` and reused by Vitest.
