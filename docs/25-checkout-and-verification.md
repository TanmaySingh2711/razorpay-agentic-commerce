# 25 — Standard Checkout and server-side verification

**Built in Objective 11.** Objective 10 created an order the server can prove it
authorized. This is where a **person** decides to pay it, and where the browser's
claim that they did is checked rather than believed.

One sentence carries the whole objective:

> **`PAYMENT_VERIFIED` is not `PAYMENT_CAPTURED`, and neither is `COMPLETED`.**

A valid signature proves the provider produced this confirmation for this order.
It does not prove money moved. Confusing the two is how a system ships goods for
funds that never settled, so nothing here commits inventory or completes a
transaction.

## The flow

```
  page render  ──────────────────────────────►  nothing happens
                                                (no session, no state change)

  human presses "Pay"
        │
        ▼
  POST /api/payments/checkout  { transactionId }
        ├─ must be PAYMENT_ORDER_CREATED
        ├─ must still hold an ACTIVE, unexpired reservation
        ├─ PAYMENT_ORDER_CREATED → PAYMENT_PENDING   + AuditEvent   (one commit)
        └─ returns the safe checkout DTO
        │
        ▼
  Razorpay Standard Checkout  (card data never touches this application)
        │
        ▼
  POST /api/payments/callback  { transactionId, paymentAttemptId,
                                 razorpay_payment_id, razorpay_signature,
                                 razorpay_order_id }        ← all untrusted
        │
        ├─ load OUR order id from the database
        ├─ HMAC-SHA256(`${ourOrderId}|${paymentId}`, key_secret), timing-safe
        │
        └─ ONE PostgreSQL commit:
             PaymentAttempt.providerPaymentId + status VERIFIED
           + AuditEvent (payment_verified)
           + PAYMENT_PENDING → PAYMENT_VERIFIED + TransactionStateTransition
```

## Why starting checkout is a POST

`PAYMENT_PENDING` has to mean _"a person pressed Pay"_. If the checkout session
were handed out while rendering a page, that state would also be reached by a
refresh, a prefetch, a link preview or a crawler — and would then mean nothing.

So the page is inert. It reads no database, starts no session and moves no
state; it renders a button and passes an identifier. Every decision happens on
the server when the click arrives.

Nothing else can trigger it either. The agent has no tool that reaches the
component, and the component exposes no imperative handle — its only caller is
the button's `onClick`.

## What the browser is given

| Field                               | Source                                   |
| ----------------------------------- | ---------------------------------------- |
| `providerKeyId`                     | config — the **public** half of the pair |
| `providerOrderId`                   | `PaymentAttempt.providerOrderId`         |
| `amountMinor`, `currency`           | `PaymentAttempt` — the server's own row  |
| `transactionId`, `paymentAttemptId` | ours, so the callback can be matched     |
| `merchantName`, `productName`       | display only                             |

What is absent is the point: no key secret, no webhook secret, no signature
material, no buyer identity, no policy detail, no quote or reservation state.

`amountMinor` is a rendering input, not an authority. Nothing the browser does
with it changes what is charged — the amount was fixed at the provider when the
order was created.

## Verification

### The order id comes from our database, never the callback

Razorpay's documentation is explicit: _"Do not use the `razorpay_order_id`
returned by Checkout; instead, retrieve the order_id from your server."_

The reason is worth stating plainly. If the client supplied **both** halves of
the signed payload, an attacker holding a genuine, correctly signed payment for
an order of their own could present it against somebody else's transaction and
the HMAC would verify perfectly.

So the parameter is named `serverStoredOrderId`, and a call site handing it
client input reads as wrong.

The client's order id is still accepted — and immediately distrusted. Keeping it
lets a mismatch be **detected and audited** rather than silently discarded: a
tampered order id is a security event, not a stray parameter.

### The comparison is timing-safe

```
expected = HMAC_SHA256(`${serverStoredOrderId}|${providerPaymentId}`, key_secret)
```

A byte-by-byte `===` leaks how much of a guessed signature was correct, which
turns forgery into a few thousand requests rather than an impossibility.
`crypto.timingSafeEqual` is used instead — but it **throws** on unequal lengths,
so the shape is validated first:

1. the signature must match `/^[0-9a-f]{64}$/i` — anything else cannot be a
   SHA-256 digest, and `Buffer.from(x, "hex")` would silently _truncate_ rather
   than reject it;
2. the order id and payment id must be non-empty;
3. only then are the buffers compared, after a length check.

Malformed input fails closed and never throws. A verifier that crashed on a bad
signature would be both an outage and an oracle.

The function returns a bare `boolean`. There is nothing to leak by construction,
and a test asserts it — the day someone widens it to return a reason is the day
an attacker gets an oracle.

### Every relationship is checked, in order

