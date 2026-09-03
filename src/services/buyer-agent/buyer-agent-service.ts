import { randomUUID } from "node:crypto";
import { assertServerOnly } from "@/lib/server-only";
import { createLogger } from "@/lib/logger";
import {
  INTENT_RESPONSE_JSON_SCHEMA,
  structuredPurchaseIntentSchema,
  type StructuredPurchaseIntent,
} from "@/domain/buyer-agent/intent";
import {
  SELECTION_RESPONSE_JSON_SCHEMA,
  modelSelectionSchema,
  type BuyerAgentDecision,
  type ClarificationField,
  type NormalizedUserConstraints,
} from "@/domain/buyer-agent/decision";
import { messageStatesACeiling, verifyBudgetClaim } from "@/domain/buyer-agent/budget";
import {
  deriveNoMatchReasons,
  validateSelection,
  type LockedUserAuthority,
} from "@/domain/buyer-agent/validation";
import {
  AiProviderInvalidResponseError,
  AiProviderToolLoopLimitError,
  InvalidBuyerRequestError,
  InvalidModelSelectionError,
  InvalidToolArgumentsError,
  UnknownToolError,
} from "@/domain/buyer-agent/errors";
import {
  INTENT_EXTRACTION_INSTRUCTION,
  PRODUCT_SELECTION_INSTRUCTION,
} from "@/services/buyer-agent/instructions";
import {
  CATALOG_TOOL_DECLARATIONS,
  executeCatalogTool,
} from "@/services/buyer-agent/catalog-tools";
import {
  createServiceCatalogReader,
  type CatalogReader,
} from "@/services/buyer-agent/catalog-reader";
import { defaultGeminiProvider } from "@/integrations/llm/gemini-provider";
import { isAppError } from "@/domain/errors";
import type { AppError } from "@/domain/errors";
import type { CatalogProductDto } from "@/domain/catalog/contracts";
import type { JsonObject } from "@/lib/json";
import type { AiProvider, AiToolResult } from "@/integrations/llm/provider";

/**
 * The Buyer Agent.
 *
 * One orchestration path, in a fixed order, with the deterministic checks
 * placed where the model cannot route around them:
 *
 *   1. validate and bound the human's message
 *   2. extract a structured intent          (model, schema-constrained)
 *   3. verify the budget against their own words   (deterministic)
 *   4. LOCK the user's authority                    (deterministic)
 *   5. run a bounded tool loop over the catalog     (model + read-only tools)
 *   6. validate the model's proposal against observed catalog facts
 *   7. return a provider-neutral decision
 *
 * Step 4 is the hinge. Once the authority is locked, nothing later can widen
 * it: not a second model turn, not a tool result, not a merchant description,
 * not a retry. The budget the shopper stated is a value in a `const` from that
 * point on, and every candidate is measured against it by code the model has no
 * access to.
 *
 * The agent proposes. It creates no transaction, issues no quote, evaluates no
 * policy, reserves no stock and touches no payment provider — and it has no
 * tool that could.
 */
assertServerOnly("src/services/buyer-agent/buyer-agent-service.ts");

const log = createLogger({ category: "agent" });

/** Longest shopping request accepted. Bounds prompt cost and injection surface. */
export const MAX_REQUEST_LENGTH = 1_000;

/**
 * Maximum model turns in the tool loop.
 *
 * Small on purpose. A model that has not chosen after this many catalog
 * searches is not converging, and every extra turn is a live API call against a
 * free tier. Exceeding it is a controlled failure, never an open-ended retry.
 */
export const MAX_TOOL_ITERATIONS = 4;

/** Maximum attempts for a *transient* provider failure. */
export const MAX_PROVIDER_ATTEMPTS = 3;

/** Base backoff between provider attempts, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 250;

export interface BuyerAgentRequest {
  readonly message: string;
  /** Supplied by tests to make retry timing and ids deterministic. */
  readonly correlationId?: string;
}

