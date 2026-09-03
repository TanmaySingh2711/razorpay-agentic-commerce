# 01 — Overview

## What this is

An entry for the **Razorpay AI Buildathon 2026, Track 01 — AI Growth & Agentic
Commerce**.

The finished system lets a person say:

> "Find me the best mechanical keyboard under ₹3000 and buy it."

and have an AI buyer agent complete that purchase against a merchant that is
transactable end to end by an agent — with every financial action explainable,
bounded, gated and auditable, and with at least one failure path handled
gracefully rather than swallowed.

## Locked architecture decisions

These are final for the project. Later objectives build on them; they are not
re-opened.

| Area            | Decision                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Application     | Next.js App Router, **modular monolith** - one deployable application with hard internal module boundaries. Explicitly **not** microservices.   |
| Language        | TypeScript, strict.                                                                                                                             |
| Runtime         | **Node.js 24 LTS** (`engines` in `package.json`, `.nvmrc`).                                                                                     |
| Package manager | npm.                                                                                                                                            |
| Database        | **PostgreSQL**, authoritative. No SQLite tier, and no planned late migration - development and deployment share the same database architecture. |
| Data access     | **Prisma ORM**, server-only. Local development and tests use Docker PostgreSQL; the deployment uses Neon PostgreSQL.                            |
| AI              | Google Gemini behind a dedicated **AI Provider Adapter**. The domain never sees a Gemini response object.                                       |
| Payments        | Razorpay behind a dedicated **Payment Provider Interface**. The domain never sees a Razorpay SDK object.                                        |

Persistence arrives in Objective 2; the AI and payment integrations arrive
later still. Objective 1 fixes the boundaries, not the implementations.

## The one rule

> **LLM can propose. Deterministic code authorizes. Payment infrastructure executes.**
>
> **No LLM output can directly cause a payment.**

Expressed as a pipeline:

```
AI proposes  →  deterministic systems validate  →  authorization gates  →  payment infrastructure executes
```

Everything else in this repository — the module boundaries, the state machine,
the money type, the error taxonomy — exists to make that sentence true in code
rather than in a README.

### What the AI may do

Interpret natural language and intent. Search through approved, controlled tool
interfaces. Rank and compare _valid_ products. Recommend one. Propose an
action. Produce a concise, structured explanation of its proposal.

### What the AI may never do

Create or alter an authoritative product price. Modify inventory. Override a
spending limit. Change an authorization policy. Approve its own request.
Determine the final payable amount. Call payment infrastructure unrestricted.
Mark a payment successful. Mutate authoritative transaction state. Bypass any
deterministic control.

## Authoritative data sources

Each concern has exactly one source of truth. Nothing else may supply it.

| Concern              | Authoritative source                                         |
| -------------------- | ------------------------------------------------------------ |
| Price                | Server / PostgreSQL only                                     |
| Inventory            | Server / PostgreSQL only                                     |
| Currency             | Server / PostgreSQL only                                     |
| Authorization policy | Server / PostgreSQL + the deterministic policy layer only    |
| Transaction state    | The server-side transaction state machine only               |
| Payment status       | Verified server-side payment data or a verified webhook only |

Six paths the architecture must never permit:

| Forbidden path                   | Blocked by                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| browser → authoritative price    | Merchant Service re-reads the product; caller fields other than the id are discarded |
| LLM → authoritative price        | same; the agent's claimed price never leaves the proposal                            |
| browser → payment amount         | the amount comes from the PurchaseQuote, never from a request body                   |
| LLM → payment amount             | the model has no amount field in any schema it produces                              |
| browser → payment-success status | capture is asserted only by a verified signature or webhook                          |
| LLM → transaction-success status | AI actors hold one transition edge, and it is not a payment edge                     |

## The invariants

These are assumed by every module and are not open for local re-litigation.

| #   | Invariant                                                              |
| --- | ---------------------------------------------------------------------- |
| 1   | Client input is untrusted.                                             |
| 2   | LLM output is untrusted.                                               |
| 3   | Product descriptions are untrusted agent input.                        |
| 4   | Product price source of truth is server-side.                          |
| 5   | Inventory source of truth is server-side.                              |
| 6   | Authorization is deterministic.                                        |
| 7   | Payment amount cannot come from the browser.                           |
| 8   | Payment amount cannot come from the LLM.                               |
| 9   | Payment success cannot be trusted from the frontend alone.             |
| 10  | Razorpay and webhook events require verification.                      |
| 11  | Duplicate external events must be handled idempotently.                |
| 12  | Transaction state is controlled server-side.                           |
| 13  | AI cannot directly mutate transaction state.                           |
| 14  | AI cannot approve itself.                                              |
| 15  | Financial decisions must carry structured explanations.                |
| 16  | Audit records exclude secrets and hidden chain-of-thought.             |
| 17  | All external integrations sit behind adapters.                         |
| 18  | Money is integer minor units with an explicit currency. Never a float. |

Invariant 18 is enforced by the type system today: see
[`src/domain/money.ts`](../src/domain/money.ts). Invariants 13 and 14 are
enforced by the transition table in
[`src/domain/transaction/transitions.ts`](../src/domain/transaction/transitions.ts).
