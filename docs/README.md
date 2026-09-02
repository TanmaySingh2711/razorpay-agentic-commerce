# Architecture documentation

This directory is the design record for `razorpay-agentic-commerce`. It is
written so that a future session can continue the build **without redesigning
the system**.

| Document                                                        | What it settles                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| [01 — Overview](./01-overview.md)                               | Project purpose, Track 01 goal, the one non-negotiable rule |
| [02 — Architecture](./02-architecture.md)                       | The eleven module boundaries and their contracts            |
| [03 — AI vs deterministic](./03-ai-vs-deterministic.md)         | What the LLM may and may not do                             |
| [04 — Transaction flow](./04-transaction-flow.md)               | End-to-end flow with trust boundaries                       |
| [05 — State machine](./05-transaction-state-machine.md)         | States, transitions, actors, idempotency                    |
| [06 — Security & trust](./06-security-and-trust-boundaries.md)  | Trust zones and the conventions per zone                    |
| [07 — API boundaries](./07-api-boundaries.md)                   | Route surface design (not built)                            |
| [08 — Data model](./08-data-model.md)                           | Entities, money representation, relationships               |
| [09 — Configuration](./09-configuration.md)                     | Environment variables and the config boundary               |
| [10 — Errors & logging](./10-errors-and-logging.md)             | Error taxonomy, log conventions                             |
| [11 — Explainability & audit](./11-explainability-and-audit.md) | Decision records and the audit trail                        |
| [12 — Testing](./12-testing.md)                                 | Test strategy and what is covered today                     |
| [13 — Repository structure](./13-repository-structure.md)       | Every directory and why it exists                           |
| [14 — Objective 1 scope](./14-objective-1-scope.md)             | What was built, what was deliberately not                   |
| [15 — Roadmap](./15-roadmap.md)                                 | Later objectives, in an order that preserves this design    |
| [26 — Staging deployment](./26-staging-deployment.md)           | The public Vercel staging environment and its variables     |

## Reading order for a new contributor

1. [01 — Overview](./01-overview.md) for the rule everything else serves.
2. [02 — Architecture](./02-architecture.md) for the map.
3. [03 — AI vs deterministic](./03-ai-vs-deterministic.md) and
   [05 — State machine](./05-transaction-state-machine.md) for the two places
   where the rule is actually enforced in code.
