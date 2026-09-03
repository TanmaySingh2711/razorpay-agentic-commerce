import type { TransactionEvent, TransitionReasonCode } from "@/domain/transaction/events";
import type { TransactionActor, TransactionState } from "@/domain/transaction/states";

/**
 * A single legal edge: from a state, on an event, by a permitted actor.
 *
 * `allowedActors` is the load-bearing field. It is where "AI cannot approve
 * itself" and "AI cannot mark a payment successful" stop being documentation
 * and become data the machine enforces.
 */
export interface TransactionTransition {
  readonly to: TransactionState;
  readonly allowedActors: readonly TransactionActor[];
  readonly reasonCode: TransitionReasonCode;
}

/** The transition matrix: state -> event -> edge. */
export type TransitionMatrix = Readonly<
  Record<
    TransactionState,
    Partial<Readonly<Record<TransactionEvent, TransactionTransition>>>
  >
>;

const CANCEL_ACTORS = ["human_user", "transaction_service"] as const;

/** Expiry is driven by a clock. Never by a user, never by an agent. */
const EXPIRY_ACTORS = ["system", "transaction_service"] as const;

/** Edges available from most pre-payment states. */
const CANCELLABLE = {
  TRANSACTION_CANCELLED: {
    to: "CANCELLED",
    allowedActors: CANCEL_ACTORS,
    reasonCode: "USER_CANCELLED",
  },
} as const satisfies Partial<Record<TransactionEvent, TransactionTransition>>;

/**
 * THE central transition matrix. Every legal lifecycle change in the system is
 * here and nowhere else - not in a route handler, not in a service.
 *
 * Ordering note: PRODUCT_SELECTED -> PRODUCT_VERIFIED -> QUOTE_CREATED. The
 * server proves the authoritative product facts *before* issuing a quote that
 * everything downstream will trust. Quoting first would freeze an amount taken
 * from an agent's unverified claim.
 *
 * Any (state, event) pair absent from this map is not a legal transition,
 * including every attempt to skip a control.
 */
