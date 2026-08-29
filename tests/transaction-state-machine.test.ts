import { describe, expect, it } from "vitest";
import { DomainRuleError } from "@/domain/errors";
import { asIdempotencyKey } from "@/domain/identifiers";
import {
  isAiActor,
  isTerminalState,
  TERMINAL_TRANSACTION_STATES,
  TRANSACTION_STATES,
  type TransactionState,
} from "@/domain/transaction/states";
import { TRANSACTION_TRANSITIONS } from "@/domain/transaction/transitions";
import {
  assertTransition,
  allowedTransitionsFrom,
  evaluateTransition,
} from "@/domain/transaction/state-machine";

describe("transaction transition table", () => {
  it("declares an entry for every state and targets only real states", () => {
    for (const state of TRANSACTION_STATES) {
      expect(TRANSACTION_TRANSITIONS[state]).toBeDefined();
      for (const transition of TRANSACTION_TRANSITIONS[state]) {
        expect(TRANSACTION_STATES).toContain(transition.to);
      }
    }
  });

  it("leaves every terminal state with no outgoing transition", () => {
    for (const state of TERMINAL_TRANSACTION_STATES) {
      expect(allowedTransitionsFrom(state)).toHaveLength(0);
    }
  });

  it("lets AI actors trigger exactly one transition in the whole lifecycle", () => {
    const aiEdges: string[] = [];
    for (const state of TRANSACTION_STATES) {
      for (const transition of TRANSACTION_TRANSITIONS[state]) {
        if (transition.allowedActors.some(isAiActor)) {
          aiEdges.push(`${state}->${transition.to}`);
        }
      }
    }
    expect(aiEdges).toEqual(["INTENT_RECEIVED->PRODUCT_SELECTED"]);
  });
});

describe("evaluateTransition", () => {
  it("permits the deterministic happy path", () => {
    const path: ReadonlyArray<
      [
        TransactionState,
        TransactionState,
        (
          | "policy_engine"
          | "merchant_service"
          | "razorpay_integration"
          | "razorpay_webhook"
          | "transaction_service"
        ),
      ]
    > = [
      ["PRODUCT_SELECTED", "PRODUCT_VERIFIED", "merchant_service"],
      ["PRODUCT_VERIFIED", "POLICY_CHECKED", "policy_engine"],
      ["POLICY_CHECKED", "AUTHORIZED", "policy_engine"],
      ["AUTHORIZED", "PAYMENT_CREATED", "razorpay_integration"],
      ["PAYMENT_CREATED", "PAYMENT_PENDING", "razorpay_integration"],
      ["PAYMENT_PENDING", "PAYMENT_CAPTURED", "razorpay_webhook"],
      ["PAYMENT_CAPTURED", "COMPLETED", "transaction_service"],
    ];
    for (const [from, to, actor] of path) {
      const result = evaluateTransition({ from, to, actor });
      expect(result.ok, `${from} -> ${to} as ${actor}`).toBe(true);
    }
  });

  it("blocks the buyer agent from authorizing its own purchase", () => {
    const result = evaluateTransition({
      from: "POLICY_CHECKED",
      to: "AUTHORIZED",
      actor: "buyer_agent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("actor_not_permitted");
  });

  it("blocks the buyer agent from approving an approval-gated transaction", () => {
    const result = evaluateTransition({
      from: "APPROVAL_REQUIRED",
      to: "AUTHORIZED",
      actor: "buyer_agent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("actor_not_permitted");
  });

  it("blocks the buyer agent from declaring a payment captured", () => {
    const result = evaluateTransition({
      from: "PAYMENT_PENDING",
      to: "PAYMENT_CAPTURED",
      actor: "buyer_agent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("actor_not_permitted");
  });

  it("refuses to skip verification, policy or approval controls", () => {
    const skips: ReadonlyArray<[TransactionState, TransactionState]> = [
      ["PRODUCT_SELECTED", "AUTHORIZED"],
      ["PRODUCT_SELECTED", "PAYMENT_CREATED"],
      ["PRODUCT_VERIFIED", "AUTHORIZED"],
      ["POLICY_CHECKED", "PAYMENT_CAPTURED"],
      ["INTENT_RECEIVED", "COMPLETED"],
    ];
    for (const [from, to] of skips) {
      const result = evaluateTransition({ from, to, actor: "transaction_service" });
      expect(result.ok, `${from} -> ${to} must be rejected`).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe("unknown_transition");
    }
  });

  it("refuses to move a completed transaction", () => {
    const result = evaluateTransition({
      from: "COMPLETED",
      to: "PAYMENT_FAILED",
      actor: "razorpay_webhook",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("terminal_state");
  });

  it("treats a replayed webhook transition as already applied, not as an error", () => {
    const result = evaluateTransition({
      from: "PAYMENT_CAPTURED",
      to: "PAYMENT_CAPTURED",
      actor: "razorpay_webhook",
      idempotencyKey: asIdempotencyKey("evt_pay_captured_1"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe("already_applied");
  });

  it("allows a failed payment to be retried, but only by the transaction service", () => {
    expect(
      evaluateTransition({
        from: "PAYMENT_FAILED",
        to: "PAYMENT_CREATED",
        actor: "transaction_service",
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition({
        from: "PAYMENT_FAILED",
        to: "PAYMENT_CREATED",
        actor: "buyer_agent",
      }).ok,
    ).toBe(false);
    expect(isTerminalState("PAYMENT_FAILED")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("throws a domain rule error carrying a browser-safe message", () => {
    try {
      assertTransition({
        from: "INTENT_RECEIVED",
        to: "COMPLETED",
        actor: "buyer_agent",
      });
      expect.unreachable("expected assertTransition to throw");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(DomainRuleError);
      const error = thrown as DomainRuleError;
      expect(error.code).toBe("TRANSACTION_INVALID_TRANSITION");
      expect(error.toPublicPayload().message).not.toContain("INTENT_RECEIVED");
    }
  });
});
