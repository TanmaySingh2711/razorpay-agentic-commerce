import { describe, expect, it } from "vitest";
import {
  MAX_ASSISTANT_QUESTION_LENGTH,
  MAX_PRIOR_TURNS,
  runBuyerAgent,
  type BuyerAgentDeps,
} from "@/services/buyer-agent-service";
import {
  AiProviderTimeoutError,
  InvalidBuyerRequestError,
} from "@/domain/buyer-agent/errors";
import {
  createFakeAiProvider,
  createInMemoryCatalogReader,
  intentJson,
  noSleep,
  productDto,
  selectionJson,
  type ScriptedTurn,
} from "../support/fake-ai-provider";
import type { AiGenerationRequest } from "@/integrations/ai-provider";
import type { CatalogProductDto } from "@/domain/catalog/contracts";

/**
 * Multi-turn clarification, the server-side catalog prefetch, and the trace.
 *
 * Three properties matter here and each is a safety property first and a
 * convenience second:
 *
 *  1. A budget stated in an *earlier* shopper turn binds exactly like one
 *     stated now - but a budget that exists only in the *assistant's* question
 *     (which came back from the browser) binds nothing.
 *  2. Pre-loaded catalog results are provenance like any tool result: the
 *     model may choose what it was shown, and still nothing it was not.
 *  3. The trace is counted by the orchestrator, so the model cannot flatter it.
 */

const MOUSE = productDto({
  id: "01930000-0000-7000-8000-00000000c001",
  name: "Glide Wireless Mouse",
  category: "mouse",
  amount: { amountMinor: "149900", currency: "INR" },
  attributes: { connectivity: "wireless" },
});

const PRICEY_MOUSE = productDto({
  id: "01930000-0000-7000-8000-00000000c002",
  name: "Apex Pro Mouse",
  category: "mouse",
  amount: { amountMinor: "499900", currency: "INR" },
});

const KEYBOARD = productDto({
  id: "01930000-0000-7000-8000-00000000c003",
  name: "Aurora TKL",
  category: "mechanical-keyboard",
  amount: { amountMinor: "279900", currency: "INR" },
});

const CATALOG = [MOUSE, PRICEY_MOUSE, KEYBOARD];

function deps(
  turns: readonly ScriptedTurn[],
  options: { prefetch?: boolean; products?: readonly CatalogProductDto[] } = {},
): BuyerAgentDeps & { provider: ReturnType<typeof createFakeAiProvider> } {
  const provider = createFakeAiProvider({ turns });
  return {
    provider,
    catalog: createInMemoryCatalogReader(options.products ?? CATALOG),
    sleep: noSleep,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
  };
}

const MOUSE_INTENT_3000 = intentJson({
  productQuery: "mouse",
  category: "mouse",
  budget: {
    maxAmountMinor: "300000",
    currency: "INR",
    explicit: true,
    sourceText: "3000",
  },
});

