import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as BuyerAgentService from "@/services/buyer-agent-service";

/**
 * What each server action tells the person, for every answer a service can give.
 *
 * The services are proved elsewhere, against PostgreSQL. This file owns the
 * layer between them and a browser: that every outcome becomes a sentence a
 * buyer can act on, that nothing internal leaks into it, that a failure is
 * caught rather than surfaced as an unhandled Server Action error, and that
 * the rate limit sits in front of everything that reaches a provider.
 *
 * Every boundary the actions touch is mocked at the module edge, so no test
 * here needs a database, a model or a network.
 */

const mocks = vi.hoisted(() => ({
  runBuyerAgent: vi.fn(),
  decidePurchase: vi.fn(),
  evaluateQuotePolicy: vi.fn(),
  limitAgentRequest: vi.fn(),
  limitPaymentRequest: vi.fn(),
  recordAgentRequest: vi.fn(),
  requestRefund: vi.fn(),
  reconcileRefund: vi.fn(),
  requestApproval: vi.fn(),
  decideApproval: vi.fn(),
  reserveInventory: vi.fn(),
  findUnique: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((path: string): never => {
    // Next.js implements redirect() by throwing; the action must let it through.
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("@/services/buyer-agent-service", async (importOriginal) => ({
  ...(await importOriginal<typeof BuyerAgentService>()),
  runBuyerAgent: mocks.runBuyerAgent,
}));
vi.mock("@/services/product-decision-service", () => ({
  decidePurchase: mocks.decidePurchase,
}));
vi.mock("@/services/policy-service", () => ({
  evaluateQuotePolicy: mocks.evaluateQuotePolicy,
}));
vi.mock("@/services/rate-limit-service", () => ({
  limitAgentRequest: mocks.limitAgentRequest,
  limitPaymentRequest: mocks.limitPaymentRequest,
}));
vi.mock("@/services/agent-request-log", () => ({
  recordAgentRequest: mocks.recordAgentRequest,
}));
vi.mock("@/services/refund-service", () => ({
  requestRefund: mocks.requestRefund,
  reconcileRefund: mocks.reconcileRefund,
}));
vi.mock("@/services/approval-service", () => ({
  requestApproval: mocks.requestApproval,
  decideApproval: mocks.decideApproval,
}));
vi.mock("@/services/reservation-service", () => ({
  reserveInventory: mocks.reserveInventory,
}));
vi.mock("@/integrations/prisma-client", () => ({
  getPrismaClient: () => ({ transaction: { findUnique: mocks.findUnique } }),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-real-ip": "203.0.113.9" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const TRANSACTION_ID = "01a068ee-b304-7756-83d6-3e709f3c1c37";
const IDLE = { kind: "IDLE" } as const;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const actions = () => import("@/app/actions");

beforeEach(() => {
  mocks.limitAgentRequest.mockResolvedValue({ kind: "ALLOWED" });
  mocks.limitPaymentRequest.mockResolvedValue({ kind: "ALLOWED" });
  mocks.recordAgentRequest.mockResolvedValue(undefined);
  mocks.runBuyerAgent.mockResolvedValue({ kind: "NO_MATCH", correlationId: "c" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("submitRequest: one sentence for every way a request can end", () => {
  const ask = async (result: unknown) => {
    mocks.decidePurchase.mockResolvedValueOnce(result);
    const { submitRequest } = await actions();
    return submitRequest(IDLE, form({ message: "Find me a mouse under ₹3000" }));
  };

  it("refuses a blank message without calling anything", async () => {
    const { submitRequest } = await actions();
    expect(await submitRequest(IDLE, form({ message: "   " }))).toMatchObject({
      kind: "ERROR",
    });
    expect(mocks.limitAgentRequest).not.toHaveBeenCalled();
    expect(mocks.runBuyerAgent).not.toHaveBeenCalled();
  });

  it("says what the shop does sell when nothing matched", async () => {
    const outcome = await ask({
      kind: "NO_VALID_CANDIDATE",
      reasons: ["WRONG_CATEGORY"],
      transactionId: null,
    });
    expect(outcome).toEqual({
      kind: "NO_MATCH",
      summary:
        "Nothing in this catalog matches what you asked for. This shop sells mechanical keyboard, mouse, headphones.",
    });
    expect(mocks.recordAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "NO_MATCH" }),
    );
  });

  it.each(["NOT_PURCHASABLE", "INSUFFICIENT_INVENTORY"])(
    "tells sold-out apart from not-sold (%s)",
    async (reason) => {
      const outcome = await ask({
        kind: "NO_VALID_CANDIDATE",
        reasons: [reason],
        transactionId: "t",
      });
      expect(outcome).toMatchObject({ kind: "NO_MATCH" });
      expect(JSON.stringify(outcome)).toContain("in stock right now");
    },
  );

  it.each([
    ["AI_SELECTION_REJECTED", "could not verify against your request"],
    ["HARD_REQUIREMENT_UNVERIFIABLE", "does not record enough"],
    ["REEVALUATION_REQUIRED", "changed while your request was being priced"],
  ])("explains a %s refusal as the safety net working", async (kind, phrase) => {
    const outcome = await ask({ kind, transactionId: "t", reasons: [] });
    expect(outcome).toMatchObject({ kind: "REFUSED" });
    expect(JSON.stringify(outcome)).toContain(phrase);
    expect(mocks.recordAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "REFUSED" }),
    );
    // Nothing internal: no reason code, no id.
    expect(JSON.stringify(outcome)).not.toMatch(/AI_SELECTION|UNVERIFIABLE|REEVALUATION/);
  });

  it("treats a browse request with no selected product as not a purchase", async () => {
    const outcome = await ask({ kind: "NO_QUOTE_REQUIRED", requestType: "BROWSE" });
    expect(outcome).toMatchObject({ kind: "NOT_A_PURCHASE" });
  });

  it("evaluates policy on a fresh quote and sends the buyer to the purchase page", async () => {
    mocks.evaluateQuotePolicy.mockResolvedValueOnce({ kind: "EVALUATED" });
    await expect(
      ask({ kind: "QUOTE_CREATED", transactionId: TRANSACTION_ID, quote: { id: "q-1" } }),
    ).rejects.toThrow(`NEXT_REDIRECT:/transaction/${TRANSACTION_ID}`);

    expect(mocks.evaluateQuotePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "q-1" }),
    );
    expect(mocks.recordAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "PURCHASE_OPENED",
        transactionId: TRANSACTION_ID,
      }),
    );
  });

  it("still opens the purchase when policy could not be evaluated yet", async () => {
    // The page shows the state as it is; a policy hiccup is not a reason to
    // hide a quote that genuinely exists.
    mocks.evaluateQuotePolicy.mockResolvedValueOnce({ kind: "QUOTE_NOT_USABLE" });
    await expect(
      ask({ kind: "QUOTE_CREATED", transactionId: TRANSACTION_ID, quote: { id: "q-1" } }),
    ).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe("refundPurchase", () => {
  const refund = async () => {
    const { refundPurchase } = await actions();
    return refundPurchase(IDLE, form({ transactionId: TRANSACTION_ID }));
  };

  it("sends only a transaction id to the service - never an amount", async () => {
    mocks.requestRefund.mockResolvedValueOnce({
      kind: "REFUND_STARTED",
      refundId: "r",
      status: "PROCESSED",
    });
    const outcome = await refund();

    expect(outcome).toEqual({
      kind: "DONE",
      message: "Refunded. The money is on its way back to your original payment method.",
    });
    const [command] = mocks.requestRefund.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(command).sort()).toEqual(["operationId", "transactionId"]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/transaction/${TRANSACTION_ID}`);
  });

  it("says a pending refund is accepted, not finished", async () => {
    mocks.requestRefund.mockResolvedValueOnce({
      kind: "REFUND_STARTED",
      refundId: "r",
      status: "PENDING",
    });
    expect(await refund()).toMatchObject({
      kind: "DONE",
      message: expect.stringContaining("is returning the money"),
    });
  });

  it.each([
    ["ALREADY_REFUNDED", "already exists"],
    ["WINDOW_CLOSED", "window for this purchase has closed"],
    ["NOT_COMPLETED", "Only a completed purchase"],
  ])("explains a %s denial in plain words", async (denial, phrase) => {
    mocks.requestRefund.mockResolvedValueOnce({ kind: "DENIED", denial });
    const outcome = await refund();
    expect(outcome).toMatchObject({ kind: "ERROR" });
    expect(JSON.stringify(outcome)).toContain(phrase);
  });

  it("says nothing changed when the provider refused", async () => {
    mocks.requestRefund.mockResolvedValueOnce({
      kind: "PROVIDER_FAILED",
      refundId: "r",
      failureCode: "BAD_REQUEST_ERROR",
    });
    const outcome = await refund();
    expect(outcome).toMatchObject({ kind: "ERROR" });
    // The provider's own code never reaches the buyer.
    expect(JSON.stringify(outcome)).not.toContain("BAD_REQUEST_ERROR");
  });

  it("promises an unresolved refund will not be sent twice", async () => {
    mocks.requestRefund.mockResolvedValueOnce({
      kind: "RECONCILIATION_REQUIRED",
      refundId: "r",
    });
    expect(await refund()).toMatchObject({
      kind: "DONE",
      message: expect.stringContaining("never be sent twice"),
    });
  });

  it("is rate limited before the refund service is reached", async () => {
    mocks.limitPaymentRequest.mockResolvedValueOnce({
      kind: "LIMITED",
      rule: "payment-minute",
      retryAfterSeconds: 12,
    });
    const outcome = await refund();
    expect(outcome).toMatchObject({ kind: "ERROR" });
    expect(JSON.stringify(outcome)).toContain("12 seconds");
    expect(mocks.requestRefund).not.toHaveBeenCalled();
  });

  it("refuses a malformed transaction id without calling anything", async () => {
    const { refundPurchase } = await actions();
    expect(await refundPurchase(IDLE, form({ transactionId: "not-a-uuid" }))).toEqual({
      kind: "ERROR",
      message: "Unknown purchase.",
    });
    expect(mocks.limitPaymentRequest).not.toHaveBeenCalled();
  });

  it("catches a thrown failure instead of surfacing it", async () => {
    mocks.requestRefund.mockRejectedValueOnce(new Error("connection reset: secret-host"));
    const outcome = await refund();
    expect(outcome).toEqual({
      kind: "ERROR",
      message: "The refund could not be requested just now.",
    });
  });
});

describe("checkRefundStatus", () => {
  const check = async () => {
    const { checkRefundStatus } = await actions();
    return checkRefundStatus(IDLE, form({ transactionId: TRANSACTION_ID }));
  };

  it("reports the reconciled status in words", async () => {
    mocks.reconcileRefund.mockResolvedValueOnce("RECONCILIATION_REQUIRED");
    expect(await check()).toEqual({
      kind: "DONE",
      message: "Refund status: reconciliation required.",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/transaction/${TRANSACTION_ID}`);
  });

  it("says so when there is no open refund", async () => {
    mocks.reconcileRefund.mockResolvedValueOnce(null);
    expect(await check()).toMatchObject({
      message: "There is no open refund on this purchase.",
    });
  });

  it("is rate limited, and catches a failed lookup", async () => {
    mocks.limitPaymentRequest.mockResolvedValueOnce({
      kind: "LIMITED",
      rule: "payment-minute",
      retryAfterSeconds: 5,
    });
    expect(await check()).toMatchObject({ kind: "ERROR" });
    expect(mocks.reconcileRefund).not.toHaveBeenCalled();

    mocks.reconcileRefund.mockRejectedValueOnce(new Error("timeout"));
    expect(await check()).toEqual({
      kind: "ERROR",
      message: "The refund status could not be checked just now.",
    });
  });
});

describe("approvePurchase / rejectPurchase / reserveStock", () => {
  it("rejects without charging, and revalidates the page", async () => {
    mocks.findUnique.mockResolvedValueOnce({ buyerProfileId: "buyer-1" });
    mocks.requestApproval.mockResolvedValueOnce({
      kind: "APPROVAL_REQUESTED",
      token: "t",
    });
    mocks.decideApproval.mockResolvedValueOnce({ kind: "REJECTED" });

    const { rejectPurchase } = await actions();
    expect(await rejectPurchase(IDLE, form({ transactionId: TRANSACTION_ID }))).toEqual({
      kind: "DONE",
      message: "Rejected. Nothing has been charged.",
    });
    expect(mocks.decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "REJECT", decidedByBuyerId: "buyer-1" }),
    );
  });

  it("answers an unknown purchase before minting any approval token", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    const { approvePurchase } = await actions();
    expect(await approvePurchase(IDLE, form({ transactionId: TRANSACTION_ID }))).toEqual({
      kind: "ERROR",
      message: "Unknown purchase.",
    });
    expect(mocks.requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["APPROVAL_NOT_REQUIRED", "not waiting for approval"],
    ["APPROVAL_ALREADY_PENDING", "already open"],
  ])("explains %s", async (kind, phrase) => {
    mocks.findUnique.mockResolvedValueOnce({ buyerProfileId: "buyer-1" });
    mocks.requestApproval.mockResolvedValueOnce({ kind });
    const { approvePurchase } = await actions();
    const outcome = await approvePurchase(IDLE, form({ transactionId: TRANSACTION_ID }));
    expect(outcome).toMatchObject({ kind: "ERROR" });
    expect(JSON.stringify(outcome)).toContain(phrase);
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("says an approval that is no longer valid charged nothing", async () => {
    mocks.findUnique.mockResolvedValueOnce({ buyerProfileId: "buyer-1" });
    mocks.requestApproval.mockResolvedValueOnce({
      kind: "APPROVAL_REQUESTED",
      token: "t",
    });
    mocks.decideApproval.mockResolvedValueOnce({ kind: "REFUSED" });
    const { approvePurchase } = await actions();
    expect(await approvePurchase(IDLE, form({ transactionId: TRANSACTION_ID }))).toEqual({
      kind: "ERROR",
      message: "That approval is no longer valid. Nothing has been charged.",
    });
  });

  it("never returns the approval token to the browser", async () => {
    mocks.findUnique.mockResolvedValueOnce({ buyerProfileId: "buyer-1" });
    mocks.requestApproval.mockResolvedValueOnce({
      kind: "APPROVAL_REQUESTED",
      token: "plaintext-approval-token",
    });
    mocks.decideApproval.mockResolvedValueOnce({ kind: "AUTHORIZED" });
    const { approvePurchase } = await actions();
    const outcome = await approvePurchase(IDLE, form({ transactionId: TRANSACTION_ID }));
    expect(JSON.stringify(outcome)).not.toContain("plaintext-approval-token");
  });

  it("explains a refused stock hold and catches a thrown one", async () => {
    const { reserveStock } = await actions();
    mocks.reserveInventory.mockResolvedValueOnce({
      kind: "REFUSED",
      refusal: "INSUFFICIENT_INVENTORY",
    });
    const refused = await reserveStock(IDLE, form({ transactionId: TRANSACTION_ID }));
    expect(refused.kind).toBe("ERROR");
    expect(JSON.stringify(refused)).not.toContain("INSUFFICIENT_INVENTORY");

    mocks.reserveInventory.mockRejectedValueOnce(new Error("deadlock"));
    expect(await reserveStock(IDLE, form({ transactionId: TRANSACTION_ID }))).toEqual({
      kind: "ERROR",
      message: "The item could not be held just now.",
    });
  });
});
