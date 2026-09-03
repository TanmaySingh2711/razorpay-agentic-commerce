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
import type {
  AiGenerationRequest,
  AiGenerationResponse,
  AiProvider,
  AiToolResponseRequest,
} from "@/integrations/llm/provider";
import {
  createFakeAiProvider,
  createInMemoryCatalogReader,
  intentJson,
  productDto,
  selectionJson,
} from "./support/fake-ai-provider";

/**
 * The request's own execution budget - and, separately, that it holds even
 * against a provider that does not cooperate with cancellation at all.
 *
 * This reproduces, and fixes, two live production defects in the same area,
 * discovered in sequence.
 *
 * First: two successive 30-second Gemini timeouts left a request running for
 * about a minute with no classified error ever reaching the caller - nothing
 * bounded the retry policy's own worst case against this application's
 * `maxDuration` cap.
 *
 * Second, once that was fixed with a deadline check backed by an
 * `AbortSignal`: a production request *still* ran into Vercel's 60-second
 * kill. `withAttemptBudget` aborted the provider's signal and then `await`ed
 * `operation()` directly - a bet that the provider would notice the abort and
 * settle promptly. Nothing enforced that promptness. Whatever the exact
 * reason inside the SDK's cancellation plumbing, the fix cannot depend on
 * proving one: the budget must hold even against a provider that ignores
 * `AbortSignal` entirely and never settles. `withAttemptBudget` now races the
 * operation against its own independent timer regardless of what the
 * provider does, so this file's decisive test - `neverSettlingProvider`,
 * which does not even read the signal it is given - is what actually proves
 * the fix, not merely a cooperative fake that happens to behave.
 *
 * Every test here uses `vi.useFakeTimers()`. Turns or operations that take
 * simulated time are driven forward with `vi.advanceTimersByTimeAsync()`,
 * which - unlike the synchronous form - flushes microtasks between timer
 * firings, so a promise chain that schedules a further timer as a reaction to
 * an earlier one (a retry's own attempt timer, in particular) is still picked
 * up within one advance. No real Gemini call, no real wait, and no flakiness
 * from actual timing.
 */

const MESSAGE = "Find me the best mechanical keyboard under ₹3000 and buy it.";

/** Comfortably covers every scenario below (well past the 42s budget). */
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

/**
 * A provider that never answers and never looks at the signal it is given.
 *
 * The point of this file. A fake that honours `AbortSignal` (the shared
 * `createFakeAiProvider`) can only ever prove that *cooperative* cancellation
 * works - which is necessary, but is exactly the property the previous,
 * still-broken fix already believed it had. This one models the failure mode
 * that actually reached production: whatever the reason, the call simply
 * keeps running. `withAttemptBudget`'s own independent timer is the only
 * thing that can end a request built on this.
 */
function neverSettlingProvider(): AiProvider & {
  readonly callCount: () => number;
  readonly signalsSeen: readonly AbortSignal[];
} {
  let calls = 0;
  const signalsSeen: AbortSignal[] = [];
  const hang = (
    request: AiGenerationRequest | AiToolResponseRequest,
  ): Promise<AiGenerationResponse> => {
    calls += 1;
    if (request.abortSignal !== undefined) signalsSeen.push(request.abortSignal);
    // Never resolves, never rejects, never listens for abort. The worst case.
    return new Promise<AiGenerationResponse>(() => {});
  };
  return {
    providerName: "non-cooperative",
    modelId: "non-cooperative-model",
    generate: hang,
    continueWithToolResults: hang,
    callCount: () => calls,
    signalsSeen,
  };
}

/**
 * A provider that honours the abort, but only after a delay - modelling an
 * SDK whose cancellation plumbing is real but slow, rather than absent.
 */
