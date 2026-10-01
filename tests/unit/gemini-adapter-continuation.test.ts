import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Gemini adapter's tool-conversation continuation.
 *
 * This file exists because of a live failure that no other test in the suite
 * could have caught. Every Buyer Agent test drives an in-memory fake provider —
 * which is right, because the agent's safety properties must be provable
 * without a key or a quota — but it left the one file that actually talks to
 * Gemini with no coverage at all. The adapter continued a tool conversation by
 * sending `previous_interaction_id: interaction.id`, and an interaction created
 * with `store: false` has no `id` at all. So the id was `undefined`, the field
 * was dropped, and the next turn presented a bare `function_result` as the
 * opening move of a brand-new conversation. Gemini answered 400 — "please
 * ensure that function response turn comes immediately after a function call
 * turn" — and the adapter's own translator turned that 4xx into
 * `AI_PROVIDER_INVALID_RESPONSE`. Intent extraction worked, because it never
 * calls a tool; every request that reached the catalog failed.
 *
 * So what is asserted here is the shape of the request the adapter *sends*, not
 * anything about what a model chose to reply. The SDK is stubbed at the module
 * boundary — the one seam where this application stops and a vendor begins —
 * and no network call is made.
 */

const create = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly interactions = { create };
  },
}));

const { createGeminiProvider } = await import("@/integrations/llm/gemini-provider");

/** A `thought` step exactly as Gemini 3 returns it, signature and all. */
const THOUGHT_STEP = { type: "thought", signature: "Es0ECsoEAR-opaque-signature" };
const CALL_STEP = {
  type: "function_call",
  id: "call_280616",
  name: "search_catalog",
  arguments: { category: "keyboards" },
};

interface CreatedRequest {
  readonly input?: unknown;
  readonly store?: boolean;
  readonly previous_interaction_id?: unknown;
  readonly system_instruction?: string;
  readonly tools?: readonly unknown[];
}

function requestAt(index: number): CreatedRequest {
  return create.mock.calls[index]?.[0] as CreatedRequest;
}

function inputItems(index: number): readonly Record<string, unknown>[] {
  const { input } = requestAt(index);
  if (!Array.isArray(input)) throw new Error("expected an array input");
  return input as readonly Record<string, unknown>[];
}

const provider = () =>
  createGeminiProvider({ apiKey: "test-key-never-used", modelId: "gemini-3.6-flash" });

const TOOL_RESULT = {
  callId: CALL_STEP.id,
  name: CALL_STEP.name,
  content: { products: [] },
};

/** Drives one generate turn that comes back asking for a tool. */
async function firstTurn() {
  create.mockResolvedValueOnce({
    status: "requires_action",
    steps: [THOUGHT_STEP, CALL_STEP],
  });
  return provider().generate({
    systemInstruction: "Select one product.",
    userMessage: "Find me a mechanical keyboard under 3000 rupees",
    correlationId: "test-correlation",
  });
}

beforeEach(() => {
  create.mockReset();
});

