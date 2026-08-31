# 23 — Structured explainability and the audit system

**Built in Objective 9.** One boundary through which every financial and
decision event is recorded, and one query that reads a transaction back as an
ordered, machine-readable story.

## Two records, two jobs

|         | Operational logs (`@/lib/logger`)     | Audit events (this system)                        |
| ------- | ------------------------------------- | ------------------------------------------------- |
| For     | operators                             | the buyer, and anyone asking what happened        |
| Content | latency, provider errors, diagnostics | what was decided, on what facts, under which rule |
| May be  | sampled, rotated, reordered, dropped  | never                                             |
| Answers | "why is this slow / broken"           | "why was I charged / blocked / asked to approve"  |

A user-facing explanation is never reassembled from log lines, and the audit
trail is never used for debugging noise. Objective 10's payment modules use this
service, not the logger, for anything a buyer could later dispute.

## The boundary

```ts
recordAuditEvent(client, command); // write
getTransactionAuditHistory(transactionId); // read
```

Before this existed, three services each had a private
`prisma.auditEvent.create` helper with its own dedupe read and its own idea of a
payload — three implementations that agreed by coincidence, and would have
become four the moment payments landed. Those are now thin adapters over this
one boundary.

The **client is the first parameter**, deliberately. Callers inside a business
transaction pass their `tx`, so the audit row commits or rolls back with the
action it describes. An optional client would let someone omit it by accident
and silently reintroduce the split-brain the boundary exists to prevent.

The service records facts. It evaluates no policy, mutates no financial state,
and has no opinion about whether what it is recording was a good idea.

## The record shape

`AuditRecord` maps onto the existing `AuditEvent` model — no new table:

| Field                                         | Source                                                |
| --------------------------------------------- | ----------------------------------------------------- |
| `eventId`                                     | `AuditEvent.id` (UUIDv7)                              |
| `transactionId`                               | column, nullable for pre-transaction events           |
| `occurredAt`                                  | `createdAt`                                           |
| `actor`                                       | closed union — the lifecycle's own `TransactionActor` |
| `action`                                      | closed union — `AuditEventType`                       |
| `result`                                      | `SUCCESS` / `FAILURE` / `BLOCKED` / `PENDING`         |
| `reasonCode`                                  | existing reason-code vocabularies                     |
| `trustedInputs`                               | `metadata`, allow-listed per action                   |
| `correlationId`, `operationKey`, `decisionId` | columns                                               |
| `conciseExplanation`                          | **derived at read time**                              |

### Actor is not authority

Gemini is a legitimate **actor** — it produces recommendations, and the record
says so (`buyer_agent` on `intent_interpreted`). It is never the **authority**
for a price, a policy outcome or a lifecycle state; those carry
`quote_service`, `policy_engine`, `merchant_service`. Recording the distinction
is what lets a reader see that an AI proposed something and a deterministic rule
decided it. `isAiActor()` names the difference in code.

### Explanations are derived, not stored

The row holds a reason code and the numbers the decision turned on; the sentence
is rendered from those at read time by a pure function. Storing prose would
create a second source of truth that drifts the first time somebody rewords it,
and would leave a free-text field in a financial record for narration to leak
into.

```
"Quote total ₹2799.00 is within the ₹3000.00 automatic purchase limit (policy version 1)."
```

Not `"The AI thought this seemed safe."` — there is no branch in the explanation
code that can produce such a sentence, because model narration is not one of its
inputs. A test asserts every action produces a sentence and that none contains
first-person or hedging language.

## Trusted inputs, allow-listed per action

Every action declares exactly which server-derived fields it may carry, as a
strict Zod schema. `Record<AuditEventType, …>` makes it exhaustive by
construction: adding an event type without deciding what it may carry is a
compile error, not a payload that accepts anything.

Two kinds of rejection, for different reasons:

- **A sensitive key** — `apiKey`, `authorization`, `sessionToken`, `cardNumber`,
  `reasoning`, `chainOfThought`, `prompt` — is refused **loudly**. Silently
  dropping it would hide a real defect and let it recur somewhere the stripping
  does not reach. The scan walks nested objects, and the error names the key,
  never the value.
