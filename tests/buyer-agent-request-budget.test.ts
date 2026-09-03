import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROVIDER_ATTEMPTS,
  MIN_ATTEMPT_BUDGET_MS,
  OVERALL_REQUEST_BUDGET_MS,
  runBuyerAgent,
  type BuyerAgentDeps,
} from "@/services/buyer-agent/buyer-agent-service";
import { GEMINI_TIMEOUT_MS } from "@/integrations/llm/gemini-provider";
import {
  AiProviderRateLimitedError,
  AiProviderRequestBudgetExceededError,
  AiProviderTimeoutError,
} from "@/domain/buyer-agent/errors";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
import {
  createFakeAiProvider,
  createInMemoryCatalogReader,
  intentJson,
  productDto,
  selectionJson,
} from "./support/fake-ai-provider";

/**
 * The request's own execution budget - and, separately, that a shortened
 * attempt genuinely cancels the provider call it bounds, rather than merely
 * declining to wait for it.
 *
 * This reproduces, and fixes, two live production defects in the same area.
 * First: two successive 30-second Gemini timeouts left a request running for
 * about a minute with no classified error ever reaching the caller - nothing
 * bounded the retry policy's own worst case against this application's
 * `maxDuration` cap. Second, once that was fixed with a deadline check: the
 * fix used `Promise.race` to give a retry a shorter window, which stops this
 * code from *waiting* on a slow call past its budget but does nothing to the
 * call itself - the real Gemini request kept running in the background,
 * still spending quota, still holding its connection open, for as long as it
 * pleased. `withAttemptBudget` now threads a real `AbortController` into the
 * provider call instead (`AiGenerationRequest.abortSignal` /
 * `AiToolResponseRequest.abortSignal`), and the shared fake provider honours
 * it exactly as a real cancelled fetch would, so the tests below can tell the
 * difference: a capped attempt's underlying call is provably stopped at the
 * cap, not merely ignored past it.
 *
 * Every test here uses `vi.useFakeTimers()`. Turns that specify `elapsedMs`
 * are driven forward with `vi.advanceTimersByTimeAsync()`, which - unlike the
 * synchronous form - flushes microtasks between timer firings, so a promise
 * chain that schedules a further timer as a reaction to an earlier one (a
 * retry's own attempt timer, in particular) is still picked up within one
 * advance. No real Gemini call, no real wait, and no flakiness from actual
 * timing.
 */

const MESSAGE = "Find me the best mechanical keyboard under ₹3000 and buy it.";

/** Comfortably covers every scenario below (well past the 50s budget). */
const ADVANCE_MS = 70_000;

const PRODUCT = productDto({
  id: "01930000-0000-7000-8000-00000000b001",
  amount: { amountMinor: "279900", currency: "INR" },
});

function deps(
  turns: Parameters<typeof createFakeAiProvider>[0]["turns"],
): BuyerAgentDeps & { provider: ReturnType<typeof createFakeAiProvider> } {
  const provider = createFakeAiProvider({ turns });
  return {
    provider,
    catalog: createInMemoryCatalogReader([PRODUCT]),
    // Backoff itself is not the thing under test, and it is milliseconds
    // against a budget measured in tens of seconds - resolving it instantly
    // keeps these tests about the deadline, not about jitter.
    sleep: () => Promise.resolve(),
  };
}

type Settled =
  | { readonly ok: true; readonly value: BuyerAgentDecision; readonly settledAt: number }
  | { readonly ok: false; readonly error: unknown; readonly settledAt: number };

/**
 * Runs the agent and advances fake time until it settles, capturing exactly
 * when that happened.
 *
 * The `.then` is attached synchronously, before any time is advanced, so the
 * promise is never briefly "unhandled" - and `settledAt` is read inside that
 * handler, at the instant the real settlement happened, rather than after
 * `ADVANCE_MS` has unconditionally elapsed (which would make every test's
 * elapsed-time reading the same fixed number regardless of what actually
 * stopped the request).
 */
async function runAndSettle(d: BuyerAgentDeps): Promise<Settled> {
  const settled = runBuyerAgent({ message: MESSAGE }, d).then(
    (value): Settled => ({ ok: true, value, settledAt: Date.now() }),
    (error: unknown): Settled => ({ ok: false, error, settledAt: Date.now() }),
  );
  await vi.advanceTimersByTimeAsync(ADVANCE_MS);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the chosen arithmetic", () => {
  it("leaves a real, if shorter, retry window after one timeout - and never room for a third", () => {
    // The design invariant every other test in this file exercises
    // behaviourally. Guards against a future change to one constant quietly
    // breaking the relationship between the other two.
    const remainingAfterOneTimeout = OVERALL_REQUEST_BUDGET_MS - GEMINI_TIMEOUT_MS;

    // A retry after one full-length timeout is always worth attempting...
    expect(remainingAfterOneTimeout).toBeGreaterThanOrEqual(MIN_ATTEMPT_BUDGET_MS);
    // ...but never gets the full per-attempt allowance a first attempt does -
    // it is a genuinely shorter, capped chance, not a second full one.
    expect(remainingAfterOneTimeout).toBeLessThan(GEMINI_TIMEOUT_MS);
  });
});

