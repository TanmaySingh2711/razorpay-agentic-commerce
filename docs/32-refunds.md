# 32 — Refunds

A completed purchase can be refunded in full by the buyer, from the purchase
page. It is the payment flow's discipline pointed the other way: nothing
financial comes from the caller, the money goes back at most once, and a lost
provider answer is settled by reading, never by asking again.

**Code:** [`src/domain/refund/contracts.ts`](../src/domain/refund/contracts.ts)
(eligibility, pure), [`src/services/refund/refund-service.ts`](../src/services/refund/refund-service.ts),
the Razorpay adapter's `createRefund` / `findRefundByReceipt`, and the refund
branch of the webhook service. **Tests:** `tests/unit/refund-rules.test.ts`
(rules and the adapter's HTTP contract), `tests/db/refund.test.ts` (the whole
flow against PostgreSQL).

## Who may ask, and for how much

Only the buyer, by pressing **Refund this purchase**, which sends a transaction
id to a server action - nothing else. There is no agent tool for refunds and
there must never be one: returning money is a financial decision exactly like
spending it.

The amount, currency and payment are copied from the **captured**
`PaymentAttempt`, so a refund cannot be larger, smaller or in a different
currency than what was charged. Eligibility (`assessRefund`) requires, in order:

1. the transaction is `COMPLETED`;
2. exactly one captured attempt with a provider payment id - two captures is an
   anomaly a person must resolve first;
3. no refund that has not `FAILED`;
4. the merchant's refund window (`REFUND_WINDOW_DAYS`, default 7) has not passed.

## A separate record, not a state

`COMPLETED` stays `COMPLETED`. The purchase genuinely happened; a refund is a
second, later financial fact about it, with its own lifecycle in the `refund`
table: `REQUESTED → PENDING → PROCESSED`, or `FAILED`, or
`RECONCILIATION_REQUIRED`. Rewriting the transaction into "never happened" would
destroy exactly the history that makes a refund explicable.

## At most once

- A **partial unique index** permits one refund per transaction whose status is
  not `FAILED`. A failed refund does not block a new attempt; anything else -
  including an unresolved one, where the provider may already hold a refund -
  does.
- The **receipt** is derived, not generated: `rf_<transaction id>_<ordinal>`. Two
  concurrent clicks compute the same receipt, and the unique index lets exactly
  one row exist (asserted by firing two requests at once).
- The receipt is also Razorpay's **idempotency key** for the refund.

## Create once, recover by reading

The adapter calls `POST /v1/payments/:id/refund` at most once per refund row,
always stating the full amount explicitly. If the answer is lost or unreadable,
it looks the receipt up with `GET /v1/payments/:id/refunds`:

| Lookup result                   | Outcome                      |
| ------------------------------- | ---------------------------- |
| found, same amount and currency | `ALREADY_EXISTS` (adopted)   |
| found, different amount         | `UNKNOWN` - never adopted    |
| not found                       | `FAILED` - definitively none |
| lookup itself failed            | `UNKNOWN`                    |

`UNKNOWN` becomes `RECONCILIATION_REQUIRED`, which blocks a second refund. The
page offers **Check refund status**, which runs `reconcileRefund` - read-only
towards the provider, so it can settle a refund's status but never create one.
A payment id is shape-checked (`pay_…`) before it is interpolated into a URL.

## Webhooks

`refund.processed` and `refund.failed` are authenticated exactly like payment
events, then take their own path: they move a `Refund` row and never a
transaction state. They are correlated by **our receipt** first, so an event that
outruns our own record of the provider's refund id still matches; the amount
must equal what we asked to return, or the event is recorded as a mismatch and
changes nothing. Settlement is a conditional update from an open status only, so
a late `refund.failed` cannot turn a processed refund back into a failed one,
and a redelivery is a `DUPLICATE`.

## Audit

`refund_requested`, `refund_denied`, `refund_processed`, `refund_failed` and
`refund_unresolved` join the audit vocabulary with their own allow-listed
payload, and read as plain sentences in the transaction timeline.
