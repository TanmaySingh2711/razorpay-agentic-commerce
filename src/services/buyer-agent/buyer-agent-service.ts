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
  AiProviderRequestBudgetExceededError,
  AiProviderTimeoutError,
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
import {
  defaultGeminiProvider,
  GEMINI_TIMEOUT_MS,
} from "@/integrations/llm/gemini-provider";
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
const RETRY_BASE_DELAY_MS = 250;

/**
 * The whole request's wall-clock budget, shared across every provider call -
 * intent extraction, every tool-loop turn, and every continuation alike.
 *
 * This is what was missing when a production request timed out twice (60s of
 * Gemini alone) and was then simply never heard from again: three retries of
 * a `GEMINI_TIMEOUT_MS` call is already up to 90 seconds for *one* provider
 * call, and the tool loop can make up to `MAX_TOOL_ITERATIONS + 1` such calls
 * - a worst case with no ceiling of its own, that this application's own
 * `maxDuration` (set on the page and route that invoke this agent) would
 * eventually meet first. When that happens the platform kills the function
 * outright: no error reaches this code, nothing is logged, and the caller
 * sees a dropped connection instead of a classified failure.
 *
 * A first fix bounded this with an `AbortSignal` alone, trusting the provider
 * to honour it promptly. A production request still hit the platform's 60s
 * kill after that fix shipped: aborting a request and *waiting for the
 * provider to notice* are two different guarantees, and nothing enforced the
 * second one - if the SDK's own cancellation plumbing is slow, buffered
 * behind an internal retry, or simply does not propagate the way this file
 * assumed, the abort is real but `await`ing its effect is not bounded on its
 * own. `withAttemptBudget` now races the operation against its own timer
 * regardless of whether the provider ever notices the abort, so this budget
 * is enforced by this process, not requested of a dependency.
 *
 * Sized with substantial margin below `maxDuration` (60s - a deliberate
 * application-level cap this project chose, not an assumed hosting limit):
 * about 18 seconds of headroom for error translation, the Server Action's own
 * catch, RSC serialisation and response delivery, none of which this budget
 * itself accounts for. `withRetry` checks it before every attempt (not only
 * between them, so it also covers time already spent by an earlier stage of
 * the same request) and shrinks a retry's own allowance to whatever remains
 * rather than requiring the full `GEMINI_TIMEOUT_MS` every time.
 */
export const OVERALL_REQUEST_BUDGET_MS = 42_000;

/**
 * The least time an attempt needs left in the budget to be worth starting.
 *
 * Below this, a call is more likely to be cut off mid-flight than to finish,
 * so refusing outright and returning a clean, classified error is the more
 * honest answer than spending the wait anyway. Chosen as a plausible fast
 * success - most Gemini calls that succeed at all do so in a few seconds -
 * not as a fraction of `GEMINI_TIMEOUT_MS`: this is a floor on "is trying at
 * all worthwhile", a different question from "how long may this attempt run".
 */
