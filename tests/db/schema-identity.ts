/**
 * The identity of the disposable test schema.
 *
 * Shared by the setup script that *stamps* the identity and the guard that
 * *checks* it, so the two can never drift apart. If they did, the guard would
 * refuse to run - which is the correct direction to fail, but a confusing one
 * to debug, so there is exactly one definition.
 */

/**
 * The dedicated PostgreSQL schema database tests run against.
 *
 * A schema rather than a separate database: it exercises real PostgreSQL
 * semantics, costs nothing extra to provision, and `public` is never touched.
 */
export const TEST_SCHEMA = "agentic_test";

/**
 * A table that exists only in a schema built by `npm run db:test:setup`.
 *
 * No Prisma migration creates it, so no development, staging or production
 * database can ever have one. That is the whole point: its presence is not a
 * hint that we are in a test environment, it is proof that we are in a schema
 * whose only purpose is to be destroyed and rebuilt.
 */
export const TEST_SCHEMA_MARKER_TABLE = "__disposable_test_schema__";

/** The exact value the marker row must carry. Bumped if the contract changes. */
export const TEST_SCHEMA_MARKER_VALUE = "agentic-commerce:disposable-test-schema:v1";

/**
 * Every table destructive cleanup is allowed to empty.
 *
 * It lives here, beside the schema identity, because the guard verifies this
 * exact list against the live database catalog before anything is truncated -
 * and then hands back the approved, schema-qualified targets. Cleanup cannot
 * name a table the guard has not cleared.
 *
 * The marker table is deliberately absent: cleanup must never be able to
 * destroy the proof that it was allowed to run.
 */
export const TEST_TABLES = [
  "audit_event",
  "webhook_event",
  "transaction_state_transition",
  "approval_request",
  "payment_attempt",
  "inventory_reservation",
  "purchase_quote",
  "transaction",
  "product",
  "authorization_policy",
  "merchant",
  "buyer_profile",
] as const;
