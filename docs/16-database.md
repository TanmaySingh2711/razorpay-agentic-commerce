# 16 — Database and persistence

**Implemented in Objective 2.** Entity _design_ rationale lives in
[08 — Data model](./08-data-model.md); this document covers what actually
exists: the Prisma setup, the connection architecture, the migration and seed
workflow, and the test isolation strategy.

## Stack

| Decision | Value                       | Why                                                                                                       |
| -------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Database | **PostgreSQL**              | Real transactional semantics, CHECK constraints, enums, BIGINT — every one of which this design leans on. |
| Hosting  | **Prisma Postgres**         | Managed, with separate pooled and direct endpoints.                                                       |
| ORM      | **Prisma 7.10.0**           | Current stable GA.                                                                                        |
| Driver   | `@prisma/adapter-pg` + `pg` | Prisma 7 requires a driver adapter.                                                                       |
| Runtime  | Node.js 24 LTS              | Prisma 7.10 engines allow `>=24.0`.                                                                       |

### Why 7.10.0 and not "latest"

At implementation time `prisma@latest` resolved to **`8.0.0-rc.12`** — a
release candidate. `prisma@8.0.0` GA does not exist on npm (404), and
`@prisma/client@latest` was still `7.10.0`. Prisma 7 remains supported. Since a
payment system should not run on a release candidate, this project pins the
7.10.0 GA line. The CLI prints an "update available → 8.0.0-rc.12" banner; that
is expected and should not be acted on until Prisma 8 reaches GA.

## Two connections, two jobs

Prisma Postgres issues two connection strings that share credentials and differ
only by hostname. They are not interchangeable:

