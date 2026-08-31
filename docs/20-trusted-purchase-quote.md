# 20 — Product decision and the trusted PurchaseQuote

**Built in Objective 6.** This is the boundary between _"the AI picked product
X"_ and _"the server will put a price behind product X"_.

## What it is for

Objective 5 ends with a proposal: a validated, provider-neutral
`BuyerAgentDecision` naming a product the model believes fits. That proposal is
trusted to mean **"this is what the AI suggested"** and nothing more. It is not
trusted for price, stock, currency, availability, or product version.

Objective 6 turns it into a persisted `PurchaseQuote` — a financial snapshot
created entirely by deterministic server code from a row read out of PostgreSQL.

```
Gemini → selectedProductId                     UNTRUSTED PROPOSAL
  → server retrieves its OWN candidates        (Objective 4 catalog)
  → deterministic hard-constraint filter
  → proposed id must belong to that set
  → FRESH re-fetch of the selected product
  → authoritative verification
  → PurchaseQuote                              TRUSTED SNAPSHOT
```

Those layers are never collapsed. The model cannot originate a unit price, a
total, a currency, a stock level, a product version, an expiry, or a quote
status.

## Input contract

Consumed from Objective 5, all of it application-owned:

`correlationId` · `requestType` · `quantity` · `maxBudget` (minor-unit string +
currency) · `budgetScope` · `hardRequirements` · `softPreferences` ·
`selectedProductId` · structured decision reasons.

### Budget scope — a prerequisite safety correction

Objective 5 carried a maximum budget but not what it applied to. _"Buy 2
keyboards under ₹3000 **each**"_ and _"buy 2 keyboards, ₹3000 **total**"_ are
₹6000 and ₹3000, and nothing about the number distinguishes them.

So `BudgetScope` (`PER_UNIT` | `TOTAL`) was added to the intent schema, the
Gemini response schema, the locked authority and the normalized constraints.
At quantity 1 the two are identical and no decision is needed. Above 1 an
unresolved scope is a **question, not a default** — the agent asks, and Objective
6 refuses independently as a backstop.

## Flow

| Step | What happens                                                                  | Trust      |
| ---- | ----------------------------------------------------------------------------- | ---------- |
| 1    | `BROWSE`/`RECOMMEND` return `NO_QUOTE_REQUIRED`, opening nothing              | —          |
| 2    | Transaction opened via the Objective 3 creation boundary at `INTENT_RECEIVED` | server     |
| 3    | Candidates retrieved from the Objective 4 catalog service, in-process         | PostgreSQL |
| 4    | Deterministic hard filtering                                                  | pure code  |
| 5    | `selectedProductId` must belong to the server's eligible set                  | server     |
| 6    | `PRODUCT_SELECTED` then `PRODUCT_VERIFIED` via the state machine              | server     |
| 7    | Fresh re-fetch, quote and `QUOTE_CREATED` — one atomic commit                 | PostgreSQL |

**Step 3 is easy to mistake for redundant.** The agent already searched the
catalog, so re-querying looks wasteful — but the agent's list came back through
a model's context, and a set the server did not build is a set the server cannot
vouch for. Only because the server built the set does step 5 mean anything.

**No Gemini call happens in Objective 6.** Objective 5's validated output is
consumed as data. Asking a model to redo work the database can settle would
spend quota to make the decision less trustworthy.

## Deterministic filtering

Every candidate is judged by arithmetic, in a fixed order, in
[`eligibility.ts`](../src/domain/product-decision/eligibility.ts):

`WRONG_CATEGORY` · `CURRENCY_MISMATCH` · `NOT_PURCHASABLE` ·
`INSUFFICIENT_INVENTORY` · `OVER_BUDGET` · `UNMET_HARD_REQUIREMENT`

Currency is settled before money, because comparing amounts across currencies is
meaningless rather than merely wrong. All failing reasons are collected, so a
shopper is told the product is out of stock _and_ over budget rather than
discovering the second after fixing the first.

Hard requirements are checked against **structured attributes and category
only** — never a name or description. A listing that says "wonderfully
mechanical" is marketing copy, and merchant copy has never been evidence here.

### Requirements the server cannot check

A hard requirement naming something the catalog carries no field for — "must be
good for gaming" — cannot be settled from structured data, and the model's
belief that a product satisfies it is an opinion. Rather than ignore it (a quote
the shopper did not ask for) or trust the model (a hard constraint decided by
AI), the result is `HARD_REQUIREMENT_UNVERIFIABLE` and the shopper is asked.

## Money

Integer minor units end to end, `bigint` throughout.

```
PostgreSQL Product.unitAmount (BIGINT) → unitAmountMinor
unitAmountMinor × quantity            → totalAmountMinor
```

