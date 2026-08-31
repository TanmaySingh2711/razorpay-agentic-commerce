-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('AVAILABLE', 'OUT_OF_STOCK', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "AuthorizationPolicyStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('INTENT_RECEIVED', 'PRODUCT_SELECTED', 'PRODUCT_VERIFIED', 'QUOTE_CREATED', 'POLICY_EVALUATED', 'APPROVAL_REQUIRED', 'AUTHORIZED', 'INVENTORY_RESERVED', 'PAYMENT_ORDER_CREATED', 'PAYMENT_PENDING', 'PAYMENT_VERIFIED', 'PAYMENT_CAPTURED', 'COMPLETED', 'PAYMENT_FAILED', 'BLOCKED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TransactionActor" AS ENUM ('human_user', 'buyer_agent', 'product_decision_engine', 'merchant_service', 'quote_service', 'policy_engine', 'approval_gate', 'inventory_service', 'transaction_service', 'payment_provider', 'payment_webhook', 'system');

-- CreateEnum
CREATE TYPE "PurchaseQuoteStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'INVALIDATED', 'SUPERSEDED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "InventoryReservationStatus" AS ENUM ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'PENDING', 'VERIFIED', 'CAPTURED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'VERIFIED', 'REJECTED', 'PROCESSED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('RAZORPAY');

-- CreateEnum
CREATE TYPE "AuditEventResult" AS ENUM ('SUCCESS', 'FAILURE', 'BLOCKED', 'PENDING');

-- CreateTable
CREATE TABLE "buyer_profile" (
    "id" TEXT NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "buyer_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "unitAmount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "inventory" INTEGER NOT NULL DEFAULT 0,
    "status" "ProductStatus" NOT NULL DEFAULT 'AVAILABLE',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorization_policy" (
    "id" TEXT NOT NULL,
    "buyerProfileId" TEXT NOT NULL,
    "maxAutoApproveAmount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "autoPurchaseAllowed" BOOLEAN NOT NULL DEFAULT false,
    "status" "AuthorizationPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "authorization_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" TEXT NOT NULL,
    "buyerProfileId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "productId" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'INTENT_RECEIVED',
    "authorizedAmount" BIGINT,
    "currency" CHAR(3),
    "correlationId" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_quote" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitAmount" BIGINT NOT NULL,
    "totalAmount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "productVersion" INTEGER NOT NULL,
    "status" "PurchaseQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "invalidatedAt" TIMESTAMPTZ(3),

    CONSTRAINT "purchase_quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservation" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "InventoryReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "committedAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "inventory_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempt" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "provider" "PaymentProvider" NOT NULL DEFAULT 'RAZORPAY',
    "providerOrderId" VARCHAR(128),
    "providerPaymentId" VARCHAR(128),
    "failureCode" VARCHAR(64),
    "failureReason" VARCHAR(500),
    "idempotencyKey" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "purchaseQuoteId" TEXT NOT NULL,
    "requestedAmount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "policyLimitSnapshot" BIGINT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "reasonCode" VARCHAR(64) NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "nonceHash" CHAR(64),
    "decidedByBuyerId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_state_transition" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromStatus" "TransactionStatus",
    "toStatus" "TransactionStatus" NOT NULL,
    "actor" "TransactionActor" NOT NULL,
    "trigger" VARCHAR(64) NOT NULL,
    "reasonCode" VARCHAR(64),
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_state_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT,
    "actor" "TransactionActor" NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "result" "AuditEventResult" NOT NULL,
    "reasonCode" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "correlationId" VARCHAR(64),
    "decisionId" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "externalEventId" VARCHAR(128) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "transactionId" TEXT,
    "payloadDigest" CHAR(64),
    "errorCategory" VARCHAR(64),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_slug_key" ON "merchant"("slug");

-- CreateIndex
CREATE INDEX "product_merchantId_category_idx" ON "product"("merchantId", "category");

-- CreateIndex
CREATE INDEX "product_merchantId_status_idx" ON "product"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_merchantId_sku_key" ON "product"("merchantId", "sku");

-- CreateIndex
CREATE INDEX "authorization_policy_buyerProfileId_status_idx" ON "authorization_policy"("buyerProfileId", "status");

-- CreateIndex
CREATE INDEX "transaction_buyerProfileId_createdAt_idx" ON "transaction"("buyerProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "transaction_merchantId_createdAt_idx" ON "transaction"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "transaction_status_idx" ON "transaction"("status");

-- CreateIndex
CREATE INDEX "purchase_quote_transactionId_status_idx" ON "purchase_quote"("transactionId", "status");

-- CreateIndex
CREATE INDEX "purchase_quote_status_expiresAt_idx" ON "purchase_quote"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "inventory_reservation_transactionId_status_idx" ON "inventory_reservation"("transactionId", "status");

-- CreateIndex
CREATE INDEX "inventory_reservation_productId_status_idx" ON "inventory_reservation"("productId", "status");

-- CreateIndex
CREATE INDEX "inventory_reservation_status_expiresAt_idx" ON "inventory_reservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "payment_attempt_transactionId_status_idx" ON "payment_attempt"("transactionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_transactionId_attemptNumber_key" ON "payment_attempt"("transactionId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_provider_providerOrderId_key" ON "payment_attempt"("provider", "providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_provider_providerPaymentId_key" ON "payment_attempt"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_idempotencyKey_key" ON "payment_attempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_nonceHash_key" ON "approval_request"("nonceHash");

-- CreateIndex
CREATE INDEX "approval_request_transactionId_status_idx" ON "approval_request"("transactionId", "status");

-- CreateIndex
CREATE INDEX "approval_request_purchaseQuoteId_idx" ON "approval_request"("purchaseQuoteId");

-- CreateIndex
CREATE INDEX "approval_request_status_expiresAt_idx" ON "approval_request"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "transaction_state_transition_transactionId_createdAt_idx" ON "transaction_state_transition"("transactionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_state_transition_transactionId_sequence_key" ON "transaction_state_transition"("transactionId", "sequence");

-- CreateIndex
CREATE INDEX "audit_event_transactionId_createdAt_idx" ON "audit_event"("transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_eventType_createdAt_idx" ON "audit_event"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_event_transactionId_idx" ON "webhook_event"("transactionId");

-- CreateIndex
CREATE INDEX "webhook_event_status_receivedAt_idx" ON "webhook_event"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_provider_externalEventId_key" ON "webhook_event"("provider", "externalEventId");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_policy" ADD CONSTRAINT "authorization_policy_buyerProfileId_fkey" FOREIGN KEY ("buyerProfileId") REFERENCES "buyer_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_buyerProfileId_fkey" FOREIGN KEY ("buyerProfileId") REFERENCES "buyer_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_quote" ADD CONSTRAINT "purchase_quote_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_quote" ADD CONSTRAINT "purchase_quote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_purchaseQuoteId_fkey" FOREIGN KEY ("purchaseQuoteId") REFERENCES "purchase_quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_decidedByBuyerId_fkey" FOREIGN KEY ("decidedByBuyerId") REFERENCES "buyer_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_state_transition" ADD CONSTRAINT "transaction_state_transition_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints (hand-added, reviewed)
--
-- The Prisma schema language cannot express these, so they are appended to the
-- generated migration deliberately. They are database-level invariants: they
-- hold even if application code is wrong, and even against a direct psql
-- session. Financial correctness must not depend solely on the ORM.
-- ---------------------------------------------------------------------------

-- Currency is an uppercase ISO-4217 alphabetic code, everywhere it appears.
-- A CHECK is used rather than a PostgreSQL enum so that adding a currency later
-- is a data change, not a migration on a locked type.
ALTER TABLE "product"              ADD CONSTRAINT "product_currency_iso4217"              CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "authorization_policy" ADD CONSTRAINT "authorization_policy_currency_iso4217" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "purchase_quote"       ADD CONSTRAINT "purchase_quote_currency_iso4217"       CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payment_attempt"      ADD CONSTRAINT "payment_attempt_currency_iso4217"      CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "approval_request"     ADD CONSTRAINT "approval_request_currency_iso4217"     CHECK ("currency" ~ '^[A-Z]{3}$');
-- Nullable on transaction: no currency exists until a product is selected.
ALTER TABLE "transaction"          ADD CONSTRAINT "transaction_currency_iso4217"          CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');

-- Money is never negative. Amounts are integer minor units.
ALTER TABLE "product"              ADD CONSTRAINT "product_unit_amount_non_negative"      CHECK ("unitAmount" >= 0);
ALTER TABLE "authorization_policy" ADD CONSTRAINT "authorization_policy_limit_non_negative" CHECK ("maxAutoApproveAmount" >= 0);
ALTER TABLE "purchase_quote"       ADD CONSTRAINT "purchase_quote_unit_amount_non_negative"  CHECK ("unitAmount" >= 0);
ALTER TABLE "purchase_quote"       ADD CONSTRAINT "purchase_quote_total_amount_non_negative" CHECK ("totalAmount" >= 0);
ALTER TABLE "payment_attempt"      ADD CONSTRAINT "payment_attempt_amount_non_negative"   CHECK ("amount" >= 0);
ALTER TABLE "approval_request"     ADD CONSTRAINT "approval_request_amount_non_negative"  CHECK ("requestedAmount" >= 0);
ALTER TABLE "approval_request"     ADD CONSTRAINT "approval_request_policy_limit_non_negative" CHECK ("policyLimitSnapshot" >= 0);
ALTER TABLE "transaction"          ADD CONSTRAINT "transaction_authorized_amount_non_negative" CHECK ("authorizedAmount" IS NULL OR "authorizedAmount" >= 0);

-- Stock can reach zero but never go below it. This is the constraint that makes
-- a future atomic conditional decrement safe: an over-selling UPDATE aborts at
-- the database rather than silently writing a negative inventory.
ALTER TABLE "product" ADD CONSTRAINT "product_inventory_non_negative" CHECK ("inventory" >= 0);

-- Quantities are strictly positive: a zero-quantity quote or reservation is
-- meaningless and would otherwise produce a zero-amount charge.
ALTER TABLE "purchase_quote"        ADD CONSTRAINT "purchase_quote_quantity_positive"        CHECK ("quantity" > 0);
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_quantity_positive" CHECK ("quantity" > 0);

-- The quote arithmetic itself is enforced in the database, so a bug in quote
-- construction cannot persist a total that disagrees with unit x quantity.
ALTER TABLE "purchase_quote" ADD CONSTRAINT "purchase_quote_total_matches_unit_times_quantity"
  CHECK ("totalAmount" = "unitAmount" * "quantity");

-- Versions and sequences are 1-based counters.
ALTER TABLE "product"              ADD CONSTRAINT "product_version_positive"              CHECK ("version" > 0);
ALTER TABLE "authorization_policy" ADD CONSTRAINT "authorization_policy_version_positive" CHECK ("version" > 0);
ALTER TABLE "payment_attempt"      ADD CONSTRAINT "payment_attempt_number_positive"       CHECK ("attemptNumber" > 0);
ALTER TABLE "transaction_state_transition" ADD CONSTRAINT "transaction_state_transition_sequence_positive" CHECK ("sequence" > 0);

-- An expiry that precedes creation would make a quote, reservation or approval
-- dead on arrival; reject it rather than debug it later.
ALTER TABLE "purchase_quote"        ADD CONSTRAINT "purchase_quote_expiry_after_creation"        CHECK ("expiresAt" > "createdAt");
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_expiry_after_creation" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "approval_request"      ADD CONSTRAINT "approval_request_expiry_after_creation"      CHECK ("expiresAt" > "createdAt");

-- A transition may only lack a previous state when it is the first one.
ALTER TABLE "transaction_state_transition" ADD CONSTRAINT "transaction_state_transition_first_has_no_from"
  CHECK (("sequence" = 1) OR ("fromStatus" IS NOT NULL));
