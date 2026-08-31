-- Objective 3: transition idempotency.
--
-- A retried transition command carrying the same key must resolve to "already
-- applied" instead of writing a second history row. Nullable, because not every
-- internal transition claims an identity - and PostgreSQL treats NULLs as
-- distinct in a unique index, so unkeyed transitions never collide.
--
-- Additive only: one nullable column and one index. No data is rewritten.

-- AlterTable
ALTER TABLE "transaction_state_transition" ADD COLUMN     "idempotencyKey" VARCHAR(128);

-- CreateIndex
CREATE UNIQUE INDEX "transaction_state_transition_transactionId_idempotencyKey_key" ON "transaction_state_transition"("transactionId", "idempotencyKey");
