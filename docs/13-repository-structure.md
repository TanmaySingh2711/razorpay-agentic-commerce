# 13 — Repository structure

This is a **modular monolith**: one Next.js application, one deployable unit,
one database, with hard internal boundaries. It is not to be split into
services — see [02](./02-architecture.md) for why.

Every file listed exists and does something. There are no placeholder
directories: a folder appears when its first real file does.

```
razorpay-agentic-commerce/
├── docs/                       architecture record (this directory)
├── prisma/
│   ├── migrations/             reviewable, committed schema history
│   ├── schema.prisma           the single schema definition
│   └── seed.ts                 idempotent demo seed
├── scripts/                    standalone CLI tooling, outside the app runtime
│   ├── buyer-agent-smoke.ts    one live agent run, outside npm test
│   ├── checkout-smoke-setup.ts prepares one real Test Mode checkout
│   ├── checkout-smoke-check.ts inspects the result of that checkout
│   ├── database-target-guard.ts refuses a command aimed at the wrong database
│   ├── db-verify.ts            verifies the live DB matches the design
│   ├── gemini-smoke.ts         the one live Gemini call, outside npm test
│   ├── pooled-endpoint.ts      pooled-vs-direct connection recognition
│   ├── prisma-cli.ts           the guarded entry point for every db:* script
│   ├── razorpay-smoke.ts       one live Razorpay Test Mode call
│   ├── setup-dev-database.ts   local development DB, loopback only
│   └── setup-test-schema.ts    creates + migrates the isolated test schema
├── src/
│   ├── app/                    Next.js App Router — delivery layer only
│   │   ├── actions/purchase.ts server actions the pages invoke
│   │   ├── api/buyer-agent/    AI buyer agent endpoint (handler.ts + route.ts)
│   │   ├── api/catalog/        agent-readable catalog endpoints
│   │   ├── api/health/route.ts liveness endpoint
│   │   ├── api/payments/       order, checkout, callback, retry, dismissed
│   │   │   └── handler.ts      HTTP validation + response mapping (testable)
│   │   ├── api/webhooks/razorpay/  provider webhook intake and verification
│   │   ├── checkout/[transactionId]/    the page that offers Pay
│   │   ├── transaction/[transactionId]/ the authoritative purchase view
│   │   ├── about/page.tsx      how the system works, for a reviewer
│   │   ├── globals.css         design tokens + element defaults
│   │   ├── ui.css              component styles, loaded after globals.css
│   │   ├── icon.tsx            generated tab icon (Next file convention)
│   │   ├── layout.tsx          root layout
│   │   └── page.tsx            landing page
│   ├── components/
│   │   ├── buyer/buyer-console.tsx       the shopping input
│   │   ├── payments/pay-button.tsx       the one place a person spends money
│   │   └── transaction/
│   │       ├── awaiting-provider.tsx  polls while the webhook is outstanding
│   │       ├── decision-form.tsx      approve / reject
│   │       └── safety-passport.tsx    the deterministic safety summary
│   ├── config/
│   │   └── env.ts              the ONLY reader of process.env
│   ├── generated/prisma/       generated Prisma client (git-ignored artifact)
│   ├── integrations/
│   │   ├── llm/
│   │   │   ├── gemini-provider.ts   the ONLY @google/genai importer
│   │   │   └── provider.ts          provider-neutral AiProvider port
│   │   ├── payments/
│   │   │   └── razorpay-provider.ts the ONLY Razorpay HTTP caller
│   │   └── persistence/
│   │       └── client.ts       the ONLY database entry point, server-only
│   ├── services/
│   │   ├── approval/approval-service.ts     the human gate
│   │   ├── audit/audit-service.ts           structured audit writing
│   │   ├── buyer-agent/
│   │   │   ├── buyer-agent-service.ts   agent orchestration
│   │   │   ├── catalog-reader.ts        read-only catalog port
│   │   │   ├── catalog-tools.ts         the allowlisted tool registry
│   │   │   └── instructions.ts          developer instructions
│   │   ├── inventory/reservation-service.ts stock holds, rebinds, commits
│   │   ├── merchant/
│   │   │   ├── catalog-repository.ts    the catalog's ONLY Prisma read boundary
│   │   │   └── catalog-service.ts       catalog application service
│   │   ├── payment/
│   │   │   ├── checkout-service.ts      session start + callback verification
│   │   │   ├── payment-order-service.ts server-side provider orders
│   │   │   ├── retry-service.ts         bounded retry and re-quote
│   │   │   └── webhook-service.ts       provider event reconciliation
│   │   ├── policy/
│   │   │   ├── authorization-recheck.ts re-derives authority before payment
│   │   │   ├── policy-reader.ts         the policy's Prisma read boundary
│   │   │   └── policy-service.ts        evaluation + recording
│   │   ├── product-decision/
│   │   │   └── product-decision-service.ts  AI proposal -> trusted quote
│   │   ├── quote/
│   │   │   ├── quote-reader.ts          quote read boundary
│   │   │   └── quote-service.ts         trusted quote creation + validation
│   │   ├── safety/passport-service.ts   safety passport rows, read-only
│   │   └── transaction/
│   │       ├── creation-service.ts      the ONLY creator of Transaction rows
│   │       ├── overview-service.ts      the read model the pages render
│   │       └── transition-service.ts    the ONLY writer of Transaction.status
│   ├── domain/                 pure, framework-free core
│   │   ├── approval/           token minting, hashing, binding contracts
│   │   ├── audit-event.ts      audit event contract
│   │   ├── audit/              payload schemas + human-readable explanations
│   │   ├── buyer-agent/        intent, decision, budget, validation, errors
│   │   ├── catalog/            public DTOs, bounded query contract, errors
│   │   ├── decision-record.ts  explainability contract
│   │   ├── errors.ts           error taxonomy
│   │   ├── inventory/          reservation contracts + pure rules
│   │   ├── money.ts            integer minor units + currency
│   │   ├── payment/            provider port, checkout, webhook, retry, rules
│   │   ├── policy/
│   │   │   ├── decision.ts        decision + reason-code vocabulary
│   │   │   ├── engine.ts          the deterministic engine (pure)
│   │   │   └── errors.ts          policy error types
│   │   ├── product-decision/   deterministic candidate rules (pure)
│   │   ├── quote/              contracts, errors, expiry/validity rules (pure)
│   │   ├── safety/passport.ts  the deterministic safety passport (pure)
│   │   ├── transaction/
│   │   │   ├── errors.ts          lifecycle-specific error types
│   │   │   ├── events.ts          domain events + reason codes
│   │   │   ├── state-machine.ts   the adjudicator (pure)
│   │   │   ├── states.ts          states, actors, terminal/failure sets
│   │   │   └── transitions.ts     the transition matrix
│   │   └── ui/journey.ts       what the buyer is shown at each state
│   └── lib/                    cross-cutting primitives
│       ├── api-response.ts     the shared HTTP success/error envelope
│       ├── checkout-script.ts  provider script loading, browser side
│       ├── clock.ts            injectable time, so expiry is testable
│       ├── http/same-origin.ts refuses cross-site state-changing requests
│       ├── json.ts             JSON value model
│       ├── logger.ts           structured operational logging
│       ├── redact.ts           secret and reasoning scrubbing
│       └── server-only.ts      module-scope browser-bundle guard
├── tests/                      Vitest suites, mirroring src by concern
│   ├── db/                     integration suites against local PostgreSQL
│   └── support/                fakes + the offline guard
├── .env.example                tracked, credential-free template
├── .nvmrc                      Node.js 24 LTS selection
├── docker-compose.yml          the local PostgreSQL for dev and tests
├── prisma.config.ts            Prisma 7 CLI config (direct connection)
├── eslint.config.mjs           lint rules incl. the process.env ban
├── next.config.ts
├── package.json
├── tsconfig.json               strict settings
└── vitest.config.mts
```

