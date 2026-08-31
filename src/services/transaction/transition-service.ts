import type { JsonObject } from "@/lib/json";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor, TransactionState } from "@/domain/transaction/states";
import { resolveTransition } from "@/domain/transaction/state-machine";
import {
  ConcurrentTransitionConflictError,
  DuplicateTransitionConflictError,
  InvalidTransitionError,
  TerminalStateViolationError,
  TransactionNotFoundError,
  TransitionPersistenceFailureError,
} from "@/domain/transaction/errors";
import { isTerminalState } from "@/domain/transaction/states";
import { getPrismaClient } from "@/integrations/persistence/client";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * Any client that can run the transition's statements.
 *
 * Either the process-wide Prisma client or an interactive-transaction client
 * the caller already opened. The transition body is written against this so it
 * reads identically in both cases - there is one implementation of the state
 * machine's persistence, never two.
 */
export type TransactionCapableClient = PrismaClient | Prisma.TransactionClient;

/**
 * The ONLY sanctioned way to change a transaction's state.
 *
 * Architecture invariant, enforced by convention and documented in
 * docs/17-transaction-state-machine.md:
 *
 *   NO MODULE MAY DIRECTLY ASSIGN Transaction.status.
 *
 * The catalog, policy, approval, inventory, payment and webhook services all
 * *request a domain event* through this service. The pure state machine decides
 * whether it is legal; this service persists the outcome atomically.
 *
 * Server-only. The persistence client it depends on throws if evaluated in a
 * browser bundle, so this module cannot be reached from client code.
 */

/** A request to move a transaction, expressed as something that happened. */
export interface TransitionCommand {
  readonly transactionId: string;
  readonly event: TransactionEvent;
  readonly actor: TransactionActor;
  /**
   * Identity of the logical operation.
   *
   * Supply it whenever the caller can retry - a webhook, a retried API call.
   * A replay carrying the same key resolves to `ALREADY_APPLIED` instead of
   * writing a second history row.
   */
  readonly idempotencyKey?: string;
  /** Safe structured context. Never secrets, never model reasoning. */
  readonly details?: JsonObject;
}

export type TransitionOutcome =
  | {
      readonly kind: "APPLIED";
      readonly transactionId: string;
      readonly from: TransactionState;
      readonly to: TransactionState;
      readonly sequence: number;
      readonly transitionId: string;
    }
  | {
      readonly kind: "ALREADY_APPLIED";
      readonly transactionId: string;
      readonly currentState: TransactionState;
      readonly explanation: string;
    }
  | {
      readonly kind: "LATE_EVENT_HELD";
      readonly transactionId: string;
      readonly currentState: TransactionState;
      readonly event: TransactionEvent;
      readonly explanation: string;
    };

export interface TransitionServiceDeps {
  readonly prisma: PrismaClient;
}

function defaultDeps(): TransitionServiceDeps {
  return { prisma: getPrismaClient() };
}

/**
 * Applies a domain event to a transaction.
 *
 * The sequence of operations is deliberate:
 *
 *  1. Load the transaction. Missing -> a precise error, not a silent no-op.
 *  2. If an idempotency key was supplied and already recorded, return
 *     ALREADY_APPLIED without touching anything - unless it was recorded for a
 *     *different* event, which is a caller bug and must be surfaced.
 *  3. Ask the pure state machine. It, not the caller, decides the next state.
 *  4. Commit the state update and the history row in ONE database transaction,
 *     with the update conditioned on the state we read.
 *
 * Step 4 is what makes this safe under concurrency: the write says "move this
 * transaction only if it is still in the state I decided from". If another
 * writer got there first, zero rows match and the whole transaction rolls back
 * with a controlled conflict error, rather than blindly overwriting a state
 * someone else legitimately set.
 */