export interface BuyerAgentDeps {
  readonly provider: AiProvider;
  readonly catalog: CatalogReader;
  /** Injected so retry tests do not sleep for real. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newCorrelationId?: () => string;
}

export function defaultBuyerAgentDeps(): BuyerAgentDeps {
  return { provider: defaultGeminiProvider(), catalog: createServiceCatalogReader() };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one provider call with a bounded retry policy.
 *
 * Only errors the taxonomy marks `retryable` are retried — timeouts, rate
 * limits, upstream 5xx. An auth failure and an invalid response are returned
 * immediately: retrying either cannot succeed, and doing it with backoff turns
 * a misconfiguration into an outage and burns a free-tier quota on it.
 *
 * Backoff is exponential with jitter, so several concurrent agent runs hitting
 * the same rate limit do not retry in lockstep.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  deps: BuyerAgentDeps,
  correlationId: string,
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = isAppError(error) && (error as AppError).retryable;
      if (!retryable || attempt === MAX_PROVIDER_ATTEMPTS) {
        throw error;
      }
      const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
      log.warn("ai provider attempt failed, retrying", {
        correlationId,
        attempt,
        code: (error as AppError).code,
      });
      await sleep(backoff + jitter);
    }
  }

  throw lastError;
}

/** Parses provider text as JSON, or fails with a typed error. */
function parseModelJson(text: string | null, correlationId: string): unknown {
  if (text === null || text.trim().length === 0) {
    throw new AiProviderInvalidResponseError("the response contained no output", {
      correlationId,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiProviderInvalidResponseError("the response was not valid JSON", {
      correlationId,
    });
  }
}

async function extractIntent(
  message: string,
  deps: BuyerAgentDeps,
  correlationId: string,
): Promise<StructuredPurchaseIntent> {
  const response = await withRetry(
    () =>
      deps.provider.generate({
        systemInstruction: INTENT_EXTRACTION_INSTRUCTION,
        userMessage: message,
        responseSchema: INTENT_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
        correlationId,
      }),
    deps,
    correlationId,
  );

  // Validated locally even though the provider was given the schema. Provider
  // enforcement is a convenience; this is the check.
  const parsed = structuredPurchaseIntentSchema.safeParse(
    parseModelJson(response.text, correlationId),
  );
  if (!parsed.success) {
    throw new AiProviderInvalidResponseError(
      `the intent did not match the schema (${parsed.error.issues[0]?.path.join(".") ?? "unknown field"})`,
      { correlationId },
    );
  }
  return parsed.data;
}

function toConstraints(
  intent: StructuredPurchaseIntent,
  authority: LockedUserAuthority,
): NormalizedUserConstraints {
  return {
    requestType: intent.requestType,
    quantity: authority.quantity,
    maxBudget:
      authority.maxAmountMinor === null || authority.currency === null
        ? null
        : {
            amountMinor: authority.maxAmountMinor.toString(),
            currency: authority.currency,
          },
    budgetScope: authority.budgetScope,
    hardRequirements: authority.hardRequirements,
    softPreferences: intent.softPreferences,
  };
}

/**
 * The bounded tool loop.
 *
 * Every catalog product the model is shown is recorded in `observed`. That map
 * is the provenance record: after the loop, a proposed product id is accepted
 * only if it is a key of this map. A model cannot select what it was never
 * shown, which makes a hallucinated id a rejected proposal rather than a
 * purchase of the wrong thing.
 */
interface ToolLoopOutcome {
  readonly text: string | null;
  readonly observed: ReadonlyMap<string, CatalogProductDto>;
  readonly toolCallCount: number;
}

async function runToolLoop(
  message: string,
  intent: StructuredPurchaseIntent,
  deps: BuyerAgentDeps,
  correlationId: string,
): Promise<ToolLoopOutcome> {
  const observed = new Map<string, CatalogProductDto>();
  let toolCallCount = 0;

  const userMessage = [
    `Shopper's request: ${message}`,
    `Structured intent: ${JSON.stringify(intent)}`,
  ].join("\n\n");

  let response = await withRetry(
    () =>
      deps.provider.generate({
        systemInstruction: PRODUCT_SELECTION_INSTRUCTION,
        userMessage,
        responseSchema: SELECTION_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
        tools: CATALOG_TOOL_DECLARATIONS,
        correlationId,
      }),
    deps,
    correlationId,
  );

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    if (response.toolCalls.length === 0) {
      return { text: response.text, observed, toolCallCount };
    }

    const results: AiToolResult[] = [];
    for (const call of response.toolCalls) {
      toolCallCount += 1;
      try {
        const execution = await executeCatalogTool(
          call.name,
          call.arguments,
          deps.catalog,
        );
        for (const product of execution.products) {
          observed.set(product.id, product);
        }
        results.push({ callId: call.id, name: call.name, content: execution.payload });
      } catch (error) {
        // A refused tool is reported back as a tool error, not thrown. The model
        // gets a chance to do something legitimate instead, and the run stays
        // bounded either way. Nothing was executed.
        if (
          error instanceof UnknownToolError ||
          error instanceof InvalidToolArgumentsError
        ) {
          log.warn("refused a model tool call", {
            correlationId,
            tool: call.name.slice(0, 64),
            code: error.code,
          });
          results.push({
            callId: call.id,
            name: call.name,
            content: { error: error.publicMessage },
            isError: true,
          });
          continue;
        }
        throw error;
      }
    }

    response = await withRetry(
      () =>
        deps.provider.continueWithToolResults({
          providerStateRef: response.providerStateRef,
          systemInstruction: PRODUCT_SELECTION_INSTRUCTION,
          toolResults: results,
          responseSchema: SELECTION_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
          tools: CATALOG_TOOL_DECLARATIONS,
          correlationId,
        }),
      deps,
      correlationId,
    );
  }

  if (response.toolCalls.length > 0) {
    throw new AiProviderToolLoopLimitError(MAX_TOOL_ITERATIONS, { correlationId });
  }
  return { text: response.text, observed, toolCallCount };
}

/**
 * Runs the Buyer Agent end to end.
 *
 * Returns a decision, or throws a typed error. It never returns a partially
 * validated result, and it never mutates anything: no transaction, no quote, no
 * reservation, no policy, no payment.
 */
export async function runBuyerAgent(
  request: BuyerAgentRequest,
  deps: BuyerAgentDeps = defaultBuyerAgentDeps(),
): Promise<BuyerAgentDecision> {
  const correlationId = request.correlationId ?? (deps.newCorrelationId ?? randomUUID)();
  const startedAt = Date.now();

  const message = request.message.trim();
  if (message.length === 0) {
    throw new InvalidBuyerRequestError("the request was empty");
  }
  if (message.length > MAX_REQUEST_LENGTH) {
    throw new InvalidBuyerRequestError(
      `the request exceeds ${String(MAX_REQUEST_LENGTH)} characters`,
    );
  }

  log.info("buyer agent started", {
    correlationId,
    provider: deps.provider.providerName,
    model: deps.provider.modelId,
    requestLength: message.length,
  });

  try {
    const intent = await extractIntent(message, deps, correlationId);

    // --- Lock the user's authority. Nothing after this may widen it. ---
    const budget =
      intent.budget === null ? null : verifyBudgetClaim(intent.budget, message);

    const ambiguousFields: ClarificationField[] = [];
    if (budget !== null && budget.kind === "REJECTED") {
      // A budget the server cannot verify is not a budget. Ask, never guess.
      ambiguousFields.push("budget");
    }
    // Budget scope. At quantity 1 'per unit' and 'total' are the same amount,
    // so nothing has to be decided. Above 1 they differ by a factor of the
    // quantity, and no downstream code can tell them apart from the number
    // alone - so an unstated scope is a question, not a default.
    const budgetScope =
      budget !== null && budget.kind === "VERIFIED"
        ? (intent.budget?.scope ?? (intent.quantity === 1 ? "PER_UNIT" : null))
        : null;

    if (
      budget !== null &&
      budget.kind === "VERIFIED" &&
      intent.quantity > 1 &&
      budgetScope === null
    ) {
      ambiguousFields.push("budget");
    }

    if (budget === null && messageStatesACeiling(message)) {
      // The model reported no budget for a message that plainly states one.
      // Proceeding would shop with no ceiling at all, which is the one failure
      // mode this agent must not have - so stop and ask instead.
      ambiguousFields.push("budget");
    }

    const authority: LockedUserAuthority = {
      maxAmountMinor:
        budget !== null && budget.kind === "VERIFIED" ? budget.maxAmountMinor : null,
      currency: budget !== null && budget.kind === "VERIFIED" ? budget.currency : null,
      budgetScope,
      quantity: intent.quantity,
      hardRequirements: intent.hardRequirements,
      category: intent.category,
    };
    const constraints = toConstraints(intent, authority);

    if (intent.needsClarification || ambiguousFields.length > 0) {
      if (intent.needsClarification) ambiguousFields.push("budget");
      const decision: BuyerAgentDecision = {
        kind: "NEEDS_CLARIFICATION",
        correlationId,
        clarificationQuestion:
          intent.clarificationQuestion ??
          "Could you tell me the maximum you would like to spend?",
        ambiguousFields: [...new Set(ambiguousFields)],
        constraints,
      };
      log.info("buyer agent finished", {
        correlationId,
        result: decision.kind,
        durationMs: Date.now() - startedAt,
      });
      return decision;
    }

    // --- Catalog exploration, bounded. ---
    const loop = await runToolLoop(message, intent, deps, correlationId);

    const parsedSelection = modelSelectionSchema.safeParse(
      parseModelJson(loop.text, correlationId),
    );
    if (!parsedSelection.success) {
      throw new AiProviderInvalidResponseError(
        `the selection did not match the schema (${parsedSelection.error.issues[0]?.path.join(".") ?? "unknown field"})`,
        { correlationId },
      );
    }
    const selection = parsedSelection.data;

    const observedList = [...loop.observed.values()];

    if (selection.outcome === "CLARIFY") {
      const decision: BuyerAgentDecision = {
        kind: "NEEDS_CLARIFICATION",
        correlationId,
        clarificationQuestion:
          selection.clarificationQuestion ??
          "Could you tell me a little more about what you need?",
        ambiguousFields: ["product"],
        constraints,
      };
      log.info("buyer agent finished", {
        correlationId,
        result: decision.kind,
        toolCalls: loop.toolCallCount,
        durationMs: Date.now() - startedAt,
      });
      return decision;
    }

    if (selection.outcome === "NO_MATCH" || selection.selectedProductId === null) {
      const derived = deriveNoMatchReasons(observedList, authority);
      const decision: BuyerAgentDecision = {
        kind: "NO_MATCH",
        correlationId,
        // The server's reasons lead: they are checkable against the catalog.
        reasonCodes: [...new Set([...derived, ...selection.noMatchReasonCodes])],
        summary: selection.summary,
        constraints,
      };
      log.info("buyer agent finished", {
        correlationId,
        result: decision.kind,
        toolCalls: loop.toolCallCount,
        durationMs: Date.now() - startedAt,
      });
      return decision;
    }

    // --- The deterministic gate. ---
    const validation = validateSelection(
      selection.selectedProductId,
      selection.quantity ?? intent.quantity,
      authority,
      loop.observed,
    );
    if (validation.kind === "REJECTED") {
      // Never repaired. A financial proposal that fails validation is discarded.
      throw new InvalidModelSelectionError(validation.reason, {
        correlationId,
        reasonCode: validation.reasonCode,
      });
    }

    const decision: BuyerAgentDecision = {
      kind: "PRODUCT_SELECTED",
      correlationId,
      selectedProductId: validation.product.id,
      quantity: authority.quantity,
      // Server-verified codes first, then the model's, deduplicated.
      reasonCodes: [...new Set([...validation.reasonCodes, ...selection.reasonCodes])],
      summary: selection.summary,
      constraints,
      observedProduct: {
        productId: validation.product.id,
        name: validation.product.name,
        amount: validation.product.amount,
        availableQuantity: validation.product.availability.quantity,
        version: validation.product.version,
        updatedAt: validation.product.updatedAt,
      },
    };

    log.info("buyer agent finished", {
      correlationId,
      result: decision.kind,
      toolCalls: loop.toolCallCount,
      durationMs: Date.now() - startedAt,
    });
    return decision;
  } catch (error) {
    log.error("buyer agent failed", {
      correlationId,
      code: isAppError(error) ? (error as AppError).code : "UNEXPECTED_ERROR",
      // A closed, safe code naming *which* deterministic check failed - never
      // the model's text, a prompt, or a catalog payload. Present only on
      // AI_INVALID_SELECTION today; absent (never fabricated) for every other
      // error. Without this, that one code told an operator nothing beyond
      // "the model proposed something the server refused" - identical for a
      // hallucinated id, an over-budget pick, and an unmet requirement.
      ...(isAppError(error) && typeof error.details["reasonCode"] === "string"
        ? { reasonCode: error.details["reasonCode"] }
        : {}),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