| Variable       | Host                  | Used by                               | Why                                                                                   |
| -------------- | --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL` | `pooled.db.prisma.io` | Application runtime                   | Reuses a small connection set, so serverless invocations cannot exhaust PostgreSQL.   |
| `DIRECT_URL`   | `db.prisma.io`        | Migrations, seed, verification, tests | Connection poolers generally cannot run DDL, and admin work needs session continuity. |

The failure modes are asymmetric, which is what makes getting this wrong
dangerous: a pooled URL used for migrations fails loudly, but a direct URL used
for application traffic _works fine at low concurrency_ and silently exhausts
connections under load.

Wiring:

- **Runtime** — [`src/integrations/persistence/client.ts`](../src/integrations/persistence/client.ts)
  builds `PrismaPg` from `DATABASE_URL`, via the typed config boundary.
- **CLI** — [`prisma.config.ts`](../prisma.config.ts) sets `datasource.url` from
  `DIRECT_URL`. In Prisma 7 the URL lives here, not in `schema.prisma`.

## The persistence boundary

One file, [`client.ts`](../src/integrations/persistence/client.ts), is the
application's only database entry point. It is responsible for three things:

1. **Server-only.** A `typeof window` guard throws if the module is ever
   evaluated in a browser bundle — a loud failure at the boundary instead of
   silently shipped credentials. Verified: no database host, username, or
   Prisma symbol appears in `.next/static/`.
2. **Pooled connection.** Runtime queries only.
3. **One client per process.** Cached on `globalThis` so Next.js dev
   hot-reload cannot open a new pool on every edit until PostgreSQL refuses
   connections.

The client is created **lazily**, so importing this module never requires a
database. That is what keeps the Objective 1 foundation bootable, buildable and
testable with no credentials at all.

## Identifiers

Every entity uses **UUIDv7** (`@default(uuid(7))`): collision-resistant, and
time-ordered, so primary-key inserts stay index-friendly rather than scattering
writes across the B-tree the way UUIDv4 does.

External provider identifiers are **never** primary keys. A Razorpay order id
or payment id is an ordinary nullable reference column on `PaymentAttempt`
(`providerOrderId`, `providerPaymentId`), and a webhook's event id is a
reference column on `WebhookEvent`. Coupling an internal key to a vendor's
identifier space would make the vendor impossible to change and would leak
provider semantics into every foreign key in the system.

## Money

Stored as **PostgreSQL `BIGINT` minor units plus an explicit `CHAR(3)`
currency**. ₹2,499.00 is `249900`. There is no `NUMERIC` column and no float
anywhere in the schema.

### The BigInt serialization rule

Prisma surfaces `BIGINT` as a JavaScript `bigint`. Two hazards follow, and both
are handled in [`money.ts`](../src/domain/money.ts):

- **`JSON.stringify` throws on a `bigint`.** So amounts cross the API boundary
  as a `MoneyDto` — `{ amountMinor: string, currency }` — a decimal _string_,
  never a JSON number. The field is named `amountMinor`, never `amount`, so a
  consumer cannot mistake paise for rupees.
- **`Number(bigint)` does not throw past `MAX_SAFE_INTEGER`; it silently
  returns a different value.** `moneyFromBigInt()` therefore range-checks before
  narrowing and throws a `ValidationError` rather than rounding. The limit is
  not a practical constraint — `MAX_SAFE_INTEGER` paise is about ninety trillion
  rupees — but silently wrong money is the one outcome this system may never
  produce.

`moneyFromBigInt` / `moneyToBigInt` are the only sanctioned crossings between
the database representation and the domain `Money` type. Objective 1's `Money`
was extended rather than duplicated: there is still exactly one money module.

## Currency

An uppercase ISO-4217 code in a `CHAR(3)` column, guarded by a CHECK constraint
(`~ '^[A-Z]{3}$'`) and by `currencyCodeSchema` in the domain. Deliberately **not**
a PostgreSQL enum: only INR is supported today, but adding a currency later
should be a data change, not a migration against a locked type. The rupee sign
is never stored; currency is never inferred from locale.

## Transaction identity vs provider identity

A `Transaction` is the internal aggregate — it exists from `INTENT_RECEIVED`,
before any product, quote, amount or provider order. It is **not** a Razorpay
order and **not** a Razorpay payment. One transaction owns many
`PaymentAttempt` rows, because a failed payment is retried against the same
authorization. Provider identifiers live on those attempts.

This is why `Transaction.productId`, `authorizedAmount` and `currency` are all
nullable: requiring them would make it impossible to create the row at the
moment the flow actually starts.

## Enum parity with the domain

`TransactionStatus` and `TransactionActor` exist in two places — the Prisma
schema (PostgreSQL needs them as DDL) and
[`states.ts`](../src/domain/transaction/states.ts) (the authoritative domain
list). Prisma schema cannot import TypeScript, so the binding is enforced by
[`tests/db/enum-parity.test.ts`](../tests/db/enum-parity.test.ts), which
compares the generated enum against the domain constant and fails the build on
any drift. The domain file remains the source of truth; the schema follows it.

## Referential actions

**Every** foreign key is `ON DELETE RESTRICT ON UPDATE CASCADE` — 16 of them,
with zero cascades or set-nulls. Financial history must not vanish because
someone deleted a product.

Practical consequences, all tested: a `Product` referenced by a quote cannot be
deleted; a `Transaction` with audit events cannot be deleted; a `Merchant` with
products cannot be deleted. Demo business entities are **deactivated** via
`status` instead (`MerchantStatus.INACTIVE`, `ProductStatus.DISCONTINUED`).

## CHECK constraints

Prisma's schema language cannot express these, so they are appended to the
migration by hand — a deliberate, reviewed customization. They hold against a
direct `psql` session and a buggy service alike, which is precisely when they
matter. **26 CHECK constraints** are live:

| Invariant                                          | Applies to                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| currency matches `^[A-Z]{3}$`                      | product, policy, quote, payment attempt, approval, transaction (nullable)                                      |
| amount `>= 0`                                      | product price, policy limit, quote unit + total, payment amount, approval amount + snapshot, authorized amount |
| `inventory >= 0`                                   | product                                                                                                        |
| `quantity > 0`                                     | quote, reservation                                                                                             |
| **`totalAmount = unitAmount * quantity`**          | quote                                                                                                          |
| `version > 0`, `attemptNumber > 0`, `sequence > 0` | product, policy, payment attempt, transition                                                                   |
| `expiresAt > createdAt`                            | quote, reservation, approval                                                                                   |
| only `sequence = 1` may have a null `fromStatus`   | transition                                                                                                     |

The quote-arithmetic constraint is the notable one: a bug in quote construction
cannot persist a total that disagrees with unit price times quantity.

## Uniqueness

| Constraint                                                                      | Purpose                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------- |
| `merchant.slug`                                                                 | Stable public merchant handle               |
| `product (merchantId, sku)`                                                     | SKUs are merchant-scoped, not global        |
| `payment_attempt (transactionId, attemptNumber)`                                | Attempts are ordered and non-duplicated     |
| `payment_attempt (provider, providerOrderId)` / `(provider, providerPaymentId)` | One attempt per provider reference          |
| `payment_attempt.idempotencyKey`                                                | Future at-least-once retry safety           |
| `approval_request.nonceHash`                                                    | One-time approval tokens cannot be replayed |
| `webhook_event (provider, externalEventId)`                                     | **Webhook idempotency**                     |
| `transaction_state_transition (transactionId, sequence)`                        | Unambiguous history ordering                |

Two deliberate uses of PostgreSQL's NULL semantics: NULLs are distinct in a
unique index, so many payment attempts may exist with no provider reference yet
(tested), and webhook uniqueness is `(provider, externalEventId)` rather than
the event id alone — an event id is only unique within the provider that issued
it.

## Indexes

Every index maps to a realistic query or an integrity requirement; none exists
merely because a column does.

| Index                                                                   | Query it serves                              |
| ----------------------------------------------------------------------- | -------------------------------------------- |
| `product (merchantId, category)`                                        | Agent-readable catalog browsing by category  |
| `product (merchantId, status)`                                          | Filtering to purchasable stock               |
| `transaction (buyerProfileId, createdAt)`                               | A buyer's transaction history                |
| `transaction (merchantId, createdAt)`                                   | Merchant-side history                        |
| `transaction (status)`                                                  | Sweeping for stuck or expiring transactions  |
| `purchase_quote (transactionId, status)`                                | Finding the live quote                       |
| `purchase_quote (status, expiresAt)`                                    | Quote expiry sweeper                         |
| `inventory_reservation (transactionId, status)` / `(productId, status)` | Reservation lookup; stock held per product   |
| `inventory_reservation (status, expiresAt)`                             | Reservation expiry sweeper                   |
| `payment_attempt (transactionId, status)`                               | Attempt history                              |
| `approval_request (transactionId, status)` / `(purchaseQuoteId)`        | Pending approvals for a transaction or quote |
| `approval_request (status, expiresAt)`                                  | Approval expiry sweeper                      |
| `transaction_state_transition (transactionId, createdAt)`               | Reconstructing a lifecycle                   |
| `audit_event (transactionId, createdAt)`                                | The user-facing audit timeline               |
| `audit_event (eventType, createdAt)`                                    | Investigating one class of event             |
| `webhook_event (transactionId)` / `(status, receivedAt)`                | Reconciliation and retry sweeps              |

## JSON policy

JSONB is used in exactly three places, all genuinely open-ended and all
application-validated before write: `Product.attributes`, `AuditEvent.metadata`,
`TransactionStateTransition.details`. Nothing relational is stored in JSON —
never status history, payment attempts, approvals, or relationships.

## Migrations applied

| Migration                                  | Why                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init_persistence_foundation`              | Objective 2: the twelve models, enums, constraints and indexes                                                                                                                                                                                                                                                                                                         |
| `add_transition_idempotency_key`           | Objective 3: `(transactionId, idempotencyKey)` on the transition history                                                                                                                                                                                                                                                                                               |
| `transaction_correlation_id_unique`        | Objective 6: one logical request opens at most one transaction. PostgreSQL exempts NULL, so flows without a correlation id are unaffected. See [20](./20-trusted-purchase-quote.md).                                                                                                                                                                                   |
| `single_active_quote_per_transaction`      | Objective 6: a partial unique index permitting one ACTIVE `PurchaseQuote` per transaction, so two prices can never be payable at once. Filtered, so superseded and expired history accumulates freely.                                                                                                                                                                 |
| `audit_event_operation_key`                | Objective 7: a unique `operationKey` on `AuditEvent`, so repeating one logical policy evaluation converges on the record that already exists instead of authorizing twice. NULL is exempt, so events with no operation identity are unaffected. See [21](./21-policy-engine.md).                                                                                       |
| `approval_gate_and_inventory_reservation`  | Objective 8: `Product.reservedQuantity` with CHECK constraints so a single conditional UPDATE can prevent overselling; `InventoryReservation.purchaseQuoteId` binding stock to the exact quote; partial unique indexes permitting one ACTIVE reservation and one PENDING approval per transaction. See [22](./22-approval-and-inventory.md).                           |
| `payment_order_receipt_and_reconciliation` | Objective 10: `PaymentAttempt.receipt`, unique and CHECK-constrained to Razorpay's 40-character ASCII limit, because the receipt is the provider's idempotency key for order creation; and a `RECONCILIATION_REQUIRED` status, so "the provider call left an unresolved outcome" is a queryable fact rather than an absence. See [24](./24-payment-order-creation.md). |

