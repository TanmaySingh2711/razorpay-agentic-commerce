# razorpay-agentic-commerce

**Razorpay AI Buildathon 2026 · Track 01 — AI Growth & Agentic Commerce**

A merchant that an AI buyer agent can transact with end to end, where every
financial action is explainable, bounded, gated and auditable.

The flow: a person says _"Find me the best mechanical keyboard under ₹3000 and
buy it"_, and an agent completes that purchase — without ever being trusted with
the money.

## Try it now — no setup required

**Live demo: https://razorpay-agentic-commerce-xi.vercel.app**

The whole flow runs there against a real, hosted database and real Razorpay
**Test Mode** — no real money moves, ever; the app refuses to start the payment
path with anything but a `rzp_test_…` key. To go all the way to a completed
payment, click Pay at checkout and choose any test payment method — Razorpay's
own Test Mode Checkout screen shows exactly what to enter, no account or real
card needed.

No clone, no `npm install`, no API keys, no database to run — this link alone
is enough to review the project end to end. Cloning and running it locally
(below) is only for inspecting or modifying the code itself.

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
state. Not because it is instructed not to — because it has no tool, no
parameter and no state-machine edge through which it could.

## What is implemented

The full purchase lifecycle works end to end, and has been exercised against the
deployed environment with **real Razorpay Test Mode payments** — including a
genuine bank decline, a controlled retry, a successful capture, and a duplicate
webhook redelivery that correctly changed nothing.

| Area                            | State                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Buyer agent                     | Bounded orchestration over Gemini behind a provider-neutral adapter                  |
| Agent-readable catalog          | Deterministic filtering, read-only tools, budget in minor units                      |
| Trusted `PurchaseQuote`         | The one place a payable amount originates                                            |
| Deterministic policy engine     | Pure function → `ALLOWED` / `APPROVAL_REQUIRED` / `BLOCKED`                          |
| Human approval gate             | One-time, exactly bound, hashed token, replay-protected                              |
| Inventory reservation           | Stock held before money moves; oversell prevented by database constraints            |
| Payment order + Checkout        | Server-side amount only, Razorpay **Test Mode** only                                 |
| Callback + webhook verification | Two separate facts; provider truth is authoritative                                  |
| Capture, commit, completion     | Inventory committed exactly once, transaction completed exactly once                 |
| Controlled retry + re-quote     | Bounded to 3 attempts; a stale quote is re-quoted against fresh facts, never revived |
| Structured audit trail          | Reason codes and deterministic facts; no secrets, no chain-of-thought                |
| PostgreSQL + Prisma             | Authoritative store; invariants held by CHECK constraints and unique indexes         |

**No real money moves.** The configuration boundary refuses any Razorpay key id
that is not `rzp_test_…`, so a live key fails closed rather than quietly working.

## Documentation

Start with **[28 — Final architecture](./docs/28-final-architecture.md)**: the
whole system in one document, with the architecture diagram, the trust
boundaries, the price flow, the state machine, the retry design, and an index
that maps a reviewer's questions to where they are answered.

Then [`docs/README.md`](./docs/README.md) for the full set.

## Getting started

Requires **Node.js 24 LTS** (`.nvmrc` and `engines` both pin it), npm, and
Docker for the local database.

```bash
nvm use              # optional, reads .nvmrc
npm install
npm run db:test:up   # start the local Docker PostgreSQL
npm run db:dev:setup # create, migrate and seed razorpay_agentic_dev
npm run dev          # http://localhost:3000
```

**No API key or secret is required to boot.** The application starts, builds and
runs its non-provider tests against an entirely empty environment — asserted by
a test. Gemini and Razorpay configuration is validated lazily, at the moment the
feature that needs it runs.

To run the database test suite as well:

```bash
npm run db:test:setup   # prepare the isolated, disposable test schema
npm run verify          # typecheck + lint + test + build, all local
```

Which database each command reaches is decided by the command's own name: plain
`db:*` names target the local development database, `db:test:*` the disposable
test one, and only the explicit `db:*:staging` commands reach the hosted
database. Every one of them refuses the wrong target before it connects.

| Environment       | Database                                 |
| ----------------- | ---------------------------------------- |
| Local development | Docker PostgreSQL (`docker-compose.yml`) |
| Automated tests   | Docker PostgreSQL, disposable schema     |
| Vercel deployment | Neon PostgreSQL                          |
| ORM everywhere    | Prisma                                   |

Copy [`.env.example`](./.env.example) to `.env.local` only when you need to
reach the hosted database or the external providers. It contains placeholders
only — no real credential is ever committed to this repository, and that is
deliberate rather than an oversight: a `Gemini` key and a `Razorpay` key are
each free to obtain in a couple of minutes (Google AI Studio, Razorpay
Dashboard Test Mode) if you want to run the buyer agent or a payment locally,
but for reviewing the project the [live demo above](#try-it-now--no-setup-required)
needs none of that.

## Scripts

| Command                | Does                                                    |
| ---------------------- | ------------------------------------------------------- |
| `npm run dev`          | Development server                                      |
| `npm run build`        | Production build                                        |
| `npm start`            | Serve the production build                              |
| `npm run typecheck`    | Route typegen + `tsc --noEmit`                          |
| `npm run lint`         | ESLint                                                  |
| `npm run test`         | Vitest                                                  |
| `npm run format:check` | Prettier check (deliberately not part of `verify`)      |
| `npm run verify`       | typecheck + lint + test + build — entirely local        |
| `npm run db:*`         | Database tooling — see [docs/16](./docs/16-database.md) |
| `npm run *:smoke`      | Deliberate external checks; never run by `verify`       |

Automated verification never calls Gemini, Razorpay, Vercel or the hosted
database — a Vitest setup file blocks non-loopback `fetch` to enforce it.

## Stack

A **modular monolith** — one Next.js application, one deployable unit, one
database, with hard internal module boundaries. Explicitly not microservices.

| Layer              | Choice                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| App                | Next.js 16 (App Router), React 19                                         |
| Language           | TypeScript 5, strict                                                      |
| Runtime            | Node.js 24 LTS, npm                                                       |
| Database           | PostgreSQL (authoritative) via Prisma ORM — Docker locally, Neon deployed |
| AI                 | Google Gemini behind a provider-neutral AI Provider Adapter               |
| Payments           | Razorpay **Test Mode** behind a Payment Provider Interface                |
| Validation / tests | Zod, Vitest, ESLint, Prettier                                             |

No agent framework, no AI SDK, no payment SDK, no state-management library.
