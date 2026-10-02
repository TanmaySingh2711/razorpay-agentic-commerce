import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderRequestBudgetExceededError } from "@/domain/buyer-agent/errors";
import type * as BuyerAgentService from "@/services/buyer-agent-service";

/**
 * The Server Action's own half of the guarantee: whatever typed error the
 * Buyer Agent's request budget produces, `submitRequest` must convert it into
 * the same graceful, generic result it already gives every other agent
 * failure - never a raw error, never a rethrow that would surface to Next.js
 * as an unhandled Server Action exception.
 *
 * `runBuyerAgent` is mocked at the module boundary so this proves
 * `submitRequest`'s own try/catch, not the retry policy again - that is
 * `tests/unit/buyer-agent-request-budget.test.ts`'s job. No live Gemini call, no
 * real timers.
 */

const { mockRunBuyerAgent } = vi.hoisted(() => ({ mockRunBuyerAgent: vi.fn() }));

vi.mock("@/services/buyer-agent-service", async (importOriginal) => ({
  // The real bounds (MAX_PRIOR_TURNS and friends), with only the agent run
  // itself replaced.
  ...(await importOriginal<typeof BuyerAgentService>()),
  runBuyerAgent: mockRunBuyerAgent,
}));

// The action's other boundaries: the request headers it keys the rate limit
// on, the limiter itself (PostgreSQL in production), and the insight log.
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-real-ip": "203.0.113.7" })),
}));

const { mockLimitAgentRequest } = vi.hoisted(() => ({
  mockLimitAgentRequest: vi.fn(),
}));

vi.mock("@/services/rate-limit-service", () => ({
  limitAgentRequest: mockLimitAgentRequest,
  limitPaymentRequest: vi.fn(),
}));

const { mockRecordAgentRequest } = vi.hoisted(() => ({
  mockRecordAgentRequest: vi.fn(),
}));

vi.mock("@/services/agent-request-log", () => ({
  recordAgentRequest: mockRecordAgentRequest,
}));

const { mockDecidePurchase } = vi.hoisted(() => ({ mockDecidePurchase: vi.fn() }));

vi.mock("@/services/product-decision-service", () => ({
  decidePurchase: mockDecidePurchase,
}));

function formDataWith(message: string): FormData {
  const data = new FormData();
  data.set("message", message);
  return data;
}

beforeEach(() => {
  mockLimitAgentRequest.mockResolvedValue({ kind: "ALLOWED" });
  mockRecordAgentRequest.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("submitRequest converts a request-budget failure into the existing graceful result", () => {
  it("returns the generic safe message when the Buyer Agent's overall deadline is exceeded", async () => {
    mockRunBuyerAgent.mockRejectedValueOnce(
      new AiProviderRequestBudgetExceededError({ correlationId: "corr-test" }),
    );

    const { submitRequest } = await import("@/app/actions");
    const outcome = await submitRequest(
      { kind: "IDLE" },
      formDataWith("Find me the best mechanical keyboard under ₹3000 and buy it."),
    );

    // Exactly the existing outcome shape every other agent failure produces -
    // no new branch was needed, and none was added.
    expect(outcome).toEqual({
      kind: "ERROR",
      message:
        "The assistant could not be reached just now. Nothing was charged. Please try again.",
    });
    // Never a raw error, never a rethrow, never the internal message or code.
    expect(JSON.stringify(outcome)).not.toContain("AI_PROVIDER_REQUEST_BUDGET_EXCEEDED");
    // Nothing downstream of the agent ran: a proposal that never arrived
    // cannot be priced.
    expect(mockDecidePurchase).not.toHaveBeenCalled();
  });

  it("leaves normal success behaviour unchanged", async () => {
    // The agent proposed a decision; `decidePurchase` is exercised
    // separately elsewhere, so it is mocked here purely to isolate
    // `submitRequest`'s own mapping of one of its ordinary, non-error
    // outcomes - proving this fix changed nothing about the happy path.
    mockRunBuyerAgent.mockResolvedValueOnce({
      kind: "NEEDS_CLARIFICATION",
      correlationId: "corr-test",
    });
    mockDecidePurchase.mockResolvedValueOnce({
      kind: "CLARIFICATION_REQUIRED",
      question: "What's your budget?",
    });

    const { submitRequest } = await import("@/app/actions");
    const outcome = await submitRequest(
      { kind: "IDLE" },
      formDataWith("Find me a keyboard."),
    );

    expect(outcome).toEqual({
      kind: "CLARIFICATION",
      question: "What's your budget?",
      // Handed back so the answer can continue the conversation.
      conversation: [
        { shopper: "Find me a keyboard.", assistantQuestion: "What's your budget?" },
      ],
    });
    expect(mockRecordAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "CLARIFICATION", turn: 1 }),
    );
  });
});

