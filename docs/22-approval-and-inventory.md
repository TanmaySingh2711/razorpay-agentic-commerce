# 22 — Human approval and inventory reservation

**Built in Objective 8.** Objective 7 can say _"a person must decide this"_.
This is where a person does — and where the stock they are deciding about stops
being available to anyone else.

## Part A — the approval gate

### An approval exists only when policy asked for one

The gate is the transaction's own state. Objective 7 puts a transaction into
`APPROVAL_REQUIRED` and nothing else does, so requiring that state is exactly
the rule _"create an approval only when the policy decision was
APPROVAL_REQUIRED"_ — expressed as persisted server truth rather than as a flag
a caller passes in. An `ALLOWED` purchase is already `AUTHORIZED`; a `BLOCKED`
one is terminal. Neither can reach the gate.

### What an approval is bound to

Every field is read from the database inside the same transaction that writes
the approval. The caller supplies a transaction id and an operation id, and
nothing else — there is no field for an amount a browser might prefer:

| Bound to       | Read from                                      |
| -------------- | ---------------------------------------------- |
| transaction    | the `APPROVAL_REQUIRED` transaction            |
| quote          | the transaction's one ACTIVE `PurchaseQuote`   |
| exact total    | `PurchaseQuote.totalAmount`                    |
| currency       | `PurchaseQuote.currency`                       |
| policy version | the recorded `policy_evaluated` audit event    |
| policy ceiling | the same audit event's `autoApproveLimitMinor` |
| buyer          | `Transaction.buyerProfileId`                   |

**An approval is transaction-scoped, never policy-changing.** Nothing in the
approval service writes to `AuthorizationPolicy`. Someone who agrees to a
₹4,000 keyboard has not raised their spending limit, and an approval for that
keyboard cannot authorize a different one — a test asserts the policy row,
including its version, is byte-for-byte unchanged after an approval.

### The token

- 256 bits from `crypto.randomBytes`, base64url. Not `Math.random`, not a
  counter, not derived from any id or timestamp — a test reads the source and
  asserts it.
- Stored as a **SHA-256 digest** in `ApprovalRequest.nonceHash` (`CHAR(64)`,
  unique). The plaintext is returned exactly once, from `requestApproval`, and
  appears in no other result, no audit event, no transition history and no log.
  Tests assert its absence from all three tables.
- Compared with `timingSafeEqual`. The index lookup finds the candidate; the
  constant-time comparison is what decides.
- Plain SHA-256, unsalted, deliberately: this is 256 bits of uniform randomness,
  not a password, so there is no dictionary for a slow KDF to defend against —
  and a deterministic digest is what lets a presented token be found by unique
  index instead of by scanning every open approval.

A repeated `requestApproval` returns `APPROVAL_ALREADY_PENDING` rather than
minting a replacement. Re-issuing would silently invalidate the token already
sent to the human, letting any repeated call cancel a pending approval. A
partial unique index enforces one PENDING approval per transaction.

### Expiry

The window closes at whichever comes first: the `APPROVAL_TTL_SECONDS` default
of 900s, **or the expiry of the quote it is bound to**.

The cap matters. Without it an approval outlives the price it exists to
authorize, so a person is shown fifteen minutes and discovers at minute six
that they never had them. Capping makes the deadline the system displays the
same as the deadline it enforces, and a test asserts the two timestamps are
equal.

The boundary is `now >= expiresAt` — inclusive, the same rule quotes and
reservations use. At the stamped instant the approval is already over.

Expiry is applied **lazily**, when something next looks at the transaction. A
control that depends on a cron job having run is wrong whenever the job is
late, and an expired approval must authorize nothing the instant it expires.

### Replay protection

One conditional `UPDATE` is the entire guard:

```sql
UPDATE approval_request SET status = 'CONSUMED', ...
 WHERE id = ... AND status = 'PENDING' AND "expiresAt" > now
```

PostgreSQL evaluates it under a row lock, so of two simultaneous uses of a token
exactly one matches; a token already consumed, rejected or expired matches
nothing. There is deliberately no "read the status, then update it" pair
anywhere in the service — that shape loses the race it is meant to win. A test
fires two approvals of the same token from two separate connections and asserts
exactly one `AUTHORIZED` and one `REFUSED`.

Rejection uses the existing lifecycle: `APPROVAL_REQUIRED --APPROVAL_REJECTED-->
CANCELLED`. No new transaction state was invented — `CANCELLED` is already the
word for a purchase a person refused.

## Part B — approval is not authorization

Consent is the beginning of the check, not the end. Between the question and the
answer a price can move, stock can vanish and a policy can be rewritten, so
after the token is settled the service re-reads everything:

```
token settled → re-read quote → re-read product → re-run policy engine → AUTHORIZED
```

| What changed                             | Refusal                  |
| ---------------------------------------- | ------------------------ |
| price, currency, stock, product version  | `QUOTE_NOT_USABLE`       |
| the transaction was re-quoted            | `QUOTE_MISMATCH`         |
| the live total no longer matches consent | `AMOUNT_MISMATCH`        |
| policy now refuses outright              | `POLICY_NOW_BLOCKS`      |
| the policy was revised                   | `POLICY_VERSION_CHANGED` |
| someone other than the buyer answered    | `NOT_THE_BUYER`          |

**A refusal rolls the settle back.** The token is consumed by the conditional
UPDATE at the top of the transaction, and throwing returns the approval to
`PENDING` along with everything else — so a person's one-time token is not
burned because the world moved while they were reading their phone. What burns a
token is a decision that was actually applied.

**The key semantic:** a human can supply the consent a policy was waiting for.
A human cannot supply consent for a purchase the policy now forbids outright.
Those are different questions, and `POLICY_NOW_BLOCKS` is the one nobody asked
them.

