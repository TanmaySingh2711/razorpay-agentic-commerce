import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetryServiceDeps } from "@/services/retry-service";
import type { CheckoutServiceDeps } from "@/services/checkout-service";

/**
 * The HTTP status each payment outcome is answered with.
 *
 * The services decide what happened; the handler decides which number a client
 * sees. Those numbers are a contract: `202` for "nobody knows whether an order
 * exists" must never be confused with `200`, and a refusal on its merits is a
 * `422`, not a `5xx`. The services are mocked at the module edge so every arm
 * of the mapping is reached without staging a provider outage for each.
 */

const mocks = vi.hoisted(() => ({
  requestPaymentRetry: vi.fn(),
  recordCheckoutDismissal: vi.fn(),
}));

vi.mock("@/services/retry-service", () => ({
  requestPaymentRetry: mocks.requestPaymentRetry,
  defaultRetryDeps: vi.fn(),
}));
vi.mock("@/services/checkout-service", () => ({
  recordCheckoutDismissal: mocks.recordCheckoutDismissal,
  startCheckout: vi.fn(),
  verifyCheckoutCallback: vi.fn(),
  defaultCheckoutDeps: vi.fn(),
}));

const { handleRetryPayment, handleCheckoutDismissed } =
  await import("@/app/api/payments/handler");

const TRANSACTION_ID = "01930000-0000-7000-8000-00000000c001";
const retryDeps = {} as RetryServiceDeps;
const checkoutDeps = {} as CheckoutServiceDeps;

function post(path: string, body: unknown): Request {
  return new Request(`https://shop.example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the retry endpoint's statuses", () => {
  it.each([
    [{ kind: "RETRY_STARTED" }, 200],
    [{ kind: "DENIED", reason: "ATTEMPT_LIMIT_REACHED" }, 422],
    [{ kind: "APPROVAL_REQUIRED" }, 200],
    [{ kind: "ORDER_NOT_READY", reason: "REFUSED" }, 422],
    [{ kind: "ORDER_NOT_READY", reason: "PROVIDER_FAILED" }, 502],
    [{ kind: "ORDER_NOT_READY", reason: "RECONCILIATION_REQUIRED" }, 202],
    [{ kind: "ORDER_NOT_READY", reason: "CREATION_IN_PROGRESS" }, 409],
  ])("answers %o with %i", async (result, status) => {
    mocks.requestPaymentRetry.mockResolvedValueOnce(result);

    const response = await handleRetryPayment(
      post("/api/payments/retry", { transactionId: TRANSACTION_ID }),
      retryDeps,
    );

    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).toContain(result.kind);
  });

  it("passes only the transaction and the optional operation id to the service", async () => {
    mocks.requestPaymentRetry.mockResolvedValue({ kind: "RETRY_STARTED" });

    await handleRetryPayment(
      post("/api/payments/retry", { transactionId: TRANSACTION_ID }),
      retryDeps,
    );
    await handleRetryPayment(
      post("/api/payments/retry", { transactionId: TRANSACTION_ID, operationId: "op-1" }),
      retryDeps,
    );

    expect(
      mocks.requestPaymentRetry.mock.calls.map((call) => call[0] as unknown),
    ).toEqual([
      { transactionId: TRANSACTION_ID },
      { transactionId: TRANSACTION_ID, operationId: "op-1" },
    ]);
  });

  it.each([
    ["an attempt counter", { transactionId: TRANSACTION_ID, retryCount: 0 }],
    ["an amount", { transactionId: TRANSACTION_ID, amount: 1 }],
    ["a policy verdict", { transactionId: TRANSACTION_ID, policy: "ALLOWED" }],
    ["no transaction", {}],
    ["a body that is not JSON", "{not json"],
  ])("refuses %s with 400 before the service runs", async (_label, body) => {
    const response = await handleRetryPayment(
      post("/api/payments/retry", body),
      retryDeps,
    );

    expect(response.status).toBe(400);
    expect(mocks.requestPaymentRetry).not.toHaveBeenCalled();
  });
});

describe("the dismissed endpoint", () => {
  it("records the dismissal and answers 200", async () => {
    mocks.recordCheckoutDismissal.mockResolvedValueOnce({ kind: "RECORDED" });

    const response = await handleCheckoutDismissed(
      post("/api/payments/dismissed", { transactionId: TRANSACTION_ID }),
      checkoutDeps,
    );

    expect(response.status).toBe(200);
    expect(mocks.recordCheckoutDismissal).toHaveBeenCalledWith(
      { transactionId: TRANSACTION_ID },
      checkoutDeps,
    );
  });

  it("accepts nothing but a transaction id", async () => {
    const response = await handleCheckoutDismissed(
      post("/api/payments/dismissed", { transactionId: TRANSACTION_ID, status: "PAID" }),
      checkoutDeps,
    );

    expect(response.status).toBe(400);
    expect(mocks.recordCheckoutDismissal).not.toHaveBeenCalled();
  });

  it("refuses a request another site caused", async () => {
    const response = await handleCheckoutDismissed(
      new Request("https://shop.example.test/api/payments/dismissed", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ transactionId: TRANSACTION_ID }),
      }),
      checkoutDeps,
    );

    expect(response.status).toBe(400);
    expect(mocks.recordCheckoutDismissal).not.toHaveBeenCalled();
  });
});