| #   | Question                                            | Rejection                              |
| --- | --------------------------------------------------- | -------------------------------------- |
| 1   | Does the transaction exist?                         | `TRANSACTION_NOT_FOUND`                |
| 2   | Which attempt is this, and is it ours?              | `ATTEMPT_MISMATCH`, `NO_PAYMENT_ORDER` |
| 3   | Does the presented order id match ours?             | `ORDER_ID_MISMATCH`                    |
| 4   | Is the payment reference well formed?               | `MALFORMED_PAYMENT_ID`                 |
| 5   | Does the signature verify against **our** order id? | `INVALID_SIGNATURE`                    |
| 6   | Already verified this exact payment?                | converge (idempotent)                  |
| 7   | A _different_ payment already recorded?             | `CONFLICTING_PAYMENT`                  |
| 8   | Is it still awaiting a payment result?              | `TRANSACTION_STATE_INVALID`            |
| 9   | Is this payment already bound to another attempt?   | `PAYMENT_ID_ALREADY_USED`              |

**The order is load-bearing.** Authentication (3–5) comes before _everything_
that could produce a success answer, convergence included. With the checks the
other way round, a caller who merely knew a transaction id and a payment id
could present any rubbish as a signature and still be handed a
`PAYMENT_VERIFIED` response — no state change, but a success answer to a request
that proved nothing. A callback that cannot authenticate itself now gets
nothing, confirmation included.

Every rejection leaves the transaction exactly as it was, records a
`payment_callback_rejected` audit event, and reveals nothing about the expected
signature.

### One bound for provider references

`MAX_PROVIDER_REFERENCE_LENGTH` (128, the width of the columns that store these
values) is shared by the request schema and the audit allow-list.

They used to be set independently — 128 at the boundary, 64 in the allow-list —
so a tampered order id between those numbers was rejected correctly but its
audit write threw, and the failure was swallowed. The attacker chose whether the
security event got recorded, by choosing how long a value to send. Sharing one
constant makes that class of gap unrepresentable.

### The trail cannot be flooded

Both the rejection and dismissal paths are reachable with nothing but a
transaction id, so "one request, one permanent row" would be an amplification an
unauthenticated caller could exploit in a loop.

- **Dismissals** converge on `checkout_dismissed:<attemptId>`. Closing the same
  window repeatedly is one fact, and its repetition carries no information.
- **Rejections** keep no operation key — each refused callback is its own
  security event, and collapsing them would hide the very pattern worth seeing —
  but they are capped at 25 per transaction. Far more than an investigator needs
  to spot a pattern; beyond that the event goes to the operational log instead.
  The cap bounds the _record_, never the check: every callback is still
  refused.

## Idempotency and uniqueness

Browsers retry and people refresh, so the same callback arrives more than once.

- **The same payment, again** → converges on the verified result. One transition
  row, one audit record, one payment attempt.
- **A different payment for a verified attempt** → `CONFLICTING_PAYMENT`. Two
  payments cannot both be the payment for one order.
- **The same payment against another transaction** → `PAYMENT_ID_ALREADY_USED`.

The audit operation key is `payment_verified:<attemptId>:<paymentId>` — keyed on
the payment as well as the attempt, so a replay converges while a _different_
payment stays a distinct event rather than being swallowed by the first.

**No migration was needed.** `@@unique([provider, providerPaymentId])` already
existed on `PaymentAttempt` from Objective 2, which is exactly the constraint
this objective requires. The service refuses before reaching it so the answer is
a controlled rejection rather than a constraint violation, but the index is the
backstop.

## Dismissal, and what a browser may not decide

Closing the payment window is neither success nor failure. **Nobody paid, and
nobody was told a payment failed** — the provider has said nothing at all.

So a dismissal records an audit event and changes nothing: no state moves, no
payment id is invented, nothing is marked failed. The stock hold is left to
expire on its own clock. A dismissal arriving _after_ a verified payment is
ignored outright, so a late window-close event can never contradict a payment.

`payment.failed` from the browser is treated the same way: it is shown to the
person and logged, and it decides nothing. Provider-authoritative failure
belongs to reconciliation.

## What Objective 11 deliberately does not do

No webhook endpoint, no webhook signature verification, no deduplication ledger,
no reconciliation, no `PAYMENT_CAPTURED`, no `COMPLETED`, no permanent inventory
commit, no retry system, no live credentials.

A test asserts the negative directly: after a verified callback the transaction
is `PAYMENT_VERIFIED`, the reservation is still `ACTIVE`, product `inventory` and
`reservedQuantity` are unchanged, and no transition to `PAYMENT_CAPTURED` or
`COMPLETED` exists.

## Testing

`tests/checkout-signature.test.ts` (14) runs against the **real adapter** with
signatures computed independently by Node's crypto — no fake anywhere. The
central test signs the right payload with the _wrong_ order id and proves it is
rejected here while verifying against the order it was really made for.

`tests/db/checkout-verification.test.ts` (30) uses real PostgreSQL and real
cryptography, faking only the network. It proves the server verifies against its
stored order id even when the callback posts none at all.

`tests/checkout-script.test.ts` (6) covers the loader's failure paths against a
hand-written DOM stub — a blocked script, a `load` that defines no global, an
in-flight tag, and server-side rendering. Only five browser APIs are used, so a
stub that small keeps the test honest about what the code depends on without
adding jsdom to prove it.

`tests/support/fake-payment-provider.ts` is the single shared stand-in for the
port. Shared rather than copied: two hand-rolled fakes drift, and a test passing
against a drifted fake proves nothing.
