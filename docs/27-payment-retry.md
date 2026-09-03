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

| Denial                      | Meaning                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRANSACTION_NOT_FOUND`     | No such transaction.                                                                                                                                                                                 |
| `PAYMENT_ALREADY_CAPTURED`  | The provider already captured a payment — including a late capture for an earlier attempt.                                                                                                           |
| `TRANSACTION_STATE_INVALID` | Not at `PAYMENT_FAILED` or (mid re-quote cycle) `AUTHORIZED`; there is no failed payment to retry.                                                                                                   |
| `OUTCOME_UNRESOLVED`        | Some attempt is `RECONCILIATION_REQUIRED`. Resolved by receipt lookup, **never** by another order.                                                                                                   |
| `ATTEMPT_IN_PROGRESS`       | An attempt is `CREATED`/`PENDING`/`VERIFIED`. Closes the double-click window the state check alone would miss.                                                                                       |
| `RETRY_LIMIT_REACHED`       | Every permitted attempt has been used - checked before the quote is even read, so a stale quote can never buy a fourth attempt.                                                                      |
| `NO_ACTIVE_QUOTE`           | Nothing to charge, and no reservation survives to re-quote against either.                                                                                                                           |
| `FINANCIAL_FACTS_CHANGED`   | The quote lapsed with no reservation left to save it, **or** a re-quote was attempted and itself refused: the product is no longer sold, its currency changed, or today's policy blocks it outright. |
| `RESERVATION_NOT_HELD`      | No live stock hold matching this quote, product and quantity.                                                                                                                                        |
| `NOT_AUTHORIZED`            | Re-running today's policy and today's approvals does not authorize this purchase.                                                                                                                    |

A gate result can also be `REQUOTE_ELIGIBLE` rather than a denial: the quote
is stale, but the original stock hold is still `ACTIVE`, unexpired, and names
this exact product and quantity. See "Re-quoting a stale quote" below - this is
what `requestPaymentRetry` acts on to replace the quote before continuing,
rather than refusing outright.

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

Deliberately **not** re-derived, ever:

- the **amount**, when a live quote already prices this purchase. It comes from
  the persisted `PurchaseQuote` and nowhere else - a retry never has a field
  for one, and nothing here computes one from scratch.
- a **new reservation**. Stock is claimed only from `AUTHORIZED`. A hold that
  lapsed cannot be re-taken without fresh authorization, and a retry never
  creates a second reservation for a hold that survived.

### Re-quoting a stale quote

A quote's TTL is ordinarily shorter than a reservation's, so the quote a
payment failed under routinely goes stale before a person notices the failure
and asks to retry - that is the ordinary shape of this scenario, not an edge
case. When the gate finds the quote no longer valid but the _original_ stock
hold is still `ACTIVE`, unexpired, and matches the exact product and quantity
that hold was claimed for, a retry is exactly the deliberate human act that may
ask for a fresh price. This is **not** a silent reprice: it is the same
`QUOTE_CREATED` self-loop that already exists for "still quoting, but again",
reused for the one caller who may take it from `PAYMENT_FAILED` -
`@/services/quote/quote-service`'s `createTrustedQuote`, called with
`replaceExisting: true`, using this transaction's own product id and quantity
and no stated budget of its own to compare against (the shopper's original
budget was already satisfied by the quote just superseded; what a re-quote
checks is the product's own current facts, not a new preference).

The sequence, all through existing, unmodified boundaries:

1. `createTrustedQuote` supersedes the stale quote and freezes today's price.
   If the product is no longer sold, its currency moved, or there is no longer
   enough of it, this throws and the retry is refused
   `FINANCIAL_FACTS_CHANGED` - the same rule an ordinary stale quote already
   answers with, just discovered one step later.
2. `evaluateQuotePolicy` re-runs the deterministic engine against the fresh
   quote. `BLOCKED` refuses the retry the same way. `APPROVAL_REQUIRED` moves
   the transaction there and stops - a person must approve the fresh amount
   before this retry may go any further, exactly the rule a first purchase
   above the ceiling already follows. Only `ALLOWED` continues.
3. The still-held reservation is pointed at the fresh quote
   (`requoteReservation`) - never re-claimed, never a second row. This step
   runs whether the fresh verdict is `ALLOWED` or `APPROVAL_REQUIRED`, so that
   once a person grants the approval the hold is already aligned with the
   quote that approval named.
4. `createPaymentOrder` is called exactly as an ordinary retry calls it. A
   requoted retry reaches it from `AUTHORIZED` rather than `PAYMENT_FAILED` -
   see the `AUTHORIZED` block in `src/domain/transaction/transitions.ts` for
   why that edge does not weaken "stock is held before money moves": the hold
   was never released, only rebound.

Nothing above is reachable except from `@/services/payment/retry-service`,
never from an ordinary first purchase, and the attempt limit is unaffected by
any of it - re-quoting does not spend or reset an attempt; only a created
`PaymentAttempt` does that.

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

When a late capture lands, the transaction reaches `PAYMENT_CAPTURED` and, in
the same reconciliation, finalizes straight through to `COMPLETED`: the
reservation the retry workflow left `ACTIVE` through the failure is committed
alongside it (the mechanics are in 22 — Human approval and inventory
reservation, under "Finalization"). If that reservation is no longer `ACTIVE`
— only reachable once every retry has been exhausted and the hold released —
the transaction is left at `PAYMENT_CAPTURED` rather than falsely reported
complete. Either way, the pending retry attempt is left untouched, further
retries are denied `PAYMENT_ALREADY_CAPTURED`, and `startCheckout` refuses.

**If two different attempts are both captured**, the webhook service detects it
explicitly — the ordinary machinery would hide it, because the state machine
correctly judges the second capture already accounted for. Both attempts are
recorded `CAPTURED` (the provider took both; a ledger that said otherwise would
be the worse error), a `payment_multiple_capture_detected` audit record is
written with both attempt ids, and the `WebhookEvent` carries
`errorCategory = MULTIPLE_CAPTURE`. The transaction state does not move a
second time: the genuine first capture already finalized it to `COMPLETED`,
and the rival capture — never reaching the `APPLIED` outcome finalization is
gated on — cannot re-commit the reservation or re-request completion. No
inventory is committed a second time, and nothing is refunded automatically —
refunds are not part of this system.

## Audit vocabulary

| Event                               | Written when                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_retry_requested`           | A person asked. Recorded before the decision.                                                                                                |
| `payment_retry_authorized`          | The gate passed, carrying the quote, amount, policy version, approval id and stock hold it re-checked. Written **before** the provider call. |
| `payment_retry_denied`              | The gate refused. `reasonCode` is the denial.                                                                                                |
| `payment_retry_limit_reached`       | The bound was hit. Its own record, because it is the refusal people come back to ask about.                                                  |
| `payment_multiple_capture_detected` | Two attempts under one transaction were both captured.                                                                                       |
| `quote_reissued`                    | A stale quote was replaced during a retry - the same event a `QUOTE_CREATED` self-loop already writes.                                       |
| `inventory_reservation_requoted`    | The still-held reservation was pointed at the fresh quote a re-quote produced. No stock counter moves.                                       |

Retry-created orders reuse `payment_order_created`; retry checkout reuses
`payment_attempt_started`; released stock reuses `inventory_released`. No
duplicate event types were introduced where an equivalent already existed.

## What Objective 14 still does not do

Retry itself never commits inventory or completes a transaction — that
authority never lived here. What has changed since this file was written is
what happens elsewhere: the authoritative Razorpay capture webhook now
finalizes a captured payment to `COMPLETED` in the same reconciliation that
confirms the capture, including for a capture this file's own late-capture and
retry paths lead to (see 22 — Human approval and inventory reservation, under
"Finalization"). Refunds are still not part of this system, and no code path
attempts one.
