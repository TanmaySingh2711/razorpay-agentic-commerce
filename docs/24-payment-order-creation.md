# 24 — Razorpay Test Mode and server-side order creation

**Built in Objective 10.** Everything before this was reversible. This is the
first thing the system does that it cannot take back.

A quote can be superseded, a policy decision re-derived, a reservation
released. If a PostgreSQL transaction rolls back, the world is as it was. An
order at Razorpay is not like that: once the request leaves the process, the
order may exist whether or not this database ever hears about it, and no
rollback anywhere reaches it.

Three commitments follow, and they shape every design choice below.

1. **Nothing external happens until every internal control has passed.**
2. **Exactly one caller may create the order**, arbitrated by the database.
3. **"We do not know" is a first-class outcome**, never folded into failure.

## The flow

```
POST /api/payments/order  { "transactionId": "..." }
        │
        ├─ transaction must be INVENTORY_RESERVED
        ├─ trusted quote re-validated (present, ACTIVE, unexpired, price still true)
        ├─ inventory reservation matched: same quote, product, quantity; ACTIVE; unexpired
        ├─ final policy recheck against today's policy version
        ├─ amount derived from PurchaseQuote.totalAmount            ← no provider call yet
        │
        ├─ atomic claim: INSERT payment_attempt (unique idempotencyKey)
        │
        ├─ ─ ─ ─ ─ ─ ─ ─ ─  POST /v1/orders  ─ ─ ─ ─ ─ ─ ─ ─ ─►  Razorpay Test Mode
        │
        └─ ONE PostgreSQL commit:
             PaymentAttempt.providerOrderId
           + AuditEvent (payment_order_created)
           + INVENTORY_RESERVED → PAYMENT_ORDER_CREATED + TransactionStateTransition
```

Checkout is not here. Nothing transitions to `PAYMENT_PENDING`, no
`razorpay_payment_id` is handled, and no signature is verified — those belong to
the next objective.

## What the caller may say

```json
{ "transactionId": "0199…" }
```

That is the whole schema, and it is `z.strictObject`, so a request carrying
`amount`, `currency`, `quoteId`, `providerOrderId` or anything else is answered
`400` rather than having the field quietly ignored. The distinction matters:
"ignored" and "honoured" look identical to whoever is probing, and a loud
refusal is what makes the boundary testable.

Everything financial is loaded server-side:

| Value    | Read from                                                 |
| -------- | --------------------------------------------------------- |
| amount   | `PurchaseQuote.totalAmount` — the persisted trusted quote |
| currency | `PurchaseQuote.currency`                                  |
| product  | `PurchaseQuote.productId`                                 |
| quantity | `PurchaseQuote.quantity`                                  |
| policy   | re-derived from `AuthorizationPolicy` at this instant     |

### The amount is already in minor units

`₹2,799` is stored as `279900` and sent as `279900`. There is no multiplication
by 100 anywhere on the path from PostgreSQL to Razorpay, and no floating point:
`bigint` is widened to `number` once, after `assessPayableAmount` has proved the
value is positive, at least the documented `INR 1.00` minimum, and small enough
that JSON cannot round it.

## The preconditions, in order

Each throws rather than returning, so there is no path to the provider with a
check skipped. They run cheapest-first, and the policy recheck runs last —
because the smaller the gap between "policy says yes" and "the order exists",
the smaller the window in which a buyer's revised policy can be ignored.