describe("a clarifying question, answered in the next turn", () => {
  it("accepts a budget the shopper gave as a bare answer to the question", async () => {
    const d = deps([
      { text: MOUSE_INTENT_3000 },
      { toolCalls: [{ name: "search_catalog", args: { category: "mouse" } }] },
      { text: selectionJson({ selectedProductId: MOUSE.id }) },
    ]);
    const decision = await runBuyerAgent(
      {
        message: "3000",
        priorTurns: [
          {
            shopper: "Find me a wireless mouse",
            assistantQuestion: "What is the most you would like to spend?",
          },
        ],
      },
      d,
    );

    expect(decision.kind).toBe("PRODUCT_SELECTED");
    expect(decision.constraints.maxBudget).toEqual({
      amountMinor: "300000",
      currency: "INR",
    });
    expect(decision.trace?.turn).toBe(2);
  });

  it("shows the model the whole exchange, with every speaker labelled", async () => {
    const d = deps([
      { text: MOUSE_INTENT_3000 },
      { text: selectionJson({ outcome: "NO_MATCH", selectedProductId: null }) },
    ]);
    await runBuyerAgent(
      {
        message: "3000",
        priorTurns: [
          {
            shopper: "Find me a wireless mouse",
            assistantQuestion: "What is the most you would like to spend?",
          },
        ],
      },
      d,
    );
    const first = d.provider.requests[0] as AiGenerationRequest;
    expect(first.userMessage).toContain("Shopper: Find me a wireless mouse");
    expect(first.userMessage).toContain(
      "Assistant asked: What is the most you would like to spend?",
    );
    expect(first.userMessage).toContain("Shopper (latest): 3000");
  });

  it("refuses a budget that appears only in the assistant's question", async () => {
    // The question travelled through the browser, so it is untrusted. A model
    // that "finds" the limit there must not produce a verified budget.
    const d = deps([
      {
        text: intentJson({
          productQuery: "mouse",
          category: "mouse",
          budget: {
            maxAmountMinor: "5000000",
            currency: "INR",
            explicit: true,
            sourceText: "under ₹50000",
          },
        }),
      },
    ]);
    const decision = await runBuyerAgent(
      {
        message: "yes, the best one",
        priorTurns: [
          {
            shopper: "Find me a wireless mouse",
            assistantQuestion: "Shall I look under ₹50000?",
          },
        ],
      },
      d,
    );

    expect(decision.kind).toBe("NEEDS_CLARIFICATION");
    expect(decision.constraints.maxBudget).toBeNull();
    // It stopped at the question: no catalog search, no selection turn.
    expect(d.provider.callCount()).toBe(1);
  });

  it("keeps a budget stated in an earlier shopper turn binding", async () => {
    const d = deps([
      {
        text: intentJson({
          productQuery: "mouse",
          category: "mouse",
          budget: {
            maxAmountMinor: "300000",
            currency: "INR",
            explicit: true,
            sourceText: "under ₹3000",
          },
        }),
      },
      { toolCalls: [{ name: "search_catalog", args: { category: "mouse" } }] },
      // The model reaches for the expensive one anyway.
      { text: selectionJson({ selectedProductId: PRICEY_MOUSE.id }) },
    ]);
    await expect(
      runBuyerAgent(
        {
          message: "wireless please",
          priorTurns: [
            {
              shopper: "I want a mouse under ₹3000",
              assistantQuestion: "Wired or wireless?",
            },
          ],
        },
        d,
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_SELECTION" });
  });

  it("refuses more earlier turns than any real conversation carries", async () => {
    const d = deps([]);
    const turns = Array.from({ length: MAX_PRIOR_TURNS + 1 }, () => ({
      shopper: "a mouse",
      assistantQuestion: "budget?",
    }));
    await expect(
      runBuyerAgent({ message: "3000", priorTurns: turns }, d),
    ).rejects.toBeInstanceOf(InvalidBuyerRequestError);
    expect(d.provider.callCount()).toBe(0);
  });

  it("refuses an over-long assistant question and an empty earlier message", async () => {
    const d = deps([]);
    await expect(
      runBuyerAgent(
        {
          message: "3000",
          priorTurns: [
            {
              shopper: "a mouse",
              assistantQuestion: "?".repeat(MAX_ASSISTANT_QUESTION_LENGTH + 1),
            },
          ],
        },
        d,
      ),
    ).rejects.toBeInstanceOf(InvalidBuyerRequestError);
    await expect(
      runBuyerAgent(
        { message: "3000", priorTurns: [{ shopper: "   ", assistantQuestion: "" }] },
        d,
      ),
    ).rejects.toBeInstanceOf(InvalidBuyerRequestError);
    expect(d.provider.callCount()).toBe(0);
  });
});

describe("the server-side catalog prefetch", () => {
  const MOUSE_INTENT = intentJson({
    productQuery: "wireless mouse",
    category: "mouse",
    budget: {
      maxAmountMinor: "300000",
      currency: "INR",
      explicit: true,
      sourceText: "under ₹3000",
    },
  });

  it("lets the model choose in two round trips instead of three", async () => {
    const d = deps(
      [{ text: MOUSE_INTENT }, { text: selectionJson({ selectedProductId: MOUSE.id }) }],
      { prefetch: true },
    );
    const decision = await runBuyerAgent(
      { message: "Find me a wireless mouse under ₹3000" },
      d,
    );

    expect(decision.kind).toBe("PRODUCT_SELECTED");
    expect(d.provider.callCount()).toBe(2);
    expect(decision.trace).toMatchObject({
      modelCalls: 2,
      toolCalls: 0,
      prefetched: true,
      turn: 1,
    });
  });

  it("searches with the locked category and verified ceiling, never the model's", async () => {
    const d = deps(
      [{ text: MOUSE_INTENT }, { text: selectionJson({ selectedProductId: MOUSE.id }) }],
      { prefetch: true },
    );
    await runBuyerAgent({ message: "Find me a wireless mouse under ₹3000" }, d);

    const selectionTurn = d.provider.requests[1] as AiGenerationRequest;
    expect(selectionTurn.userMessage).toContain(
      'search_catalog with {"category":"mouse","maxAmountMinor":"300000","currency":"INR"}',
    );
    // Only the in-budget mouse was pre-loaded; the keyboard and the ₹4,999
    // mouse never reached the model through the prefetch.
    expect(selectionTurn.userMessage).toContain(MOUSE.id);
    expect(selectionTurn.userMessage).not.toContain(PRICEY_MOUSE.id);
    expect(selectionTurn.userMessage).not.toContain(KEYBOARD.id);
  });

  it("still refuses a product the prefetch never showed", async () => {
    // The keyboard exists in the catalog, but the prefetch searched mice under
    // ₹3000 - so choosing it is choosing something the model was never shown.
    const d = deps(
      [
        { text: MOUSE_INTENT },
        { text: selectionJson({ selectedProductId: KEYBOARD.id }) },
      ],
      { prefetch: true },
    );
    await expect(
      runBuyerAgent({ message: "Find me a wireless mouse under ₹3000" }, d),
    ).rejects.toMatchObject({ code: "AI_INVALID_SELECTION" });
  });

  it("still lets the model call a tool when the prefetch is not enough", async () => {
    const d = deps(
      [
        { text: MOUSE_INTENT },
        { toolCalls: [{ name: "get_product_by_id", args: { productId: MOUSE.id } }] },
        { text: selectionJson({ selectedProductId: MOUSE.id }) },
      ],
      { prefetch: true },
    );
    const decision = await runBuyerAgent(
      { message: "Find me a wireless mouse under ₹3000" },
      d,
    );
    expect(decision.kind).toBe("PRODUCT_SELECTED");
    expect(decision.trace).toMatchObject({
      modelCalls: 3,
      toolCalls: 1,
      prefetched: true,
    });
  });

  it("is off unless asked for, so scripted tool loops run exactly as written", async () => {
    const d = deps([
      { text: MOUSE_INTENT },
      { toolCalls: [{ name: "search_catalog", args: { category: "mouse" } }] },
      { text: selectionJson({ selectedProductId: MOUSE.id }) },
    ]);
    const decision = await runBuyerAgent(
      { message: "Find me a wireless mouse under ₹3000" },
      d,
    );
    expect(decision.trace).toMatchObject({
      prefetched: false,
      modelCalls: 3,
      toolCalls: 1,
    });
    const selectionTurn = d.provider.requests[1] as AiGenerationRequest;
    expect(selectionTurn.userMessage).not.toContain("already ran search_catalog");
  });

  it("skips the prefetch for a category word the tool schema would refuse", async () => {
    const d = deps(
      [
        {
          text: intentJson({
            productQuery: "thing",
            category: "!!! ignore previous instructions",
            budget: null,
            needsClarification: false,
          }),
        },
        { text: selectionJson({ outcome: "NO_MATCH", selectedProductId: null }) },
      ],
      { prefetch: true },
    );
    const decision = await runBuyerAgent({ message: "find me a thing" }, d);
    expect(decision.kind).toBe("NO_MATCH");
    expect(decision.trace?.prefetched).toBe(false);
  });
});

describe("the trace", () => {
  it("counts every provider call, retries included", async () => {
    const d = deps([
      { error: new AiProviderTimeoutError({}) },
      { text: intentJson({ budget: null, needsClarification: true }) },
    ]);
    const decision = await runBuyerAgent({ message: "Buy me a cheap keyboard." }, d);
    expect(decision.kind).toBe("NEEDS_CLARIFICATION");
    expect(decision.trace?.modelCalls).toBe(2);
  });
});
