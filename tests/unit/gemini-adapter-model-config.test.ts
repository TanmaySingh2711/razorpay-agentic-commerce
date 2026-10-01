import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The latency-oriented model configuration: which model id and thinking level
 * actually reach the request, and that switching them changes nothing else
 * about the request shape.
 *
 * Production evidence showed `gemini-3.6-flash` repeatedly reaching the full
 * 30-second per-attempt ceiling in this synchronous purchase flow. The fix is
 * `gemini-3.5-flash-lite` with `generation_config.thinking_level: "minimal"` -
 * safe because every task the Buyer Agent asks the model to do is schema- or
 * tool-constrained, and every financial decision is made deterministically
 * outside the model. This file proves the adapter actually sends that
 * configuration, and that doing so changes nothing else: the structured
 * output schema, the tool declarations, the continuation transcript and the
 * `AbortSignal` wiring must all still reach the SDK exactly as before.
 *
 * The SDK is stubbed at the module boundary, as in
 * `tests/gemini-adapter-continuation.test.ts` - no network call is made.
 */

const create = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly interactions = { create };
  },
}));

const { createGeminiProvider, DEFAULT_THINKING_LEVEL } =
  await import("@/integrations/llm/gemini-provider");

interface CreatedRequest {
  readonly model?: string;
  readonly generation_config?: { thinking_level?: string };
  readonly response_format?: unknown;
  readonly tools?: readonly unknown[];
}

function requestAt(index: number): CreatedRequest {
  return create.mock.calls[index]?.[0] as CreatedRequest;
}

function optionsAt(index: number): { signal?: AbortSignal } {
  return (create.mock.calls[index]?.[1] ?? {}) as { signal?: AbortSignal };
}

const SCHEMA = { type: "object", properties: { outcome: { type: "string" } } };
const TOOLS = [
  {
    name: "search_catalog",
    description: "Search the catalog.",
    parameters: { type: "object", properties: {} },
  },
];

beforeEach(() => {
  create.mockReset();
});

describe("the configured model id reaches the request", () => {
  it("sends whatever model id the provider was built with", async () => {
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    const provider = createGeminiProvider({
      apiKey: "test-key-never-used",
      modelId: "gemini-3.5-flash-lite",
    });

    await provider.generate({
      systemInstruction: "Extract the intent.",
      userMessage: "Find me a keyboard",
      correlationId: "test-correlation",
    });

    expect(requestAt(0).model).toBe("gemini-3.5-flash-lite");
  });
});

describe("the thinking level reaches generation_config", () => {
  it("defaults to minimal, the latency-oriented setting, on generate()", async () => {
    expect(DEFAULT_THINKING_LEVEL).toBe("minimal");
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    const provider = createGeminiProvider({
      apiKey: "test-key-never-used",
      modelId: "gemini-3.5-flash-lite",
    });

    await provider.generate({
      systemInstruction: "Extract the intent.",
      userMessage: "Find me a keyboard",
      correlationId: "test-correlation",
    });

    expect(requestAt(0).generation_config).toEqual({ thinking_level: "minimal" });
  });

  it("defaults to minimal on continueWithToolResults() as well", async () => {
    create.mockResolvedValueOnce({
      status: "requires_action",
      steps: [
        { type: "function_call", id: "call_1", name: "search_catalog", arguments: {} },
      ],
    });
    const provider = createGeminiProvider({
      apiKey: "test-key-never-used",
      modelId: "gemini-3.5-flash-lite",
    });
    const first = await provider.generate({
      systemInstruction: "Select one product.",
      userMessage: "Find me a keyboard",
      correlationId: "test-correlation",
    });

    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    await provider.continueWithToolResults({
      providerStateRef: first.providerStateRef,
      systemInstruction: "Select one product.",
      toolResults: [
        { callId: "call_1", name: "search_catalog", content: { products: [] } },
      ],
      correlationId: "test-correlation",
    });

    expect(requestAt(1).generation_config).toEqual({ thinking_level: "minimal" });
  });

  it("honours an explicit, higher thinking level when one is configured", async () => {
    // The variable exists so a deployment can deliberately raise it; this
    // proves the override actually reaches the request rather than the
    // default silently winning.
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    const provider = createGeminiProvider({
      apiKey: "test-key-never-used",
      modelId: "gemini-3.5-flash-lite",
      thinkingLevel: "high",
    });

    await provider.generate({
      systemInstruction: "Extract the intent.",
      userMessage: "Find me a keyboard",
      correlationId: "test-correlation",
    });

    expect(requestAt(0).generation_config).toEqual({ thinking_level: "high" });
  });
});

describe("nothing else about the request changes", () => {
  it("still passes the structured output schema unchanged", async () => {
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    const provider = createGeminiProvider({
      apiKey: "test-key-never-used",
      modelId: "gemini-3.5-flash-lite",
    });

    await provider.generate({
      systemInstruction: "Extract the intent.",
      userMessage: "Find me a keyboard",
      responseSchema: SCHEMA,
      correlationId: "test-correlation",
    });

    expect(requestAt(0).response_format).toEqual({
      type: "text",
      mime_type: "application/json",
      schema: SCHEMA,
    });
  });

  it("still passes tool declarations unchanged", async () => {
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    const provider = createGeminiProvider({
      apiKey: "test-key-never-used",
      modelId: "gemini-3.5-flash-lite",
    });

    await provider.generate({
      systemInstruction: "Select one product.",
      userMessage: "Find me a keyboard",
      tools: TOOLS,
      correlationId: "test-correlation",
    });

    expect(requestAt(0).tools).toEqual([{ type: "function", ...TOOLS[0] }]);
  });

  it("still threads an AbortSignal into the SDK request options", async () => {
    create.mockResolvedValueOnce({ output_text: "{}", steps: [] });
    const provider = createGeminiProvider({
      apiKey: "test-key-never-used",
      modelId: "gemini-3.5-flash-lite",
    });
    const controller = new AbortController();

    await provider.generate({
      systemInstruction: "Extract the intent.",
      userMessage: "Find me a keyboard",
      correlationId: "test-correlation",
      abortSignal: controller.signal,
    });

    expect(optionsAt(0).signal).toBe(controller.signal);
  });
});
