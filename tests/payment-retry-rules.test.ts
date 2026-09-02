import { describe, expect, it } from "vitest";
import {
  MAX_PAYMENT_ATTEMPTS,
  RETRY_DENIALS,
  RETRY_REUSES_PROVIDER_ORDER,
  endsWorkflow,
  remainingAttempts,
  withinAttemptLimit,
} from "@/domain/payment/retry";
import { resolveTransition } from "@/domain/transaction/state-machine";
import { allTransitionEdges } from "@/domain/transaction/transitions";
import { AI_ACTORS, TRANSACTION_ACTORS } from "@/domain/transaction/states";
import { handleRetryPayment } from "@/app/api/payments/handler";
import type { RetryServiceDeps } from "@/services/payment/retry-service";
import type { TransactionActor } from "@/domain/transaction/states";

/**
 * The retry rules, decided without a database.
 *
 * Everything here is a total function over values or a pure state-machine
 * question, which is what makes it possible to enumerate the boundary cases
 * rather than sample them. The interesting properties of a retry workflow are
 * negative - that a limit cannot be raised, that an AI actor cannot take the
 * retry edge, that a browser cannot name an amount - and negatives are exactly
 * what a deterministic suite can prove exhaustively.
 */

describe("the attempt limit", () => {
  it("permits one initial attempt and two retries", () => {
    expect(MAX_PAYMENT_ATTEMPTS).toBe(3);
  });

  it("is a function of the persisted count and nothing else", () => {
    // Enumerated across the whole boundary, including past it. A transaction
    // that somehow holds more attempts than the limit must still refuse rather
    // than compute a negative allowance.
    const table: ReadonlyArray<readonly [number, boolean, number]> = [
      [0, true, 3],
      [1, true, 2],
      [2, true, 1],
      [3, false, 0],
      [4, false, 0],
      [99, false, 0],
    ];
    for (const [used, allowed, remaining] of table) {
      expect(withinAttemptLimit(used), `used=${String(used)}`).toBe(allowed);
      expect(remainingAttempts(used), `used=${String(used)}`).toBe(remaining);
    }
  });
});

describe("which refusals end the workflow", () => {
  /**
   * The distinction decides whether held stock is given back, so it is asserted
   * per denial rather than left to a helper nobody re-reads. Getting it wrong
   * in one direction keeps a unit away from buyers who could complete; in the
   * other it takes a unit away from someone mid-payment.
   */
  const ENDING = [
    "RETRY_LIMIT_REACHED",
    "FINANCIAL_FACTS_CHANGED",
    "NOT_AUTHORIZED",
    "NO_ACTIVE_QUOTE",
  ] as const;

  for (const denial of RETRY_DENIALS) {
    const expected = (ENDING as readonly string[]).includes(denial);
    it(`${denial} ${expected ? "ends" : "does not end"} the workflow`, () => {
      expect(endsWorkflow(denial)).toBe(expected);
    });
  }

  it("never releases stock while an outcome is unknown or a payment is live", () => {
    // The two refusals where releasing would be a guess about money.
    expect(endsWorkflow("OUTCOME_UNRESOLVED")).toBe(false);
    expect(endsWorkflow("ATTEMPT_IN_PROGRESS")).toBe(false);
  });
});

describe("the provider order rule", () => {
  it("creates a new provider order for every retry", () => {
    // Razorpay permits reusing an order after a decline; this system does not,
    // because both inbound channels resolve a provider order id to exactly one
    // internal PaymentAttempt and a shared order would make that undecidable.
    expect(RETRY_REUSES_PROVIDER_ORDER).toBe(false);
  });
});

describe("the retry edge out of PAYMENT_FAILED", () => {
  it("is available to the transaction service", () => {
    const decision = resolveTransition({
      currentState: "PAYMENT_FAILED",
      event: "PAYMENT_RETRY_REQUESTED",
      actor: "transaction_service",
    });
    expect(decision.kind).toBe("APPLY");
    if (decision.kind !== "APPLY") throw new Error("unreachable");
    expect(decision.to).toBe("PAYMENT_ORDER_CREATED");
    expect(decision.reasonCode).toBe("PAYMENT_RETRY_REQUESTED");
  });

  it("is available to nobody else", () => {
    // Enumerated over every actor rather than spot-checked, so an actor added
    // later is refused by default instead of quietly inheriting the edge.
    const others = TRANSACTION_ACTORS.filter((actor) => actor !== "transaction_service");
    for (const actor of others) {
      const decision = resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "PAYMENT_RETRY_REQUESTED",
        actor,
      });
      expect(decision.kind, actor).toBe("INVALID");
      if (decision.kind !== "INVALID") throw new Error("unreachable");
      expect(decision.reason, actor).toBe("actor_not_permitted");
    }
  });

  it("is not available to an AI actor in particular", () => {
    for (const actor of AI_ACTORS) {
      const decision = resolveTransition({
        currentState: "PAYMENT_FAILED",
        event: "PAYMENT_RETRY_REQUESTED",
        actor,
      });
      expect(decision.kind, actor).toBe("INVALID");
    }
  });

  it("gives an AI actor exactly one edge in the whole matrix, and it is not this one", () => {
    const aiEdges = allTransitionEdges().filter((edge) =>
      edge.allowedActors.some((actor: TransactionActor) => AI_ACTORS.includes(actor)),
    );
    expect(aiEdges.map((edge) => edge.event)).toEqual(["PRODUCT_SELECTION_CONFIRMED"]);
  });
});

