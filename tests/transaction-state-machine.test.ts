import { describe, expect, it } from "vitest";
import {
  TRANSACTION_EVENTS,
  isExternalPaymentEvent,
  type TransactionEvent,
} from "@/domain/transaction/events";
import {
  isAiActor,
  isTerminalState,
  TERMINAL_TRANSACTION_STATES,
  TRANSACTION_STATES,
  type TransactionActor,
  type TransactionState,
} from "@/domain/transaction/states";
import {
  allTransitionEdges,
  TRANSACTION_TRANSITIONS,
} from "@/domain/transaction/transitions";
import {
  permittedEventsFrom,
  resolveTransition,
  type TransitionDecisionKind,
} from "@/domain/transaction/state-machine";

/**
 * The pure state machine. No database, no provider, no clock.
 *
 * These tests are the enforcement mechanism for the project's financial rule:
 * an AI actor holds exactly one edge in the entire lifecycle, controls cannot be
 * skipped, and terminal transactions never resume.
 */
describe("transition matrix shape", () => {
  it("declares an entry for every state and targets only real states and events", () => {
    for (const state of TRANSACTION_STATES) {
      expect(TRANSACTION_TRANSITIONS[state]).toBeDefined();
    }
    for (const edge of allTransitionEdges()) {
      expect(TRANSACTION_STATES).toContain(edge.to);
      expect(TRANSACTION_EVENTS).toContain(edge.event);
      expect(edge.allowedActors.length).toBeGreaterThan(0);
    }
  });

  it("leaves every terminal state with no outgoing edge", () => {
    for (const state of TERMINAL_TRANSACTION_STATES) {
      expect(permittedEventsFrom(state)).toHaveLength(0);
    }
  });

  it("verifies the product before issuing a quote", () => {
    // The ordering that matters: a quote freezes an amount, so the authoritative
    // product facts must be proven first.
    expect(
      TRANSACTION_TRANSITIONS.PRODUCT_SELECTED.PRODUCT_VERIFICATION_SUCCEEDED?.to,
    ).toBe("PRODUCT_VERIFIED");
    expect(TRANSACTION_TRANSITIONS.PRODUCT_VERIFIED.QUOTE_ISSUED?.to).toBe(
      "QUOTE_CREATED",
    );
    // The inverse ordering must not exist.
    expect(TRANSACTION_TRANSITIONS.PRODUCT_SELECTED.QUOTE_ISSUED).toBeUndefined();
    expect(
      TRANSACTION_TRANSITIONS.QUOTE_CREATED.PRODUCT_VERIFICATION_SUCCEEDED,
    ).toBeUndefined();
  });

  it("lets AI actors trigger exactly one transition in the whole lifecycle", () => {
    const aiEdges = allTransitionEdges()
      .filter((edge) => edge.allowedActors.some(isAiActor))
      .map((edge) => `${edge.from}--${edge.event}-->${edge.to}`);
    expect(aiEdges).toEqual([
      "INTENT_RECEIVED--PRODUCT_SELECTION_CONFIRMED-->PRODUCT_SELECTED",
    ]);
  });

  it("names no payment vendor in the domain core", () => {
    for (const edge of allTransitionEdges()) {
      for (const actor of edge.allowedActors) {
        expect(actor).not.toMatch(/razorpay|stripe|paypal/i);
      }
    }
  });

  it("only lets a clock expire a transaction, never a user or an agent", () => {
    for (const edge of allTransitionEdges()) {
      if (edge.to === "EXPIRED") {
        expect(edge.allowedActors).toEqual(["system", "transaction_service"]);
      }
    }
  });
});

/**
 * Coverage guarantee: every permitted financial transition is exercised.
 *
 * This is table-driven over the matrix itself, so adding an edge without a
 * thought is impossible - a new edge is automatically asserted here, and any
 * edge that does not behave as declared fails.
 */
