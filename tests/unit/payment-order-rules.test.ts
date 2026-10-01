import { describe, expect, it } from "vitest";
import {
  MAX_RECEIPT_LENGTH,
  RECEIPT_PATTERN,
  assessPayableAmount,
  deriveReceipt,
  paymentAttemptIdFromReceipt,
  toProviderAmount,
} from "@/domain/payment/rules";
import {
  isAmbiguousFailure,
  isSafelyRetryable,
  PROVIDER_FAILURE_CATEGORIES,
} from "@/domain/payment/provider";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";

/**
 * The payment rules and the Razorpay adapter, with no database and no network.
 *
 * The adapter is exercised through an injected `fetch`, which is what makes the
 * interesting cases testable at all: a lost response, a 200 that cannot be
 * parsed, and a duplicate receipt are all conditions a live Test Mode call
 * cannot be made to produce on demand. Every test here also counts the calls
 * the adapter makes, because the single most important property of this code is
 * negative — it must not ask for a second order.
 */

const ORDER_ID = "order_TestModeOrder001";
const RECEIPT_SOURCE = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

interface FakeCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** A fetch stand-in that answers from a queue and records what it was asked. */
function fakeFetch(
  responders: readonly ((call: FakeCall) => Response | Promise<Response> | never)[],
): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const call: FakeCall = {
      method: init?.method ?? "GET",
      url,
      body: rawBody === null ? null : JSON.parse(rawBody),
    };
    calls.push(call);
    const responder = responders[Math.min(index, responders.length - 1)];
    index += 1;
    if (responder === undefined) throw new Error("no responder configured");
    return await responder(call);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/** JSON.stringify, but tolerant of the bigint amounts these values carry. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function orderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    entity: "order",
    amount: 279_900,
    amount_paid: 0,
    amount_due: 279_900,
    currency: "INR",
    receipt: deriveReceipt(RECEIPT_SOURCE),
    status: "created",
    attempts: 0,
    notes: {},
    created_at: 1_780_000_000,
    ...overrides,
  };
}

function provider(
  responders: readonly ((call: FakeCall) => Response | Promise<Response>)[],
): { provider: ReturnType<typeof createRazorpayProvider>; calls: FakeCall[] } {
  const fake = fakeFetch(responders);
  return {
    provider: createRazorpayProvider({
      keyId: "rzp_test_unit",
      keySecret: "unit-test-secret",
      baseUrl: "https://provider.test/v1",
      fetchImpl: fake.fetch,
    }),
    calls: fake.calls,
  };
}

const REQUEST = {
  amountMinor: 279_900n,
  currency: "INR" as const,
  receipt: deriveReceipt(RECEIPT_SOURCE),
};

const createCalls = (calls: readonly FakeCall[]): readonly FakeCall[] =>
  calls.filter((call) => call.method === "POST");

// ---------------------------------------------------------------------------

describe("the receipt", () => {
  it("fits Razorpay's documented 40-character ASCII limit", () => {
    const receipt = deriveReceipt(RECEIPT_SOURCE);
    expect(receipt.length).toBeLessThanOrEqual(MAX_RECEIPT_LENGTH);
    expect(RECEIPT_PATTERN.test(receipt)).toBe(true);
  });

  it("is stable, so a retry presents the provider the same idempotency key", () => {
    expect(deriveReceipt(RECEIPT_SOURCE)).toBe(deriveReceipt(RECEIPT_SOURCE));
  });

  it("is unique per payment attempt", () => {
    const other = deriveReceipt("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c");
    expect(other).not.toBe(deriveReceipt(RECEIPT_SOURCE));
  });

  it("names the attempt it belongs to, so an order can be traced back", () => {
    expect(paymentAttemptIdFromReceipt(deriveReceipt(RECEIPT_SOURCE))).toBe(
      RECEIPT_SOURCE,
    );
  });

  it("does not claim a reference that was not ours", () => {
    expect(paymentAttemptIdFromReceipt("order_someoneElse")).toBeNull();
    expect(paymentAttemptIdFromReceipt("rcpt_not-hex")).toBeNull();
  });

  it("refuses to produce a value the provider would reject", () => {
    expect(() => deriveReceipt("a".repeat(64))).toThrow(/40-character/);
  });
});

describe("the amount that may be charged", () => {
  it("passes a trusted quote total through unchanged, in minor units", () => {
    const assessed = assessPayableAmount(279_900n, "INR");
    expect(assessed.kind).toBe("PAYABLE");
    if (assessed.kind !== "PAYABLE") return;
    // ₹2,799.00 is 279900 paise. Not 27990000: the quote is already minor.
    expect(toProviderAmount(assessed)).toBe(279_900);
  });

  it("refuses a zero or negative amount", () => {
    expect(assessPayableAmount(0n, "INR")).toMatchObject({ refusal: "NOT_POSITIVE" });
    expect(assessPayableAmount(-1n, "INR")).toMatchObject({ refusal: "NOT_POSITIVE" });
  });

  it("refuses an amount below the documented provider minimum of INR 1.00", () => {
    expect(assessPayableAmount(99n, "INR")).toMatchObject({
      refusal: "BELOW_PROVIDER_MINIMUM",
    });
    expect(assessPayableAmount(100n, "INR").kind).toBe("PAYABLE");
  });

  it("refuses an amount that JSON could not carry without rounding", () => {
    const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(assessPayableAmount(beyond, "INR")).toMatchObject({
      refusal: "NOT_SAFELY_REPRESENTABLE",
    });
  });

  it("refuses a currency this integration does not support", () => {
    expect(assessPayableAmount(279_900n, "USD")).toMatchObject({
      refusal: "UNSUPPORTED_CURRENCY",
    });
  });
});

describe("failure categories", () => {
  it("treats exactly the outcomes that could have created an order as ambiguous", () => {
    const ambiguous = PROVIDER_FAILURE_CATEGORIES.filter(isAmbiguousFailure);
    expect([...ambiguous].sort()).toEqual([
      "NETWORK_FAILURE",
      "TIMEOUT",
      "UNREADABLE_RESPONSE",
    ]);
  });

  it("never marks an ambiguous outcome safely retryable", () => {
    for (const category of PROVIDER_FAILURE_CATEGORIES) {
      if (isAmbiguousFailure(category)) {
        expect(isSafelyRetryable(category)).toBe(false);
      }
    }
  });
});

describe("the Razorpay adapter", () => {
  it("sends only trusted server-derived fields, with the amount unmultiplied", async () => {
    const { provider: rzp, calls } = provider([() => jsonResponse(200, orderBody())]);

    const outcome = await rzp.createOrder({
      ...REQUEST,
      notes: { transactionId: "txn-1" },
    });

    expect(outcome.kind).toBe("CREATED");
    const posted = createCalls(calls)[0];
    expect(posted?.url).toBe("https://provider.test/v1/orders");
    expect(posted?.body).toEqual({
      amount: 279_900,
      currency: "INR",
      receipt: REQUEST.receipt,
      notes: { transactionId: "txn-1" },
    });
  });

  it("parses the order id, amount and status back out of a Test Mode response", async () => {
    const { provider: rzp } = provider([() => jsonResponse(200, orderBody())]);
    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome.kind).toBe("CREATED");
    if (outcome.kind !== "CREATED") return;
    expect(outcome.order.providerOrderId).toBe(ORDER_ID);
    expect(outcome.order.amountMinor).toBe(279_900n);
    expect(outcome.order.currency).toBe("INR");
    expect(outcome.order.status).toBe("created");
  });

  it("reports an authentication failure without ever looking the receipt up", async () => {
    const { provider: rzp, calls } = provider([
      () =>
        jsonResponse(401, {
          error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" },
        }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome).toMatchObject({
      kind: "FAILED",
      failure: { category: "AUTHENTICATION_FAILED" },
    });
    // A lookup would be refused identically, and nothing can have been created
    // without credentials.
    expect(calls).toHaveLength(1);
  });

  it("reports rate limiting as a definite, safely retryable failure", async () => {
    const { provider: rzp, calls } = provider([() => jsonResponse(429, {})]);
    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome).toMatchObject({
      kind: "FAILED",
      failure: { category: "RATE_LIMITED" },
    });
    expect(calls).toHaveLength(1);
    expect(isSafelyRetryable("RATE_LIMITED")).toBe(true);
  });

  it("converges on the existing order when the receipt was already used", async () => {
    // Razorpay documents the receipt as the idempotency key: a second create
    // with the same value is rejected. The right answer is to fetch it, not to
    // pick a new receipt and try again.
    const { provider: rzp, calls } = provider([
      () =>
        jsonResponse(400, {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "Duplicate request. This request has already been processed.",
          },
        }),
      () => jsonResponse(200, { entity: "collection", count: 1, items: [orderBody()] }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome.kind).toBe("ALREADY_EXISTS");
    if (outcome.kind !== "ALREADY_EXISTS") return;
    expect(outcome.order.providerOrderId).toBe(ORDER_ID);
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("resolves a timeout by lookup rather than by asking for another order", async () => {
    const { provider: rzp, calls } = provider([
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      () => jsonResponse(200, { entity: "collection", count: 1, items: [orderBody()] }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome.kind).toBe("ALREADY_EXISTS");
    expect(createCalls(calls)).toHaveLength(1);
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.url).toContain(`receipt=${REQUEST.receipt}`);
  });

  it("downgrades a timeout to a definite failure once a lookup proves nothing exists", async () => {
    const { provider: rzp, calls } = provider([
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      () => jsonResponse(200, { entity: "collection", count: 0, items: [] }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    // The provider is authoritative that no order carries this receipt, so the
    // ambiguity is gone even though the symptom was a timeout.
    expect(outcome).toMatchObject({ kind: "FAILED", failure: { category: "TIMEOUT" } });
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("stays UNKNOWN when the lookup itself fails, and issues no second create", async () => {
    const { provider: rzp, calls } = provider([
      () => {
        throw new TypeError("socket hang up");
      },
      () => {
        throw new TypeError("socket hang up");
      },
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome).toMatchObject({
      kind: "UNKNOWN",
      failure: { category: "NETWORK_FAILURE" },
    });
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("treats a provider 5xx as possibly-created and checks before giving up", async () => {
    const { provider: rzp, calls } = provider([
      () => jsonResponse(502, { error: { code: "SERVER_ERROR" } }),
      () => jsonResponse(200, { entity: "collection", count: 1, items: [orderBody()] }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome.kind).toBe("ALREADY_EXISTS");
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("recovers an order whose success response could not be parsed", async () => {
    const { provider: rzp, calls } = provider([
      () => new Response("<html>gateway</html>", { status: 200 }),
      () => jsonResponse(200, { entity: "collection", count: 1, items: [orderBody()] }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome.kind).toBe("ALREADY_EXISTS");
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("refuses to adopt a recovered order whose amount is not the one requested", async () => {
    const { provider: rzp } = provider([
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      () =>
        jsonResponse(200, {
          items: [orderBody({ amount: 1_000 })],
        }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome).toMatchObject({
      kind: "UNKNOWN",
      failure: { code: "RECOVERED_MISMATCH" },
    });
  });

  it("never sends an amount it has already judged unpayable", async () => {
    const { provider: rzp, calls } = provider([() => jsonResponse(200, orderBody())]);

    const outcome = await rzp.createOrder({ ...REQUEST, amountMinor: 0n });

    expect(outcome).toMatchObject({
      kind: "FAILED",
      failure: { code: "AMOUNT_NOT_POSITIVE" },
    });
    expect(calls).toHaveLength(0);
  });

  it("carries no provider prose into the failure it reports", async () => {
    const { provider: rzp } = provider([
      () =>
        jsonResponse(400, {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "The amount 999999 is invalid for account acc_secretish",
          },
        }),
      () => jsonResponse(200, { items: [] }),
    ]);

    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome.kind).toBe("FAILED");
    if (outcome.kind !== "FAILED") return;
    expect(serialize(outcome.failure)).not.toContain("acc_secretish");
    expect(outcome.failure.code).toBe("BAD_REQUEST_ERROR");
  });

  it("authenticates with the key id and secret, and leaks neither into the body", async () => {
    let authorization: string | null = null;
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization");
      return jsonResponse(200, orderBody());
    }) as unknown as typeof fetch;

    const rzp = createRazorpayProvider({
      keyId: "rzp_test_unit",
      keySecret: "unit-test-secret",
      baseUrl: "https://provider.test/v1",
      fetchImpl: impl,
    });
    const outcome = await rzp.createOrder(REQUEST);

    expect(outcome.kind).toBe("CREATED");
    // HTTP Basic, exactly as the Orders API documents.
    expect(authorization).toBe(
      `Basic ${Buffer.from("rzp_test_unit:unit-test-secret").toString("base64")}`,
    );
    // And the secret appears in the header alone - never in a field we send.
    expect(serialize(outcome)).not.toContain("unit-test-secret");
  });
});
