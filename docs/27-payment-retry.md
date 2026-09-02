# 27 — Graceful payment failure and controlled retry

Objective 14. A failed payment is an ordinary outcome; the dangerous thing is
the obvious response to it. This document records how a retry is made bounded,
explainable and impossible for anything other than a person to start.

**Code:** `src/domain/payment/retry.ts` (the rules),
`src/services/payment/retry-service.ts` (the gate),
`src/app/api/payments/retry/route.ts` (the boundary).
**Tests:** `tests/payment-retry-rules.test.ts`, `tests/db/payment-retry.test.ts`.

---

## The one rule

> A retry is granted by deterministic server code, to a person who asked for
> one, at most `MAX_PAYMENT_ATTEMPTS` times, after every financial control has
> been re-run against current facts.

Nothing else may start a payment attempt. In particular:

| Cannot start a retry             | Why not                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The buyer agent (Gemini)         | It has no tool that reaches the retry service, and the transition matrix restricts `PAYMENT_RETRY_REQUESTED` to `transaction_service`.                         |
| A `payment.failed` webhook       | Reconciliation records the failure and stops. There is no call from the webhook service into the retry service.                                                |
| A page load, refresh or prefetch | The endpoint is POST-only and the checkout page performs only reads.                                                                                           |
| A browser payload                | The request schema is `z.strictObject({ transactionId, operationId? })`. Every other key — `retryCount`, `amount`, `providerOrderId`, `approved` — is a `400`. |
| A duplicate HTTP request         | Two requests converge on one attempt through a unique claim in `payment_attempt`.                                                                              |

## What a failure is recorded as

A `payment.failed` event carries more than a code: Razorpay reports where the
failure came from (`error_source`), how far the payment got (`error_step`), and
a machine reason (`error_reason`). All three are mapped, at the parse boundary,
onto closed application-owned sets in `src/domain/payment/failure.ts`, and the
attempt stores the result:

