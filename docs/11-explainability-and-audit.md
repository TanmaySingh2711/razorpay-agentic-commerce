# 11 — Explainability and audit

Contracts implemented:
[`decision-record.ts`](../src/domain/decision-record.ts),
[`audit-event.ts`](../src/domain/audit-event.ts). The services that write them
are not.

## Explainability is not chain-of-thought

The system never captures, stores, or displays hidden model reasoning. That is a
design decision, not a limitation:

- it is unverified text — the model's narration need not describe what actually
  determined the outcome;
- it is unbounded, and would leak prompt internals into a financial record;
- it is injectable — catalog text a merchant controls could end up narrating a
  purchase;
- most of the consequential decisions are made by **deterministic code**, which
  has no chain-of-thought to show, and those are exactly the decisions a user
  most needs explained.

Instead, every consequential decision emits a small, fixed, machine-checkable
**decision record**.

## The decision record contract

| Field           | Meaning                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisionId`    | Identity of this decision.                                                                                                                                                                            |
| `transactionId` | The transaction it belongs to.                                                                                                                                                                        |
| `decisionType`  | `intent_interpretation`, `product_selection`, `product_verification`, `policy_evaluation`, `approval_decision`, `payment_authorization`, `payment_execution`, `state_transition`, `failure_handling`. |
| `actor`         | The component that decided.                                                                                                                                                                           |
| `inputs`        | The specific values the decision turned on — flat, bounded, never a raw payload.                                                                                                                      |
| `ruleApplied`   | The deterministic rule id, or `null` for AI-domain decisions.                                                                                                                                         |
| `result`        | `selected`, `verified`, `allowed`, `requires_approval`, `blocked`, `failed`.                                                                                                                          |
| `reason`        | One concise, user-safe sentence. **Capped at 400 characters.**                                                                                                                                        |
| `occurredAt`    | UTC ISO-8601.                                                                                                                                                                                         |

The cap is structural, not stylistic: it makes dumping reasoning into an
audit-visible field impossible rather than discouraged. A test asserts it.

`AI_OWNED_DECISION_TYPES` names the only two types an AI component may own —
`intent_interpretation` and `product_selection`. Everything else must carry a
`ruleApplied`, because everything else was decided by deterministic code.

### The five questions the system must answer

| Question                         | Decision type                                | Example reason                                                             |
| -------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| Why was this product selected?   | `product_selection`                          | "Highest rated mechanical keyboard in the catalog under the ₹3000 budget." |
| Why was this payment allowed?    | `policy_evaluation`                          | "Verified price ₹2999.00 is within the ₹3000.00 budget for this intent."   |
| Why was human approval required? | `policy_evaluation`                          | "Amount ₹2999.00 exceeds the ₹2000.00 auto-approval threshold."            |
| Why was this blocked?            | `policy_evaluation` / `product_verification` | "Verified price ₹3499.00 exceeds the ₹3000.00 budget."                     |
| Why did this fail?               | `failure_handling`                           | "Payment attempt was declined by the issuing bank."                        |

## The audit trail

A different system from the operational log — see
[10](./10-errors-and-logging.md) for the contrast. Audit events are a product
feature: durable, ordered, append-only, and sufficient on their own to
reconstruct a transaction end to end.

| Field           | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `eventId`       | Identity of this event.                                            |
| `transactionId` | The transaction it reconstructs.                                   |
| `eventType`     | A closed vocabulary (below).                                       |
| `actor`         | Which component acted.                                             |
| `occurredAt`    | UTC ISO-8601, ordered per transaction.                             |
| `result`        | `success` \| `failure` \| `blocked` \| `pending`.                  |
| `details`       | Structured, length-capped, redaction-safe context.                 |
| `decisionId`    | Links to the decision that produced this event, when there is one. |
| `correlationId` | Ties the event to the request that caused it.                      |

### Coverage

The vocabulary spans the whole lifecycle, so no step is unaccounted for:

`intent_received`, `product_selected`, `product_verified`,
`product_verification_failed`, `policy_evaluated`, `approval_requested`,
`approval_granted`, `approval_denied`, `payment_order_created`,
`payment_attempt_started`, `payment_captured`, `payment_failed`,
`webhook_received`, `webhook_rejected`, `state_transitioned`,
`transaction_completed`, `transaction_blocked`, `transaction_cancelled`.

An event type outside this list is rejected by the schema — a test asserts it —
so a new kind of financial action cannot be introduced without being audited.

### Rules

- **Append-only.** No updates, no deletes.
- **Redacted by construction.** The same scrubbing as the logger, plus a
  500-character cap on detail strings.
- **No secrets, no card data, no chain-of-thought** (invariant 16).
- **Every consequential step emits one.** Including refusals: a blocked policy
  evaluation is as important to record as an approved one.