| Check                | Refusal                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| transaction state    | `TRANSACTION_STATE_INVALID`                                            |
| trusted quote        | `NO_ACTIVE_QUOTE`, `QUOTE_NOT_USABLE`                                  |
| inventory hold       | `NO_ACTIVE_RESERVATION`, `RESERVATION_MISMATCH`, `RESERVATION_EXPIRED` |
| authorization/policy | `NOT_AUTHORIZED` (the recheck's own cause in `detail`)                 |
| amount               | `AMOUNT_NOT_PAYABLE`                                                   |

### A person's approval, and what it may answer

Re-running the deterministic engine against an above-ceiling amount keeps
answering `APPROVAL_REQUIRED` — correctly, because the amount really is above
the ceiling. Refusing on that basis would make it impossible to ever pay for a
purchase a person deliberately approved. That is not a safety property, just a
broken product.

So the recheck accepts an `approvalMaySatisfy` option, and Objective 10 passes
it. The approval is only allowed to answer the question it was asked: it must
name **this transaction, this exact quote, this exact amount and currency, and
the policy version still in force**, and it must be `CONSUMED`. A `BLOCKED`
verdict is checked first and no approval can override it — a person may raise
their own ceiling, but may not authorize something the policy refuses outright.

## Duplicate-order prevention

Two mechanisms, one on each side of the boundary.

### Ours: a unique row is the claim

```
payment_attempt.idempotencyKey = "payment_order:<transactionId>:<quoteId>"   UNIQUE
```

Derived server-side, never from anything the caller sends. Two concurrent
requests compute the same string, both attempt the insert, and PostgreSQL lets
exactly one succeed. The loser reads the winner's row and **never calls the
provider**.

This is durable in a way an in-process lock is not: it survives a second server
process, a restart, and a request handled on another machine, because the
arbiter is the database everyone already shares. No mutex, no Redis, no
distributed lock.

A caller-supplied `operationId` is deliberately _not_ the claim identity. If it
were, two requests carrying different operation ids would each be entitled to
their own order — the exact duplicate this exists to prevent.

### Razorpay's: the receipt

The Orders API documents `receipt` as unique and treats it as the idempotency
key for order creation — a second create call carrying the same value is
rejected with _"Duplicate request. This request has already been processed."_
And `GET /v1/orders?receipt=…` fetches an order back by it.

Those two facts together are what make the adapter safe without a lock:

```
receipt = "rcpt_" + PaymentAttempt.id with hyphens removed     (37 chars ≤ 40, ASCII)
```

Derived from the attempt id, so it is **stable across every retry** (the retry
finds the row rather than creating one), **unique** (UUIDv7), and **reversible**
(a receipt seen in a dashboard names the attempt it belongs to). It is stored on
the row as well, with a unique index and a `CHECK` enforcing Razorpay's
`^[A-Za-z0-9_-]{1,40}$` limit — a row that could not be sent to the provider
should not be storable.

## The failure window

A Razorpay call cannot participate in a PostgreSQL transaction. Two things can
go wrong that a rollback cannot fix, and the design names both.

### The adapter never asks twice

`createOrder` calls the create endpoint **at most once, ever**. Every recovery
path is a read.

| Symptom                             | What the adapter does                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `401` / `403`                       | definite failure; no lookup (nothing could have been created, and a lookup would be refused identically) |
| `429`                               | definite failure; the request was rejected before processing                                             |
| `400` (including duplicate receipt) | look the receipt up                                                                                      |
| `5xx`                               | look the receipt up                                                                                      |
| timeout / network error             | look the receipt up                                                                                      |
| `200` that will not parse           | look the receipt up                                                                                      |

The lookup is what removes the ambiguity. Finding the order means it was created
despite the failure; finding **nothing is authoritative** that it was not, so a
timeout is downgraded to a definite failure. Only a lookup that itself fails
leaves `UNKNOWN`.

Duplicate detection needs no string-matching on vendor prose: any non-success is
followed by a lookup, and the receipt's presence at the provider settles it.

### `RECONCILIATION_REQUIRED` is a status, not an absence

```
enum PaymentAttemptStatus { CREATED PENDING VERIFIED CAPTURED FAILED RECONCILIATION_REQUIRED }
```

The other five all _assert_ something. None can say "we called the provider and
did not learn what happened", and that difference matters more than any of the
others: such an attempt must never be retried into a second order, and must be
resolved by receipt.

It is a status rather than a combination of nullable columns so that a
reconciliation job asks one indexed question instead of a three-part predicate a
future writer could get subtly wrong. Any provider order id we _did_ learn is
stored even here — especially here — because an order whose id was lost is far
harder to reconcile than one whose bookkeeping simply did not finish.

The audit record for it uses result `PENDING`, not `FAILURE`. Calling it a
failure would invite the retry that must not happen.

Neither the failure record nor the unresolved record carries an operation key.
One attempt can legitimately fail, or end up unresolved, more than once — a
`FAILED` attempt is explicitly allowed a fresh create — and those are distinct
events about distinct provider calls. A key derived from the attempt would make
the second converge on the first and vanish from the trail. Each of these writes
happens exactly once per provider call, so appending is correct; convergence is
provided by the claim row, not by the audit key.

### What a retry does

The attempt's own status decides, which is the whole reason the status exists:

| Attempt state                                    | Next call                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| has `providerOrderId`                            | finish the local half; no provider call at all                                  |
| `CREATED`, someone else's claim, under the lease | look up; else `CREATION_IN_PROGRESS` (`409`)                                    |
| `CREATED`, someone else's claim, lease elapsed   | look up; create only if `NOT_FOUND` is authoritative                            |
| `RECONCILIATION_REQUIRED`                        | look up first; create only if `NOT_FOUND` is authoritative                      |
| `FAILED`                                         | create again — a definite failure created nothing, and the receipt is unchanged |

#### The claim lease

A claim row is the right to call the provider, and its holder normally resolves
it in seconds. A process that dies between claiming and recording an outcome
would otherwise leave the row at `CREATED` forever, and every later retry would
answer `CREATION_IN_PROGRESS` for work nobody is doing — a permanent wedge, not
a safety property. After 60 seconds an unresolved claim is treated as abandoned
and may be taken over.

Correctness does not depend on that number. If the lease expires while the
original holder is still working, both callers present the **same receipt**, so
Razorpay rejects the second create and hands back the existing order. The lease
decides how long a wedged transaction waits, never whether a duplicate can
exist.

The claim is timestamped from the injected clock rather than the database
default, so the lease is measured against the same clock that reads it.

### Replaying is not the same as reporting

The replay short-circuit answers with an order only while the transaction is in
`PAYMENT_ORDER_CREATED` or `PAYMENT_PENDING` — live, and not yet paid.

A transaction cancelled, expired, blocked or failed _after_ its order was
created still has a perfectly real provider order attached. Answering
`ORDER_CREATED` for one of those would be a green light read off a dead
transaction — "your order is ready, go pay" for a purchase that is over. So is
`COMPLETED`, where the money has already moved. All of them are answered with
`TRANSACTION_STATE_INVALID` naming the state.

## Atomic local finalization

The provider reference, the audit event and the lifecycle transition are **one
PostgreSQL commit**. That makes both forbidden half-states impossible:

- a transaction at `PAYMENT_ORDER_CREATED` with no stored order id;
- a stored order id with no transition or audit record explaining it.

The audit write comes before the transition, so the trail reads in causal order
— the decision, then the move it caused — which is the ordering the audit
timeline reader is built around.

If the commit fails, the order still exists at Razorpay. This code does not
pretend otherwise: the failure is caught and the attempt is parked for
reconciliation _with the order id preserved_.

**A conflict is not a failure.** Two requests can legitimately reach
finalization for the same attempt — one creates the order, the other's receipt
lookup finds it just before the first commits. The loser is rejected by the
state machine's concurrency guard, and that rejection means _somebody else
already finished this_. So before treating anything as unresolved, the attempt
is re-read: a row carrying a provider order id **and** still at `CREATED` can
only have got there through a successful finalization, since parking leaves
`RECONCILIATION_REQUIRED` and a definite failure leaves `FAILED`. That read is
what makes the two distinguishable, and it is why the loser converges on the
order instead of overwriting a healthy one with a failure code.

Before any of it, a fail-closed guard rejects an empty provider order id and an
amount that does not match what was sent.

## Configuration

`RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are validated as their own section
(`getRazorpayCredentials()`), separate from `RAZORPAY_WEBHOOK_SECRET`. Creating
an order needs a key id and secret and nothing else; validating all three
together would let an unconfigured webhook block order creation — a control
failing a path it has no authority over.

`RAZORPAY_KEY_SECRET` is server-only without qualification. It authenticates
this application to Razorpay, signs nothing the browser needs, and appears in
exactly one place: an HTTP `Authorization: Basic` header built inside the
adapter. It is never in a response, an audit payload, a log line, an error, or a
`NEXT_PUBLIC_*` variable.

`RAZORPAY_KEY_ID` is the public half. It is returned in the response `meta`
**only alongside a real order**, so an endpoint probe cannot read configuration
out of the server. Checkout will need it next objective.

## Responses

| Outcome                   | Status | Meaning                                       |
| ------------------------- | ------ | --------------------------------------------- |
| `ORDER_CREATED`           | 200    | the order exists and is recorded              |
| `RECONCILIATION_REQUIRED` | 202    | unresolved; will be reconciled, not retried   |
| `CREATION_IN_PROGRESS`    | 409    | another request owns creation                 |
| `REFUSED`                 | 422    | a control declined; no provider call was made |
| `PROVIDER_FAILED`         | 502    | the provider definitely created nothing       |

## What is deliberately not done here

**Inventory is not released on a provider failure.** A transient outage is not a
reason to give a buyer's reserved unit away; the hold has its own expiry. And no
`PAYMENT_FAILED` transition is emitted — the payment failure and retry workflow
of a later objective owns the decisions about when to release stock and when to
permit a fresh attempt. Moving the lifecycle here would pre-empt those decisions
with a guess.

## Testing

`tests/payment-order-rules.test.ts` (27) drives the adapter through an injected
`fetch`: lost responses, unparsable `200`s, duplicate receipts, and 5xx. Each one
asserts the **count of create calls**, because the property that matters is
negative.

`tests/db/payment-order.test.ts` (37) runs against real PostgreSQL with a fake
provider — every arrangement walks the real creation, transition, quote, policy,
approval and reservation services, so no test starts from a hand-built row. It
proves one order under concurrency, and forces a commit failure after a
simulated provider success to prove the transaction does not falsely reach
`PAYMENT_ORDER_CREATED`.

`npm run razorpay:smoke` makes the one live Test Mode call. It refuses to run
against a `rzp_live_` key, creates a ₹1.00 order, captures nothing, writes no
database row, and prints no credential.