describe("every allowed edge resolves to APPLY", () => {
  const edges = allTransitionEdges();

  it("covers a non-trivial number of edges", () => {
    expect(edges.length).toBeGreaterThan(30);
  });

  it.each(edges.map((e) => [`${e.from} --${e.event}--> ${e.to}`, e] as const))(
    "%s",
    (_label, edge) => {
      for (const actor of edge.allowedActors) {
        const decision = resolveTransition({
          currentState: edge.from,
          event: edge.event,
          actor,
        });
        expect(decision.kind).toBe("APPLY");
        if (decision.kind === "APPLY") {
          expect(decision.to).toBe(edge.to);
          expect(decision.reasonCode).toBe(edge.reasonCode);
        }
      }
    },
  );

  it("rejects every edge when attempted by a non-permitted actor", () => {
    const allActors: readonly TransactionActor[] = [
      "human_user",
      "buyer_agent",
      "merchant_service",
      "policy_engine",
      "approval_gate",
      "inventory_service",
      "payment_provider",
      "payment_webhook",
    ];
    for (const edge of edges) {
      const forbidden = allActors.filter((a) => !edge.allowedActors.includes(a));
      for (const actor of forbidden) {
        const decision = resolveTransition({
          currentState: edge.from,
          event: edge.event,
          actor,
        });
        // External payment events may legitimately classify as duplicate or
        // late; what must never happen is APPLY by a forbidden actor.
        expect(decision.kind).not.toBe("APPLY");
      }
    }
  });
});

describe("canonical successful lifecycle", () => {
  it("walks intent to completion through every control", () => {
    const path: ReadonlyArray<[TransactionEvent, TransactionActor, TransactionState]> = [
      ["PRODUCT_SELECTION_CONFIRMED", "buyer_agent", "PRODUCT_SELECTED"],
      ["PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service", "PRODUCT_VERIFIED"],
      ["QUOTE_ISSUED", "quote_service", "QUOTE_CREATED"],
      ["POLICY_EVALUATION_COMPLETED", "policy_engine", "POLICY_EVALUATED"],
      ["POLICY_ALLOWED", "policy_engine", "AUTHORIZED"],
      ["INVENTORY_RESERVED", "inventory_service", "INVENTORY_RESERVED"],
      ["PAYMENT_ORDER_CREATED", "payment_provider", "PAYMENT_ORDER_CREATED"],
      ["PAYMENT_STARTED", "payment_provider", "PAYMENT_PENDING"],
      ["PAYMENT_CALLBACK_VERIFIED", "payment_provider", "PAYMENT_VERIFIED"],
      ["PAYMENT_CAPTURE_CONFIRMED", "payment_webhook", "PAYMENT_CAPTURED"],
      ["TRANSACTION_COMPLETED", "transaction_service", "COMPLETED"],
    ];

    let state: TransactionState = "INTENT_RECEIVED";
    for (const [event, actor, expected] of path) {
      const decision = resolveTransition({ currentState: state, event, actor });
      expect(decision.kind, `${state} + ${event}`).toBe("APPLY");
      if (decision.kind !== "APPLY") return;
      state = decision.to;
      expect(state).toBe(expected);
    }
    expect(state).toBe("COMPLETED");
    expect(isTerminalState(state)).toBe(true);
  });
});