## Migration workflow

```
npm run db:migrate:create -- --name <name>   # plan a migration, do NOT apply
#   review prisma/migrations/<ts>_<name>/migration.sql
npm run db:migrate:deploy                    # apply it (uses DIRECT_URL)
npm run db:status                            # applied? any drift?
npm run db:verify                            # does the live DB match the design?
```

`prisma migrate deploy` is the canonical path; `db push` is never used as
schema history. Migration files are committed and reviewed. Prisma 7 no longer
runs `generate` or `seed` automatically after a migration — run them explicitly.

Two migrations exist. The second (Objective 3) adds a nullable
`idempotencyKey` to `transaction_state_transition` plus a unique
`(transactionId, idempotencyKey)` index - additive only, no data rewritten.

The initial migration was reviewed before application: 12 tables, 12 enums, 20
indexes, 16 foreign keys, zero destructive statements.

## Seed workflow

```
npm run db:seed
```

Idempotent by construction — every write is an upsert against a stable key
(`merchant.slug`, `product (merchantId, sku)`, and fixed UUIDs for the two
singleton demo rows). Running it twice produces identical counts, which is
tested by running it twice.

Seeds one buyer, one authorization policy, one merchant, and six mechanical
keyboards: three viable under ₹3,000 differing on switch type, layout,
connectivity and rating; one premium above budget; one out of stock; one
discontinued. The policy's auto-approve ceiling is ₹2,000 — deliberately below
most of the catalog, so the human approval gate is actually exercised later
rather than bypassed.

