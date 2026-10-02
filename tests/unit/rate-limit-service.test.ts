import { describe, expect, it, vi } from "vitest";
import {
  consumeRateLimits,
  limitAgentRequest,
  limitPaymentRequest,
  paymentRequestChecks,
  type RateLimitDeps,
} from "@/services/rate-limit-service";
import { getRateLimitConfig } from "@/lib/env";
import { fixedClock } from "@/lib/clock";
import { RETENTION_SECONDS } from "@/domain/rate-limit";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The limiter's failure paths.
 *
 * Counting and concurrency are proved against real PostgreSQL in
 * `tests/db/rate-limit.test.ts`. What that suite cannot stage on demand is the
 * database misbehaving at a chosen moment: losing the insert race, failing
 * outright, or failing only during housekeeping. Those are driven here with a
 * scripted store, because each has a different required answer - retry, fail
 * closed, and carry on.
 */

const NOW = new Date("2026-10-01T12:00:30.000Z");

interface Store {
  readonly upsert: ReturnType<typeof vi.fn>;
  readonly deleteMany: ReturnType<typeof vi.fn>;
}

function store(): Store {
  let hits = 0;
  return {
    upsert: vi.fn(() => {
      hits += 1;
      return Promise.resolve({ hits });
    }),
    deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
  };
}

function deps(rateLimitWindow: Store, random = 1): RateLimitDeps {
  return {
    prisma: { rateLimitWindow } as unknown as PrismaClient,
    clock: fixedClock(NOW),
    config: getRateLimitConfig({
      RATE_LIMIT_AGENT_PER_MINUTE: "3",
      RATE_LIMIT_AGENT_PER_DAY: "5",
      RATE_LIMIT_AGENT_GLOBAL_PER_DAY: "8",
      RATE_LIMIT_PAYMENT_PER_MINUTE: "2",
    }),
    random: () => random,
  };
}

const uniqueViolation = () => Object.assign(new Error("unique"), { code: "P2002" });

describe("losing the race to create a window", () => {
  it("retries the upsert once and counts the request", async () => {
    const windows = store();
    windows.upsert.mockRejectedValueOnce(uniqueViolation());
    const d = deps(windows);

    const decision = await consumeRateLimits(paymentRequestChecks("client", d.config), d);

    expect(decision).toEqual({ kind: "ALLOWED" });
    expect(windows.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not retry forever: a second violation is an error", async () => {
    const windows = store();
    windows.upsert.mockRejectedValue(uniqueViolation());
    const d = deps(windows);

    await expect(
      consumeRateLimits(paymentRequestChecks("client", d.config), d),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(windows.upsert).toHaveBeenCalledTimes(2);
  });
});

describe("failing closed", () => {
  it("throws when the database cannot be reached, without a retry", async () => {
    const windows = store();
    windows.upsert.mockRejectedValue(new Error("connection refused"));
    const d = deps(windows);

    await expect(
      consumeRateLimits(paymentRequestChecks("client", d.config), d),
    ).rejects.toThrow("connection refused");
    expect(windows.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("pruning", () => {
  it("deletes only windows older than the retention period, on the sampled request", async () => {
    const windows = store();
    const d = deps(windows, 0);

    await consumeRateLimits(paymentRequestChecks("client", d.config), d);

    expect(windows.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        windowStart: { lt: new Date(NOW.getTime() - RETENTION_SECONDS * 1_000) },
      },
    });
  });

  it("is skipped on every other request", async () => {
    const windows = store();
    const d = deps(windows, 0.5);

    await consumeRateLimits(paymentRequestChecks("client", d.config), d);

    expect(windows.deleteMany).not.toHaveBeenCalled();
  });

  it("never refuses a request that was within its limits when it fails", async () => {
    const windows = store();
    windows.deleteMany.mockRejectedValueOnce(new Error("deadlock"));
    const d = deps(windows, 0);

    await expect(
      consumeRateLimits(paymentRequestChecks("client", d.config), d),
    ).resolves.toEqual({ kind: "ALLOWED" });
  });

  it("does not run for a refused request", async () => {
    const windows = store();
    const d = deps(windows, 0);
    const checks = paymentRequestChecks("client", d.config);

    await consumeRateLimits(checks, d);
    await consumeRateLimits(checks, d);
    windows.deleteMany.mockClear();

    expect(await consumeRateLimits(checks, d)).toMatchObject({
      kind: "LIMITED",
      rule: "payment-minute",
    });
    expect(windows.deleteMany).not.toHaveBeenCalled();
  });
});

describe("the two entry points", () => {
  it("consumes all three agent ceilings, in order, for an allowed request", async () => {
    const windows = store();

    expect(await limitAgentRequest("client", deps(windows))).toEqual({ kind: "ALLOWED" });

    const buckets = windows.upsert.mock.calls.map(
      (call) =>
        (call[0] as { where: { bucket_windowStart: { bucket: string } } }).where
          .bucket_windowStart.bucket,
    );
    expect(buckets).toHaveLength(3);
    expect(new Set(buckets).size).toBe(3);
    expect(buckets[2]).not.toContain("client");
  });

  it("consumes the single payment ceiling and refuses past it", async () => {
    const windows = store();
    const d = deps(windows);

    expect((await limitPaymentRequest("client", d)).kind).toBe("ALLOWED");
    expect((await limitPaymentRequest("client", d)).kind).toBe("ALLOWED");
    expect(await limitPaymentRequest("client", d)).toEqual({
      kind: "LIMITED",
      rule: "payment-minute",
      retryAfterSeconds: 30,
    });
  });
});
