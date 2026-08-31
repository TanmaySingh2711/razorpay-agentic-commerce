-- Objective 8: the human approval gate and inventory reservation.

-- ---------------------------------------------------------------------------
-- 1. Reserved stock, as a column on the product.
-- ---------------------------------------------------------------------------
--
-- A reservation is a temporary claim, not a sale, so on-hand `inventory` must
-- NOT move when one is taken. What moves is this counter, and reservable stock
-- is the difference:
--
--     reservable = "inventory" - "reservedQuantity"
--
-- Holding it as a column rather than summing the reservation table on every
-- attempt is what makes overselling preventable with a single conditional
-- UPDATE. PostgreSQL takes a row lock for that UPDATE and re-evaluates its WHERE
-- clause against the freshly committed row, so of two buyers racing for the last
-- unit exactly one can match the predicate. Summing a child table would leave a
-- read-then-insert window that no amount of application ordering closes.
--
-- The default of 0 is correct for every product that exists and every product
-- created later: nothing is reserved until something reserves it. No backfill,
-- and no trap for a future INSERT that forgets the column.
ALTER TABLE "product" ADD COLUMN "reservedQuantity" INTEGER NOT NULL DEFAULT 0;

-- The backstop. Even if the conditional UPDATE above were ever written wrongly,
-- the database refuses to hold more stock than exists. Financial correctness
-- does not depend on the ORM being right.
ALTER TABLE "product" ADD CONSTRAINT "product_reserved_quantity_non_negative"
  CHECK ("reservedQuantity" >= 0);
ALTER TABLE "product" ADD CONSTRAINT "product_reserved_within_inventory"
  CHECK ("reservedQuantity" <= "inventory");

-- ---------------------------------------------------------------------------
-- 2. A reservation names the exact quote it was taken against.
-- ---------------------------------------------------------------------------
--
-- Without this a reservation floats free of the price it is holding stock for,
-- and a re-quote would silently inherit stock reserved under a different amount.
-- RESTRICT, like every other financial reference: a quote with a reservation
-- against it cannot be deleted out from under it.
--
-- NOT NULL with no default is safe because the table is empty - Objective 8 is
-- the first code in the repository that creates a reservation at all.
ALTER TABLE "inventory_reservation" ADD COLUMN "purchaseQuoteId" TEXT NOT NULL;

ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_purchaseQuoteId_fkey"
  FOREIGN KEY ("purchaseQuoteId") REFERENCES "purchase_quote"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "inventory_reservation_purchaseQuoteId_idx"
  ON "inventory_reservation"("purchaseQuoteId");

-- ---------------------------------------------------------------------------
-- 3. One live claim, and one open question, per transaction.
-- ---------------------------------------------------------------------------
--
-- Partial unique indexes, the same shape as the one-active-quote rule from
-- Objective 6. Two ACTIVE reservations on one transaction would hold stock
-- twice for a single purchase; two PENDING approvals would mean two live
-- tokens, either of which could authorize - so a rejected approval would not
-- actually stop anything.
--
-- Filtered, so the full history of RELEASED, EXPIRED, COMMITTED reservations
-- and CONSUMED, REJECTED, EXPIRED approvals accumulates untouched beside the one
-- live row.
CREATE UNIQUE INDEX "inventory_reservation_one_active_per_transaction"
  ON "inventory_reservation" ("transactionId")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "approval_request_one_pending_per_transaction"
  ON "approval_request" ("transactionId")
  WHERE "status" = 'PENDING';