async function executeTransition(
  prisma: TransactionCapableClient,
  command: TransitionCommand,
): Promise<TransitionOutcome> {
  const { transactionId, event, actor } = command;

  const existing = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true },
  });
  if (existing === null) {
    throw new TransactionNotFoundError(transactionId);
  }
  const currentState = existing.status;

  // --- Idempotency: has this exact operation already been recorded? ---
  if (command.idempotencyKey !== undefined) {
    const recorded = await prisma.transactionStateTransition.findUnique({
      where: {
        transactionId_idempotencyKey: {
          transactionId,
          idempotencyKey: command.idempotencyKey,
        },
      },
      select: { toStatus: true, trigger: true },
    });
    if (recorded !== null) {
      // Same key, different operation: the caller reused an identity. Allowing
      // it would silently attribute one operation's effect to another.
      if (recorded.trigger !== event) {
        throw new DuplicateTransitionConflictError({
          transactionId,
          idempotencyKey: command.idempotencyKey,
          attemptedEvent: event,
          recordedTo: recorded.toStatus,
        });
      }
      return {
        kind: "ALREADY_APPLIED",
        transactionId,
        currentState,
        explanation: `${event} was already applied to this transaction under the same operation key.`,
      };
    }
  }

  // --- The pure decision. The caller never chooses the target state. ---
  const decision = resolveTransition({ currentState, event, actor });

  switch (decision.kind) {
    case "IDEMPOTENT_NO_OP":
      return {
        kind: "ALREADY_APPLIED",
        transactionId,
        currentState,
        explanation: decision.explanation,
      };

    case "LATE_EVENT_RECONCILIATION_CANDIDATE":
      // Deliberately no state change and no history row: the transition did not
      // happen. A later reconciliation objective decides what this means.
      return {
        kind: "LATE_EVENT_HELD",
        transactionId,
        currentState,
        event,
        explanation: decision.explanation,
      };

    case "INVALID":
      if (decision.reason === "terminal_state" || isTerminalState(currentState)) {
        throw new TerminalStateViolationError({ transactionId, currentState, event });
      }
      throw new InvalidTransitionError({
        transactionId,
        currentState,
        event,
        actor,
        reason: decision.reason,
        explanation: decision.explanation,
      });

    case "APPLY":
      break;
  }

  const { from, to, reasonCode } = decision;

  const tx = prisma;

  // Conditional update: only move the transaction if it is STILL in the
  // state the decision was made from. This is the concurrency guard, and it
  // is what makes this function safe to run inside a caller's transaction:
  // the guard is a predicate on the row, not on when the read happened.
  const updated = await tx.transaction.updateMany({
    where: { id: transactionId, status: from },
    data: {
      status: to,
      ...(to === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });

  if (updated.count === 0) {
    // Someone else transitioned first. Roll back; change nothing.
    throw new ConcurrentTransitionConflictError({
      transactionId,
      expectedState: from,
      event,
    });
  }

  // Sequence is derived inside the same transaction. If two writers somehow
  // reach here together, the unique (transactionId, sequence) index rejects
  // the loser - a second, independent guard behind the conditional update.
  const last = await tx.transactionStateTransition.findFirst({
    where: { transactionId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const sequence = (last?.sequence ?? 0) + 1;

  const transition = await tx.transactionStateTransition.create({
    data: {
      transactionId,
      sequence,
      fromStatus: from,
      toStatus: to,
      actor,
      trigger: event,
      reasonCode,
      details: command.details ?? {},
      ...(command.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: command.idempotencyKey }),
    },
    select: { id: true },
  });

  return {
    kind: "APPLIED" as const,
    transactionId,
    from,
    to,
    sequence,
    transitionId: transition.id,
  };
}

/**
 * Classifies a failure from the transition path.
 *
 * A controlled conflict is a business outcome and keeps its own type; anything
 * else is infrastructure and is wrapped so a Prisma error - which carries SQL
 * and connection detail - cannot travel any further.
 */
function classifyTransitionFailure(
  error: unknown,
  transactionId: string,
  event: TransactionEvent,
): never {
  if (
    error instanceof ConcurrentTransitionConflictError ||
    error instanceof DuplicateTransitionConflictError ||
    error instanceof TransactionNotFoundError ||
    error instanceof InvalidTransitionError ||
    error instanceof TerminalStateViolationError
  ) {
    throw error;
  }
  throw new TransitionPersistenceFailureError({ transactionId, event, cause: error });
}

/**
 * Applies a domain event, owning its own database transaction.
 *
 * The normal entry point. Read, decision and commit all happen inside one
 * PostgreSQL transaction, so the state the decision was made from is the state
 * the conditional update tests against.
 */
export async function applyTransactionEvent(
  command: TransitionCommand,
  deps: TransitionServiceDeps = defaultDeps(),
): Promise<TransitionOutcome> {
  try {
    return await deps.prisma.$transaction((tx) => executeTransition(tx, command));
  } catch (error) {
    classifyTransitionFailure(error, command.transactionId, command.event);
  }
}

/**
 * Applies a domain event **inside a transaction the caller already opened**.
 *
 * This exists for exactly one reason: Objective 6 must commit a PurchaseQuote
 * and the `QUOTE_ISSUED` transition together or not at all. A database that
 * ends up in `QUOTE_CREATED` with no quote row - or holding a quote whose
 * transaction never reached that state - is a financial record that contradicts
 * itself, and no amount of cleanup afterwards makes it trustworthy.
 *
 * The alternative would have been for the quote service to write the status
 * itself, which is precisely what Objective 3 exists to prevent. So the state
 * machine is *lent* to the caller's transaction rather than bypassed: the same
 * matrix, the same actor check, the same conditional update, the same history
 * row. Nothing is duplicated and nothing is skipped.
 *
 * The caller owns rollback. Errors propagate unwrapped so the caller's
 * transaction aborts, and the caller decides how to classify them.
 */
export function applyTransactionEventWithin(
  tx: TransactionCapableClient,
  command: TransitionCommand,
): Promise<TransitionOutcome> {
  return executeTransition(tx, command);
}

/**
 * The ordered transition history of a transaction.
 *
 * Ordered by `sequence` rather than timestamp: two transitions can share a
 * millisecond, and history that cannot be ordered cannot be audited.
 */
export async function getTransactionHistory(
  transactionId: string,
  deps: TransitionServiceDeps = defaultDeps(),
) {
  return deps.prisma.transactionStateTransition.findMany({
    where: { transactionId },
    orderBy: { sequence: "asc" },
  });
}