## Why each area exists

| Area                            | Reason it is a boundary                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                      | The delivery layer. UI and route handlers, nothing else. Business logic here would make the rules untestable without a server and unreachable from anything but HTTP.                                                                                      |
| `src/config/`                   | The single reader of the environment. Isolating it makes "no secret required to boot" a checkable property and stops ad-hoc `process.env` access spreading.                                                                                                |
| `src/domain/`                   | The financial core: pure, dependency-free, exhaustively testable. This is where the invariants live. It imports nothing that could pull in a framework, a provider, or a network call.                                                                     |
| `src/domain/transaction/`       | Its own folder because the lifecycle has three genuinely separate concerns — the vocabulary (`states`), the policy (`transitions`), and the adjudicator (`state-machine`) — and the transition table is data a reviewer should be able to read on its own. |
| `src/lib/`                      | Cross-cutting primitives used by more than one layer. **Not a `utils.ts` dumping ground**: each file has one named responsibility, and anything domain-specific belongs in `domain/`.                                                                      |
| `prisma/`                       | Prisma's own convention: schema, migrations and seed together. Migrations are committed - they are reviewable schema history, not build output.                                                                                                            |
| `scripts/`                      | Standalone Node CLI tooling that runs outside the Next.js runtime. Deliberately not in `src/`, because it is not part of the application.                                                                                                                  |
| `src/integrations/persistence/` | The single server-only database boundary. One client, one connection strategy, no `pg` usage anywhere else.                                                                                                                                                |
| `src/generated/`                | Build artifact from `prisma generate`. Git-ignored, lint-ignored, regenerated by `postinstall`.                                                                                                                                                            |
| `tests/`                        | Kept out of `src/` so the shipped surface is obvious and the test runner needs no exclusion rules.                                                                                                                                                         |
| `docs/`                         | The design record. It is the artefact that lets a later session continue without redesigning.                                                                                                                                                              |

