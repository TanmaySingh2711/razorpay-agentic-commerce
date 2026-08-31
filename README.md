# razorpay-agentic-commerce

**Razorpay AI Buildathon 2026 · Track 01 — AI Growth & Agentic Commerce**

A merchant that an AI buyer agent can transact with end to end, where every
financial action is explainable, bounded, gated and auditable.

The target flow: a person says _"Find me the best mechanical keyboard under
₹3000 and buy it"_, and an agent completes that purchase — without ever being
trusted with the money.

## The rule this repository is built around

> **LLM can propose. Deterministic code authorizes. Payment infrastructure executes.**
>
> **No LLM output can directly cause a payment.**

```
AI proposes  →  deterministic systems validate  →  authorization gates  →  payment infrastructure executes
```

The AI may interpret language, compare products and recommend one. It may not
invent an amount, alter a price, change a policy, approve its own action, decide
that a payment is permitted, mark a payment successful, or mutate transaction
state.

## Status

**Objective 1 — foundation and architecture. Complete.**

What exists: a strict-TypeScript Next.js application, the pure financial core
(money as integer minor units, the typed transaction state machine, error,
decision and audit contracts), a typed configuration boundary, structured
logging with redaction, a health endpoint, and the full architecture record in
[`docs/`](./docs).

What does not exist yet, deliberately: the buyer agent, any LLM call, the
catalog, the policy engine, the approval gate, Razorpay, webhooks, and the
database. See [docs/14](./docs/14-objective-1-scope.md) for the exact line, and
[docs/15](./docs/15-roadmap.md) for the order they arrive in.

## Getting started

Requires **Node.js 24 LTS** (`.nvmrc` and `engines` both pin it) and npm.

```bash
nvm use              # optional, reads .nvmrc
npm install
npm run dev          # http://localhost:3000
```

**No API key or secret is required to boot.** The application starts, builds and
runs its foundation tests against an entirely empty environment — asserted by a
test. Copy [`.env.example`](./.env.example) to `.env.local` and fill in
`DATABASE_URL` / `DIRECT_URL` to enable the database layer.

```bash
npm run db:migrate:deploy   # apply the schema
npm run db:seed             # idempotent demo catalog
npm run db:verify           # confirm the live DB matches the design
npm run db:test:setup       # prepare the isolated test schema
```

## Scripts

| Command             | Does                                                    |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | Development server                                      |
| `npm run build`     | Production build                                        |
| `npm start`         | Serve the production build                              |
| `npm run typecheck` | Route typegen + `tsc --noEmit`                          |
| `npm run lint`      | ESLint                                                  |
| `npm run test`      | Vitest                                                  |
| `npm run format`    | Prettier                                                |
| `npm run verify`    | typecheck + lint + test + build                         |
| `npm run db:*`      | Database tooling — see [docs/16](./docs/16-database.md) |

## Documentation

Start with [`docs/README.md`](./docs/README.md). The two documents that carry
the most weight are
[03 — AI vs deterministic control](./docs/03-ai-vs-deterministic.md) and
[05 — Transaction state machine](./docs/05-transaction-state-machine.md), which
is where the rule above stops being prose and becomes enforced code.

## Stack

A **modular monolith** — one Next.js application, one deployable unit, one
database, with hard internal module boundaries. Explicitly not microservices.

| Layer              | Choice                                                            |
| ------------------ | ----------------------------------------------------------------- |
| App                | Next.js 16 (App Router), React 19                                 |
| Language           | TypeScript 5, strict                                              |
| Runtime            | Node.js 24 LTS, npm                                               |
| Database           | PostgreSQL (authoritative), Prisma ORM — **from Objective 2**     |
| AI                 | External provider behind an AI Provider Adapter — later objective |
| Payments           | Razorpay behind a Payment Provider Interface — later objective    |
| Validation / tests | Zod, Vitest, ESLint, Prettier                                     |

No agent framework, no AI SDK, no payment SDK, no state-management library.
Each arrives with the objective that needs it.