| Column              | Holds                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failureCategory`   | A closed enum: `DECLINED_BY_BANK`, `INSUFFICIENT_FUNDS`, `AUTHENTICATION_FAILED`, `INSTRUMENT_INVALID`, `LIMIT_EXCEEDED`, `CANCELLED_BY_CUSTOMER`, `PROVIDER_UNAVAILABLE`, `REQUEST_REJECTED`, `UNKNOWN` |
| `failureSource`     | Normalised origin: customer, business, bank, gateway, internal                                                                                                                                           |
| `failureStep`       | How far it got: initiation, authentication, authorization, response                                                                                                                                      |
| `failureCode`       | The provider's own code, as a bounded token                                                                                                                                                              |
| `failureReasonCode` | The provider's machine reason, as a bounded token                                                                                                                                                        |
| `failureReason`     | Our sentence for the category. Never the provider's prose.                                                                                                                                               |
| `failedAt`          | Our clock, the same source as the webhook event's `processedAt`                                                                                                                                          |

Three decisions in that table are load-bearing.

**`error_description` is parsed and then dropped.** It is the vendor's free
text, written for a merchant's support desk. It changes without notice and can
echo request content into a row that is meant to be evidence, so the sentence a
buyer reads is written in this repository instead and selected by category.

**Category is a database enum; source and step are bounded strings.** The
category is ours, so PostgreSQL should refuse anything outside it. Source and
step are the provider's vocabulary, and a value we have never seen must still
store — a genuine decline must reconcile whether or not we have a name for it.

**Classification is total.** Anything unrecognised becomes `UNKNOWN`, which is a
real answer meaning "authentically reported, not classifiable". It never throws:
a reconciliation that raised on an unfamiliar reason would leave real money in
an unknown state over a vocabulary problem.

Nothing here has a field for a card number, expiry, CVV, OTP, UPI PIN or
cardholder name, and `tests/db/payment-retry.test.ts` sends a deliberately
prose-filled `error_description` containing a card-shaped number to prove none
of it is stored.

## The limit

`MAX_PAYMENT_ATTEMPTS = 3` — one initial attempt plus at most two retries,
defined once in `src/domain/payment/retry.ts`.

It is **counted from persisted `payment_attempt` rows**. There is no counter in
a session, a cookie, or a request body, so there is nothing to tamper with: the
only way to raise the count is to create real attempt rows, which is the thing
being limited.

## Eligibility

Every retry request runs the same read-only gate, in this order. The first
refusal wins.

| Denial                      | Meaning                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `TRANSACTION_NOT_FOUND`     | No such transaction.                                                                                           |
| `PAYMENT_ALREADY_CAPTURED`  | The provider already captured a payment — including a late capture for an earlier attempt.                     |
| `TRANSACTION_STATE_INVALID` | Not at `PAYMENT_FAILED`; there is no failed payment to retry.                                                  |
| `OUTCOME_UNRESOLVED`        | Some attempt is `RECONCILIATION_REQUIRED`. Resolved by receipt lookup, **never** by another order.             |
| `ATTEMPT_IN_PROGRESS`       | An attempt is `CREATED`/`PENDING`/`VERIFIED`. Closes the double-click window the state check alone would miss. |
| `RETRY_LIMIT_REACHED`       | Every permitted attempt has been used.                                                                         |
| `NO_ACTIVE_QUOTE`           | Nothing to charge.                                                                                             |
| `FINANCIAL_FACTS_CHANGED`   | The quote lapsed, or the price, currency, availability or product version moved.                               |
| `RESERVATION_NOT_HELD`      | No live stock hold matching this quote, product and quantity.                                                  |
| `NOT_AUTHORIZED`            | Re-running today's policy and today's approvals does not authorize this purchase.                              |

The gate is **read-only**: it writes nothing, so the checkout page can consult
it on every render to decide whether to offer a Retry button, and the request
itself can consult it again a moment later.

## What is re-derived, and what is not

Re-derived on every retry, through the existing boundaries:

- the **trusted quote**, re-read against today's product row (`readActiveQuote`);
- the **deterministic policy**, re-run against today's policy version
  (`recheckPolicyAuthorization`);
- the **approval binding**, which must still name this transaction, this exact
  quote, this exact amount and currency, and the policy version in force;
- the **stock hold**, which must be `ACTIVE`, unexpired, and match the quote.

Deliberately **not** re-derived:

- the **amount**. It comes from the persisted `PurchaseQuote` and nowhere else.
- a **new quote**. There is no legal path from `PAYMENT_FAILED` back to quoting,
  and inventing one would let a retry become a silent reprice. If the financial
  facts moved, the retry is refused and the buyer starts a new purchase.
- a **new reservation**. Stock is claimed only from `AUTHORIZED`. A hold that
  lapsed cannot be re-taken without fresh authorization.

## Stock, on refusal

A refusal that **ends the workflow** releases the hold through the inventory
boundary: `RETRY_LIMIT_REACHED`, `FINANCIAL_FACTS_CHANGED`, `NOT_AUTHORIZED`,
`NO_ACTIVE_QUOTE`. Nothing further can happen to the purchase, so keeping the
unit would starve buyers who can complete.

Every other refusal releases nothing. `OUTCOME_UNRESOLVED` and
`ATTEMPT_IN_PROGRESS` are refusals about _not yet knowing_, and releasing stock
on a guess is how a system gives away a unit somebody is mid-payment for. The
reservation's own expiry handles abandonment.

## Every retry is a new `PaymentAttempt`

The failed attempt is never edited. History reads:

```
PaymentAttempt #1  FAILED     order_A   pay_1   BANK_DECLINED
PaymentAttempt #2  FAILED     order_B   pay_2   BANK_DECLINED
PaymentAttempt #3  CAPTURED   order_C   pay_3
```

Each keeps its own id, attempt number, provider order, provider payment,
status, timestamps and failure classification.

### Why a new provider order every time

Razorpay permits the alternative. Its documentation is explicit that an order
moves `created → attempted` when a payment is first tried on it, that several
payments may be attempted against one order id, and that it reaches `paid` only
once a payment is captured — so reusing an order after a decline is legal on the
provider's side. (It also forbids another payment while an existing one is
`authorised`, and any payment once the order is `paid`.)

This system creates a new order anyway, and `RETRY_REUSES_PROVIDER_ORDER =
false` records that as an asserted value rather than a comment:

1. **Correlation must stay decidable.** Both inbound channels — the checkout
   callback and the webhook — resolve an internal `PaymentAttempt` from the
   provider order id we stored, and `@@unique([provider, providerOrderId])`
   makes the database enforce the one-to-one mapping. Share an order between two
   attempts and a late `payment.captured` for the first becomes
   indistinguishable from one for the second.
2. **The receipt is derived from the attempt id.** It is Razorpay's idempotency
   key for order creation, so a new attempt necessarily carries a new receipt.

The cost is one extra order object per retry, bounded by the attempt limit.

## Callback correlation, once several attempts exist

Objective 11's callback handler resolved "the attempt of this transaction" by
taking the newest one carrying a provider order. With a single attempt that was
exact; with retries it is a guess, and a guess must not decide which attempt a
payment belongs to. Objective 14 replaces it with three explicit routes, in
descending order of directness:

1. **The attempt id**, when the caller names one — checked to belong to the
   named transaction.
2. **The presented order id**, matched against the `providerOrderId` _we_
   stored. This is a lookup in our own records, not trust in the caller's: the
   value selects a row and never signs anything, and the HMAC is still computed
   over the column that row holds.
3. **The only candidate**, when exactly one attempt carries a provider order.

Otherwise the callback is refused as `ATTEMPT_AMBIGUOUS`. A presented order id
that matches nothing still falls through to the newest attempt on purpose —
that is the tampered-order-id case, and it belongs in `ORDER_ID_MISMATCH`,
which records what was presented, rather than in a bare "not found" that would
discard the evidence.

Reverting this rule makes an unnamed callback verify against whichever attempt
is newest, which `tests/db/payment-retry.test.ts` catches.

## Concurrency

Two simultaneous retry requests compute the same next attempt number from the
same rows, so they race for one claim key —
`payment_order:<transactionId>:<quoteId>:retry<n>` — under the unique index on
`payment_attempt.idempotencyKey`. PostgreSQL picks one winner. The loser reads
the winner's row and either converges on it or is told creation is in flight; it
never calls `createOrder`.

The disabled button in the UI is a courtesy, not a control.

## Late capture and double capture

A capture can arrive for an attempt that was already reported failed, after a
retry has started. Objective 14 adds one transition for exactly that:

```
PAYMENT_ORDER_CREATED --PAYMENT_CAPTURE_CONFIRMED (payment_webhook)--> PAYMENT_CAPTURED
```

Without it a genuine capture for attempt #1 would be held for reconciliation
while the buyer was still being invited to pay again. It is restricted to
`payment_webhook`: only the party that holds the money may say it arrived.

When a late capture lands, the transaction reaches `PAYMENT_CAPTURED`, the
pending retry attempt is left untouched, further retries are denied
`PAYMENT_ALREADY_CAPTURED`, and `startCheckout` refuses.

**If two different attempts are both captured**, the webhook service detects it
explicitly — the ordinary machinery would hide it, because the state machine
correctly judges the second capture already accounted for. Both attempts are
recorded `CAPTURED` (the provider took both; a ledger that said otherwise would
be the worse error), a `payment_multiple_capture_detected` audit record is
written with both attempt ids, and the `WebhookEvent` carries
`errorCategory = MULTIPLE_CAPTURE`. The transaction state does not move a second
time, no inventory is committed, and nothing is refunded automatically —
refunds are not part of this system.

## Audit vocabulary

| Event                               | Written when                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_retry_requested`           | A person asked. Recorded before the decision.                                                                                                |
| `payment_retry_authorized`          | The gate passed, carrying the quote, amount, policy version, approval id and stock hold it re-checked. Written **before** the provider call. |
| `payment_retry_denied`              | The gate refused. `reasonCode` is the denial.                                                                                                |
| `payment_retry_limit_reached`       | The bound was hit. Its own record, because it is the refusal people come back to ask about.                                                  |
| `payment_multiple_capture_detected` | Two attempts under one transaction were both captured.                                                                                       |

Retry-created orders reuse `payment_order_created`; retry checkout reuses
`payment_attempt_started`; released stock reuses `inventory_released`. No
duplicate event types were introduced where an equivalent already existed.

## What Objective 14 still does not do

`PAYMENT_CAPTURED` is not `COMPLETED`. Inventory is never committed here,
nothing is fulfilled, and no refund is ever issued. Those remain later work.
