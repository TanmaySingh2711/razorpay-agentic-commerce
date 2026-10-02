import { describe, expect, it, vi } from "vitest";
import {
  DAY_SECONDS,
  MINUTE_SECONDS,
  bucketKey,
  clientKeyFromHeaders,
  isOverLimit,
  secondsUntilWindowEnds,
  windowStartOf,
} from "@/domain/rate-limit";
import { withRateLimit } from "@/lib/rate-limited";
import { agentRequestChecks, paymentRequestChecks } from "@/services/rate-limit-service";
import { getRateLimitConfig } from "@/lib/env";

/**
 * The rate limiter's arithmetic and its HTTP face, without a database.
 *
 * The counter itself - the atomic upsert, concurrency, window rollover - is
 * proved against PostgreSQL in `tests/db/rate-limit.test.ts`. Here: where a
 * window starts and ends, when a count is over, how a caller is identified
 * without storing who they are, and what a refused request looks like.
 */

describe("fixed windows", () => {
  const at = (iso: string) => new Date(iso);

  it("aligns minute and day windows to the epoch", () => {
    expect(windowStartOf(at("2026-10-01T12:34:56.789Z"), MINUTE_SECONDS)).toEqual(
      at("2026-10-01T12:34:00.000Z"),
    );
    expect(windowStartOf(at("2026-10-01T12:34:56.789Z"), DAY_SECONDS)).toEqual(
      at("2026-10-01T00:00:00.000Z"),
    );
  });

  it("puts the last millisecond of a window in that window, and the next in the next", () => {
    const last = at("2026-10-01T12:34:59.999Z");
    const next = at("2026-10-01T12:35:00.000Z");
    expect(windowStartOf(last, MINUTE_SECONDS)).not.toEqual(
      windowStartOf(next, MINUTE_SECONDS),
    );
  });

  it("never tells a client to retry in zero seconds", () => {
    expect(secondsUntilWindowEnds(at("2026-10-01T12:34:59.999Z"), MINUTE_SECONDS)).toBe(
      1,
    );
    expect(secondsUntilWindowEnds(at("2026-10-01T12:34:00.000Z"), MINUTE_SECONDS)).toBe(
      60,
    );
    expect(secondsUntilWindowEnds(at("2026-10-01T12:34:30.500Z"), MINUTE_SECONDS)).toBe(
      30,
    );
  });

  it("allows exactly the limit and refuses the one after", () => {
    const rule = { name: "r", limit: 3, windowSeconds: 60 };
    expect([1, 2, 3, 4].map((hits) => isOverLimit(hits, rule))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("the caller's identity", () => {
  const key = (init: Record<string, string>) => clientKeyFromHeaders(new Headers(init));

  it("is a digest, never the address itself", () => {
    const k = key({ "x-real-ip": "203.0.113.7" });
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain("203");
  });

  it("is stable for one caller and different for another", () => {
    expect(key({ "x-real-ip": "203.0.113.7" })).toBe(key({ "x-real-ip": "203.0.113.7" }));
    expect(key({ "x-real-ip": "203.0.113.7" })).not.toBe(
      key({ "x-real-ip": "203.0.113.8" }),
    );
  });

  it("prefers the platform's x-real-ip, then the first forwarded hop", () => {
    expect(key({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" })).toBe(
      key({ "x-real-ip": "203.0.113.7" }),
    );
    expect(key({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).toBe(
      key({ "x-forwarded-for": "198.51.100.1" }),
    );
  });

  it("puts every caller without an address into one shared bucket", () => {
    expect(key({})).toBe(key({ "x-forwarded-for": "  " }));
  });
});

describe("the ceilings in front of each surface", () => {
  const config = getRateLimitConfig({});

  it("defaults to five a minute, sixty a day, fifteen hundred a day globally", () => {
    const checks = agentRequestChecks("client-a", config);
    expect(checks.map((check) => [check.rule.name, check.rule.limit])).toEqual([
      ["agent-minute", 5],
      ["agent-day", 60],
      ["agent-global-day", 1500],
    ]);
  });

  it("checks the client's own limits before the global one", () => {
    // The order is the control: a client already over its own limit must be
    // refused before it can spend the deployment-wide allowance.
    const buckets = agentRequestChecks("client-a", config).map((check) => check.bucket);
    expect(buckets[0]).toContain("client-a");
    expect(buckets[1]).toContain("client-a");
    expect(buckets[2]).toBe("agent:agent-global-day:global");
  });

  it("keeps payment buckets apart from agent buckets", () => {
    const [payment] = paymentRequestChecks("client-a", config);
    expect(payment?.bucket).toBe(
      bucketKey(
        "payment",
        { name: "payment-minute", limit: 20, windowSeconds: 60 },
        "client-a",
      ),
    );
  });

  it("treats a blank setting as the default, and rejects a nonsense one", () => {
    expect(
      getRateLimitConfig({ RATE_LIMIT_AGENT_PER_MINUTE: "" }).RATE_LIMIT_AGENT_PER_MINUTE,
    ).toBe(5);
    expect(
      getRateLimitConfig({ RATE_LIMIT_AGENT_PER_MINUTE: "9" })
        .RATE_LIMIT_AGENT_PER_MINUTE,
    ).toBe(9);
    expect(() => getRateLimitConfig({ RATE_LIMIT_AGENT_PER_MINUTE: "0" })).toThrow(
      /RATE_LIMIT_AGENT_PER_MINUTE/,
    );
  });
});

describe("a refused request", () => {
  const request = () =>
    new Request("http://localhost:3000/api/buyer-agent", {
      method: "POST",
      headers: { "x-real-ip": "203.0.113.7" },
    });

  it("is a 429 with Retry-After, and the handler never runs", async () => {
    const handler = vi.fn(() => Promise.resolve(new Response("ran")));
    const response = await withRateLimit(
      request(),
      () =>
        Promise.resolve({ kind: "LIMITED", rule: "agent-minute", retryAfterSeconds: 17 }),
      handler,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        category: "rate_limited",
        message: "Too many requests. Please wait a moment and try again.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("is refused, not waved through, when the limiter cannot answer", async () => {
    const handler = vi.fn(() => Promise.resolve(new Response("ran")));
    const response = await withRateLimit(
      request(),
      () => Promise.reject(new Error("database unreachable")),
      handler,
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reaches the handler, keyed on the hashed caller, when allowed", async () => {
    const limit = vi.fn(() => Promise.resolve({ kind: "ALLOWED" } as const));
    const response = await withRateLimit(request(), limit, () =>
      Promise.resolve(new Response("ran")),
    );
    expect(await response.text()).toBe("ran");
    expect(limit).toHaveBeenCalledWith(
      clientKeyFromHeaders(new Headers({ "x-real-ip": "203.0.113.7" })),
    );
  });
});
