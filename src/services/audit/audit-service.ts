import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/persistence/client";
import { explainAuditEvent } from "@/domain/audit/explanations";
import { sanitizeAuditPayload } from "@/domain/audit/record";
import type { AuditActor, AuditRecord, AuditResult } from "@/domain/audit/record";
import type { AuditEventType } from "@/domain/audit-event";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";
import type { TransactionState } from "@/domain/transaction/states";
import type { JsonObject } from "@/lib/json";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The audit boundary. One way in, one way out.
 *
 * Everything the system does with someone's money is recorded here, and nowhere
 * else. Before this existed, three services each had their own private
 * `prisma.auditEvent.create` helper with its own dedupe read and its own idea
 * of what a payload looked like — three implementations that agreed by
 * coincidence, and would have become four the moment payments landed.
 *
 * What this service is responsible for:
 *
 *  1. **Refusing bad payloads.** Every action has an allow-list of trusted,
 *     server-derived fields. A secret, a model's reasoning, or simply an
 *     unexpected key is rejected rather than stored.
 *  2. **Idempotency.** An operation key, unique in the database, so a retried
 *     request converges on the record that already exists.
 *  3. **Participating in the caller's transaction.** The client is the first
 *     parameter precisely so a caller cannot forget to pass theirs, which is
 *     what makes "the money moved but the audit write failed" impossible.
 *  4. **Reading a transaction's history back** as one deterministic timeline.
 *
 * What it is emphatically NOT responsible for: deciding anything. It records
 * facts. It evaluates no policy, mutates no financial state, and has no opinion
 * about whether what it is recording was a good idea.
 *
 * This is also not the operational log. `@/lib/logger` is for operators and may
 * be sampled, rotated and dropped; these rows may not. A future payment module
 * uses this service, not that one, for anything a buyer could later dispute.
 */
assertServerOnly("src/services/audit/audit-service.ts");

export interface AuditEventCommand {
  /** Null only for events that precede a transaction existing. */
  readonly transactionId: string | null;
  readonly action: AuditEventType;
  readonly actor: AuditActor;
  readonly result: AuditResult;
  readonly reasonCode?: string | null;
  /** Trusted, server-derived facts. Validated against the action's allow-list. */
  readonly trustedInputs: JsonObject;
  readonly correlationId?: string | null;
  /**
   * Identity of the logical operation.
   *
   * Supply it whenever the caller can retry. A replay carrying the same key
   * converges on the row that already exists instead of appending a second
   * one - including two writes racing, because the insert itself carries the
   * conflict clause rather than depending on a preceding read.
   */
  readonly operationKey?: string | null;
  readonly decisionId?: string | null;
}

export type AuditWriteOutcome =
  | { readonly kind: "RECORDED"; readonly eventId: string }
  | { readonly kind: "ALREADY_RECORDED"; readonly eventId: string };

/**
 * Records one audited fact.
 *
 * The client is the first parameter on purpose. Callers inside a business
 * transaction pass their `tx`, so the audit row commits or rolls back with the
 * action it describes; callers with no transaction pass the process client. A
 * signature with an optional client would let someone omit it by accident and
 * silently reintroduce the split-brain this exists to prevent.
 */
export async function recordAuditEvent(
  client: TransactionCapableClient,
  command: AuditEventCommand,
): Promise<AuditWriteOutcome> {
  // Refuse before writing anything. A payload carrying a secret must never
  // reach the row, not even to be cleaned up afterwards.
  const trustedInputs = sanitizeAuditPayload(command.action, command.trustedInputs);

  const operationKey = command.operationKey ?? null;
  const data = {
    transactionId: command.transactionId,
    actor: command.actor,
    eventType: command.action,
    result: command.result,
    reasonCode: command.reasonCode ?? null,
    metadata: trustedInputs,
    correlationId: command.correlationId ?? null,
    decisionId: command.decisionId ?? null,
    operationKey,
  };

  if (operationKey === null) {
    // No operation identity, so nothing to converge on: every call is its own
    // event. Used for facts that genuinely happen once.
    const created = await client.auditEvent.create({ data, select: { id: true } });
    return { kind: "RECORDED", eventId: created.id };
  }

  // `skipDuplicates` compiles to INSERT … ON CONFLICT DO NOTHING, so the
  // conflict is resolved by the same statement that writes the row.
  //
  // A read followed by an insert would leave a window between them: two callers
  // retrying the same operation at once would both find nothing, both insert,
  // and the loser's unique violation would abort its whole transaction -
  // rolling back the business action it was auditing. Here the loser simply
  // writes nothing and converges, which is what "idempotent" is supposed to
  // mean.
  //
  // `…AndReturn` keeps the ordinary path to a single round trip, and is exact
  // about which of the two happened - a returned row means this call wrote it.
  // That matters more than it looks: these writes sit inside business
  // transactions that already make a dozen sequential round trips, and against
  // a hosted database every extra one is latency spent inside a held
  // transaction. The read-back runs only on the rare convergence path, where
  // the row already exists and there is nothing to hurry.
  const inserted = await client.auditEvent.createManyAndReturn({
    data: [data],
    skipDuplicates: true,
    select: { id: true },
  });
  const written = inserted[0];
  if (written !== undefined) {
    return { kind: "RECORDED", eventId: written.id };
  }

  const existing = await client.auditEvent.findUniqueOrThrow({
    where: { operationKey },
    select: { id: true },
  });
  return { kind: "ALREADY_RECORDED", eventId: existing.id };
}

