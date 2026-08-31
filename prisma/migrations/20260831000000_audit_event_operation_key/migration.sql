-- Objective 7: one logical policy evaluation writes at most one audit event.
--
-- Repeating an evaluation - a retried request, two concurrent callers, a
-- redelivered job - must converge on the record that already exists rather than
-- appending a second one. An audit trail that shows a purchase being authorized
-- twice cannot be used to answer "what did the system decide", which is the
-- only reason it exists.
--
-- The key is the identity of the logical operation, namespaced by its writer
-- and carrying the quote and the policy version it was decided under, so a
-- genuinely new evaluation (a changed policy) is a different operation rather
-- than a duplicate of the old one.
--
-- Enforced by the database, not by an application check: a check-then-insert
-- pair loses the race that matters, whereas a duplicate under this index aborts
-- the whole transaction - the state transitions included - so the alternative
-- to one record is none, never two.
--
-- Nullable, and NULLs are exempt from a PostgreSQL unique index, so every
-- existing and future audit event that carries no operation identity is
-- unaffected.
ALTER TABLE "audit_event" ADD COLUMN "operationKey" VARCHAR(160);

CREATE UNIQUE INDEX "audit_event_operationKey_key" ON "audit_event"("operationKey");