function delayedAbortProvider(replyDelayAfterAbortMs: number): AiProvider & {
  readonly callCount: () => number;
} {
  let calls = 0;
  const op = (
    request: AiGenerationRequest | AiToolResponseRequest,
  ): Promise<AiGenerationResponse> => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      request.abortSignal?.addEventListener(
        "abort",
        () => {
          setTimeout(() => {
            reject(new Error("late rejection, long after the abort fired"));
          }, replyDelayAfterAbortMs);
        },
        { once: true },
      );
    });
  };
  return {
    providerName: "delayed-abort",
    modelId: "delayed-abort-model",
    generate: op,
    continueWithToolResults: op,
    callCount: () => calls,
  };
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

describe("a non-cooperative provider cannot keep the request alive", () => {
  it("settles within the configured budget even though the provider never answers and ignores AbortSignal", async () => {
    const provider = neverSettlingProvider();
    const d: BuyerAgentDeps = {
      provider,
      catalog: createInMemoryCatalogReader([PRODUCT]),
      sleep: () => Promise.resolve(),
    };
    const startedAt = Date.now();

    const result = await runAndSettle(d);

    // A clean, classified refusal - never a hang, and never dependent on the
    // provider ever noticing it was told to stop.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    // Never *exceeds* the application budget - this is the maximally
    // adversarial case (every attempt burns its full allowance and never
    // answers), so it lands exactly on the boundary rather than under it,
    // and nowhere near the 60s platform kill this fixes.
    expect(result.settledAt - startedAt).toBeLessThanOrEqual(OVERALL_REQUEST_BUDGET_MS);
    // Exactly two real attempts fit this arithmetic (a full 30s, then the 12s
    // that remains); a third is refused before ever calling the provider.
    expect(provider.callCount()).toBe(2);
    expect(provider.callCount()).toBeLessThan(MAX_PROVIDER_ATTEMPTS);
  });

  it("aborts the active request's signal even though the provider never reads it", async () => {
    const provider = neverSettlingProvider();
    const d: BuyerAgentDeps = {
      provider,
      catalog: createInMemoryCatalogReader([PRODUCT]),
      sleep: () => Promise.resolve(),
    };

    await runAndSettle(d);

    expect(provider.signalsSeen.length).toBeGreaterThan(0);
    // Every signal handed to the provider was genuinely aborted - not merely
    // stopped being awaited.
    for (const signal of provider.signalsSeen) {
      expect(signal.aborted).toBe(true);
    }
  });

  it("safely consumes a rejection from an already-abandoned attempt", async () => {
    // The provider's cancellation is real, just slow - it rejects 10s after
    // the abort it was sent, well after this attempt's own 30s budget (and
    // this application's 42s overall budget) already forced a decision.
    // Nothing may treat that late rejection as live, and it must never
    // surface as an unhandled promise rejection.
    const seenUnhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seenUnhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const provider = delayedAbortProvider(10_000);
      const d: BuyerAgentDeps = {
        provider,
        catalog: createInMemoryCatalogReader([PRODUCT]),
        sleep: () => Promise.resolve(),
      };

      const result = await runAndSettle(d);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);

      // Let every abandoned attempt's delayed rejection actually fire - the
      // test's own fake-timer advance already ran past them, but Node still
      // needs a microtask turn to notice a promise settling.
      await Promise.resolve();
      await Promise.resolve();

      expect(seenUnhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("cancellation: a shortened attempt actually aborts the provider call", () => {
  it("genuinely aborts a capped retry at its shrunk budget, not at the full GEMINI_TIMEOUT_MS", async () => {
    // Attempt 1: a full 30s timeout, consuming 30s of the 42s budget.
    // Attempt 2 is still allowed - 12s remains - but is capped to that 12s.
    // Its scripted turn would take 20s to answer if left uninterrupted: more
    // than the correct 12s cap, but less than the full 30s GEMINI_TIMEOUT_MS.
    // If the cap were not genuinely enforced, this turn would still "answer"
    // successfully at 20s. Correctly capped, it must never get the chance.
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { text: intentJson(), elapsedMs: 20_000 },
    ]);

    const result = await runAndSettle(d);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    expect(d.provider.callCount()).toBe(2);
    // No timer - the cancelled turn's own, or anything else - is left
    // pending. Nothing was left dangling after the request finished.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort an attempt that answers within its own budget", async () => {
    // The other half of the same guarantee: cancellation must not be
    // trigger-happy. A retry given 12s of remaining budget, answering in 5s,
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
    // Attempt 1: a full GEMINI_TIMEOUT_MS timeout (30s of the 42s budget).
    // Attempt 2: still allowed - 12s remained - and it also times out on its
    // own account, within its own narrower window (11s of it). What is left
    // (1s) is under MIN_ATTEMPT_BUDGET_MS, so a third attempt is refused
    // before it starts.
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { error: new AiProviderTimeoutError(), elapsedMs: 11_000 },
    ]);

    const result = await runAndSettle(d);

    // A clean, classified refusal - never a hang, never a third real attempt,
    // never silence.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    expect(d.provider.callCount()).toBe(2);
    expect(d.provider.callCount()).toBeLessThan(MAX_PROVIDER_ATTEMPTS);
  });

  it("never lets total provider time exceed the request's own budget", async () => {
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { error: new AiProviderTimeoutError(), elapsedMs: 11_000 },
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
    // Intent extraction needs a retry to succeed - one full 30s timeout, then
    // an 11s answer - consuming 41s of the 42s budget between them. What
    // remains (1s) is under MIN_ATTEMPT_BUDGET_MS, so the tool loop's first
    // call - a distinct withRetry invocation, for a different provider method
    // - must refuse before it is ever attempted: the deadline is one budget
    // for the whole request, not a fresh one per stage.
    const d = deps([
      { error: new AiProviderTimeoutError(), elapsedMs: GEMINI_TIMEOUT_MS },
      { text: intentJson(), elapsedMs: 11_000 },
      // Never reached: the tool loop's own first call finds under
      // MIN_ATTEMPT_BUDGET_MS remaining and refuses before this turn is
      // consumed.
      { toolCalls: [{ name: "search_catalog", args: {} }] },
    ]);

    const result = await runAndSettle(d);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    // Exactly two provider calls: the timeout, then the retry that answered.
    // The tool loop's own call never happened.
    expect(d.provider.callCount()).toBe(2);
  });

  it("skips tool execution entirely once the budget is already exhausted, rather than running tools first", async () => {
    // Intent extraction and the first search both succeed, consuming enough
    // of the budget (29s + 12s of a 42s budget) that under
    // MIN_ATTEMPT_BUDGET_MS remains by the time the model asks to search
    // again. The second search must never execute - checked before spending
    // any time on tools, not only before the next provider call.
    const d = deps([
      { text: intentJson(), elapsedMs: 29_000 },
      { toolCalls: [{ name: "search_catalog", args: {} }], elapsedMs: 12_000 },
    ]);

    const result = await runAndSettle(d);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiProviderRequestBudgetExceededError);
    // Only the two provider calls happened; no continuation was ever
    // attempted, because the loop refused before even executing the tool
    // that would have fed one.
    expect(d.provider.callCount()).toBe(2);
  });

  it("does not sleep past the deadline: backoff is capped to whatever remains", async () => {
    const sleepCalls: number[] = [];
    const provider = createFakeAiProvider({
      turns: [
        { error: new AiProviderRateLimitedError(), elapsedMs: GEMINI_TIMEOUT_MS },
        { error: new AiProviderRateLimitedError(), elapsedMs: 11_500 },
      ],
    });
    const d: BuyerAgentDeps = {
      provider,
      catalog: createInMemoryCatalogReader([PRODUCT]),
      sleep: (ms: number) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    };

    await runAndSettle(d);

    // The backoff before the (never-started) third attempt must not have
    // been asked to sleep for longer than the budget had left at that point.
    // With ~30s + ~11.5s already spent of a 42s budget, well under a second
    // remains - nowhere near the unbounded exponential backoff's own math
    // would otherwise request.
    for (const ms of sleepCalls) {
      expect(ms).toBeLessThanOrEqual(1_000);
    }
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