₹2,799 is `279900`; two of them are `559800`. The multiplication never passes
through a JavaScript number, so there is no rounding step and no precision loss
at the top of the range. A database CHECK constraint independently enforces
`totalAmount = unitAmount × quantity`.

Budget comparison depends on scope: `PER_UNIT` compares `unitAmountMinor`,
`TOTAL` compares `totalAmountMinor`. The two are never mixed.

## The quote

```json
{
  "status": "QUOTE_CREATED",
  "transactionId": "01930000-…",
  "quote": {
    "id": "01930000-…",
    "productId": "01930000-…",
    "quantity": 1,
    "unitAmount": { "amountMinor": "279900", "currency": "INR" },
    "totalAmount": { "amountMinor": "279900", "currency": "INR" },
    "currency": "INR",
    "productVersion": 1,
    "status": "ACTIVE",
    "createdAt": "2026-06-01T10:00:00.000Z",
    "expiresAt": "2026-06-01T10:05:00.000Z"
  },
  "selectionReasons": ["WITHIN_BUDGET", "CURRENCY_MATCH", "IN_STOCK"]
}
```

Amounts cross the wire as decimal strings of minor units: `JSON.stringify`
throws on a `bigint`, and a JSON number would lose precision. No raw Prisma row
is ever returned.

Selection reasons are a closed vocabulary, every code corresponding to a check
that actually ran. No model narration, and no chain-of-thought, is stored or
returned.

## Expiry

TTL comes from `QUOTE_TTL_SECONDS` (default **300s**), one centralized value —
never a duration written at a call site.

**The boundary is `now >= expiresAt`: at the exact stamped millisecond the quote
is already expired.** An inclusive boundary would leave a one-millisecond window
whose behaviour depends on clock resolution, and a financial rule that is
ambiguous for a millisecond is one somebody eventually lands on.

Expiry is computed from the clock at the moment of use, **not** from the stored
status column. A status column is only as current as whatever last wrote it, and
there is deliberately no background job — a payment path must never depend on a
scheduler having run.

Time is injected ([`clock.ts`](../src/lib/clock.ts)), so tests hit the boundary
exactly without sleeping.

> A bug the database caught: `createdAt` originally fell through to the
> PostgreSQL default while `expiresAt` came from the application clock, so a
> quote's lifetime was measured between two different time sources. The
> `expiresAt > createdAt` CHECK constraint surfaced it. Both ends now come from
> the same clock.

## Validation

`validateQuoteForUse(quoteId)` is the single boundary Objectives 7–10 call
before relying on a quote. It re-reads the product every time and returns
`VALID` · `EXPIRED` · `INVALIDATED` (with reasons) · `NOT_FOUND`.

| Change                           | Reason                      | Behaviour                                                             |
| -------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| Price differs — either direction | `PRICE_CHANGED`             | Quote unusable; amount never rewritten                                |
| Currency differs                 | `CURRENCY_CHANGED`          | Unusable; **no FX conversion, ever**                                  |
| Stock below quoted quantity      | `INSUFFICIENT_STOCK`        | Unusable; stock is **not** modified                                   |
| Product unpublished/out of stock | `PRODUCT_UNAVAILABLE`       | Unusable                                                              |
| `Product.version` bumped         | `PRODUCT_VERSION_CHANGED`   | Unusable — catches attribute changes the field comparisons cannot see |
| A newer quote replaced it        | `SUPERSEDED_BY_NEWER_QUOTE` | Unusable                                                              |

A price _decrease_ invalidates too. The snapshot froze a specific amount;
re-pricing it in either direction would make the record a lie about what was
promised.

Version policy is deliberately conservative: any change to `Product.version`
invalidates, because a change we cannot see in the fields we compare is still a
change we did not quote for.

Validation writes only the quote's `status` and `invalidatedAt` — never its
financial fields, and never inventory.

## Immutability and re-quoting

A quote's financial snapshot is immutable. When the world moves — the price
changes, stock falls, the product is edited — the old quote is **retired and
replaced**, never rewritten. It is a record of a price the merchant once stood
behind, and overwriting it would destroy the history that makes a disputed
charge explicable.

`createTrustedQuote({ …, replaceExisting: true })` performs the replacement
in one transaction: supersede the active quote, insert the new one, record the
lifecycle event. Without the flag the call is idempotent and returns the
existing quote — so an ordinary retry can never silently re-price an order the
shopper is already looking at.

### The re-quote transition

`QUOTE_CREATED --QUOTE_ISSUED--> QUOTE_CREATED` is the matrix's only self-loop.

