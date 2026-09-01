-- Objective 10: server-side payment order creation.
--
-- Two additions, both there to make the external-side-effect window survivable.
-- Creating an order at Razorpay is the first thing this system does that
-- PostgreSQL cannot roll back, so the schema has to be able to express "the
-- provider may hold an order we did not finish recording" as an ordinary,
-- queryable fact rather than as an absence.

-- ---------------------------------------------------------------------------
-- 1. A status for the outcome nobody knows.
-- ---------------------------------------------------------------------------
--
-- The existing statuses all assert something: CREATED, PENDING, VERIFIED,
-- CAPTURED, FAILED. None of them can say "we called the provider and did not
-- learn what happened", and the difference matters more than any of the others:
-- an attempt in this state must never be retried into a second provider order,
-- and must eventually be reconciled against the provider by receipt.
--
-- Encoding it as a status rather than as a combination of nullable columns is
-- deliberate. A reconciliation job asks one question - `status =
-- 'RECONCILIATION_REQUIRED'` - instead of a three-part predicate over
-- providerOrderId and failureCode that any future writer could get subtly wrong.
ALTER TYPE "PaymentAttemptStatus" ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';

-- ---------------------------------------------------------------------------
-- 2. The receipt: our reference, and the provider's idempotency key.
-- ---------------------------------------------------------------------------
--
-- Razorpay documents `receipt` as unique and treats it as the idempotency key
-- for order creation: a second create call carrying the same value is rejected
-- rather than honoured. That single fact is what prevents duplicate orders
-- across a retry, a race or a lost response - so the value has to be stored,
-- stable, and unique on our side too.
--
-- It is stored rather than recomputed on demand. The value is derived from the
-- PaymentAttempt id today, but a stored reference cannot be invalidated later
-- by a change to that derivation, and a financial reference that can silently
-- change is not a reference.
ALTER TABLE "payment_attempt" ADD COLUMN "receipt" VARCHAR(40);

CREATE UNIQUE INDEX "payment_attempt_receipt_key"
  ON "payment_attempt" ("receipt");

-- The provider's documented limits, enforced here rather than trusted to the
-- code that builds the value: at most 40 characters, and ASCII only - Razorpay
-- rejects emoji and non-ASCII receipts. A row that could not be sent to the
-- provider should not be storable in the first place.
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_receipt_format"
  CHECK ("receipt" IS NULL OR "receipt" ~ '^[A-Za-z0-9_-]{1,40}$');
