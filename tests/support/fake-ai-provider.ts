import { AppError } from "@/domain/errors";
import { CatalogProductNotFoundError } from "@/domain/catalog/errors";
import type { CatalogProductDto } from "@/domain/catalog/contracts";
import type { CatalogReader } from "@/services/buyer-agent/catalog-reader";
import type {
  AiGenerationRequest,
  AiGenerationResponse,
  AiProvider,
  AiProviderStateRef,
  AiToolResponseRequest,
} from "@/integrations/llm/provider";

/**
 * A deterministic stand-in for Gemini.
 *
 * Every ordinary test in this objective runs against this, never the live API.
 * That is not only about the free tier: a test whose outcome depends on what a
 * model felt like saying cannot prove a safety property. The rules under test —
 * an immutable budget, product-id provenance, refused tools, rejected malformed
 * output — must hold for *every* model response, so the tests script the
 * responses precisely, including the hostile ones a real model would rarely
 * produce on demand.
 *
 * The fake implements the application's own `AiProvider` interface. Nothing
 * here imports `@google/genai`, which is the point of having that interface.
 */

export interface ScriptedTurn {
  /** Structured JSON the model "returned". */
  readonly text?: string | null;
  /** Tool calls the model asked for. */
  readonly toolCalls?: readonly { name: string; args: Record<string, unknown> }[];
  /** Thrown instead of answering, to simulate a provider failure. */
  readonly error?: Error;
}

export interface FakeProviderOptions {
  readonly turns: readonly ScriptedTurn[];
  readonly modelId?: string;
}

export interface FakeAiProvider extends AiProvider {
  /** Every request the agent made, for asserting correlation and prompt content. */
  readonly requests: (AiGenerationRequest | AiToolResponseRequest)[];
  readonly callCount: () => number;
}

/**
 * Builds a provider that replays scripted turns in order.
 *
 * The last turn repeats if the agent asks for more, which lets a test model a
 * runaway loop by scripting a single tool-calling turn.
 */
export function createFakeAiProvider(options: FakeProviderOptions): FakeAiProvider {
  const requests: (AiGenerationRequest | AiToolResponseRequest)[] = [];
  let index = 0;

  const next = (): AiGenerationResponse => {
    const turn =
      options.turns[Math.min(index, options.turns.length - 1)] ??
      ({ text: null } satisfies ScriptedTurn);
    index += 1;

    if (turn.error !== undefined) throw turn.error;

    return {
      text: turn.text ?? null,
      toolCalls: (turn.toolCalls ?? []).map((call, position) => ({
        id: `call-${String(index)}-${String(position)}`,
        name: call.name,
        arguments: call.args as never,
      })),
      // Opaque to everything above the adapter, so a fake has to say so too.
      // The recognisable value is deliberate: a test asserts it never appears
      // in a decision, which is how "provider state does not leak" is checked.
      providerStateRef: `interaction-${String(index)}` as unknown as AiProviderStateRef,
    };
  };

  return {
    providerName: "fake",
    modelId: options.modelId ?? "fake-model",
    requests,
    callCount: () => index,
    generate(request: AiGenerationRequest): Promise<AiGenerationResponse> {
      requests.push(request);
      return Promise.resolve(next());
    },
    continueWithToolResults(
      request: AiToolResponseRequest,
    ): Promise<AiGenerationResponse> {
      requests.push(request);
      return Promise.resolve(next());
    },
  };
}

/** A well-formed intent payload, overridable per test. */
export function intentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestType: "PURCHASE",
    productQuery: "mechanical keyboard",
    category: "mechanical-keyboard",
    quantity: 1,
    budget: {
      maxAmountMinor: "300000",
      currency: "INR",
      explicit: true,
      sourceText: "under ₹3000",
    },
    hardRequirements: [],
    softPreferences: [],
    needsClarification: false,
    clarificationQuestion: null,
    ...overrides,
  });
}

/** A well-formed selection payload, overridable per test. */
export function selectionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    outcome: "SELECT",
    selectedProductId: null,
    quantity: 1,
    reasonCodes: ["WITHIN_BUDGET"],
    noMatchReasonCodes: [],
    clarificationQuestion: null,
    summary: "This one fits your budget.",
    ...overrides,
  });
}

/** Builds a catalog product DTO for pure tests. */
export function productDto(
  overrides: Partial<CatalogProductDto> & { id: string },
): CatalogProductDto {
  return {
    merchantId: "01930000-0000-7000-8000-0000000000m1",
    sku: "SKU-TEST",
    name: "Test Keyboard",
    description: "A keyboard.",
    category: "mechanical-keyboard",
    amount: { amountMinor: "279900", currency: "INR" },
    availability: { status: "AVAILABLE", quantity: 5, purchasable: true },
    attributes: { switchType: "linear-red", layout: "tkl-87" },
    version: 1,
    updatedAt: "2026-05-01T10:30:00.000Z",
    ...overrides,
  };
}

/** Never sleeps. Keeps retry tests instant and deterministic. */
export const noSleep = (): Promise<void> => Promise.resolve();

/**
 * An in-memory catalog, implementing the same read port production uses.
 *
 * It applies the visibility and budget rules the real catalog applies, so a
 * test that filters by price really filters. The database-backed path is
 * covered separately in tests/db/buyer-agent-flow.test.ts.
 */
export function createInMemoryCatalogReader(
  products: readonly CatalogProductDto[],
): CatalogReader {
  return {
    searchProducts(query) {
      const matches = products.filter((product) => {
        if (
          query.category !== undefined &&
          product.category.toLowerCase() !== query.category.toLowerCase()
        ) {
          return false;
        }
        if (query.currency !== undefined && product.amount.currency !== query.currency) {
          return false;
        }
        if (
          query.maxAmountMinor !== undefined &&
          BigInt(product.amount.amountMinor) > query.maxAmountMinor
        ) {
          return false;
        }
        return query.attributes.every(
          (filter) =>
            String(product.attributes[filter.key] ?? "").toLowerCase() ===
            String(filter.value).toLowerCase(),
        );
      });
      const page = matches.slice(query.offset, query.offset + query.limit);
      return Promise.resolve({
        products: page,
        total: matches.length,
        limit: query.limit,
        offset: query.offset,
      });
    },
    getProduct(productId) {
      const product = products.find((candidate) => candidate.id === productId);
      if (product === undefined) {
        return Promise.reject(new CatalogProductNotFoundError(productId));
      }
      return Promise.resolve(product);
    },
    getMerchant() {
      return Promise.resolve({
        id: "01930000-0000-7000-8000-0000000000m1",
        name: "Fake Merchant",
        slug: "fake-merchant",
        supportedCurrencies: ["INR"],
        updatedAt: "2026-05-01T10:30:00.000Z",
        catalogVersion: "1",
      });
    },
  };
}

/** A reader that fails loudly if a refused tool ever reaches it. */
export const unreachableCatalogReader: CatalogReader = {
  searchProducts() {
    throw new Error("a refused tool must never reach the catalog");
  },
  getProduct() {
    throw new Error("a refused tool must never reach the catalog");
  },
  getMerchant() {
    throw new Error("a refused tool must never reach the catalog");
  },
};

/**
 * Awaits a promise expected to reject and returns the error it threw.
 *
 * `promise.catch((e) => e)` widens the type to a union of the value and the
 * error, which then has to be cast at every use. This narrows once, here.
 */
export async function captureError(promise: Promise<unknown>): Promise<AppError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof AppError)) {
    throw new Error(`expected an AppError, received ${String(outcome)}`);
  }
  return outcome;
}