export const TRANSACTION_TRANSITIONS: TransitionMatrix = {
  INTENT_RECEIVED: {
    // The single point in the whole lifecycle where an AI actor may act.
    PRODUCT_SELECTION_CONFIRMED: {
      to: "PRODUCT_SELECTED",
      allowedActors: ["buyer_agent", "product_decision_engine"],
      reasonCode: "PRODUCT_SELECTED",
    },
    INTENT_REJECTED: {
      to: "BLOCKED",
      allowedActors: ["policy_engine", "transaction_service"],
      reasonCode: "INTENT_REJECTED",
    },
    TRANSACTION_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "TRANSACTION_EXPIRED",
    },
    ...CANCELLABLE,
  },

  PRODUCT_SELECTED: {
    // Server-side verification: the agent's claimed price is discarded here.
    PRODUCT_VERIFICATION_SUCCEEDED: {
      to: "PRODUCT_VERIFIED",
      allowedActors: ["merchant_service"],
      reasonCode: "PRODUCT_VERIFIED",
    },
    PRODUCT_VERIFICATION_FAILED: {
      to: "BLOCKED",
      allowedActors: ["merchant_service", "transaction_service"],
      reasonCode: "PRODUCT_VERIFICATION_FAILED",
    },
    TRANSACTION_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "TRANSACTION_EXPIRED",
    },
    ...CANCELLABLE,
  },

  PRODUCT_VERIFIED: {
    // Only now may an amount be frozen.
    QUOTE_ISSUED: {
      to: "QUOTE_CREATED",
      allowedActors: ["quote_service"],
      reasonCode: "QUOTE_ISSUED",
    },
    TRANSACTION_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "TRANSACTION_EXPIRED",
    },
    ...CANCELLABLE,
  },

  QUOTE_CREATED: {
    /**
     * Re-quoting: a replacement price, without leaving the quoting phase.
     *
     * The only self-loop in the matrix, and it earns its place. A quote can
     * lapse or be invalidated - the price moved, stock fell, the product
     * changed - and the honest response is a *new* quote, not an edited one:
     * the old row is a record of a price the merchant once stood behind, and
     * rewriting it would destroy the history that makes a disputed charge
     * explicable.
     *
     * The transaction has not progressed, so inventing a new state to express
     * "still quoting, but again" would model a phase that does not exist.
     * Staying put is the truthful description.
     *
     * It is safe to loop because each pass writes its own history row with the
     * `QUOTE_REISSUED` reason, and because the database permits at most one
     * ACTIVE quote per transaction - so a replacement can only exist once its
     * predecessor has been superseded. Restricted to `quote_service`: no agent,
     * user or provider can ask for a re-price.
     */
    QUOTE_ISSUED: {
      to: "QUOTE_CREATED",
      allowedActors: ["quote_service"],
      reasonCode: "QUOTE_REISSUED",
    },
    POLICY_EVALUATION_COMPLETED: {
      to: "POLICY_EVALUATED",
      allowedActors: ["policy_engine"],
      reasonCode: "POLICY_EVALUATED",
    },
    QUOTE_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "QUOTE_EXPIRED",
    },
    ...CANCELLABLE,
  },

  POLICY_EVALUATED: {
    POLICY_ALLOWED: {
      to: "AUTHORIZED",
      allowedActors: ["policy_engine"],
      reasonCode: "POLICY_ALLOWED",
    },
    POLICY_REQUIRES_APPROVAL: {
      to: "APPROVAL_REQUIRED",
      allowedActors: ["policy_engine"],
      reasonCode: "POLICY_REQUIRES_APPROVAL",
    },
    POLICY_BLOCKED: {
      to: "BLOCKED",
      allowedActors: ["policy_engine"],
      reasonCode: "POLICY_BLOCKED",
    },
    QUOTE_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "QUOTE_EXPIRED",
    },
    ...CANCELLABLE,
  },

  APPROVAL_REQUIRED: {
    // Only the human-backed approval gate can convert approval into authority.
    APPROVAL_GRANTED: {
      to: "AUTHORIZED",
      allowedActors: ["approval_gate"],
      reasonCode: "APPROVAL_GRANTED",
    },
    APPROVAL_REJECTED: {
      to: "CANCELLED",
      allowedActors: ["approval_gate"],
      reasonCode: "APPROVAL_REJECTED",
    },
    APPROVAL_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "APPROVAL_EXPIRED",
    },
    ...CANCELLABLE,
  },

  AUTHORIZED: {
    // Stock is held before money moves: no edge from here to a payment state
    // claims it for the first time.
    INVENTORY_RESERVED: {
      to: "INVENTORY_RESERVED",
      allowedActors: ["inventory_service"],
      reasonCode: "INVENTORY_RESERVED",
    },
    INVENTORY_UNAVAILABLE: {
      to: "BLOCKED",
      allowedActors: ["inventory_service", "transaction_service"],
      reasonCode: "INVENTORY_UNAVAILABLE",
    },
    /**
     * The one exception to the rule above, and it does not weaken it.
     *
     * This edge exists for exactly one caller: a controlled retry whose
     * original quote went stale after a failed payment. That retry re-quotes
     * and re-runs policy against today's facts (see `PAYMENT_FAILED` below),
     * which is what lands the transaction back here - AUTHORIZED - while the
     * *original* stock hold, claimed before the first attempt, is still
     * `ACTIVE` and has just been rebound to the fresh quote. Stock genuinely is
     * held before this edge is taken; it was simply never released, so there is
     * nothing left for `reserveInventory` to claim a second time.
     *
     * `retry` on `CreatePaymentOrderCommand` cannot be constructed by any HTTP
     * boundary - only `@/services/payment/retry-service` builds one, and only
     * after its own gate has independently confirmed a matching `ACTIVE`
     * reservation exists - so this edge cannot be reached by an ordinary first
     * authorization, which never carries that value.
     */
    PAYMENT_RETRY_REQUESTED: {
      to: "PAYMENT_ORDER_CREATED",
      allowedActors: ["transaction_service"],
      reasonCode: "PAYMENT_RETRY_REQUESTED",
    },
    ...CANCELLABLE,
  },

  INVENTORY_RESERVED: {
    PAYMENT_ORDER_CREATED: {
      to: "PAYMENT_ORDER_CREATED",
      allowedActors: ["payment_provider"],
      reasonCode: "PAYMENT_ORDER_CREATED",
    },
    PAYMENT_FAILED: {
      to: "PAYMENT_FAILED",
      allowedActors: ["payment_provider"],
      reasonCode: "PAYMENT_ATTEMPT_FAILED",
    },
    RESERVATION_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "RESERVATION_EXPIRED",
    },
    ...CANCELLABLE,
  },

  PAYMENT_ORDER_CREATED: {
    PAYMENT_STARTED: {
      to: "PAYMENT_PENDING",
      allowedActors: ["payment_provider", "transaction_service"],
      reasonCode: "PAYMENT_STARTED",
    },
    /**
     * A capture for an *earlier* attempt, arriving after a retry has begun.
     *
     * Added in Objective 14, and it exists because of one concrete sequence:
     * attempt #1 is reported failed, a person requests a retry, the retry
     * creates attempt #2 and puts the transaction back at PAYMENT_ORDER_CREATED
     * - and only then does the provider deliver a genuine `payment.captured`
     * for attempt #1. Money moved. Without this edge the event has no legal
     * transition, is held for reconciliation, and a real capture sits
     * unaccounted for while the buyer is invited to pay again.
     *
     * Restricted to `payment_webhook`: only the party that holds the money may
     * say it arrived. The browser callback path cannot take this edge, and does
     * not try - it refuses any callback outside PAYMENT_PENDING.
     */
    PAYMENT_CAPTURE_CONFIRMED: {
      to: "PAYMENT_CAPTURED",
      allowedActors: ["payment_webhook"],
      reasonCode: "LATE_CAPTURE_RECONCILED",
    },
    PAYMENT_FAILED: {
      to: "PAYMENT_FAILED",
      allowedActors: ["payment_provider", "payment_webhook"],
      reasonCode: "PAYMENT_ATTEMPT_FAILED",
    },
    ...CANCELLABLE,
  },

  PAYMENT_PENDING: {
    PAYMENT_CALLBACK_VERIFIED: {
      to: "PAYMENT_VERIFIED",
      allowedActors: ["payment_provider"],
      reasonCode: "PAYMENT_SIGNATURE_VERIFIED",
    },
    // A verified webhook may report settlement without a checkout callback.
    PAYMENT_CAPTURE_CONFIRMED: {
      to: "PAYMENT_CAPTURED",
      allowedActors: ["payment_webhook", "payment_provider"],
      reasonCode: "PAYMENT_CAPTURE_CONFIRMED",
    },
    PAYMENT_FAILED: {
      to: "PAYMENT_FAILED",
      allowedActors: ["payment_provider", "payment_webhook"],
      reasonCode: "PAYMENT_ATTEMPT_FAILED",
    },
    PAYMENT_WINDOW_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "PAYMENT_WINDOW_EXPIRED",
    },
  },

  PAYMENT_VERIFIED: {
    PAYMENT_CAPTURE_CONFIRMED: {
      to: "PAYMENT_CAPTURED",
      allowedActors: ["payment_webhook", "payment_provider"],
      reasonCode: "PAYMENT_CAPTURE_CONFIRMED",
    },
    PAYMENT_FAILED: {
      to: "PAYMENT_FAILED",
      allowedActors: ["payment_webhook", "payment_provider"],
      reasonCode: "PAYMENT_ATTEMPT_FAILED",
    },
  },

  PAYMENT_CAPTURED: {
    TRANSACTION_COMPLETED: {
      to: "COMPLETED",
      allowedActors: ["transaction_service"],
      reasonCode: "TRANSACTION_COMPLETED",
    },
  },

  /**
   * PAYMENT_FAILED is a failure state but NOT terminal, and its exits are
   * deliberately narrow:
   *
   *  - retry, by the transaction service only, reusing the existing
   *    authorization and reservation when they still hold - it never re-enters
   *    the AI path;
   *  - re-quoting, when a retry's own authorization no longer holds because the
   *    original quote went stale. This is not a silent reprice: it is the same
   *    self-loop `QUOTE_CREATED` already has for "still quoting, but again",
   *    reused here because a failed payment can sit for longer than a quote's
   *    TTL, and the honest answer to a stale quote is a fresh one, re-run
   *    through the full deterministic policy engine - never an edited amount.
   *    Restricted to `quote_service`, exactly like the original edge: no
   *    retry request can name a price, only ask for the current one;
   *  - a late verified capture from the provider, because money may genuinely
   *    have moved after a failure was recorded. Restricted to `payment_webhook`
   *    so only verified provider evidence can take it.
   *
   * Objective 3 makes these transitions *possible*. The conditions under which
   * a service may request them belong to the payment objective.
   */
  PAYMENT_FAILED: {
    PAYMENT_RETRY_REQUESTED: {
      to: "PAYMENT_ORDER_CREATED",
      allowedActors: ["transaction_service"],
      reasonCode: "PAYMENT_RETRY_REQUESTED",
    },
    QUOTE_ISSUED: {
      to: "QUOTE_CREATED",
      allowedActors: ["quote_service"],
      reasonCode: "QUOTE_REISSUED",
    },
    PAYMENT_CAPTURE_CONFIRMED: {
      to: "PAYMENT_CAPTURED",
      allowedActors: ["payment_webhook"],
      reasonCode: "LATE_CAPTURE_RECONCILED",
    },
    RESERVATION_EXPIRED: {
      to: "EXPIRED",
      allowedActors: EXPIRY_ACTORS,
      reasonCode: "RESERVATION_EXPIRED",
    },
    ...CANCELLABLE,
  },

  // Terminal states. No exits, by design.
  COMPLETED: {},
  BLOCKED: {},
  CANCELLED: {},
  EXPIRED: {},
};

/** Every legal edge, flattened. Used by tests to prove coverage. */
export function allTransitionEdges(): ReadonlyArray<{
  readonly from: TransactionState;
  readonly event: TransactionEvent;
  readonly to: TransactionState;
  readonly allowedActors: readonly TransactionActor[];
  readonly reasonCode: TransitionReasonCode;
}> {
  const edges: Array<{
    from: TransactionState;
    event: TransactionEvent;
    to: TransactionState;
    allowedActors: readonly TransactionActor[];
    reasonCode: TransitionReasonCode;
  }> = [];
  for (const [from, events] of Object.entries(TRANSACTION_TRANSITIONS)) {
    for (const [event, edge] of Object.entries(events)) {
      edges.push({
        from: from as TransactionState,
        event: event as TransactionEvent,
        to: edge.to,
        allowedActors: edge.allowedActors,
        reasonCode: edge.reasonCode,
      });
    }
  }
  return edges;
}

export function findTransition(
  from: TransactionState,
  event: TransactionEvent,
): TransactionTransition | undefined {
  return TRANSACTION_TRANSITIONS[from][event];
}
