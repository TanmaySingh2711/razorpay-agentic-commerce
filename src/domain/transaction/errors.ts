import { DomainRuleError, InfrastructureError, NotFoundError } from "@/domain/errors";
import type { JsonObject } from "@/lib/json";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionActor, TransactionState } from "@/domain/transaction/states";
import type { InvalidTransitionReason } from "@/domain/transaction/state-machine";

/**
 * Failures specific to the transaction lifecycle.
 *
 * Each extends the project-wide taxonomy in `@/domain/errors`, so they carry the
 * same two faces: an operator-facing message and a deliberately dull public one.
 * Internal state names never reach the browser - a caller learns that the action
 * was refused, not the shape of the machine that refused it.
 */
export class TransactionNotFoundError extends NotFoundError {
  constructor(transactionId: string) {
    super({
      code: "TRANSACTION_NOT_FOUND",
      message: `No transaction exists with id ${transactionId}.`,
      publicMessage: "That transaction could not be found.",
      details: { transactionId },
    });
  }
}

export class InvalidTransitionError extends DomainRuleError {
  constructor(args: {
    readonly transactionId: string;
    readonly currentState: TransactionState;
    readonly event: TransactionEvent;
    readonly actor: TransactionActor;
    readonly reason: InvalidTransitionReason;
    readonly explanation: string;
  }) {
    super({
      code: "TRANSACTION_INVALID_TRANSITION",
      message: args.explanation,
      publicMessage: "That action is not allowed for this transaction right now.",
      details: {
        transactionId: args.transactionId,
        currentState: args.currentState,
        event: args.event,
        actor: args.actor,
        reason: args.reason,
      },
    });
  }
}

/** A normal command was aimed at a finished transaction. */
export class TerminalStateViolationError extends DomainRuleError {
  constructor(args: {
    readonly transactionId: string;
    readonly currentState: TransactionState;
    readonly event: TransactionEvent;
  }) {
    super({
      code: "TRANSACTION_TERMINAL_STATE",
      message: `Transaction ${args.transactionId} is terminal in ${args.currentState}; ${args.event} was refused.`,
      publicMessage: "This transaction is already finished and cannot change.",
      details: {
        transactionId: args.transactionId,
        currentState: args.currentState,
        event: args.event,
      },
    });
  }
}

/**
 * Another writer moved the transaction between our read and our write.
 *
 * Retryable: the caller may re-read and re-decide. It is emphatically not a
 * signal to force the write through.
 */
export class ConcurrentTransitionConflictError extends DomainRuleError {
  constructor(args: {
    readonly transactionId: string;
    readonly expectedState: TransactionState;
    readonly event: TransactionEvent;
  }) {
    super({
      code: "TRANSACTION_CONCURRENT_CONFLICT",
      message:
        `Transaction ${args.transactionId} was no longer in ${args.expectedState} when ` +
        `${args.event} tried to commit; another transition won the race.`,
      publicMessage: "This transaction was updated by another process. Please try again.",
      details: {
        transactionId: args.transactionId,
        expectedState: args.expectedState,
        event: args.event,
      },
      retryable: true,
    });
  }
}

/**
 * The same idempotency key was reused for a *different* logical transition.
 *
 * Distinct from a benign retry: a replay of the same operation resolves to
 * "already applied". This means a caller reused an operation identity for
 * something else, which would silently corrupt the history if allowed.
 */
export class DuplicateTransitionConflictError extends DomainRuleError {
  constructor(args: {
    readonly transactionId: string;
    readonly idempotencyKey: string;
    readonly attemptedEvent: TransactionEvent;
    readonly recordedTo: TransactionState;
  }) {
    super({
      code: "TRANSACTION_DUPLICATE_OPERATION",
      message:
        `Idempotency key ${args.idempotencyKey} on transaction ${args.transactionId} was ` +
        `already used for a transition to ${args.recordedTo}; it cannot be reused for ` +
        `${args.attemptedEvent}.`,
      publicMessage: "This request conflicts with one already processed.",
      details: {
        transactionId: args.transactionId,
        attemptedEvent: args.attemptedEvent,
        recordedTo: args.recordedTo,
      },
    });
  }
}

/** The atomic write failed. Nothing was committed. */
export class TransitionPersistenceFailureError extends InfrastructureError {
  constructor(args: {
    readonly transactionId: string;
    readonly event: TransactionEvent;
    readonly cause?: unknown;
    readonly details?: JsonObject;
  }) {
    super({
      code: "TRANSACTION_PERSISTENCE_FAILURE",
      message: `Persisting ${args.event} for transaction ${args.transactionId} failed; the transition was rolled back.`,
      details: { transactionId: args.transactionId, event: args.event, ...args.details },
      ...(args.cause === undefined ? {} : { cause: args.cause }),
    });
  }
}

/**
 * Opening a transaction failed. Nothing was created.
 *
 * The usual cause is a foreign key: a buyer or merchant id that does not exist.
 * The creation boundary lets the database decide that rather than pre-reading,
 * because check-then-insert has a race and a constraint does not - so the raw
 * driver error is preserved as `cause` for an operator, while the caller sees
 * only that the transaction could not be started.
 */
export class TransactionCreationFailureError extends InfrastructureError {
  constructor(args: {
    readonly buyerProfileId: string;
    readonly merchantId: string;
    readonly cause?: unknown;
  }) {
    super({
      code: "TRANSACTION_CREATION_FAILED",
      message:
        `Creating a transaction for buyer ${args.buyerProfileId} at merchant ` +
        `${args.merchantId} failed; no transaction was opened.`,
      details: { buyerProfileId: args.buyerProfileId, merchantId: args.merchantId },
      ...(args.cause === undefined ? {} : { cause: args.cause }),
    });
  }
}