describe("submitRequest is gated by the abuse and cost ceilings", () => {
  it("refuses a rate-limited caller before the model is called", async () => {
    mockLimitAgentRequest.mockResolvedValueOnce({
      kind: "LIMITED",
      rule: "agent-minute",
      retryAfterSeconds: 42,
    });

    const { submitRequest } = await import("@/app/actions");
    const outcome = await submitRequest(
      { kind: "IDLE" },
      formDataWith("Find me a mouse."),
    );

    expect(outcome).toEqual({
      kind: "ERROR",
      message:
        "You are sending requests faster than this demo allows. Please wait 42 seconds and try again - nothing was charged.",
    });
    expect(mockRunBuyerAgent).not.toHaveBeenCalled();
    expect(mockRecordAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "RATE_LIMITED" }),
    );
  });

  it("says so plainly when the whole demo has used its daily allowance", async () => {
    mockLimitAgentRequest.mockResolvedValueOnce({
      kind: "LIMITED",
      rule: "agent-global-day",
      retryAfterSeconds: 3000,
    });
    const { submitRequest } = await import("@/app/actions");
    const outcome = await submitRequest(
      { kind: "IDLE" },
      formDataWith("Find me a mouse."),
    );
    expect(outcome).toMatchObject({ kind: "ERROR" });
    expect(JSON.stringify(outcome)).toContain("today");
    expect(mockRunBuyerAgent).not.toHaveBeenCalled();
  });

  it("fails closed when the limiter itself cannot answer", async () => {
    mockLimitAgentRequest.mockRejectedValueOnce(new Error("database unreachable"));
    const { submitRequest } = await import("@/app/actions");
    const outcome = await submitRequest(
      { kind: "IDLE" },
      formDataWith("Find me a mouse."),
    );
    expect(outcome).toMatchObject({ kind: "ERROR" });
    expect(mockRunBuyerAgent).not.toHaveBeenCalled();
  });
});

describe("submitRequest continues a conversation", () => {
  it("passes the earlier turns to the agent", async () => {
    mockRunBuyerAgent.mockResolvedValueOnce({ kind: "NO_MATCH", correlationId: "c" });
    mockDecidePurchase.mockResolvedValueOnce({
      kind: "NO_VALID_CANDIDATE",
      reasons: [],
      transactionId: null,
    });
    const data = formDataWith("3000");
    data.set(
      "conversation",
      JSON.stringify([{ shopper: "a wireless mouse", assistantQuestion: "Budget?" }]),
    );

    const { submitRequest } = await import("@/app/actions");
    await submitRequest({ kind: "IDLE" }, data);

    expect(mockRunBuyerAgent).toHaveBeenCalledWith({
      message: "3000",
      priorTurns: [{ shopper: "a wireless mouse", assistantQuestion: "Budget?" }],
    });
  });

  it("refuses a conversation that is not one this app could have produced", async () => {
    const data = formDataWith("3000");
    data.set(
      "conversation",
      JSON.stringify([{ shopper: "", assistantQuestion: "x", extra: 1 }]),
    );

    const { submitRequest } = await import("@/app/actions");
    const outcome = await submitRequest({ kind: "IDLE" }, data);

    expect(outcome).toMatchObject({ kind: "ERROR" });
    expect(mockRunBuyerAgent).not.toHaveBeenCalled();
    expect(mockLimitAgentRequest).not.toHaveBeenCalled();
  });
});

describe("submitRequest answers a browse request with a recommendation", () => {
  const selected = {
    kind: "PRODUCT_SELECTED",
    correlationId: "corr-browse",
    selectedProductId: "01930000-0000-7000-8000-00000000b001",
    quantity: 1,
    reasonCodes: ["WITHIN_BUDGET"],
    summary: "A quiet linear board that fits your budget.",
    constraints: {
      requestType: "BROWSE",
      quantity: 1,
      maxBudget: { amountMinor: "300000", currency: "INR" },
      budgetScope: "PER_UNIT",
      category: "mechanical-keyboard",
      hardRequirements: [],
      softPreferences: [],
    },
    observedProduct: {
      productId: "01930000-0000-7000-8000-00000000b001",
      name: "Aurora TKL Mechanical Keyboard",
      amount: { amountMinor: "249900", currency: "INR" },
      availableQuantity: 5,
      version: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  };

  it("recommends without opening anything, and offers a buy prompt that keeps the budget", async () => {
    mockRunBuyerAgent.mockResolvedValueOnce(selected);
    mockDecidePurchase.mockResolvedValueOnce({
      kind: "NO_QUOTE_REQUIRED",
      correlationId: "corr-browse",
      requestType: "BROWSE",
    });

    const { submitRequest } = await import("@/app/actions");
    const outcome = await submitRequest(
      { kind: "IDLE" },
      formDataWith("Show me a keyboard under ₹3000"),
    );

    expect(outcome).toEqual({
      kind: "RECOMMENDATION",
      productName: "Aurora TKL Mechanical Keyboard",
      price: { amountMinor: "249900", currency: "INR" },
      summary: "A quiet linear board that fits your budget.",
      buyPrompt: "Buy the Aurora TKL Mechanical Keyboard under ₹3,000.00",
    });

    // The suggested follow-up must carry the shopper's ceiling in words the
    // server's own budget check reads back exactly - never a looser one.
    const { verifyBudgetClaim } = await import("@/domain/buyer-agent/budget");
    const prompt = outcome.kind === "RECOMMENDATION" ? outcome.buyPrompt : "";
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "300000",
          currency: "INR",
          explicit: true,
          scope: "PER_UNIT",
          sourceText: "under ₹3,000.00",
        },
        prompt,
      ),
    ).toMatchObject({ kind: "VERIFIED", maxAmountMinor: 300_000n });
  });
});
