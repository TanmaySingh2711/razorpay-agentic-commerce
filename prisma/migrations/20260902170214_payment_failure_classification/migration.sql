-- CreateEnum
CREATE TYPE "payment_failure_category" AS ENUM ('DECLINED_BY_BANK', 'INSUFFICIENT_FUNDS', 'AUTHENTICATION_FAILED', 'INSTRUMENT_INVALID', 'LIMIT_EXCEEDED', 'CANCELLED_BY_CUSTOMER', 'PROVIDER_UNAVAILABLE', 'REQUEST_REJECTED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "payment_attempt" ADD COLUMN     "failedAt" TIMESTAMPTZ(3),
ADD COLUMN     "failureCategory" "payment_failure_category",
ADD COLUMN     "failureReasonCode" VARCHAR(64),
ADD COLUMN     "failureSource" VARCHAR(32),
ADD COLUMN     "failureStep" VARCHAR(40);