describe("continuing a tool conversation", () => {
  it("never sends a function result as the opening move", async () => {
    // The exact request Gemini answered 400 to. A continuation whose first
    // input item is a function_result has no function call to answer.
    const first = await firstTurn();
    create.mockResolvedValueOnce({ output_text: '{"outcome":"NO_MATCH"}', steps: [] });

    await provider().continueWithToolResults({
      providerStateRef: first.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [TOOL_RESULT],
      correlationId: "test-correlation",
    });

    expect(inputItems(1)[0]?.["type"]).not.toBe("function_result");
  });

  it("replays the shopper's message, then the model's steps, then the result", async () => {
    const first = await firstTurn();
    create.mockResolvedValueOnce({ output_text: '{"outcome":"NO_MATCH"}', steps: [] });

    await provider().continueWithToolResults({
      providerStateRef: first.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [TOOL_RESULT],
      correlationId: "test-correlation",
    });

    expect(inputItems(1).map((item) => item["type"])).toEqual([
      "text",
      "thought",
      "function_call",
      "function_result",
    ]);
  });

  it("replays a thought step verbatim, signature included", async () => {
    // Gemini 3 rejects a continuation whose reasoning steps were dropped, and
    // rewriting one would be forging the model's own record of its reasoning.
    // Either way the adapter's job is to hand it back untouched.
    const first = await firstTurn();
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });

    await provider().continueWithToolResults({
      providerStateRef: first.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [TOOL_RESULT],
      correlationId: "test-correlation",
    });

    expect(inputItems(1)[1]).toEqual(THOUGHT_STEP);
  });

  it("pairs each result with the call id the model issued", async () => {
    const first = await firstTurn();
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });

    await provider().continueWithToolResults({
      providerStateRef: first.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [{ ...TOOL_RESULT, isError: true }],
      correlationId: "test-correlation",
    });

    const result = inputItems(1)[3];
    expect(result?.["call_id"]).toBe(CALL_STEP.id);
    expect(result?.["name"]).toBe(CALL_STEP.name);
    expect(result?.["is_error"]).toBe(true);
  });

  it("accumulates every turn, so a second tool round still has its history", async () => {
    // Two searches in one run is the ordinary case, not an edge case: the model
    // narrows its query after seeing the first result set. The second
    // continuation must carry both rounds or it fails the same way the first
    // one did.
    const first = await firstTurn();
    const secondCall = { ...CALL_STEP, id: "call_991122" };
    create.mockResolvedValueOnce({
      status: "requires_action",
      steps: [secondCall],
    });

    const second = await provider().continueWithToolResults({
      providerStateRef: first.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [TOOL_RESULT],
      correlationId: "test-correlation",
    });

    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    await provider().continueWithToolResults({
      providerStateRef: second.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [{ ...TOOL_RESULT, callId: secondCall.id }],
      correlationId: "test-correlation",
    });

    expect(inputItems(2).map((item) => item["type"])).toEqual([
      "text",
      "thought",
      "function_call",
      "function_result",
      "function_call",
      "function_result",
    ]);
  });

  it("refuses a continuation that lost the preceding turn", async () => {
    // Cheaper and clearer than sending a request the API is certain to reject.
    await expect(
      provider().continueWithToolResults({
        providerStateRef: null,
        systemInstruction: "Select one product.",
        toolResults: [TOOL_RESULT],
        correlationId: "test-correlation",
      }),
    ).rejects.toMatchObject({ code: "AI_PROVIDER_INVALID_RESPONSE" });

    expect(create).not.toHaveBeenCalled();
  });
});

describe("what the adapter refuses to rely on", () => {
  it("never sends previous_interaction_id, because nothing is stored", async () => {
    // `store: false` and a referenced conversation are mutually exclusive. The
    // original bug was an adapter that asked for both and silently got neither.
    const first = await firstTurn();
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });

    await provider().continueWithToolResults({
      providerStateRef: first.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [TOOL_RESULT],
      correlationId: "test-correlation",
    });

    for (const index of [0, 1]) {
      expect(requestAt(index).store).toBe(false);
      expect(requestAt(index)).not.toHaveProperty("previous_interaction_id");
    }
  });

  it("does not depend on an interaction id the API does not return", async () => {
    // The response below is the real shape of an unstored interaction: status,
    // steps, usage - and no id anywhere. A continuation must still be possible.
    const first = await firstTurn();
    expect(first.providerStateRef).not.toBeNull();
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]?.id).toBe(CALL_STEP.id);
  });
});

describe("what the continuation state may not become", () => {
  it("is not a string, so it cannot be concatenated into a log line", async () => {
    // The transcript carries thought signatures, so it is exactly the value
    // that must never be logged, persisted or returned. The type is the real
    // enforcement - it is branded and empty, so reading a field off it does not
    // compile - and this is the runtime half: a value that is not a string
    // cannot slip into a template literal and read as harmless text.
    const first = await firstTurn();
    expect(typeof first.providerStateRef).toBe("object");
    expect(String(first.providerStateRef)).toBe("[object Object]");
  });

  it("survives a turn that produced no steps at all", async () => {
    create.mockResolvedValueOnce({ output_text: '{"outcome":"CLARIFY"}' });
    const response = await provider().generate({
      systemInstruction: "Extract the intent.",
      userMessage: "Find me a keyboard",
      correlationId: "test-correlation",
    });

    expect(response.text).toBe('{"outcome":"CLARIFY"}');
    expect(response.toolCalls).toHaveLength(0);
    expect(response.providerStateRef).not.toBeNull();
  });
});