describe("approval branch", () => {
  it("routes through a human and back into the authorized flow", () => {
    const approvalRequired = resolveTransition({
      currentState: "POLICY_EVALUATED",
      event: "POLICY_REQUIRES_APPROVAL",
      actor: "policy_engine",
    });
    expect(approvalRequired).toMatchObject({ kind: "APPLY", to: "APPROVAL_REQUIRED" });

    const granted = resolveTransition({
      currentState: "APPROVAL_REQUIRED",
      event: "APPROVAL_GRANTED",
      actor: "approval_gate",
    });
    expect(granted).toMatchObject({ kind: "APPLY", to: "AUTHORIZED" });

    const reserved = resolveTransition({
      currentState: "AUTHORIZED",
      event: "INVENTORY_RESERVED",
      actor: "inventory_service",
    });
    expect(reserved).toMatchObject({ kind: "APPLY", to: "INVENTORY_RESERVED" });
  });

  it("terminates safely when a human refuses or does not answer", () => {
    expect(
      resolveTransition({
        currentState: "APPROVAL_REQUIRED",
        event: "APPROVAL_REJECTED",
        actor: "approval_gate",
      }),
    ).toMatchObject({ kind: "APPLY", to: "CANCELLED" });

    expect(
      resolveTransition({
        currentState: "APPROVAL_REQUIRED",
        event: "APPROVAL_EXPIRED",
        actor: "system",
      }),
    ).toMatchObject({ kind: "APPLY", to: "EXPIRED" });
  });

  it("refuses to let the agent approve on the human's behalf", () => {
    const decision = resolveTransition({
      currentState: "APPROVAL_REQUIRED",
      event: "APPROVAL_GRANTED",
      actor: "buyer_agent",
    });
    expect(decision.kind).toBe("INVALID");
    if (decision.kind === "INVALID") expect(decision.reason).toBe("actor_not_permitted");
  });
});

describe("blocked branch", () => {
  it("blocks on a policy refusal and then goes nowhere", () => {
    expect(
      resolveTransition({
        currentState: "POLICY_EVALUATED",
        event: "POLICY_BLOCKED",
        actor: "policy_engine",
      }),
    ).toMatchObject({ kind: "APPLY", to: "BLOCKED" });

    for (const event of ["POLICY_ALLOWED", "PAYMENT_ORDER_CREATED"] as const) {
      const decision = resolveTransition({
        currentState: "BLOCKED",
        event,
        actor: "transaction_service",
      });
      expect(decision.kind).toBe("INVALID");
      if (decision.kind === "INVALID") expect(decision.reason).toBe("terminal_state");
    }
  });
});

describe("payment failure semantics", () => {
  it("is reachable from every legitimate payment lifecycle state", () => {
    for (const from of [
      "PAYMENT_ORDER_CREATED",
      "PAYMENT_PENDING",
      "PAYMENT_VERIFIED",
    ] as const) {
      expect(
        resolveTransition({
          currentState: from,
          event: "PAYMENT_FAILED",
          actor: "payment_webhook",
        }),
      ).toMatchObject({ kind: "APPLY", to: "PAYMENT_FAILED" });
    }
  });

  it("is a failure state but not a terminal one", () => {
    expect(isTerminalState("PAYMENT_FAILED")).toBe(false);
  });

  it("never becomes COMPLETED on its own", () => {
    const decision = resolveTransition({
      currentState: "PAYMENT_FAILED",
      event: "TRANSACTION_COMPLETED",
      actor: "transaction_service",
    });
    expect(decision.kind).toBe("INVALID");
  });

  it("permits only the three explicitly reserved recovery paths", () => {
    // Controlled retry, by the transaction service alone.
    expect(
      resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "PAYMENT_RETRY_REQUESTED",
        actor: "transaction_service",
      }),
    ).toMatchObject({ kind: "APPLY", to: "PAYMENT_ORDER_CREATED" });

    // Re-quoting a stale quote, by the quote service alone - a retry whose own
    // quote no longer holds, never a caller naming a price.
    expect(
      resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "QUOTE_ISSUED",
        actor: "quote_service",
      }),
    ).toMatchObject({ kind: "APPLY", to: "QUOTE_CREATED" });

    // A late verified capture - money really did move - by the webhook alone.
    expect(
      resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "PAYMENT_CAPTURE_CONFIRMED",
        actor: "payment_webhook",
      }),
    ).toMatchObject({ kind: "APPLY", to: "PAYMENT_CAPTURED" });

    // ...and not by anyone else.
    expect(
      resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "PAYMENT_RETRY_REQUESTED",
        actor: "buyer_agent",
      }).kind,
    ).toBe("INVALID");
    expect(
      resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "QUOTE_ISSUED",
        actor: "transaction_service",
      }).kind,
    ).toBe("INVALID");
  });

  it("does not allow arbitrary continuation of the normal flow", () => {
    for (const event of ["PAYMENT_STARTED", "POLICY_ALLOWED"] as const) {
      expect(
        resolveTransition({
          currentState: "PAYMENT_FAILED",
          event,
          actor: "transaction_service",
        }).kind,
      ).toBe("INVALID");
    }
  });
});