export const MIN_ATTEMPT_BUDGET_MS = 5_000;

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
 * Runs `operation` under an attempt's own budget - enforced by this process,
 * never merely requested of the provider.
 *
 * Two things happen when `budgetMs` elapses, and only the first is a
 * courtesy:
 *
 *  1. `operation`'s own `AbortSignal` is aborted - the cooperative path, and
 *     the one that actually cancels a well-behaved provider's real network
 *     request (`AiGenerationRequest.abortSignal` /
 *     `AiToolResponseRequest.abortSignal`), so quota stops being spent and
 *     the connection is released.
 *  2. This function settles anyway, immediately, whether or not that abort
 *     was ever honoured.
 *
 * That second half is load-bearing, and its absence is exactly what let a
 * production request run past this budget and into the hosting platform's
 * own 60-second kill: a version of this function that only aborted and then
 * `await`ed `operation()` directly was betting the whole request's execution
 * time on the provider noticing the signal promptly. Nothing in the
 * `AbortSignal` contract guarantees that - a slow SDK, a proxy that buffers
 * the underlying connection, or an internal retry the abort does not reach
 * are all real ways for a provider to keep running regardless of being told
 * to stop. This budget must hold even against a provider that ignores
 * cancellation entirely, so it is enforced by a second, independent
 * mechanism rather than requested once and trusted.
 *
 * The abandoned operation, if it settles later, is never used: a stale
 * response is discarded (the Buyer Agent is read-only, so nothing it could
 * still do would mutate anything), and a stale rejection is swallowed rather
 * than left an unhandled promise rejection - both handled by the no-op
 * `.then` attached once this function has already returned.
 *
 * Real `setTimeout`, never the injected `sleep` - that hook exists to skip
 * *backoff* waiting in tests and answers a different question (how long
 * between attempts), not this one (how long is this attempt itself allowed to
 * run). A test that needs this to fire deterministically uses
 * `vi.useFakeTimers()` and drives it with `vi.advanceTimersByTimeAsync()`.
 */
function withAttemptBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  budgetMs: number,
  correlationId: string,
): Promise<T> {
  const controller = new AbortController();
  const attempt = operation(controller.signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn("ai provider attempt aborted, attempt budget elapsed", {
        correlationId,
        budgetMs,
      });
      // 1. Ask the provider to stop. Best-effort; not trusted.
      controller.abort();
      // 2. Settle this attempt right now regardless. The budget is a hard
      //    ceiling on this attempt, not a request the provider may decline.
      reject(new AiProviderTimeoutError({ correlationId, attemptBudgetMs: budgetMs }));
      // 3. Whatever the abandoned operation eventually does - resolve,
      //    reject, or never settle at all - must never surface here and must
      //    never become an unhandled rejection.
      attempt.then(
        () => {},
        () => {},
      );
    }, budgetMs);

    attempt.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

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
 *
 * `deadlineAt` is the second bound, checked *before* every attempt, including
 * the first of this call: a request that arrives here having already spent
 * most of its budget on an earlier stage must refuse just as readily as one
 * that has spent it all on this stage's own retries. Below
 * `MIN_ATTEMPT_BUDGET_MS` remaining, refusing outright -
 * `AiProviderRequestBudgetExceededError`, never silence - is the honest
 * answer.
 *
 * Between those two floors, an attempt's own allowed duration is
 * `min(GEMINI_TIMEOUT_MS, remaining)`, not always the full
 * `GEMINI_TIMEOUT_MS`. This is deliberate: requiring a full, untouched
 * `GEMINI_TIMEOUT_MS` of remaining budget before ever allowing a retry meant
 * that one genuine full-length timeout - the single most common transient
 * failure this policy exists to survive - left too little of a 50-second
 * budget for a second attempt to ever legally start, so the "bounded retry"
 * a timeout is marked eligible for never actually happened. Capping the
 * *retry's* window to whatever remains instead gives it a real, if shorter,
 * chance - the first attempt of any call still gets the full
 * `GEMINI_TIMEOUT_MS`, unchanged, so ordinary single-attempt reliability is
 * untouched; only a retry's own ceiling shrinks, and only when the budget
 * genuinely demands it. Every attempt, including the first, runs under
 * `withAttemptBudget`, so that ceiling is always backed by a real abort, not
 * only the provider's own configured worst case.
 */
