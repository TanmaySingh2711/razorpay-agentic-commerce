# razorpay-agentic-commerce

**Razorpay AI Buildathon 2026 · Track 01 — AI Growth & Agentic Commerce**

A merchant that an AI buyer agent can transact with end to end, where every
financial action is explainable, bounded, gated and auditable.

The target flow: a person says _"Find me the best mechanical keyboard under
₹3000 and buy it"_, and an agent completes that purchase — without ever being
trusted with the money.

## The rule this repository is built around

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

```bash
npm install
npm run dev          # http://localhost:3000
```

**No API key or secret is required.** The foundation boots, builds and tests
against an entirely empty environment — that is asserted by a test. Copy
[`.env.example`](./.env.example) to `.env.local` only when a later objective
needs a provider.

## Scripts

| Command             | Does                            |
| ------------------- | ------------------------------- |
| `npm run dev`       | Development server              |
| `npm run build`     | Production build                |
| `npm start`         | Serve the production build      |
| `npm run typecheck` | Route typegen + `tsc --noEmit`  |
| `npm run lint`      | ESLint                          |
| `npm run test`      | Vitest                          |
| `npm run format`    | Prettier                        |
| `npm run verify`    | typecheck + lint + test + build |

## Documentation

Start with [`docs/README.md`](./docs/README.md). The two documents that carry
the most weight are
[03 — AI vs deterministic control](./docs/03-ai-vs-deterministic.md) and
[05 — Transaction state machine](./docs/05-transaction-state-machine.md), which
is where the rule above stops being prose and becomes enforced code.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript 5 (strict) · Zod · Vitest ·
ESLint · Prettier · npm.

No agent framework, no AI SDK, no payment SDK, no ORM, no state-management
library. Each arrives with the objective that needs it.
