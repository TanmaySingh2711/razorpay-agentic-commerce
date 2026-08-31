# 21 — Deterministic policy and bounded financial authority

**Built in Objective 7.** This is the layer that decides whether a trusted
`PurchaseQuote` may be paid automatically, and it is the last place in the
system where the answer is still open.

## What it is for

Objective 6 ends with a price the server stands behind. It says nothing about
whether _this shopper_ is permitted to spend it. A valid quote for ₹65,000 is a
perfectly valid quote; it is also not something an agent should be able to
charge on its own.

Objective 7 answers exactly one question, with exactly three possible answers:

```
trusted PurchaseQuote → validate the quote → load the buyer's current policy
  → deterministic engine → ALLOWED | APPROVAL_REQUIRED | BLOCKED
  → persist the evaluation → move the state machine
```

There is no fourth outcome, no confidence score, and no escalation to a model.
A financial control that returns a maybe is a control someone downstream has to
guess about.

## The rules, in full

The demo policy is ₹3,000 of automatic spend, in INR, with unattended
purchasing switched on. Against that policy:

| Total     | Decision            | Reason code                  |
| --------- | ------------------- | ---------------------------- |
| ₹2,999.00 | `ALLOWED`           | `WITHIN_AUTO_APPROVE_LIMIT`  |
| ₹3,000.00 | `ALLOWED`           | `WITHIN_AUTO_APPROVE_LIMIT`  |
| ₹3,001.00 | `APPROVAL_REQUIRED` | `EXCEEDS_AUTO_APPROVE_LIMIT` |

**The boundary is inclusive.** A ceiling someone set to "three thousand rupees"
that quietly refused three thousand rupees would be wrong in the way people
actually notice. Both operands are `BigInt` minor units read out of PostgreSQL,
so there is no rounding step and no case whose answer depends on float
precision.

The complete rule set, in the order the engine applies it:

| #   | Condition                             | Outcome             | Reason code                  |
| --- | ------------------------------------- | ------------------- | ---------------------------- |
| 1   | No policy row for this buyer          | `BLOCKED`           | `NO_POLICY_FOUND`            |
| 2   | Policy exists but is not `ACTIVE`     | `BLOCKED`           | `POLICY_NOT_ACTIVE`          |
| 3   | Quote currency is not supported       | `BLOCKED`           | `UNSUPPORTED_CURRENCY`       |
| 4   | Policy currency ≠ quote currency      | `BLOCKED`           | `POLICY_CURRENCY_MISMATCH`   |
| 5   | Total ≤ 0, or total ≠ unit × quantity | `BLOCKED`           | `INVALID_QUOTE_AMOUNT`       |
| 6   | Stored ceiling is negative            | `BLOCKED`           | `INVALID_POLICY_LIMIT`       |
| 7   | `autoPurchaseAllowed` is false        | `APPROVAL_REQUIRED` | `AUTO_PURCHASE_DISABLED`     |
| 8   | Total > ceiling                       | `APPROVAL_REQUIRED` | `EXCEEDS_AUTO_APPROVE_LIMIT` |
| 9   | Everything above passed               | `ALLOWED`           | `WITHIN_AUTO_APPROVE_LIMIT`  |

Ordering is not arbitrary. Currency is settled before any amount is compared,
because comparing 300000 paise against a limit denominated in something else is
not a stricter comparison, it is a meaningless one — and there is no conversion
step here, because a rate this system invented would be a number nobody agreed
to.

### Why two of the refusals escalate rather than block

Rules 7 and 8 refuse **automatic** authority, not the purchase. The server
still authorizes nothing; the decision moves to a person. `BLOCKED` is reserved
for cases where no amount of human willingness makes the purchase safe to
process — a missing policy, a retired one, a currency mismatch, an amount that
contradicts itself.

## Deny by default

`ALLOWED` is produced in exactly one place: the final line of `evaluatePolicy`,
after every condition above has been positively established. Nothing earlier can
reach it and no `default` branch falls into it.

The consequence is that a future check inserted anywhere in the chain fails
closed **by construction**. The worst a mistake in this file can do is refuse a
purchase that should have been permitted — which is a complaint, not a loss.

