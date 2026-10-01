import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderRequestBudgetExceededError } from "@/domain/buyer-agent/errors";

/**
 * The Server Action's own half of the guarantee: whatever typed error the
 * Buyer Agent's request budget produces, `submitRequest` must convert it into
 * the same graceful, generic result it already gives every other agent
 * failure - never a raw error, never a rethrow that would surface to Next.js
 * as an unhandled Server Action exception.
 *
 * `runBuyerAgent` is mocked at the module boundary so this proves
 * `submitRequest`'s own try/catch, not the retry policy again - that is
 * `tests/buyer-agent-request-budget.test.ts`'s job. No live Gemini call, no
 * real timers.
 */

const { mockRunBuyerAgent } = vi.hoisted(() => ({ mockRunBuyerAgent: vi.fn() }));

vi.mock("@/services/buyer-agent/buyer-agent-service", () => ({
  runBuyerAgent: mockRunBuyerAgent,
}));

const { mockDecidePurchase } = vi.hoisted(() => ({ mockDecidePurchase: vi.fn() }));

vi.mock("@/services/product-decision/product-decision-service", () => ({
  decidePurchase: mockDecidePurchase,
}));

function formDataWith(message: string): FormData {
  const data = new FormData();
  data.set("message", message);
  return data;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("submitRequest converts a request-budget failure into the existing graceful result", () => {
  it("returns the generic safe message when the Buyer Agent's overall deadline is exceeded", async () => {
    mockRunBuyerAgent.mockRejectedValueOnce(
      new AiProviderRequestBudgetExceededError({ correlationId: "corr-test" }),
    );

    const { submitRequest } = await import("@/app/actions/purchase");
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

    const { submitRequest } = await import("@/app/actions/purchase");
    const outcome = await submitRequest(
      { kind: "IDLE" },
      formDataWith("Find me a keyboard."),
    );

    expect(outcome).toEqual({
      kind: "CLARIFICATION",
      question: "What's your budget?",
    });
  });
});
