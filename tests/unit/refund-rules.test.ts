import { describe, expect, it } from "vitest";
import {
  REFUND_DENIALS,
  REFUND_STATUSES,
  assessRefund,
  describeRefundDenial,
  describeRefundStatus,
  refundReceiptFor,
  type RefundFacts,
} from "@/domain/refund";
import { createRazorpayProvider } from "@/integrations/razorpay-provider";

/**
 * Refund eligibility, and the Razorpay refund adapter.
 *
 * Eligibility is a pure function of persisted facts, so every boundary is
 * enumerated here without a database. The adapter is driven through an
 * injected `fetch`, so the HTTP contract - one POST, recovery by GET, the
 * exact amount - is asserted without a network.
 */

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;
const TRANSACTION_ID = "01930000-0000-7000-8000-00000000f001";

function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    transactionStatus: "COMPLETED",
    completedAt: new Date(NOW.getTime() - DAY),
    capturedAttempts: [
      {
        id: "attempt-1",
        amountMinor: 279_900n,
        currency: "INR",
        providerPaymentId: "pay_Captured0001",
      },
    ],
    refundStatuses: [],
    windowDays: 7,
    now: NOW,
    ...overrides,
  };
}

describe("refund eligibility", () => {
  it("allows a completed, singly-captured purchase inside the window", () => {
    expect(assessRefund(facts())).toEqual({
      kind: "ELIGIBLE",
      paymentAttemptId: "attempt-1",
      providerPaymentId: "pay_Captured0001",
      amountMinor: 279_900n,
      currency: "INR",
    });
  });

  it.each(["AUTHORIZED", "PAYMENT_PENDING", "PAYMENT_CAPTURED", "CANCELLED", "BLOCKED"])(
    "refuses a purchase that is %s",
    (status) => {
      expect(assessRefund(facts({ transactionStatus: status }))).toEqual({
        kind: "DENIED",
        denial: "NOT_COMPLETED",
      });
    },
  );

  it("refuses when no captured attempt carries a provider payment id", () => {
    expect(assessRefund(facts({ capturedAttempts: [] }))).toMatchObject({
      denial: "NO_CAPTURED_PAYMENT",
    });
    expect(
      assessRefund(
        facts({
          capturedAttempts: [
            { id: "a", amountMinor: 1n, currency: "INR", providerPaymentId: null },
          ],
        }),
      ),
    ).toMatchObject({ denial: "NO_CAPTURED_PAYMENT" });
  });

  it("refuses to pick between two captures - a person must reconcile first", () => {
    const attempt = facts().capturedAttempts[0];
    if (attempt === undefined) throw new Error("fixture");
    expect(
      assessRefund(
        facts({
          capturedAttempts: [
            attempt,
            { ...attempt, id: "b", providerPaymentId: "pay_B" },
          ],
        }),
      ),
    ).toMatchObject({ denial: "MULTIPLE_CAPTURES" });
  });

  it.each(["REQUESTED", "PENDING", "PROCESSED", "RECONCILIATION_REQUIRED"] as const)(
    "refuses while a %s refund exists",
    (status) => {
      expect(assessRefund(facts({ refundStatuses: [status] }))).toMatchObject({
        denial: "ALREADY_REFUNDED",
      });
    },
  );

  it("allows a new refund after every earlier one failed", () => {
    expect(assessRefund(facts({ refundStatuses: ["FAILED", "FAILED"] })).kind).toBe(
      "ELIGIBLE",
    );
  });

  it("closes exactly at the end of the window", () => {
    const edge = new Date(NOW.getTime() - 7 * DAY);
    expect(assessRefund(facts({ completedAt: edge })).kind).toBe("ELIGIBLE");
    expect(
      assessRefund(facts({ completedAt: new Date(edge.getTime() - 1) })),
    ).toMatchObject({ denial: "WINDOW_CLOSED" });
    expect(assessRefund(facts({ completedAt: null }))).toMatchObject({
      denial: "WINDOW_CLOSED",
    });
  });

  it("has a sentence for every denial and every status", () => {
    for (const denial of REFUND_DENIALS) {
      expect(describeRefundDenial(denial).length).toBeGreaterThan(10);
    }
    for (const status of REFUND_STATUSES) {
      expect(describeRefundStatus(status).length).toBeGreaterThan(10);
    }
  });
});

describe("the refund receipt", () => {
  it("is stable, ordinal-specific and fits the 40-character limit", () => {
    const first = refundReceiptFor(TRANSACTION_ID, 1);
    expect(first).toBe(refundReceiptFor(TRANSACTION_ID, 1));
    expect(first).not.toBe(refundReceiptFor(TRANSACTION_ID, 2));
    expect(first.length).toBeLessThanOrEqual(40);
    expect(refundReceiptFor(TRANSACTION_ID, 99).length).toBeLessThanOrEqual(40);
    expect(first).toMatch(/^rf_[0-9a-f]{32}_1$/);
  });
});