describe("the retry re-quote path stays inside its own lane", () => {
  it("lets a requoted retry proceed from AUTHORIZED straight to order creation", () => {
    // Reachable only via requoteAndContinue: it never claims a fresh
    // reservation, so PAYMENT_ORDER_CREATED must be reachable without ever
    // passing through INVENTORY_RESERVED again.
    expect(
      resolveTransition({
        currentState: "AUTHORIZED",
        event: "PAYMENT_RETRY_REQUESTED",
        actor: "transaction_service",
      }),
    ).toMatchObject({ kind: "APPLY", to: "PAYMENT_ORDER_CREATED" });
  });

  it("does not let anyone else take that edge, or let it claim stock", () => {
    expect(
      resolveTransition({
        currentState: "AUTHORIZED",
        event: "PAYMENT_RETRY_REQUESTED",
        actor: "inventory_service",
      }).kind,
    ).toBe("INVALID");
    // Still the only way an ordinary first authorization reaches a hold.
    expect(
      resolveTransition({
        currentState: "AUTHORIZED",
        event: "INVENTORY_RESERVED",
        actor: "inventory_service",
      }),
    ).toMatchObject({ kind: "APPLY", to: "INVENTORY_RESERVED" });
  });
});

describe("terminal state protection", () => {
  const internalEvents = TRANSACTION_EVENTS.filter((e) => !isExternalPaymentEvent(e));

  it.each(TERMINAL_TRANSACTION_STATES)("%s refuses every internal event", (state) => {
    for (const event of internalEvents) {
      const decision = resolveTransition({
        currentState: state,
        event,
        actor: "transaction_service",
      });
      expect(decision.kind, `${state} + ${event}`).toBe("INVALID");
      if (decision.kind === "INVALID") expect(decision.reason).toBe("terminal_state");
    }
  });

  it("never silently reopens a completed transaction", () => {
    for (const event of ["PRODUCT_SELECTION_CONFIRMED", "POLICY_ALLOWED"] as const) {
      const decision = resolveTransition({
        currentState: "COMPLETED",
        event,
        actor: "transaction_service",
      });
      expect(decision.kind).toBe("INVALID");
    }
  });
});

