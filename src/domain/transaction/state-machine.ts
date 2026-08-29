import { DomainRuleError } from "@/domain/errors";
import type { IdempotencyKey } from "@/domain/identifiers";
import {
  isTerminalState,
  type TransactionActor,
  type TransactionState,
} from "@/domain/transaction/states";
import {
  TRANSACTION_TRANSITIONS,
  type TransactionTransition,
} from "@/domain/transaction/transitions";
import { err, ok, type Result } from "@/lib/result";

/**
 * The deterministic adjudicator for transaction state changes.
 *
 * It is pure: no I/O, no persistence, no clock. The Transaction Service asks it
 * whether a move is legal and then writes the result. Because it is pure it is
 * exhaustively testable, which is what makes "AI cannot mutate transaction
 * state" a checkable property rather than a promise.
 */
export interface TransitionRequest {
  readonly from: TransactionState;
  readonly to: TransactionState;
  readonly actor: TransactionActor;
  /**
   * Present when the request originates from an at-least-once source (a
   * Razorpay webhook, a retried API call). The persistence layer stores it so a
   * replayed request resolves to `already_applied` instead of a second write.
   */
  readonly idempotencyKey?: IdempotencyKey;
}

export type TransitionRejectionReason =
  "terminal_state" | "unknown_transition" | "actor_not_permitted";

export interface TransitionApproval {
  readonly outcome: "applied" | "already_applied";
  readonly from: TransactionState;
  readonly to: TransactionState;
  readonly actor: TransactionActor;
  readonly trigger: string;
}

export interface TransitionRejection {
  readonly reason: TransitionRejectionReason;
  readonly from: TransactionState;
  readonly to: TransactionState;
  readonly actor: TransactionActor;
  /** Concise, user-safe explanation. Feeds the structured decision record. */
  readonly explanation: string;
}

export function allowedTransitionsFrom(
  state: TransactionState,
): readonly TransactionTransition[] {
  return TRANSACTION_TRANSITIONS[state];
}

export function findTransition(
  from: TransactionState,
  to: TransactionState,
): TransactionTransition | undefined {
  return TRANSACTION_TRANSITIONS[from].find((transition) => transition.to === to);
}

/**
 * Adjudicates a requested transition. A rejection is a normal, auditable
 * outcome, so it is returned as a value rather than thrown.
 */
export function evaluateTransition(
  request: TransitionRequest,
): Result<TransitionApproval, TransitionRejection> {
  const { from, to, actor } = request;

  // Replay of a transition already applied. Safe to acknowledge, never re-run.
  if (from === to) {
    const inbound = Object.values(TRANSACTION_TRANSITIONS)
      .flat()
      .find((transition) => transition.to === to);
    if (inbound !== undefined) {
      return ok({
        outcome: "already_applied",
        from,
        to,
        actor,
        trigger: inbound.trigger,
      });
    }
  }

  if (isTerminalState(from)) {
    return err({
      reason: "terminal_state",
      from,
      to,
      actor,
      explanation: `Transaction is already finished in state ${from} and cannot change.`,
    });
  }

  const transition = findTransition(from, to);
  if (transition === undefined) {
    return err({
      reason: "unknown_transition",
      from,
      to,
      actor,
      explanation: `Moving from ${from} to ${to} is not a permitted step in the transaction lifecycle.`,
    });
  }

  if (!transition.allowedActors.includes(actor)) {
    return err({
      reason: "actor_not_permitted",
      from,
      to,
      actor,
      explanation: `${actor} is not permitted to perform ${transition.trigger}.`,
    });
  }

  return ok({ outcome: "applied", from, to, actor, trigger: transition.trigger });
}

/**
 * Throwing variant for call sites where a rejection means a bug rather than a
 * business outcome. Prefer `evaluateTransition` on any path that must audit
 * the refusal.
 */
export function assertTransition(request: TransitionRequest): TransitionApproval {
  const result = evaluateTransition(request);
  if (!result.ok) {
    throw new DomainRuleError({
      code: "TRANSACTION_INVALID_TRANSITION",
      message: result.error.explanation,
      publicMessage: "That action is not allowed for this transaction right now.",
      details: {
        reason: result.error.reason,
        from: result.error.from,
        to: result.error.to,
        actor: result.error.actor,
      },
    });
  }
  return result.value;
}