/**
 * There is deliberately no update or delete.
 *
 * Financial history is append-only. A mistake is corrected by recording what
 * actually happened next, not by rewriting what was recorded before — an audit
 * trail that can be edited is not evidence of anything. The database keeps its
 * own protections too: every foreign key into this table is ON DELETE RESTRICT,
 * so a transaction cannot be deleted out from under its own history.
 */

// ---------------------------------------------------------------------------
// Reading a transaction back
// ---------------------------------------------------------------------------

/**
 * One entry in a transaction's timeline, whichever table it came from.
 *
 * `source` is kept rather than hidden: a reader should be able to tell that the
 * lifecycle entries come from the authoritative state-machine history and the
 * rest from the audit trail.
 */
export interface AuditTimelineEntry extends AuditRecord {
  readonly source: "AUDIT" | "STATE_TRANSITION";
  /** Present only for state transitions, where it is the authoritative order. */
  readonly sequence: number | null;
}

export interface AuditServiceDeps {
  readonly prisma: PrismaClient;
}

function defaultDeps(): AuditServiceDeps {
  return { prisma: getPrismaClient() };
}

/**
 * The complete, ordered story of one transaction.
 *
 * **Composed, not duplicated.** `TransactionStateTransition` remains the
 * authoritative record of lifecycle state — it has the actor checks, the
 * conditional update and the unique sequence behind it, and Objective 3 exists
 * to make it the only way state changes. Mirroring every transition into the
 * audit table as well would create two histories that can disagree, and the
 * moment they disagree neither is trustworthy. So this reads both and merges
 * them into one normalized timeline instead.
 *
 * **Ordering is fully specified**, because "whatever the database returns" is
 * not an order. Entries sort by:
 *
 *   1. `occurredAt`;
 *   2. then audit events before state transitions at the same instant, since a
 *      decision is what causes the move that follows it;
 *   3. then a stable per-source key — `sequence` for transitions, and the row
 *      id for audit events, which is a UUIDv7 and therefore itself
 *      time-ordered.
 *
 * Rules 2 and 3 are not hypothetical. Timestamps have millisecond resolution
 * and several rows are routinely written microseconds apart inside a single
 * business transaction, so collisions happen; without a specified tie-break the
 * same transaction could render in a different order on two consecutive reads.
 * Services also write the audit record *before* the state transition it
 * explains, so timestamp order and causal order agree rather than needing rule
 * 2 to rescue them.
 */
export async function getTransactionAuditHistory(
  transactionId: string,
  deps: AuditServiceDeps = defaultDeps(),
): Promise<readonly AuditTimelineEntry[]> {
  const [events, transitions] = await Promise.all([
    deps.prisma.auditEvent.findMany({
      where: { transactionId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    deps.prisma.transactionStateTransition.findMany({
      where: { transactionId },
      orderBy: { sequence: "asc" },
    }),
  ]);

  const entries: AuditTimelineEntry[] = [
    ...events.map((event) => {
      const trustedInputs = asJsonObject(event.metadata);
      const action = event.eventType as AuditEventType;
      const result = event.result as AuditResult;
      return {
        source: "AUDIT" as const,
        eventId: event.id,
        transactionId: event.transactionId,
        occurredAt: event.createdAt.toISOString(),
        actor: event.actor,
        action,
        result,
        reasonCode: event.reasonCode,
        conciseExplanation: explainAuditEvent({
          action,
          result,
          reasonCode: event.reasonCode,
          trustedInputs,
        }),
        trustedInputs,
        correlationId: event.correlationId,
        operationKey: event.operationKey,
        decisionId: event.decisionId,
        sequence: null,
      };
    }),
    ...transitions.map((transition) => {
      const trustedInputs: JsonObject = {
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        trigger: transition.trigger,
        sequence: transition.sequence,
        transitionId: transition.id,
      };
      return {
        source: "STATE_TRANSITION" as const,
        eventId: transition.id,
        transactionId: transition.transactionId,
        occurredAt: transition.createdAt.toISOString(),
        actor: transition.actor,
        action: "state_transitioned" as const,
        result: "SUCCESS" as const,
        reasonCode: transition.reasonCode,
        conciseExplanation: explainAuditEvent({
          action: "state_transitioned",
          result: "SUCCESS",
          reasonCode: transition.reasonCode,
          trustedInputs,
        }),
        trustedInputs,
        correlationId: null,
        // A transition carries no operation identity of its own; the audit
        // event that explains it does.
        operationKey: null,
        decisionId: null,
        sequence: transition.sequence,
      };
    }),
  ];

  return entries.sort(compareTimelineEntries);
}

/** Audit before transition at the same instant: the decision precedes the move. */
const SOURCE_RANK: Record<AuditTimelineEntry["source"], number> = {
  AUDIT: 0,
  STATE_TRANSITION: 1,
};

function compareTimelineEntries(
  left: AuditTimelineEntry,
  right: AuditTimelineEntry,
): number {
  if (left.occurredAt !== right.occurredAt) {
    return left.occurredAt < right.occurredAt ? -1 : 1;
  }
  const rank = SOURCE_RANK[left.source] - SOURCE_RANK[right.source];
  if (rank !== 0) return rank;

  if (left.sequence !== null && right.sequence !== null) {
    return left.sequence - right.sequence;
  }
  // UUIDv7: lexicographic order is creation order.
  if (left.eventId === right.eventId) return 0;
  return left.eventId < right.eventId ? -1 : 1;
}

/** The lifecycle state this transaction is authoritatively in, per Objective 3. */
export async function getAuthoritativeState(
  transactionId: string,
  deps: AuditServiceDeps = defaultDeps(),
): Promise<TransactionState | null> {
  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { status: true },
  });
  return transaction?.status ?? null;
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as JsonObject;
}