## Part C — inventory reservation

### A claim, not a sale

```
reservable = Product.inventory - Product.reservedQuantity
```

On-hand `inventory` does **not** move when stock is reserved. The unit is still
in the warehouse, and if the buyer walks away it was never sold. Collapsing the
two — decrementing inventory at reservation time — looks simpler and destroys
the ability to answer "how many do we actually have?", because an abandoned
checkout becomes indistinguishable from a sale.

### How overselling is prevented

Not by reading stock and then inserting a row: that pair has a gap, and under
two simultaneous requests the gap is where both succeed. Instead a single
conditional UPDATE claims the stock:

```sql
UPDATE product SET "reservedQuantity" = "reservedQuantity" + n
 WHERE id = ...
   AND "inventory" = <the figure we measured>
   AND "reservedQuantity" <= <inventory - n>
```

PostgreSQL takes a row lock for that statement and re-evaluates the `WHERE`
clause against the freshly committed row, so of two buyers racing for one unit
exactly one matches and the other updates nothing — a clean, reported refusal
rather than a second sale. Re-asserting `inventory` guards against a concurrent
commit selling a unit underneath the claim.

Two CHECK constraints stand behind it, so even a wrong version of the service
cannot write more reserved stock than exists:

```sql
CHECK ("reservedQuantity" >= 0)
CHECK ("reservedQuantity" <= "inventory")
```

**Why not `SELECT … FOR UPDATE`.** Equally correct in principle, but raw SQL
naming a table resolves through `search_path`, which in this project's isolated
test schema points at `public` — verified empirically. The lock would be taken
on the wrong row, silently. A conditional UPDATE through the ORM is
schema-correct everywhere and needs no raw SQL at all.

### Atomicity

The availability check, the reservation row, the `AUTHORIZED -->
INVENTORY_RESERVED` transition and its history row are **one** PostgreSQL
transaction. Every partial outcome is a lie the database would then tell
forever: a transaction reading `INVENTORY_RESERVED` while holding no stock would
send a buyer to pay for a unit nobody set aside, and a reservation whose
transaction never moved would hold stock away from real buyers with nothing to
release it.

### Expiry, release and commit

| Operation   | Effect                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| **expire**  | lazy, on the next attempt: `ACTIVE → EXPIRED`, `reservedQuantity` falls |
| **release** | `ACTIVE → RELEASED`, `reservedQuantity` falls                           |
| **commit**  | `ACTIVE → COMMITTED`, **both** `inventory` and `reservedQuantity` fall  |

All three are conditional UPDATEs from `ACTIVE`, which makes each of them
exactly-once and idempotent at the same time: only a transition that genuinely
moved the row returns a count of one, so the counter is adjusted once no matter
how many callers race. A second release is `ALREADY_SETTLED`, which is a
success — release runs on cancellation, payment failure and expiry, all paths
that are retried and replayed.

A **COMMITTED reservation cannot be released**: it is no longer `ACTIVE`, so
nothing matches and sold stock cannot be handed back into availability.

`RESERVATION_TTL_SECONDS` defaults to 600s — the checkout window.

### Commit is gated on evidence, not on a caller's word

`commitReservation` is the only operation in the system that decrements real
stock, and it refuses unless the transaction is in `PAYMENT_CAPTURED` or
`COMPLETED`. Nothing in Objectives 1–8 can put a transaction into either state,
which is the point: the operation exists for the payment workflow to call later
and is unusable until that workflow can honestly prove capture. It is called by
nothing today — no route, no tool, no service.

### What counts as a retry

`reserveInventory` treats a repeat as idempotent only when the transaction is in
`INVENTORY_RESERVED` and its hold has not lapsed. Every other state refuses,
including states that still own an ACTIVE reservation row: releasing is a
separate operation, so a cancelled, expired or payment-failed transaction still
holds one, and answering `RESERVED` for any of those would report that stock is
legitimately held for a purchase that is over.

### One live claim per transaction

A partial unique index permits at most one `ACTIVE` reservation per transaction,
so a retry cannot hold stock twice for a single purchase. Filtered, so the
history of `RELEASED`, `EXPIRED` and `COMMITTED` rows accumulates beside it.

Every reservation names the exact `PurchaseQuote` it is holding stock for. A
reservation that did not could be inherited by a re-quote at a different price,
holding stock for an amount nobody authorized.

## Security boundaries

- **No model-callable tool** for approving, consuming, reserving, releasing or
  committing. `FORBIDDEN_TOOL_NAMES` lists every variant and a test asserts
  none is registered.
- **The buyer agent cannot import either service** — asserted against the source
  of every buyer-agent module and route handler.
- **The browser expresses only APPROVE or REJECT**, plus the token. Amount,
  currency, quantity, policy outcome and transaction state are all read from
  persisted server state; the command types have no field for any of them.
- **The token never appears** in an audit event, a transition history row, a DTO
  or a log.

## Migration, and why

`20260831120000_approval_gate_and_inventory_reservation`:

1. `Product.reservedQuantity` plus its two CHECK constraints — the column the
   atomic claim operates on, defaulting to 0, which is correct for every
   existing and future product with no backfill.
2. `InventoryReservation.purchaseQuoteId` (NOT NULL, RESTRICT) — the table was
   empty, since Objective 8 is the first code that creates a reservation.
3. Partial unique index: one ACTIVE reservation per transaction.
4. Partial unique index: one PENDING approval per transaction.

**No new secret was required.** A high-entropy random token with a stored digest
needs no signing key at all, so no environment variable was added beyond two
optional, defaulted TTLs.

## What Objective 8 deliberately did not do

No Razorpay SDK, orders, checkout, signature verification, webhooks, real
payment capture or retry. No audit UI. `commitReservation` exists but is called
by nothing.