- **An undeclared field** is refused because an audit record is evidence.
  Storing whatever arrived is how a trail becomes a dumping ground.

Amounts must be integer minor-unit strings, so `"2799.00"` — the shape of a bug
that becomes a hundredth of the real number downstream — is rejected.

Failing closed here can abort a business transaction, since audit writes are
atomic with the actions they describe. That is the intended trade: payloads are
built by this repository's own code against these schemas, so a rejection is a
bug caught in tests rather than a condition users meet.

## Coverage from Objectives 1–8

| Stage     | Events                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------- |
| Intent    | `intent_interpreted`, `clarification_requested`, `no_candidate_matched`                            |
| Product   | `product_selected`, `product_selection_rejected`, `product_verified`                               |
| Quote     | `quote_created`, `quote_reissued`, `quote_expired`, `quote_invalidated`                            |
| Policy    | `policy_evaluated` with decision, reason code and policy version                                   |
| Approval  | `approval_requested`, `approval_granted`, `approval_denied`, `approval_expired`                    |
| Inventory | `inventory_reserved`, `inventory_released`, `inventory_reservation_expired`, `inventory_committed` |
| Lifecycle | composed from `TransactionStateTransition`                                                         |

## Atomicity and idempotency

Audit writes participate in the caller's transaction wherever the action is
financial: quote creation and re-issue, quote settlement, policy evaluation,
approval consumption and rejection, reservation, release, expiry and commit. A
rollback takes the audit row with it — a test forces a failure after the audit
write and asserts nothing survives.

Idempotency reuses the **existing** unique `operationKey` column added in
Objective 7. **No migration was needed for Objective 9.** The write is an
`INSERT … ON CONFLICT DO NOTHING`, so a retried operation converges on the row
that already exists — including two callers racing, because the conflict is
resolved by the same statement that writes the row rather than by a read
preceding it. A read-then-insert pair would leave a window where both callers
find nothing, both insert, and the loser's unique violation aborts the business
transaction it was auditing.

Services write the audit record **before** the state transition it explains, so
timestamp order and causal order agree.

## Append-only

There is no `updateAuditEvent` and no `deleteAuditEvent`, and a test asserts the
module exports nothing matching `update|delete|remove|purge|edit`. A mistake is
corrected by recording what happened next, not by rewriting what was recorded
before — a trail that can be edited is not evidence. Every foreign key into the
table remains `ON DELETE RESTRICT`.

## The timeline query

`getTransactionAuditHistory(transactionId)` returns one normalized, deterministic
chronology.

### Composed, not duplicated

`TransactionStateTransition` **remains authoritative for lifecycle state** — it
has the actor checks, the conditional update and the unique sequence behind it,
and Objective 3 exists to make it the only way state changes. Mirroring every
transition into the audit table as well would create two histories that can
disagree, and the moment they disagree neither is trustworthy. So the query
reads both tables and merges them, keeping `source` on each entry so a reader
can tell which is which.

### Ordering is fully specified

"Whatever the database returns" is not an order. Entries sort by:

1. `occurredAt`;
2. then **audit before state transition** at the same instant — a decision
   causes the move that follows it;
3. then a stable per-source key: `sequence` for transitions, and the row id for
   audit events, which is a UUIDv7 and therefore itself creation-ordered.

Timestamps have millisecond resolution and rows are written microseconds apart,
so collisions are real rather than theoretical. Both tie-break rules are tested
by **forcing** a tie, not by hoping the clock produces one.

## Payment-ready

`payment_order_created`, `payment_attempt_started`, `payment_verified`,
`payment_captured`, `payment_failed`, `webhook_received` and `webhook_rejected`
already exist in the vocabulary, with a payload allow-list and an explanation
each. Objective 10 adds calls, not architecture.

## No AI calls

Objective 9 makes zero Gemini requests. Explanations are rendered from stored
structured facts by a pure function with no network access.

## What Objective 9 deliberately did not do

No Razorpay SDK, orders, checkout, payment verification, webhooks,
reconciliation or retry. No audit UI or dashboard — a queryable structured
backend timeline is the deliverable.