describe("cancellation: a shortened attempt actually aborts the provider call", () => {
  it("genuinely aborts a capped retry at its shrunk budget, not at the full GEMINI_TIMEOUT_MS", async () => {
    // Attempt 1: a full 30s timeout, consuming 30s of the 50s budget.
    // Attempt 2 is still allowed - 20s remains - but is capped to that 20s.
    // Its scripted turn would take 25s to answer if left uninterrupted: more
    // than the correct 20s cap, but less than the full 30s GEMINI_TIMEOUT_MS.
    // If the cap were not genuinely enforced (the old Promise.race bug, or a
    // regression back to always using the full 30s), this turn would still
    // "answer" successfully at 25s. Correctly capped, it must never get the
    // chance: the attempt is aborted at 20s, and the turn's own timer is
    // cancelled, never firing at all.
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { text: intentJson(), elapsedMs: 25_000 },
    ]);

    const result = await runAndSettle(d);

    // Never a success built from the "aborted" turn's answer, and never a
    // hang - a clean, classified refusal once the budget is spent.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    // Exactly two real attempts. The would-be-successful 25s turn was never
    // allowed to complete, and no third attempt ever started.
    expect(d.provider.callCount()).toBe(2);
    // No timer - the cancelled turn's own, or anything else - is left
    // pending. Nothing was left dangling after the request finished.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort an attempt that answers within its own budget", async () => {
    // The other half of the same guarantee: cancellation must not be
    // trigger-happy. A retry given 20s of remaining budget, answering in 5s,
    // must succeed - proving the abort fires only when genuinely earned, not
    // merely because a retry's window is shorter than a first attempt's.
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { text: intentJson(), elapsedMs: 5_000 },
      { toolCalls: [{ name: "search_catalog", args: {} }] },
      { text: selectionJson({ selectedProductId: PRODUCT.id }) },
    ]);

    const result = await runAndSettle(d);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("PRODUCT_SELECTED");
    expect(d.provider.callCount()).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the overall request deadline", () => {
  it("still gives the first attempt of any call up to the full GEMINI_TIMEOUT_MS", async () => {
    // 29s, just under the ceiling: proves the first attempt is not cut short
    // by some smaller, mistaken budget.
    const d = deps([
      { text: intentJson(), elapsedMs: 29_000 },
      { toolCalls: [{ name: "search_catalog", args: {} }] },
      { text: selectionJson({ selectedProductId: PRODUCT.id }) },
    ]);

    const result = await runAndSettle(d);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("PRODUCT_SELECTED");
    expect(d.provider.callCount()).toBe(3);
  });

  it("refuses a third attempt once two real attempts have spent the budget below what a third needs", async () => {
    // Attempt 1: a full GEMINI_TIMEOUT_MS timeout (30s of the 50s budget).
    // Attempt 2: still allowed - 20s remained - and it also times out on its
    // own account, within its own narrower window (19s of it). What is left
    // (1s) is under MIN_ATTEMPT_BUDGET_MS, so a third attempt is refused
    // before it starts.
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { error: new AiProviderTimeoutError(), elapsedMs: 19_000 },
    ]);

    const result = await runAndSettle(d);

    // A clean, classified refusal - never a hang, never a third real attempt,
    // never silence.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    // Exactly the two real attempts arithmetic says are meaningful here - the
    // count-based bound (MAX_PROVIDER_ATTEMPTS = 3) would have allowed a
    // third; the deadline is what actually stopped it.
    expect(d.provider.callCount()).toBe(2);
    expect(d.provider.callCount()).toBeLessThan(MAX_PROVIDER_ATTEMPTS);
  });

  it("never lets total provider time exceed the request's own budget", async () => {
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { error: new AiProviderTimeoutError(), elapsedMs: 19_000 },
    ]);
    const startedAt = Date.now();

    const result = await runAndSettle(d);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    // Read at the moment the request actually settled, not after this test's
    // own generous timer advance - which always elapses in full regardless of
    // when (or whether) the promise it was driving had already resolved.
    expect(result.settledAt - startedAt).toBeLessThan(OVERALL_REQUEST_BUDGET_MS);
  });

  it("bounds the deadline across every stage, not per provider call", async () => {
    // Intent extraction succeeds close to its own ceiling (29s), and the tool
    // loop's first call also succeeds close to what then remains (20s of the
    // 21s left) - both genuine successes, no error scripted anywhere. That
    // leaves 1s, under MIN_ATTEMPT_BUDGET_MS, by the time the loop needs a
    // *second*, distinct withRetry call (continueWithToolResults, after the
    // tool executes) to continue the same conversation. That call must
    // refuse before it ever reaches the provider: the deadline is one budget
    // for the whole request, not a fresh one per stage or per call.
    const d = deps([
      { text: intentJson(), elapsedMs: 29_000 },
      { toolCalls: [{ name: "search_catalog", args: {} }], elapsedMs: 20_000 },
      // Never reached: continueWithToolResults finds under
      // MIN_ATTEMPT_BUDGET_MS remaining and refuses before this turn is
      // consumed.
      { text: selectionJson({ selectedProductId: PRODUCT.id }) },
    ]);

    const result = await runAndSettle(d);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    // Exactly two provider calls: intent extraction, then the tool loop's
    // first search. The continuation call never happened.
    expect(d.provider.callCount()).toBe(2);
  });

  it("still bounds retries by count when the budget is not the constraint", async () => {
    // A fast, non-timeout transient failure repeated past MAX_PROVIDER_ATTEMPTS
    // barely touches the budget at all - the count-based bound is what stops
    // this, exactly as before this fix, and the deadline is not why it gives
    // up. No elapsed time is scripted, so this settles on its own without
    // needing a timer advance at all.
    const d = deps([{ error: new AiProviderRateLimitedError() }]);

    await expect(runBuyerAgent({ message: MESSAGE }, d)).rejects.toBeInstanceOf(
      AiProviderRateLimitedError,
    );
    expect(d.provider.callCount()).toBe(MAX_PROVIDER_ATTEMPTS);
  });
});
