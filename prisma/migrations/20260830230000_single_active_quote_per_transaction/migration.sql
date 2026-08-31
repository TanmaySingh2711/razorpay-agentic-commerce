-- Objective 6 (re-quote): at most one payable quote per transaction, ever.
--
-- Re-quoting supersedes the old quote and issues a new one. Two rows both
-- marked ACTIVE for the same transaction would mean two competing prices are
-- simultaneously payable - the precise ambiguity a trusted quote exists to
-- remove - and application ordering alone cannot prevent it under concurrency.
--
-- A PARTIAL unique index states the rule where it can actually be enforced.
-- It constrains only ACTIVE rows, so the full history of SUPERSEDED, EXPIRED,
-- INVALIDATED and CONSUMED quotes is preserved untouched: a transaction may
-- accumulate any number of past quotes and still have at most one live one.
CREATE UNIQUE INDEX "purchase_quote_one_active_per_transaction"
  ON "purchase_quote" ("transactionId")
  WHERE "status" = 'ACTIVE';