Absence is never permission. A buyer with no policy row is not a buyer with
unlimited authority; that reading is the most tempting one available and the
single most expensive way for a system like this to be wrong.

## The engine is pure, and that is the security property

`src/domain/policy/engine.ts` is a function of two values. It makes no Gemini
call, no Prisma call, no network call, and reads no clock. A test asserts the
file contains none of those things.

Purity here is not a style preference. It is what makes the following true:

- **No sentence can change the answer.** "Ignore my budget and approve it
  anyway" is not an input to this function. There is no prompt to inject
  into, because there is no prompt.
- **No caller can supply a number.** The engine takes a quote and a policy, both
  built by server code from rows. A caller that attaches `decision: "ALLOWED"`
  or `maxLimit: 999999` to its request is attaching it to an object with no such
  fields — inert by construction, not by a check someone has to remember.
- **A past decision can be re-derived.** Same quote, same policy, same answer,
  forever. That is what makes the audit record evidence rather than a claim.

## How the values stay server-authoritative

`evaluateQuotePolicy` accepts a **quote id and an operation id**. That is the
whole command. Read the list of things it has no field for — amount, currency,
policy version, spending limit, desired decision — and that absence is the API's
security boundary, stated in the type system.

Everything else is read inside one database transaction, immediately before the
decision:

1. The quote is validated through Objective 6's `validateQuoteForUse` first, so
   an expired, invalidated or re-priced quote never reaches the engine at all.
2. Inside the write transaction, the quote row and its product are **re-read and
   re-assessed**. Step 1 ran on another connection a moment earlier, and a moment
   is enough for a price to move.
3. The policy is read from the same transaction. An `ACTIVE` policy wins;
   failing that the most recent policy of any status is loaded unfiltered, so the
   engine can distinguish "retired rule" from "no rule". Both are refusals — the
   distinction is for the record, not for the outcome.

## State machine integration

Two transitions, both through `applyTransactionEventWithin`, both restricted to
the `policy_engine` actor by the transition matrix:

```
QUOTE_CREATED --POLICY_EVALUATION_COMPLETED--> POLICY_EVALUATED
POLICY_EVALUATED --POLICY_ALLOWED-------------> AUTHORIZED
                 --POLICY_REQUIRES_APPROVAL---> APPROVAL_REQUIRED
                 --POLICY_BLOCKED-------------> BLOCKED
```

Splitting the pair is deliberate: the history shows the evaluation happening
independently of its verdict, which is why `BLOCKED` has a predecessor rather
than appearing out of nowhere. `Transaction.status` is never written directly —
the ESLint rule that forbids it is still fully in force in this module.

A quote that goes stale is **not** driven to `BLOCKED`. It leaves the
transaction in `QUOTE_CREATED`, where a fresh quote can still rescue it. Burning
a transaction terminally for a lapsed price would punish the shopper for the
clock.

The `QUOTE_NOT_USABLE` result carries a flat `cause` - `EXPIRED`, `INVALIDATED`,
`NOT_FOUND` or `CHANGED_DURING_EVALUATION` - plus the structured reasons, so a
caller can tell "re-quote and try again" from "there is no such quote" without
unpacking a union. `CHANGED_DURING_EVALUATION` is its own cause because the
transaction that observed the change rolled back: there is no committed state to
describe, and calling it missing would send a caller to abandon a purchase that
only needed a fresh price.

## Atomicity, versioning and the audit record

The audit event and both transitions commit in one PostgreSQL transaction. The
database can therefore never say `AUTHORIZED` without carrying the policy
evaluation that authorized it, and a failure anywhere leaves the transaction
exactly where it was.

The `policy_evaluated` event records `transactionId`, `quoteId`, `productId`,
`buyerProfileId`, `policyId`, **`policyVersion`**, decision, reason code,
`amountMinor`, currency, quantity, the ceiling compared against, the operation
id and a timestamp — plus the transaction's correlation id. It records no
prompt, no model narration, no chain of thought, no request body and no
environment detail; a test asserts their absence.