The transaction has not progressed: it is still in the quoting phase, just with
a different price. Inventing a new state to mean "still quoting, but again"
would model a phase that does not exist, so staying put is the truthful
description. Each pass writes its own history row with the `QUOTE_REISSUED`
reason code, so a re-price is fully auditable, and the edge is restricted to
`quote_service` — no agent, user or provider can ask for one.

### One payable quote, enforced by PostgreSQL

A **partial unique index** permits at most one `ACTIVE` quote per transaction:

```sql
CREATE UNIQUE INDEX "purchase_quote_one_active_per_transaction"
  ON "purchase_quote" ("transactionId")
  WHERE "status" = 'ACTIVE';
```

Two rows both marked `ACTIVE` would mean two competing prices are simultaneously
payable — exactly the ambiguity a trusted quote exists to remove — and
application ordering alone cannot prevent that under concurrency. Because the
index is filtered, the full history of `SUPERSEDED`, `EXPIRED`, `INVALIDATED`
and `CONSUMED` quotes accumulates untouched beside the one live row. A test
bypasses the service entirely and asserts the database refuses the second
insert.

## Atomicity

Three things must become true together:

- the `PurchaseQuote` row exists,
- the `Transaction` reads `QUOTE_CREATED`,
- a `TransactionStateTransition` records why.

A database holding any two without the third is a financial record that
contradicts itself. So all three happen in **one PostgreSQL transaction**.

This required the smallest possible change to Objective 3: the transition logic
was extracted so it can run against a caller-owned transaction client, exposed
as `applyTransactionEventWithin`. The state machine is **lent** to the quote
service's transaction, never bypassed — same matrix, same actor check, same
conditional update, same history row. Nothing is duplicated, and
`Transaction.status` is still never written directly.

A side effect of moving the read inside the transaction: two racing events are
now adjudicated sequentially where they do not overlap, rather than one being
refused outright. Both outcomes are safe, and the concurrency tests assert the
invariant — **one departure from any given state** — rather than which of the two
safe paths the scheduler took.

## Idempotency and concurrency

The buyer-agent `correlationId` is the operation identity. `Transaction.correlationId`
carries a **unique index** (the objective's one migration), so:

- a retry finds the existing transaction rather than opening a second purchase;
- two _simultaneous_ retries are separated by PostgreSQL rather than by
  application timing — the losing INSERT is rejected and that caller falls back
  to the existing row.

Each lifecycle step carries a derived idempotency key
(`{correlationId}:product-selected`, `:product-verified`, `:quote-issued`), so a
replay writes no second history row. `createTrustedQuote` also returns an
existing ACTIVE quote rather than creating a second one.

Tested against real PostgreSQL, not mocks.

## What a quote is **not**

**Not an authorization.** A valid quote says the server confirms these product
facts at this moment. It says nothing about whether this shopper may spend that
much — that is Objective 7's policy decision. A quote well above any future
auto-approval limit is still a perfectly valid quote, and Objective 6 does not
block one for that reason.

**Not an inventory reservation.** Quoting reads stock; it does not hold it.
Between quoting and paying, someone else may buy the last unit. A test asserts
`Product.inventory` is unchanged after a quote is created, and that no
`InventoryReservation` row appears. Holding stock is Objective 8.

## Results

`QUOTE_CREATED` · `NO_QUOTE_REQUIRED` · `CLARIFICATION_REQUIRED` ·
`HARD_REQUIREMENT_UNVERIFIABLE` · `NO_VALID_CANDIDATE` · `AI_SELECTION_REJECTED`
· `REEVALUATION_REQUIRED`

A discriminated union — no shape carries a half-built quote. Business refusals
are branches, not exceptions; only genuine infrastructure failures throw, and
Prisma errors, SQL and connection details never escape.

### On not blocking the transaction

When the product changes between selection and the authoritative read, the
result is `REEVALUATION_REQUIRED` and the transaction is left at
`PRODUCT_SELECTED`. It is deliberately **not** driven to `BLOCKED` via
`PRODUCT_VERIFICATION_FAILED`: that edge is terminal, and it exists for "the
server proved the agent's claim wrong". A price moving between two reads is not
the agent lying — it is the world moving — and blocking terminally would destroy
the ability to re-quote.

## The Objective 7 handoff

Objective 7 receives a **currently valid trusted PurchaseQuote** and evaluates
the persisted row. It never needs to trust a Gemini price, a client price, or a
stale catalog price — it calls `validateQuoteForUse` and reads
`unitAmount`/`totalAmount`/`currency` off the quote.

## What Objective 6 deliberately does not implement

No `AuthorizationPolicy` evaluation, no spending limits, no auto-approval, no
`ApprovalRequest`, no `InventoryReservation`, no Razorpay, no payment order, no
checkout, no signature verification, no webhooks, no reconciliation, no retry
policy, no background scheduler, and no distributed locking.