interface FakeCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function adapter(
  responders: readonly ((call: FakeCall) => Response | Promise<Response>)[],
): { provider: ReturnType<typeof createRazorpayProvider>; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FakeCall = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const responder = responders[Math.min(index, responders.length - 1)];
    index += 1;
    if (responder === undefined) throw new Error("no responder configured");
    return await responder(call);
  }) as unknown as typeof fetch;
  return {
    provider: createRazorpayProvider({
      keyId: "rzp_test_refunds",
      keySecret: "refund-unit-secret",
      baseUrl: "https://provider.test/v1",
      fetchImpl,
    }),
    calls,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const RECEIPT = refundReceiptFor(TRANSACTION_ID, 1);
const REQUEST = {
  providerPaymentId: "pay_Captured0001",
  amountMinor: 279_900n,
  currency: "INR" as const,
  receipt: RECEIPT,
};

function refundBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rfnd_Unit0000001",
    entity: "refund",
    amount: 279_900,
    currency: "INR",
    payment_id: "pay_Captured0001",
    receipt: RECEIPT,
    status: "processed",
    speed_requested: "normal",
    ...overrides,
  };
}

describe("the Razorpay refund adapter", () => {
  it("POSTs the exact captured amount once, with our receipt", async () => {
    const { provider, calls } = adapter([() => json(200, refundBody())]);

    const outcome = await provider.createRefund(REQUEST);

    expect(outcome).toEqual({
      kind: "CREATED",
      refund: {
        providerRefundId: "rfnd_Unit0000001",
        providerPaymentId: "pay_Captured0001",
        amountMinor: 279_900n,
        currency: "INR",
        receipt: RECEIPT,
        status: "processed",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://provider.test/v1/payments/pay_Captured0001/refund",
      body: { amount: 279_900, speed: "normal", receipt: RECEIPT },
    });
  });

  it("recovers a duplicate-receipt refusal by reading, never by re-posting", async () => {
    const { provider, calls } = adapter([
      () =>
        json(400, {
          error: { code: "BAD_REQUEST_ERROR", reason: "duplicate_receipt" },
        }),
      () => json(200, { entity: "collection", count: 1, items: [refundBody()] }),
    ]);

    const outcome = await provider.createRefund(REQUEST);

    expect(outcome.kind).toBe("ALREADY_EXISTS");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(calls[1]?.url).toBe(
      "https://provider.test/v1/payments/pay_Captured0001/refunds?count=100",
    );
  });

  it("reports UNKNOWN when the create times out and the lookup fails too", async () => {
    const { provider, calls } = adapter([
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ]);
    const outcome = await provider.createRefund(REQUEST);
    expect(outcome).toMatchObject({ kind: "UNKNOWN", failure: { category: "TIMEOUT" } });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("concludes FAILED when the create timed out but the provider holds nothing", async () => {
    const { provider } = adapter([
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => json(200, { entity: "collection", count: 0, items: [] }),
    ]);
    expect((await provider.createRefund(REQUEST)).kind).toBe("FAILED");
  });

  it("will not adopt a recovered refund for a different amount", async () => {
    const { provider } = adapter([
      () => json(502, {}),
      () => json(200, { entity: "collection", items: [refundBody({ amount: 100 })] }),
    ]);
    expect(await provider.createRefund(REQUEST)).toMatchObject({
      kind: "UNKNOWN",
      failure: { code: "RECOVERED_MISMATCH" },
    });
  });

  it("does not look up after refused credentials or a rate limit", async () => {
    for (const status of [401, 429]) {
      const { provider, calls } = adapter([() => json(status, {})]);
      expect((await provider.createRefund(REQUEST)).kind).toBe("FAILED");
      expect(calls).toHaveLength(1);
    }
  });

  it("refuses a malformed payment id before building a URL from it", async () => {
    const { provider, calls } = adapter([() => json(200, refundBody())]);
    const outcome = await provider.createRefund({
      ...REQUEST,
      providerPaymentId: "pay_x/../../orders",
    });
    expect(outcome).toMatchObject({
      kind: "FAILED",
      failure: { code: "PAYMENT_ID_MALFORMED" },
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-positive amount without calling the provider", async () => {
    const { provider, calls } = adapter([() => json(200, refundBody())]);
    expect((await provider.createRefund({ ...REQUEST, amountMinor: 0n })).kind).toBe(
      "FAILED",
    );
    expect(calls).toHaveLength(0);
  });

  it("finds a refund by exact receipt only", async () => {
    const { provider } = adapter([
      () =>
        json(200, {
          entity: "collection",
          items: [refundBody({ receipt: "rf_someone_else" })],
        }),
    ]);
    expect(await provider.findRefundByReceipt("pay_Captured0001", RECEIPT)).toEqual({
      kind: "NOT_FOUND",
    });
  });
});
