# 13 — Repository structure

This is a **modular monolith**: one Next.js application, one deployable unit,
one database, with hard internal boundaries. It is not to be split into
services — see [02](./02-architecture.md) for why.

Every file listed exists and does something. There are no placeholder
directories: a folder appears when its first real file does. The homes for
future modules are named here so they land in the right place without being
pre-created as empty shells.

```
razorpay-agentic-commerce/
├── docs/                       architecture record (this directory)
├── prisma/
│   ├── schema.prisma           the database schema (single source of DDL)
│   ├── migrations/             reviewable, committed schema history
│   └── seed.ts                 idempotent demo seed
├── scripts/
│   ├── db-verify.ts            verifies the live DB matches the design
│   ├── gemini-smoke.ts         the one live Gemini call, outside npm test
│   └── setup-test-schema.ts    creates + migrates the isolated test schema
├── src/
│   ├── app/                    Next.js App Router — delivery layer only
│   │   ├── api/buyer-agent/    AI buyer agent endpoint (handler.ts + route.ts)
│   │   ├── api/catalog/        agent-readable catalog endpoints
│   │   │   ├── handlers.ts     HTTP validation + response mapping (testable)
│   │   │   ├── merchant/route.ts
│   │   │   └── products/route.ts, products/[productId]/route.ts
│   │   ├── api/health/route.ts liveness endpoint
│   │   ├── globals.css         minimal foundation styling
│   │   ├── layout.tsx          root layout
│   │   └── page.tsx            foundation landing page
│   ├── config/
│   │   └── env.ts              the ONLY reader of process.env
│   ├── generated/prisma/       generated Prisma client (git-ignored artifact)
│   ├── integrations/
│   │   ├── llm/
│   │   │   ├── gemini-provider.ts  the ONLY @google/genai importer
│   │   │   └── provider.ts         provider-neutral AiProvider port
│   │   └── persistence/
│   │       └── client.ts       the ONLY database entry point, server-only
│   ├── services/
│   │   ├── buyer-agent/
│   │   │   ├── buyer-agent-service.ts  agent orchestration
│   │   │   ├── catalog-reader.ts       read-only catalog port
│   │   │   ├── catalog-tools.ts        the allowlisted tool registry
│   │   │   └── instructions.ts         developer instructions
│   │   ├── merchant/
│   │   │   ├── catalog-repository.ts  the catalog's ONLY Prisma read boundary
│   │   │   └── catalog-service.ts     catalog application service
│   │   ├── product-decision/
│   │   │   └── product-decision-service.ts  AI proposal -> trusted quote
│   │   ├── quote/
│   │   │   └── quote-service.ts       trusted quote creation + validation
│   │   └── transaction/
│   │       ├── creation-service.ts    the ONLY creator of Transaction rows
│   │       └── transition-service.ts  the ONLY writer of Transaction.status
│   ├── domain/                 pure, framework-free core
│   │   ├── audit-event.ts      audit event contract
│   │   ├── buyer-agent/
│   │   │   ├── budget.ts          deterministic budget provenance checks
│   │   │   ├── decision.ts        BuyerAgentDecision union + reason codes
│   │   │   ├── errors.ts          AI provider + agent error taxonomy
│   │   │   ├── intent.ts          structured purchase intent schema
│   │   │   └── validation.ts      the deterministic selection gate
│   │   ├── catalog/
│   │   │   ├── contracts.ts       public product/merchant DTOs
│   │   │   ├── errors.ts          catalog error types
│   │   │   └── query.ts           the bounded, validated query contract
│   │   ├── decision-record.ts  explainability contract
│   │   ├── errors.ts           error taxonomy
│   │   ├── identifiers.ts      branded id types
│   │   ├── money.ts            integer minor units + currency
│   │   ├── product-decision/
│   │   │   └── eligibility.ts     deterministic candidate rules (pure)
│   │   ├── quote/
│   │   │   ├── contracts.ts       decision result union
│   │   │   ├── errors.ts          quote error types
│   │   │   └── rules.ts           expiry, validity, invalidation (pure)
│   │   └── transaction/
│   │       ├── errors.ts          lifecycle-specific error types
│   │       ├── events.ts          domain events + reason codes
│   │       ├── state-machine.ts   the adjudicator (pure)
│   │       ├── states.ts          states, actors, terminal/failure sets
│   │       └── transitions.ts     the transition matrix
│   └── lib/                    cross-cutting primitives
│       ├── api-response.ts     the shared HTTP success/error envelope
│       ├── clock.ts            injectable time, so expiry is testable
│       ├── json.ts             JSON value model
│       ├── logger.ts           structured operational logging
│       ├── redact.ts           secret and reasoning scrubbing
│       ├── result.ts           Result<T, E>
│       └── server-only.ts      module-scope browser-bundle guard
├── tests/                      Vitest suites, mirroring src by concern
├── .env.example                tracked, credential-free template
├── .nvmrc                      Node.js 24 LTS selection
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

## Where future modules go

Created when their first real file is written, not before:

| Module                        | Home                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| Buyer Agent                   | `src/services/buyer-agent/` - **built**                    |
| Merchant Service + Catalog    | `src/services/merchant/` - **catalog built**               |
| Product Decision Engine       | `src/services/product-decision/` - **built**               |
| Policy / Authorization Engine | `src/domain/policy/` (pure, so it belongs in the core)     |
| Human Approval Gate           | `src/services/approval/`                                   |
| Transaction Service           | `src/services/transaction/` - **transition service built** |
| Audit Service                 | `src/services/audit/`                                      |
| Payment Provider Interface    | `src/integrations/payment/`                                |
| Razorpay adapter              | `src/integrations/payment/razorpay/`                       |
| AI Provider Adapter           | `src/integrations/llm/` - **Gemini adapter built**         |
| Persistence (Prisma/Postgres) | `src/integrations/persistence/` - **built**                |
| PurchaseQuote service         | `src/services/quote/` - **built**                          |
| Inventory reservation         | `src/services/inventory/`                                  |
| UI components                 | `src/components/`                                          |

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
