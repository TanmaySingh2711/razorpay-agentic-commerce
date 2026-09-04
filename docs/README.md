# Architecture documentation

This directory is the design record for `razorpay-agentic-commerce`. It
describes the system **as it is implemented**, so a reviewer can understand the
whole thing without reading every source file, and a future session can continue
the build without redesigning it.

**Start here: [28 — Final architecture](./28-final-architecture.md).** It is the
consolidated picture — diagram, trust boundaries, price flow, state machine,
retry design — and it links onward to whichever document owns each detail.

## Foundations

| Document                                                        | What it settles                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [01 — Overview](./01-overview.md)                               | Project purpose, Track 01 goal, the one non-negotiable rule                          |
| [02 — Architecture](./02-architecture.md)                       | The module boundaries and their contracts                                            |
| [03 — AI vs deterministic](./03-ai-vs-deterministic.md)         | What the LLM may and may not do                                                      |
| [04 — Transaction flow](./04-transaction-flow.md)               | End-to-end flow with trust boundaries                                                |
| [05 — State model](./05-transaction-state-machine.md)           | The states themselves; the engine is [17](./17-transaction-state-machine.md)         |
| [06 — Security & trust](./06-security-and-trust-boundaries.md)  | Trust zones and the conventions per zone                                             |
| [07 — API boundaries](./07-api-boundaries.md)                   | The HTTP and server-action surface                                                   |
| [08 — Data model](./08-data-model.md)                           | Entities, money representation, relationships                                        |
| [09 — Configuration](./09-configuration.md)                     | Environment variables and the config boundary                                        |
| [10 — Errors & logging](./10-errors-and-logging.md)             | Error taxonomy, log conventions                                                      |
| [11 — Explainability & audit](./11-explainability-and-audit.md) | Decision-record contract; the trail itself is [23](./23-audit-and-explainability.md) |
| [13 — Repository structure](./13-repository-structure.md)       | Every directory and why it exists                                                    |

## The system, component by component

| Document                                                            | What it settles                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| [16 — Database](./16-database.md)                                   | PostgreSQL, Prisma, migrations, local vs hosted             |
| [17 — Transaction state machine](./17-transaction-state-machine.md) | The authoritative lifecycle, as implemented                 |
| [18 — Agent-readable catalog](./18-agent-readable-catalog.md)       | Deterministic filtering and the read-only tool surface      |
| [19 — Buyer agent](./19-buyer-agent.md)                             | Gemini behind the adapter, and the agent's hard limits      |
| [20 — Trusted purchase quote](./20-trusted-purchase-quote.md)       | The only place a payable amount originates                  |
| [21 — Policy engine](./21-policy-engine.md)                         | The deterministic authorization decision                    |
| [22 — Approval and inventory](./22-approval-and-inventory.md)       | The human gate and the stock hold                           |
| [23 — Audit and explainability](./23-audit-and-explainability.md)   | Structured records, reason codes, no chain-of-thought       |
| [24 — Payment order creation](./24-payment-order-creation.md)       | Server-side orders, idempotency, attempts                   |
| [25 — Checkout and verification](./25-checkout-and-verification.md) | Callback signatures, webhooks, reconciliation               |
| [26 — Staging deployment](./26-staging-deployment.md)               | The public Vercel environment and its variables             |
| [27 — Payment retry](./27-payment-retry.md)                         | Bounded human-triggered retry, and the stale-quote re-quote |
| [28 — Final architecture](./28-final-architecture.md)               | **The whole system in one document**                        |
| [29 — Safety passport](./29-safety-passport.md)                     | The deterministic reviewer summary on the transaction page  |

## Testing

| Document                        | What it settles                                          |
| ------------------------------- | -------------------------------------------------------- |
| [12 — Testing](./12-testing.md) | Test strategy, the local-only guarantee, what is covered |

## Historical record

These describe an earlier point in the build. They are kept because the
reasoning is still useful, but **they do not describe the current system** —
where they disagree with the documents above, the documents above are right.

| Document                                            | What it records                                             |
| --------------------------------------------------- | ----------------------------------------------------------- |
| [14 — Objective 1 scope](./14-objective-1-scope.md) | What the first objective did and deliberately did not build |
| [15 — Roadmap](./15-roadmap.md)                     | The order later objectives were planned in                  |

## Reading order for a new contributor

1. [28 — Final architecture](./28-final-architecture.md) for the whole picture.
2. [03 — AI vs deterministic](./03-ai-vs-deterministic.md) and
   [17 — State machine](./17-transaction-state-machine.md) for the two places
   where the rule stops being prose and becomes enforced code.
3. [20](./20-trusted-purchase-quote.md), [21](./21-policy-engine.md) and
   [22](./22-approval-and-inventory.md) for the financial controls in detail.
4. [27](./27-payment-retry.md) for the most subtle part of the lifecycle.
