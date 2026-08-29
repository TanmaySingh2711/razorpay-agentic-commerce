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

## The one rule

> **No LLM output can directly cause a payment.**

Expressed as a pipeline:

```
AI proposes  →  deterministic systems validate  →  authorization gates  →  payment infrastructure executes
```

Everything else in this repository — the module boundaries, the state machine,
the money type, the error taxonomy — exists to make that sentence true in code
rather than in a README.

### What the AI may do

Interpret natural language, understand intent, search through approved tool
interfaces, compare products, recommend one, propose an action, and produce a
short structured explanation of its proposal.

### What the AI may never do

Invent a payment amount. Alter an authoritative price. Modify an authorization
policy. Approve its own financial action. Decide whether a payment is
permitted. Mark a payment successful. Mutate authoritative transaction state.
Bypass any deterministic control.

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
