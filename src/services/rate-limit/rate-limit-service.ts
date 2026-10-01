import { assertServerOnly } from "@/lib/server-only";
import { createLogger } from "@/lib/logger";
import { systemClock, type Clock } from "@/lib/clock";
import { getRateLimitConfig, type RateLimitConfig } from "@/config/env";
import { getPrismaClient } from "@/integrations/persistence/client";
import {
  DAY_SECONDS,
  GLOBAL_SUBJECT,
  MINUTE_SECONDS,
  RETENTION_SECONDS,
  bucketKey,
  isOverLimit,
  secondsUntilWindowEnds,
  windowStartOf,
  type RateLimitRule,
} from "@/domain/rate-limit/rules";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The abuse and cost limiter.
 *
 * Counters live in PostgreSQL because the deployment is serverless: each warm
 * instance has its own memory, so an in-process counter would multiply every
 * caller's allowance by the number of instances. One row per (bucket, window),
 * incremented by a single atomic upsert - two concurrent requests can never
 * both read "under the limit" and both proceed, because neither reads at all;
 * each learns the count its own increment produced.
 *
 * Checks run in order and stop at the first refusal. That ordering is
 * load-bearing for the deployment-wide ceiling: a caller already over their
 * own limit is refused *before* the global counter is touched, so one abusive
 * client cannot spend everybody else's daily allowance by being refused.
 *
 * ## Failing closed
 *
 * If PostgreSQL cannot be reached the check throws, and the callers treat that
 * as a refusal. Every path this guards needs the same database a moment later
 * anyway, and "the limiter was down, so there was no limit" is precisely the
 * outage a quota ceiling exists to prevent.
 */
assertServerOnly("src/services/rate-limit/rate-limit-service.ts");

const log = createLogger({ category: "http" });

const UNIQUE_VIOLATION = "P2002";

/** Roughly one request in fifty also prunes expired windows. */
const PRUNE_PROBABILITY = 0.02;

export type RateLimitDecision =
  | { readonly kind: "ALLOWED" }
  | {
      readonly kind: "LIMITED";
      /** The rule that refused, for the log and the response. Never a secret. */
      readonly rule: string;
      readonly retryAfterSeconds: number;
    };

export interface RateLimitCheck {
  readonly bucket: string;
  readonly rule: RateLimitRule;
}

export interface RateLimitDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly config: RateLimitConfig;
  /** Injected so pruning is deterministic in tests. */
  readonly random: () => number;
}

export function defaultRateLimitDeps(): RateLimitDeps {
  return {
    prisma: getPrismaClient(),
    clock: systemClock,
    config: getRateLimitConfig(),
    random: Math.random,
  };
}

/** Increments one window's counter and returns the count this call produced. */
async function increment(
  prisma: PrismaClient,
  bucket: string,
  windowStart: Date,
): Promise<number> {
  const upsert = () =>
    prisma.rateLimitWindow.upsert({
      where: { bucket_windowStart: { bucket, windowStart } },
      create: { bucket, windowStart, hits: 1 },
      // `increment` is `SET hits = hits + 1` in one statement: atomic, with no
      // read-modify-write window for a concurrent request to fall into.
      update: { hits: { increment: 1 } },
      select: { hits: true },
    });

  try {
    return (await upsert()).hits;
  } catch (error) {
    // Two first requests in a brand-new window can both try the INSERT arm.
    // The loser sees a unique violation; by then the row exists, so running
    // the upsert again takes the atomic UPDATE arm and counts correctly.
    if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return (await upsert()).hits;
    }
    throw error;
  }
}

/**
 * Consumes one unit from each check, in order, stopping at the first refusal.
 */
export async function consumeRateLimits(
  checks: readonly RateLimitCheck[],
  deps: RateLimitDeps,
): Promise<RateLimitDecision> {
  const now = deps.clock.now();

  for (const check of checks) {
    const hits = await increment(
      deps.prisma,
      check.bucket,
      windowStartOf(now, check.rule.windowSeconds),
    );
    if (isOverLimit(hits, check.rule)) {
      const retryAfterSeconds = secondsUntilWindowEnds(now, check.rule.windowSeconds);
      log.warn("request refused by rate limit", {
        rule: check.rule.name,
        retryAfterSeconds,
      });
      return { kind: "LIMITED", rule: check.rule.name, retryAfterSeconds };
    }
  }

  if (deps.random() < PRUNE_PROBABILITY) {
    await pruneExpiredWindows(deps).catch((error: unknown) => {
      // Housekeeping, not the control. A failed prune leaves old rows behind;
      // it must not refuse a request that was within its limits.
      log.warn("rate limit pruning failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    });
  }
  return { kind: "ALLOWED" };
}

/** Deletes windows that can no longer be current. Returns how many. */
export async function pruneExpiredWindows(
  deps: Pick<RateLimitDeps, "prisma" | "clock">,
): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - RETENTION_SECONDS * 1_000);
  const deleted = await deps.prisma.rateLimitWindow.deleteMany({
    where: { windowStart: { lt: cutoff } },
  });
  return deleted.count;
}

/**
 * The three ceilings in front of the Buyer Agent: per client per minute, per
 * client per day, and the whole deployment per day - in that order.
 */
export function agentRequestChecks(
  clientKey: string,
  config: RateLimitConfig,
): readonly RateLimitCheck[] {
  const perMinute: RateLimitRule = {
    name: "agent-minute",
    limit: config.RATE_LIMIT_AGENT_PER_MINUTE,
    windowSeconds: MINUTE_SECONDS,
  };
  const perDay: RateLimitRule = {
    name: "agent-day",
    limit: config.RATE_LIMIT_AGENT_PER_DAY,
    windowSeconds: DAY_SECONDS,
  };
  const globalPerDay: RateLimitRule = {
    name: "agent-global-day",
    limit: config.RATE_LIMIT_AGENT_GLOBAL_PER_DAY,
    windowSeconds: DAY_SECONDS,
  };
  return [
    { bucket: bucketKey("agent", perMinute, clientKey), rule: perMinute },
    { bucket: bucketKey("agent", perDay, clientKey), rule: perDay },
    { bucket: bucketKey("agent", globalPerDay, GLOBAL_SUBJECT), rule: globalPerDay },
  ];
}

/** The ceiling in front of the money endpoints: per client per minute. */
export function paymentRequestChecks(
  clientKey: string,
  config: RateLimitConfig,
): readonly RateLimitCheck[] {
  const perMinute: RateLimitRule = {
    name: "payment-minute",
    limit: config.RATE_LIMIT_PAYMENT_PER_MINUTE,
    windowSeconds: MINUTE_SECONDS,
  };
  return [{ bucket: bucketKey("payment", perMinute, clientKey), rule: perMinute }];
}

/** Consumes the Buyer Agent's ceilings for one client. */
export function limitAgentRequest(
  clientKey: string,
  deps: RateLimitDeps = defaultRateLimitDeps(),
): Promise<RateLimitDecision> {
  return consumeRateLimits(agentRequestChecks(clientKey, deps.config), deps);
}

/** Consumes the payment endpoints' ceiling for one client. */
export function limitPaymentRequest(
  clientKey: string,
  deps: RateLimitDeps = defaultRateLimitDeps(),
): Promise<RateLimitDecision> {
  return consumeRateLimits(paymentRequestChecks(clientKey, deps.config), deps);
}