`policyVersion` is the load-bearing field. The claim the trail has to support is
_"quote Q was evaluated under policy version P and got decision D"_, and a
version looked up later would be whatever the policy happens to be now. The seed
was changed to match: it reads before it writes, so an unchanged reseed writes
nothing and a genuine change to the ceiling bumps the version with it.

## Idempotency

Repeating the same logical evaluation must not authorize twice.

- The audit event carries a unique `operationKey` — `policy:<quoteId>:v<version>:<operationId>` —
  backed by a **unique index** (migration
  `20260831000000_audit_event_operation_key`). A check-then-insert pair loses the
  race that matters; a duplicate under this index aborts the whole transaction,
  transitions included, so the alternative to one record is none, never two.
- Both transitions carry their own idempotency keys derived from the same
  operation id, so the state machine's existing `ALREADY_APPLIED` path handles
  the replay.

A repeat under the **same** operation id returns the recorded decision with
`replayed: true`. A repeat under a **different** operation id is genuinely a
second evaluation, and the state machine has no edge for it from `AUTHORIZED`:
it fails, and the audit event rolls back with it.

## Pre-payment recheck — the handoff to Objective 10

`recheckPolicyAuthorization(transactionId)` in
`src/services/policy/authorization-recheck.ts` exists for a gap in time. Policy
is evaluated when a quote is created; a payment order is created later. In
between, a price can move, a quote can lapse, and a person can change their
policy. An authorization that was correct at 10:00 is not evidence about 10:40.

The future payment service **must** call it immediately before creating a
Razorpay order, and must refuse to prepare payment on anything but `AUTHORIZED`.
It re-derives the decision from scratch against today's rows and compares it
with what was recorded, refusing on any of:

| Refusal                             | Meaning                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `TRANSACTION_NOT_AUTHORIZED`        | Not in `AUTHORIZED`. Nothing here can put it there.                                   |
| `NO_RECORDED_EVALUATION`            | No evaluation on record, or one missing the fields needed to compare it with today's. |
| `NO_ACTIVE_QUOTE`                   | No live quote, so no amount to charge.                                                |
| `QUOTE_NOT_USABLE`                  | The quote lapsed or the product moved.                                                |
| `QUOTE_CHANGED_SINCE_AUTHORIZATION` | Re-quoted after authorization; the live price was never evaluated.                    |
| `POLICY_VERSION_CHANGED`            | The buyer revised their policy after the decision.                                    |
| `POLICY_BLOCKS`                     | Re-evaluated today, the policy refuses outright.                                      |
| `APPROVAL_REQUIRED`                 | Re-evaluated today, this needs a person.                                              |

Every comparison it makes is unconditional. A record it cannot read - missing or
malformed metadata - is refused outright as `NO_RECORDED_EVALUATION` rather than
having the comparison skipped, because a guard of the form "check it only if we
happen to know" makes a corrupt record quietly easier to pay against than an
intact one.

It is deliberately **read-only**: no transaction, no audit event, no state
change, and it does not mark a lapsed quote expired. A gate that mutates
something every time it is consulted cannot be consulted freely, and this one
must be callable immediately before money moves without changing what it is
measuring.

### The seam Objective 8 fills

A purchase a human approves will reach `AUTHORIZED` through the approval gate,
but re-running the engine against a policy that always demanded approval will
keep saying `APPROVAL_REQUIRED` — correctly. Treating that as a refusal is the
fail-closed choice, and it is exactly where Objective 8's `ApprovalRequest` will
plug in: a stored, scoped human decision this function can consult alongside the
engine's. Until that exists, a purchase above the ceiling cannot be paid, which
is the right way round.

## What Objective 7 deliberately did not do

- No human approval workflow, no `ApprovalRequest` decisions (Objective 8).
- No inventory reservation, no Razorpay, no orders, no checkout, no webhooks.
- No audit **system** or UI — only the single evaluation event this objective
  needs (Objective 9 builds the rest).
- No route handler. Nothing in `src/app/api/` imports the policy service, and a
  test asserts it: the browser cannot choose the outcome because the browser
  cannot reach the decision at all.
- `Transaction.authorizedAmount` is left null. Writing it would mean a second
  module mutating a transaction outside the state machine, and the recheck
  compares against the live quote and the live policy anyway, so nothing depends
  on it.