async function withRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deps: BuyerAgentDeps,
  correlationId: string,
  deadlineAt: number,
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < MIN_ATTEMPT_BUDGET_MS) {
      log.warn("ai provider attempt skipped, request budget exhausted", {
        correlationId,
        attempt,
        remainingMs: Math.max(0, remainingMs),
      });
      throw new AiProviderRequestBudgetExceededError({
        correlationId,
        attempt,
        ...(isAppError(lastError) ? { lastErrorCode: (lastError as AppError).code } : {}),
      });
    }
    const attemptBudgetMs = Math.min(GEMINI_TIMEOUT_MS, remainingMs);
    log.info("ai provider attempt started", { correlationId, attempt, attemptBudgetMs });

    try {
      return await withAttemptBudget(operation, attemptBudgetMs, correlationId);
    } catch (error) {
      lastError = error;
      const retryable = isAppError(error) && (error as AppError).retryable;
      if (!retryable || attempt === MAX_PROVIDER_ATTEMPTS) {
        throw error;
      }
      const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
      // Capped to whatever budget remains: backing off is only ever meant to
      // space attempts out, never to spend time the request does not have.
      // The next iteration's own check refuses cleanly either way, but a
      // request that already knows it has nothing left must not additionally
      // sleep through the time it would have used to say so.
      const cappedBackoff = Math.max(
        0,
        Math.min(backoff + jitter, deadlineAt - Date.now()),
      );
      log.warn("ai provider attempt failed, retrying", {
        correlationId,
        attempt,
        code: (error as AppError).code,
        backoffMs: cappedBackoff,
      });
      if (cappedBackoff > 0) {
        await sleep(cappedBackoff);
      }
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
  deadlineAt: number,
): Promise<StructuredPurchaseIntent> {
  const response = await withRetry(
    (signal) =>
      deps.provider.generate({
        systemInstruction: INTENT_EXTRACTION_INSTRUCTION,
        userMessage: message,
        responseSchema: INTENT_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
        correlationId,
        abortSignal: signal,
      }),
    deps,
    correlationId,
    deadlineAt,
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
  deadlineAt: number,
): Promise<ToolLoopOutcome> {
  const observed = new Map<string, CatalogProductDto>();
  let toolCallCount = 0;

  const userMessage = [
    `Shopper's request: ${message}`,
    `Structured intent: ${JSON.stringify(intent)}`,
  ].join("\n\n");

  let response = await withRetry(
    (signal) =>
      deps.provider.generate({
        systemInstruction: PRODUCT_SELECTION_INSTRUCTION,
        userMessage,
        responseSchema: SELECTION_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
        tools: CATALOG_TOOL_DECLARATIONS,
        correlationId,
        abortSignal: signal,
      }),
    deps,
    correlationId,
    deadlineAt,
  );

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    if (response.toolCalls.length === 0) {
      return { text: response.text, observed, toolCallCount };
    }

    // Checked before spending any time executing tools, not only before the
    // next provider call: a budget already too low for another provider call
    // is too low for the continuation those tools exist to feed, so nothing
    // is gained by running them first and refusing afterward.
    if (deadlineAt - Date.now() < MIN_ATTEMPT_BUDGET_MS) {
      log.warn("tool execution skipped, request budget exhausted", { correlationId });
      throw new AiProviderRequestBudgetExceededError({
        correlationId,
        stage: "tool_execution",
      });
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
      (signal) =>
        deps.provider.continueWithToolResults({
          providerStateRef: response.providerStateRef,
          systemInstruction: PRODUCT_SELECTION_INSTRUCTION,
          toolResults: results,
          responseSchema: SELECTION_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
          tools: CATALOG_TOOL_DECLARATIONS,
          correlationId,
          abortSignal: signal,
        }),
      deps,
      correlationId,
      deadlineAt,
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
  // One deadline for the whole run, shared by every provider call this request
  // makes - intent extraction and every tool-loop turn alike. See
  // `OVERALL_REQUEST_BUDGET_MS`.
  const deadlineAt = startedAt + OVERALL_REQUEST_BUDGET_MS;

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
    overallBudgetMs: OVERALL_REQUEST_BUDGET_MS,
  });

  try {
    const intent = await extractIntent(message, deps, correlationId, deadlineAt);

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
    const loop = await runToolLoop(message, intent, deps, correlationId, deadlineAt);

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
