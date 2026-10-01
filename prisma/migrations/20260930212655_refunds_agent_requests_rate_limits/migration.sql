-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('REQUESTED', 'PENDING', 'PROCESSED', 'FAILED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "agent_request_outcome" AS ENUM ('PURCHASE_OPENED', 'CLARIFICATION', 'NO_MATCH', 'NOT_A_PURCHASE', 'REFUSED', 'ERROR', 'RATE_LIMITED');

-- CreateTable
CREATE TABLE "refund" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'REQUESTED',
    "receipt" VARCHAR(40) NOT NULL,
    "providerRefundId" VARCHAR(128),
    "failureCode" VARCHAR(64),
    "requestedByBuyerId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_request" (
    "id" TEXT NOT NULL,
    "outcome" "agent_request_outcome" NOT NULL,
    "requestType" VARCHAR(16),
    "category" VARCHAR(40),
    "maxBudgetMinor" BIGINT,
    "currency" CHAR(3),
    "transactionId" TEXT,
    "turn" INTEGER NOT NULL DEFAULT 1,
    "modelCalls" INTEGER,
    "toolCalls" INTEGER,
    "productsObserved" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_window" (
    "bucket" VARCHAR(120) NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_window_pkey" PRIMARY KEY ("bucket","windowStart")
);

-- CreateIndex
CREATE UNIQUE INDEX "refund_receipt_key" ON "refund"("receipt");

-- CreateIndex
CREATE UNIQUE INDEX "refund_providerRefundId_key" ON "refund"("providerRefundId");

-- CreateIndex
CREATE INDEX "refund_transactionId_status_idx" ON "refund"("transactionId", "status");

-- CreateIndex
CREATE INDEX "refund_status_createdAt_idx" ON "refund"("status", "createdAt");

-- CreateIndex
CREATE INDEX "agent_request_createdAt_idx" ON "agent_request"("createdAt");

-- CreateIndex
CREATE INDEX "agent_request_outcome_createdAt_idx" ON "agent_request"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "agent_request_transactionId_idx" ON "agent_request"("transactionId");

-- CreateIndex
CREATE INDEX "rate_limit_window_windowStart_idx" ON "rate_limit_window"("windowStart");

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_requestedByBuyerId_fkey" FOREIGN KEY ("requestedByBuyerId") REFERENCES "buyer_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_request" ADD CONSTRAINT "agent_request_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints and filtered indexes (hand-added, reviewed)
-- ---------------------------------------------------------------------------

-- Money: positive integer minor units with an ISO 4217 code, as everywhere else.
ALTER TABLE "refund" ADD CONSTRAINT "refund_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "refund" ADD CONSTRAINT "refund_currency_iso4217" CHECK ("currency" ~ '^[A-Z]{3}$');

-- At most one refund per transaction that has not failed. A FAILED refund
-- does not count, so a buyer may try again after the provider refused; any
-- other status - including RECONCILIATION_REQUIRED, where the provider may
-- already hold a refund - blocks a second one. Prisma cannot express a
-- filtered index, so it lives here.
CREATE UNIQUE INDEX "refund_one_live_per_transaction"
  ON "refund" ("transactionId")
  WHERE "status" <> 'FAILED';

-- A processed refund records when; nothing else may claim a processed time.
ALTER TABLE "refund" ADD CONSTRAINT "refund_processed_at_matches_status"
  CHECK (("status" = 'PROCESSED') = ("processedAt" IS NOT NULL));

ALTER TABLE "agent_request" ADD CONSTRAINT "agent_request_budget_positive"
  CHECK ("maxBudgetMinor" IS NULL OR "maxBudgetMinor" > 0);
ALTER TABLE "agent_request" ADD CONSTRAINT "agent_request_currency_iso4217"
  CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "agent_request" ADD CONSTRAINT "agent_request_counters_non_negative"
  CHECK ("turn" > 0 AND "durationMs" >= 0
    AND ("modelCalls" IS NULL OR "modelCalls" >= 0)
    AND ("toolCalls" IS NULL OR "toolCalls" >= 0)
    AND ("productsObserved" IS NULL OR "productsObserved" >= 0));

ALTER TABLE "rate_limit_window" ADD CONSTRAINT "rate_limit_window_hits_non_negative"
  CHECK ("hits" >= 0);