**No fabricated payment history.** No transactions, quotes, attempts, approvals
or audit events are seeded; those must be produced by the real flow.

## Test isolation

Database tests run against a dedicated **`agentic_test` PostgreSQL schema** in
the same database, created and migrated by `npm run db:test:setup`.

- **Not SQLite.** Tests must exercise PostgreSQL semantics — CHECK constraints,
  enums, BIGINT, RESTRICT — because that is what production runs. SQLite would
  silently accept things PostgreSQL rejects, so the tests would prove nothing.
- **Not the demo data.** The schema is dropped and recreated on each setup;
  `public` is never touched.
- **Not a second paid database.** A schema costs nothing.
- **Same migrations.** The test schema is built from the same migration files,
  so it cannot drift from production.

`TEST_DIRECT_URL` can point at a completely separate database if preferred.
Tests skip themselves when no database is configured, so the foundation suite
still passes with zero credentials.

### The interlock in front of destructive cleanup

The suite empties its tables between tests with a single
`TRUNCATE ... RESTART IDENTITY CASCADE` — twelve `deleteMany` round trips to a
hosted database dominated the runtime. That statement is also the most
destructive thing in the repository: pointed at the wrong schema it would erase
a real transaction history in one call, and `CASCADE` would follow the foreign
keys outward while doing it.

So it is gated. `assertDisposableTestSchema()` in `tests/db/test-database-guard.ts`
must prove two things against the live database before anything is deleted:

1. **The schema is disposable.** `npm run db:test:setup` stamps the schema with
   a marker table holding a known token. No Prisma migration creates that table,
   so no development, staging or production database has one. The marker cannot
   be faked by claiming to be a test environment — it can only be earned by
   having been built to be thrown away.
2. **Every target is inside that schema.** The guard reads PostgreSQL's own
   catalog (`pg_class`, `relkind = 'r'`), confirms each table exists there, and
   **returns** the approved schema-qualified names. Cleanup truncates what the
   guard hands back and nothing else, so it cannot name a table the guard never
   cleared, and a half-built schema is refused rather than partially emptied.

`NODE_ENV` is checked first and counts for nothing on its own — it is a claim
about intent made by whoever launched the process, and it is precisely what is
wrong when someone runs the suite against a `.env.local` pointing at a live
database.

`current_schema()` is deliberately **not** used. The Prisma pg adapter
schema-qualifies the SQL it generates rather than setting the session's
`search_path`, so it reports `public` on a perfectly correct test connection. A
check that is green when it should be red is worse than no check.

The guard fails closed in every direction — unreachable database, missing marker
table, wrong marker value, missing target table, any error while checking — and
caches a refusal as well as a pass, so a flaky retry cannot become an approval.
No refusal message ever contains a connection string. `test-database-guard.test.ts`
proves each refusal, including that `resetTestData()` itself stops and the rows
are still there afterwards.

None of this touches production referential actions: every foreign key remains
`ON DELETE RESTRICT`, asserted separately in `constraints.test.ts`. `CASCADE`
appears only in the disposable schema's teardown.

## Commands

| Script                      | Does                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `npm run db:generate`       | Regenerate the Prisma client into `src/generated/prisma`    |
| `npm run db:migrate`        | Create and apply a migration (development)                  |
| `npm run db:migrate:create` | Plan a migration without applying it                        |
| `npm run db:migrate:deploy` | Apply pending migrations                                    |
| `npm run db:status`         | Migration/drift status                                      |
| `npm run db:verify`         | Verify the live schema, constraints, FKs and both endpoints |
| `npm run db:seed`           | Idempotent demo seed                                        |
| `npm run db:studio`         | Prisma Studio                                               |
| `npm run db:test:setup`     | Recreate, migrate and mark the isolated test schema         |

`postinstall` runs `prisma generate`, so a fresh clone has a usable client after
`npm install`. The generated client is git-ignored — it is a build artifact.

## Deferred to later objectives

Objective 2 ships **models, not behaviour**. Not implemented: quote generation,
policy evaluation, approval workflow, inventory reservation logic, state-machine
execution, transition writing, audit writing, catalog APIs, Razorpay, and the
AI provider. Every table those need exists and is tested; none of their logic
does.
