import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentRequestChecks,
  consumeRateLimits,
  pruneExpiredWindows,
  type RateLimitDeps,
} from "@/services/rate-limit/rate-limit-service";
import { getRateLimitConfig } from "@/config/env";
import { fixedClock, type MutableClock } from "@/lib/clock";
import { databaseConfigured, disconnectTestDb, resetTestData, testDb } from "./harness";

/**
 * The rate limiter against real PostgreSQL.
 *
 * The property worth the most is the concurrent one: many requests arriving at
 * once must be admitted exactly up to the limit. A limiter that read the count
 * and then wrote it back would admit every request that read before any wrote
 * - the same check-then-act race the inventory hold exists to close - so this
 * suite fires them genuinely in parallel against one database.
 */

const NOW = new Date("2026-10-01T12:00:30.000Z");

let clock: MutableClock;

function deps(overrides: Partial<RateLimitDeps> = {}): RateLimitDeps {
  return {
    prisma: testDb(),
    clock,
    config: getRateLimitConfig({
      RATE_LIMIT_AGENT_PER_MINUTE: "3",
      RATE_LIMIT_AGENT_PER_DAY: "5",
      RATE_LIMIT_AGENT_GLOBAL_PER_DAY: "8",
    }),
    // Never prune during a test unless the test asks for it.
    random: () => 1,
    ...overrides,
  };
}

const consume = (client: string, d = deps()) =>
  consumeRateLimits(agentRequestChecks(client, d.config), d);

describe.skipIf(!databaseConfigured)("the rate limiter", () => {
  beforeEach(async () => {
    await resetTestData();
    clock = fixedClock(NOW);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("admits exactly the per-minute limit, then refuses until the window ends", async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await consume("client-a"));

    expect(results.slice(0, 3).every((r) => r.kind === "ALLOWED")).toBe(true);
    expect(results[3]).toEqual({
      kind: "LIMITED",
      rule: "agent-minute",
      retryAfterSeconds: 30,
    });

    clock.advanceMs(30_000);
    expect((await consume("client-a")).kind).toBe("ALLOWED");
  });

  it("admits exactly the limit when requests arrive simultaneously", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => consume("client-burst")),
    );
    expect(results.filter((r) => r.kind === "ALLOWED")).toHaveLength(3);
    expect(results.filter((r) => r.kind === "LIMITED")).toHaveLength(9);
  });

  it("enforces the daily ceiling across minute windows", async () => {
    const outcomes: string[] = [];
    for (let minute = 0; minute < 3; minute += 1) {
      for (let i = 0; i < 2; i += 1) {
        const result = await consume("client-day");
        outcomes.push(result.kind === "LIMITED" ? result.rule : "ALLOWED");
      }
      clock.advanceMs(60_000);
    }
    expect(outcomes).toEqual([
      "ALLOWED",
      "ALLOWED",
      "ALLOWED",
      "ALLOWED",
      "ALLOWED",
      "agent-day",
    ]);
  });

  it("caps the whole deployment, however many clients the traffic comes from", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const result = await consume(`client-${String(i)}`);
      outcomes.push(result.kind === "LIMITED" ? result.rule : "ALLOWED");
    }
    expect(outcomes.filter((o) => o === "ALLOWED")).toHaveLength(8);
    expect(outcomes.slice(8)).toEqual(["agent-global-day", "agent-global-day"]);
  });

  it("does not let a client that is over its own limit spend the global allowance", async () => {
    for (let i = 0; i < 20; i += 1) await consume("client-abusive");

    const global = await testDb().rateLimitWindow.findFirst({
      where: { bucket: "agent:agent-global-day:global" },
    });
    // Three admitted in the first minute; the rest were refused by the
    // per-minute rule before the global counter was touched.
    expect(global?.hits).toBe(3);
    expect((await consume("client-innocent")).kind).toBe("ALLOWED");
  });

  it("stores digests and counters only", async () => {
    await consume("client-a");
    const rows = await testDb().rateLimitWindow.findMany();
    expect(rows.map((row) => row.bucket).sort()).toEqual([
      "agent:agent-day:client-a",
      "agent:agent-global-day:global",
      "agent:agent-minute:client-a",
    ]);
  });

  it("prunes only windows that can no longer be current", async () => {
    await consume("client-old");
    clock.advanceMs(3 * 86_400_000);
    await consume("client-new");

    expect(await pruneExpiredWindows({ prisma: testDb(), clock })).toBe(3);
    const remaining = await testDb().rateLimitWindow.findMany();
    expect(
      remaining.every(
        (row) => row.bucket.includes("client-new") || row.bucket.endsWith("global"),
      ),
    ).toBe(true);
    expect(remaining.length).toBeGreaterThan(0);
  });
});