## Where each module lives

Every module named in [02 — Architecture](./02-architecture.md) is implemented.
This is where each one is:

| Module                        | Home                                         |
| ----------------------------- | -------------------------------------------- |
| Buyer Agent                   | `src/services/buyer-agent/`                  |
| AI Provider Adapter           | `src/integrations/llm/`                      |
| Merchant Service + Catalog    | `src/services/merchant/`                     |
| Product Decision Engine       | `src/services/product-decision/`             |
| PurchaseQuote service         | `src/services/quote/`                        |
| Policy / Authorization Engine | `src/domain/policy/`, `src/services/policy/` |
| Human Approval Gate           | `src/services/approval/`                     |
| Inventory reservation         | `src/services/inventory/`                    |
| Transaction Service           | `src/services/transaction/`                  |
| Transaction State Machine     | `src/domain/transaction/`                    |
| Payment Provider Interface    | `src/domain/payment/provider.ts`             |
| Razorpay adapter              | `src/integrations/payments/`                 |
| Webhook handling              | `src/services/payment/webhook-service.ts`    |
| Audit Service                 | `src/services/audit/`                        |
| Safety Passport               | `src/domain/safety/`, `src/services/safety/` |
| Persistence (Prisma/Postgres) | `src/integrations/persistence/`              |
| UI components                 | `src/components/`                            |

The policy engine lives in `src/domain/` rather than `src/services/` because it
is pure: no database, no network, no clock, no model. That placement is the
security property, not a filing preference.

## Rules that keep it clean

- No source files in the repository root.
- No business logic in UI components.
- Payment logic never mixes with agent logic — separate top-level modules, and
  the agent has no dependency edge to the Razorpay adapter.
- Policy logic never lives in a route handler; handlers call one service.
- Database access is confined to `src/integrations/persistence/`, server-only.
  No Prisma import in a React component or anywhere under `app/` except through
  a service. A `typeof window` guard enforces this at runtime, and the built
  client bundle is checked for database host, credential and Prisma symbols.
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
