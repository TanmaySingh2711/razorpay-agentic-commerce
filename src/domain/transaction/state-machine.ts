import {
  isExternalPaymentEvent,
  type TransactionEvent,
  type TransitionReasonCode,
} from "@/domain/transaction/events";
import {
  isTerminalState,
  type TransactionActor,
  type TransactionState,
} from "@/domain/transaction/states";
import {
  findTransition,
  TRANSACTION_TRANSITIONS,
} from "@/domain/transaction/transitions";

/**
 * The deterministic adjudicator for transaction state changes.
 *
 * Pure: no I/O, no persistence, no clock, no provider. It answers one question -
 * given a current state and a domain event, what should happen? - and returns a
 * classification the caller must handle.
 *
 * Because it is pure it is exhaustively testable, which is what turns "AI cannot
 * mutate transaction state" from a promise into a checkable property.
 */

/**
 * The four possible verdicts.
 *
 * `LATE_EVENT_RECONCILIATION_CANDIDATE` exists because payment providers send
 * events at-least-once, out of order, and sometimes long after a transaction
 * moved on. Such an event is neither a bug nor a safe no-op: it may be the
 * authoritative financial truth arriving late, and a human or a reconciliation
 * job must decide. Collapsing it into INVALID would discard real money events;
 * collapsing it into APPLY would let a stale webhook rewrite a settled
 * transaction.
 */
export type TransitionDecisionKind =
  "APPLY" | "IDEMPOTENT_NO_OP" | "INVALID" | "LATE_EVENT_RECONCILIATION_CANDIDATE";

export interface TransitionRequest {
  readonly currentState: TransactionState;
  readonly event: TransactionEvent;
  readonly actor: TransactionActor;
}

export type InvalidTransitionReason =
  "terminal_state" | "event_not_permitted_from_state" | "actor_not_permitted";

export type TransitionDecision =
  | {
      readonly kind: "APPLY";
      readonly from: TransactionState;
      readonly to: TransactionState;
      readonly event: TransactionEvent;
      readonly actor: TransactionActor;
      readonly reasonCode: TransitionReasonCode;
    }
  | {
      readonly kind: "IDEMPOTENT_NO_OP";
      readonly currentState: TransactionState;
      readonly event: TransactionEvent;
      /** Concise, user-safe explanation. Feeds a decision record. */
      readonly explanation: string;
    }
  | {
      readonly kind: "INVALID";
      readonly currentState: TransactionState;
      readonly event: TransactionEvent;
      readonly actor: TransactionActor;
      readonly reason: InvalidTransitionReason;
      readonly explanation: string;
    }
  | {
      readonly kind: "LATE_EVENT_RECONCILIATION_CANDIDATE";
      readonly currentState: TransactionState;
      readonly event: TransactionEvent;
      readonly explanation: string;
    };

/**
 * States in which an external payment event has demonstrably already been
 * accounted for, so receiving it again is a duplicate rather than news.
 *
 * Example: a `PAYMENT_CAPTURE_CONFIRMED` webhook arriving when the transaction
 * is already COMPLETED. The capture happened; the transaction moved past it.
 * Replaying it must change nothing.
 */
const EVENT_ALREADY_ACCOUNTED_FOR: Partial<
  Record<TransactionEvent, readonly TransactionState[]>
> = {
  PAYMENT_CALLBACK_VERIFIED: ["PAYMENT_VERIFIED", "PAYMENT_CAPTURED", "COMPLETED"],
  PAYMENT_CAPTURE_CONFIRMED: ["PAYMENT_CAPTURED", "COMPLETED"],
  PAYMENT_FAILED: ["PAYMENT_FAILED"],
};

function alreadyAccountedFor(event: TransactionEvent, state: TransactionState): boolean {
  return EVENT_ALREADY_ACCOUNTED_FOR[event]?.includes(state) ?? false;
}

/**
 * Adjudicates one event against one state.
 *
 * Order of reasoning matters:
 *   1. Has this external event already been accounted for? -> duplicate.
 *   2. Is there a legal edge, and may this actor take it? -> apply or refuse.
 *   3. Is it an external payment event with no legal edge? -> reconcile, do not
 *      discard: money may have moved.
 *   4. Otherwise it is a genuine programming or protocol error.
 */
export function resolveTransition(request: TransitionRequest): TransitionDecision {
  const { currentState, event, actor } = request;

  // 1. A replayed provider event that this transaction has already moved past.
  if (isExternalPaymentEvent(event) && alreadyAccountedFor(event, currentState)) {
    return {
      kind: "IDEMPOTENT_NO_OP",
      currentState,
      event,
      explanation: `${event} has already been accounted for in state ${currentState}.`,
    };
  }

  const transition = findTransition(currentState, event);

  // 2. A legal edge exists.
  if (transition !== undefined) {
    if (!transition.allowedActors.includes(actor)) {
      return {
        kind: "INVALID",
        currentState,
        event,
        actor,
        reason: "actor_not_permitted",
        explanation: `${actor} is not permitted to perform ${event}.`,
      };
    }
    return {
      kind: "APPLY",
      from: currentState,
      to: transition.to,
      event,
      actor,
      reasonCode: transition.reasonCode,
    };
  }

  // 3. No legal edge, but the provider is telling us something about money.
  if (isExternalPaymentEvent(event)) {
    return {
      kind: "LATE_EVENT_RECONCILIATION_CANDIDATE",
      currentState,
      event,
      explanation:
        `${event} arrived while the transaction is ${currentState}, where it is not a legal ` +
        `transition. It is held for reconciliation rather than applied or discarded.`,
    };
  }

  // 4. Genuinely illegal.
  if (isTerminalState(currentState)) {
    return {
      kind: "INVALID",
      currentState,
      event,
      actor,
      reason: "terminal_state",
      explanation: `Transaction is already finished in state ${currentState} and cannot change.`,
    };
  }

  return {
    kind: "INVALID",
    currentState,
    event,
    actor,
    reason: "event_not_permitted_from_state",
    explanation: `${event} is not a permitted step from ${currentState}.`,
  };
}

/** Events legally available from a state, ignoring actor permissions. */
export function permittedEventsFrom(
  state: TransactionState,
): readonly TransactionEvent[] {
  return Object.keys(TRANSACTION_TRANSITIONS[state]) as TransactionEvent[];
}
