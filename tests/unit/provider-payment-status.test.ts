import { afterEach, describe, expect, it, vi } from "vitest";
import { createRazorpayProvider } from "@/integrations/razorpay-provider";

/**
 * Asking Razorpay which payments were made against an order.
 *
 * The adapter half is exercised against a scripted `fetch`: the path it calls,
 * what it believes, and what it refuses. The server action half is exercised
 * with the service mocked: it must never let a browser do more than name a
 * purchase, and a failure must never surface as a thrown Server Action error.
 * The reconciliation itself is proved against PostgreSQL in
 * tests/db/webhook-reconciliation.test.ts.
 */

const ORDER_ID = "order_UnitTest0001";

function adapter(respond: (url: string) => Response) {
  const urls: string[] = [];
  const provider = createRazorpayProvider({
    keyId: "rzp_test_status",
    keySecret: "status-unit-secret",
    baseUrl: "https://provider.test/v1",
    fetchImpl: (async (input: string | URL | Request) => {
      urls.push(String(input));
      return respond(String(input));
    }) as unknown as typeof fetch,
  });
  return { provider, urls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const payment = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_UnitTest0001",
  entity: "payment",
  order_id: ORDER_ID,
  amount: 279_900,
  currency: "INR",
  status: "captured",
  method: "card",
  ...overrides,
});

describe("listOrderPayments", () => {
  it("asks for exactly this order's payments and reads them as integers", async () => {
    const { provider, urls } = adapter(() =>
      json(200, { entity: "collection", count: 1, items: [payment()] }),
    );

    const outcome = await provider.listOrderPayments(ORDER_ID);

    expect(urls).toEqual([`https://provider.test/v1/orders/${ORDER_ID}/payments`]);
    expect(outcome).toEqual({
      kind: "FOUND",
      payments: [
        {
          providerPaymentId: "pay_UnitTest0001",
          providerOrderId: ORDER_ID,
          amountMinor: 279_900n,
          currency: "INR",
          status: "captured",
          errorCode: null,
          errorSource: null,
          errorStep: null,
          errorReason: null,
        },
      ],
    });
  });

  it("never hands back a payment that names a different order", async () => {
    const { provider } = adapter(() =>
      json(200, { items: [payment({ id: "pay_Other", order_id: "order_Someone" })] }),
    );

    expect(await provider.listOrderPayments(ORDER_ID)).toEqual({
      kind: "FOUND",
      payments: [],
    });
  });

  it("refuses a malformed order id before any request is made", async () => {
    const { provider, urls } = adapter(() => json(200, { items: [] }));

    const outcome = await provider.listOrderPayments("order_x/../../payments");

    expect(outcome).toMatchObject({ kind: "FAILED" });
    expect(urls).toEqual([]);
  });

  it("reports a provider error as a failure, not as an empty list", async () => {
    const { provider } = adapter(() =>
      json(401, { error: { code: "BAD_REQUEST_ERROR", description: "auth failed" } }),
    );

    expect(await provider.listOrderPayments(ORDER_ID)).toMatchObject({ kind: "FAILED" });
  });

  it("reports an unreadable answer as a failure", async () => {
    const { provider } = adapter(
      () => new Response("<html>oops</html>", { status: 200 }),
    );

    expect(await provider.listOrderPayments(ORDER_ID)).toMatchObject({ kind: "FAILED" });
  });
});

const mocks = vi.hoisted(() => ({
  checkPaymentWithProvider: vi.fn(),
  limitPaymentRequest: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/services/webhook-service", () => ({
  checkPaymentWithProvider: mocks.checkPaymentWithProvider,
}));
vi.mock("@/services/rate-limit-service", () => ({
  limitAgentRequest: vi.fn(),
  limitPaymentRequest: mocks.limitPaymentRequest,
}));
vi.mock("@/integrations/prisma-client", () => ({ getPrismaClient: () => ({}) }));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-real-ip": "203.0.113.9" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const TRANSACTION_ID = "01a068ee-b304-7756-83d6-3e709f3c1c37";

describe("checkPaymentStatus", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const check = async (id: unknown) => {
    const { checkPaymentStatus } = await import("@/app/actions");
    return checkPaymentStatus(id);
  };

  it("reports a reconciled capture as a change and refreshes the purchase page", async () => {
    mocks.limitPaymentRequest.mockResolvedValueOnce({ kind: "ALLOWED" });
    mocks.checkPaymentWithProvider.mockResolvedValueOnce({
      kind: "RECONCILED",
      outcome: { kind: "RECONCILED" },
    });

    expect(await check(TRANSACTION_ID)).toEqual({ kind: "CHANGED" });
    expect(mocks.checkPaymentWithProvider).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/shop/${TRANSACTION_ID}`);
  });

  it.each([["STILL_WAITING"], ["NOT_WAITING"], ["PROVIDER_UNAVAILABLE"]] as const)(
    "reports %s as no change",
    async (kind) => {
      mocks.limitPaymentRequest.mockResolvedValueOnce({ kind: "ALLOWED" });
      mocks.checkPaymentWithProvider.mockResolvedValueOnce({ kind });

      expect(await check(TRANSACTION_ID)).toEqual({ kind: "UNCHANGED" });
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([["not an id"], [42], [null], [{ transactionId: TRANSACTION_ID }]])(
    "asks nothing for %o",
    async (input) => {
      expect(await check(input)).toEqual({ kind: "UNCHANGED" });
      expect(mocks.limitPaymentRequest).not.toHaveBeenCalled();
      expect(mocks.checkPaymentWithProvider).not.toHaveBeenCalled();
    },
  );

  it("does not ask the provider once the payment ceiling is reached", async () => {
    mocks.limitPaymentRequest.mockResolvedValueOnce({
      kind: "LIMITED",
      rule: "payment-minute",
      retryAfterSeconds: 30,
    });

    expect(await check(TRANSACTION_ID)).toEqual({ kind: "UNCHANGED" });
    expect(mocks.checkPaymentWithProvider).not.toHaveBeenCalled();
  });

  it("turns a failure into no change, never a thrown error", async () => {
    mocks.limitPaymentRequest.mockResolvedValueOnce({ kind: "ALLOWED" });
    mocks.checkPaymentWithProvider.mockRejectedValueOnce(new Error("connection refused"));

    await expect(check(TRANSACTION_ID)).resolves.toEqual({ kind: "UNCHANGED" });
  });
});