describe("nonsense transitions are impossible", () => {
  /**
   * Each case names *how* it is refused, not merely that it is not applied.
   *
   * "Not APPLY" is three different answers wearing one coat, and the difference
   * between them is the whole behaviour: `INVALID/terminal_state` means the
   * purchase is over, `INVALID/event_not_permitted_from_state` means a control
   * was skipped, and `IDEMPOTENT_NO_OP` means the machine decided the event was
   * harmless. A refusal quietly becoming a no-op is precisely the regression
   * that matters here and the one a negative assertion cannot see - so the
   * expected kind, and its reason, are part of the table.
   */
  const nonsense: ReadonlyArray<
    readonly [TransactionState, TransactionEvent, TransitionDecisionKind, string | null]
  > = [
    // An external capture this early is not nonsense at all: the machine parks
    // it for reconciliation rather than refusing it, because a real payment may
    // have happened and must never be dropped. Asserted so that the day it
    // starts being refused outright, somebody has to say so out loud.
    [
      "INTENT_RECEIVED",
      "PAYMENT_CAPTURE_CONFIRMED",
      "LATE_EVENT_RECONCILIATION_CANDIDATE",
      null,
    ],
    [
      "INTENT_RECEIVED",
      "TRANSACTION_COMPLETED",
      "INVALID",
      "event_not_permitted_from_state",
    ],
    [
      "PRODUCT_SELECTED",
      "TRANSACTION_COMPLETED",
      "INVALID",
      "event_not_permitted_from_state",
    ],
    ["PRODUCT_SELECTED", "POLICY_ALLOWED", "INVALID", "event_not_permitted_from_state"],
    ["BLOCKED", "PAYMENT_STARTED", "INVALID", "terminal_state"],
    ["COMPLETED", "POLICY_ALLOWED", "INVALID", "terminal_state"],
    ["CANCELLED", "PAYMENT_ORDER_CREATED", "INVALID", "terminal_state"],
    // Skipping the reservation is the check-then-charge race.
    ["AUTHORIZED", "PAYMENT_ORDER_CREATED", "INVALID", "event_not_permitted_from_state"],
    // Skipping verification would quote an unverified price.
    ["PRODUCT_SELECTED", "QUOTE_ISSUED", "INVALID", "event_not_permitted_from_state"],
  ];

  it.each(
    nonsense.map(
      ([state, event, kind, reason]) =>
        [`${state} + ${event} -> ${kind}`, state, event, kind, reason] as const,
    ),
  )("%s", (_label, state, event, expectedKind, expectedReason) => {
    const decision = resolveTransition({
      currentState: state,
      event,
      actor: "transaction_service",
    });

    expect(decision.kind).toBe(expectedKind);
    if (expectedReason !== null) {
      expect(decision.kind === "INVALID" ? decision.reason : null).toBe(expectedReason);
    }
  });

  it("refuses every one of them for a reason the machine can name", () => {
    // No refusal may be silent: whatever kind it carries, it must also carry an
    // explanation, because that string is what reaches the audit trail.
    for (const [state, event] of nonsense) {
      const decision = resolveTransition({
        currentState: state,
        event,
        actor: "transaction_service",
      });
      expect(decision.kind).not.toBe("APPLY");
      expect("explanation" in decision ? decision.explanation.length : 0).toBeGreaterThan(
        10,
      );
    }
  });
});

describe("late external event classification", () => {
  it("treats a replayed capture on a settled transaction as already applied", () => {
    for (const state of ["PAYMENT_CAPTURED", "COMPLETED"] as const) {
      const decision = resolveTransition({
        currentState: state,
        event: "PAYMENT_CAPTURE_CONFIRMED",
        actor: "payment_webhook",
      });
      expect(decision.kind).toBe("IDEMPOTENT_NO_OP");
    }
  });

  it("treats a replayed failure on an already-failed transaction as already applied", () => {
    expect(
      resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "PAYMENT_FAILED",
        actor: "payment_webhook",
      }).kind,
    ).toBe("IDEMPOTENT_NO_OP");
  });

  it("holds a capture that arrives after the transaction was abandoned", () => {
    // Money may genuinely have moved. Discarding this would lose a real event;
    // applying it would resurrect an abandoned transaction. Neither is safe.
    for (const state of ["CANCELLED", "EXPIRED", "BLOCKED"] as const) {
      const decision = resolveTransition({
        currentState: state,
        event: "PAYMENT_CAPTURE_CONFIRMED",
        actor: "payment_webhook",
      });
      expect(decision.kind).toBe("LATE_EVENT_RECONCILIATION_CANDIDATE");
    }
  });

  it("holds a failure event that contradicts a settled capture", () => {
    const decision = resolveTransition({
      currentState: "COMPLETED",
      event: "PAYMENT_FAILED",
      actor: "payment_webhook",
    });
    expect(decision.kind).toBe("LATE_EVENT_RECONCILIATION_CANDIDATE");
  });

  it("never silently moves a transaction backwards on a late event", () => {
    // A verified callback arriving after completion is absorbed as a no-op,
    // not refused and not applied. Asserted exactly: "not APPLY" would equally
    // accept the machine reclassifying this as an INVALID hard error, which
    // would turn an ordinary late browser callback into a failed request.
    const decision = resolveTransition({
      currentState: "COMPLETED",
      event: "PAYMENT_CALLBACK_VERIFIED",
      actor: "payment_provider",
    });
    expect(decision.kind).toBe("IDEMPOTENT_NO_OP");
  });
});