describe("a late capture arriving after a retry has begun", () => {
  it("is applied from PAYMENT_ORDER_CREATED when the provider says so", () => {
    // The sequence this edge exists for: attempt #1 reported failed, a retry
    // created attempt #2, and only then did a genuine capture for #1 arrive.
    const decision = resolveTransition({
      currentState: "PAYMENT_ORDER_CREATED",
      event: "PAYMENT_CAPTURE_CONFIRMED",
      actor: "payment_webhook",
    });
    expect(decision.kind).toBe("APPLY");
    if (decision.kind !== "APPLY") throw new Error("unreachable");
    expect(decision.to).toBe("PAYMENT_CAPTURED");
    expect(decision.reasonCode).toBe("LATE_CAPTURE_RECONCILED");
  });

  it("is not available to the browser callback path", () => {
    // `payment_provider` is the checkout-callback actor. A verified signature
    // proves a message is authentic, never that funds moved, so it may not
    // reach PAYMENT_CAPTURED from anywhere.
    const decision = resolveTransition({
      currentState: "PAYMENT_ORDER_CREATED",
      event: "PAYMENT_CAPTURE_CONFIRMED",
      actor: "payment_provider",
    });
    expect(decision.kind).toBe("INVALID");
  });

  it("still reaches capture from a recorded failure", () => {
    const decision = resolveTransition({
      currentState: "PAYMENT_FAILED",
      event: "PAYMENT_CAPTURE_CONFIRMED",
      actor: "payment_webhook",
    });
    expect(decision.kind).toBe("APPLY");
  });
});

describe("a stale failure cannot undo a capture", () => {
  for (const state of ["PAYMENT_CAPTURED", "COMPLETED"] as const) {
    it(`is a no-op in ${state}`, () => {
      const decision = resolveTransition({
        currentState: state,
        event: "PAYMENT_FAILED",
        actor: "payment_webhook",
      });
      // COMPLETED is terminal and PAYMENT_CAPTURED has no failure edge; either
      // way nothing moves, and neither answer is APPLY.
      expect(decision.kind).not.toBe("APPLY");
    });
  }

  it("does not let a second capture move an already captured transaction", () => {
    const decision = resolveTransition({
      currentState: "PAYMENT_CAPTURED",
      event: "PAYMENT_CAPTURE_CONFIRMED",
      actor: "payment_webhook",
    });
    expect(decision.kind).toBe("IDEMPOTENT_NO_OP");
  });
});

describe("the retry request boundary", () => {
  /**
   * Dependencies that fail loudly if they are touched.
   *
   * The point of these tests is that a hostile body never reaches the service
   * at all. Asserting "no retry happened" afterwards would be weaker: it cannot
   * tell a request that was refused at the boundary from one that ran and then
   * declined for some unrelated reason.
   */
  const forbiddenDeps = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `the retry service was reached with an invalid body (via ${String(property)})`,
        );
      },
    },
  ) as RetryServiceDeps;

  async function post(
    body: unknown,
    deps: RetryServiceDeps = forbiddenDeps,
  ): Promise<{ status: number; code: string }> {
    const response = await handleRetryPayment(
      new Request("https://test.local/api/payments/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      deps,
    );
    const envelope = (await response.json()) as { error?: { code?: string } };
    return { status: response.status, code: envelope.error?.code ?? "" };
  }

  /**
   * Every financial lever a client might reach for.
   *
   * `z.strictObject` refuses each one by name rather than ignoring it, which is
   * the difference that matters: "ignored" and "honoured" look identical to
   * whoever is probing, and a loud refusal is what makes the boundary testable.
   */
  const HOSTILE_FIELDS: ReadonlyArray<readonly [string, unknown]> = [
    ["retryCount", 0],
    ["retryLimit", 999],
    ["maxAttempts", 999],
    ["attemptsUsed", 0],
    ["attemptNumber", 1],
    ["amount", 1],
    ["amountMinor", "1"],
    ["currency", "USD"],
    ["providerOrderId", "order_someoneElses"],
    ["razorpay_order_id", "order_someoneElses"],
    ["policy", "ALLOWED"],
    ["policyDecision", "ALLOWED"],
    ["approved", true],
    ["approvalId", "approval_forged"],
    ["quoteId", "quote_cheaper"],
    ["status", "CAPTURED"],
    ["retry", { attemptNumber: 2 }],
  ];

  for (const [field, value] of HOSTILE_FIELDS) {
    it(`refuses a request carrying ${field}`, async () => {
      const { status, code } = await post({
        transactionId: "11111111-1111-7111-8111-111111111111",
        [field]: value,
      });
      // 400, not 500: the body was refused at the boundary, so the deps proxy
      // was never touched. A 500 here would mean the service had been reached
      // with a field it should never have seen.
      expect(status).toBe(400);
      expect(code).toBe("PAYMENT_RETRY_REQUEST_INVALID");
    });
  }

  it("refuses a request with no transaction id at all", async () => {
    const { status } = await post({ amount: 1 });
    expect(status).toBe(400);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await handleRetryPayment(
      new Request("https://test.local/api/payments/retry", {
        method: "POST",
        body: "retryCount=0",
      }),
      forbiddenDeps,
    );
    expect(response.status).toBe(400);
  });

  it("accepts the two fields it does take, and only those", async () => {
    // Proves the refusals above are about the extra fields rather than about a
    // boundary that refuses everything. This body gets past validation and
    // reaches the service, which is exactly what the recording deps observe.
    let reached = false;
    const recordingDeps = new Proxy(
      {},
      {
        get() {
          reached = true;
          throw new Error("stop here");
        },
      },
    ) as RetryServiceDeps;

    const { status } = await post(
      { transactionId: "11111111-1111-7111-8111-111111111111", operationId: "op1" },
      recordingDeps,
    );
    expect(reached).toBe(true);
    expect(status).toBe(500);
  });
});
