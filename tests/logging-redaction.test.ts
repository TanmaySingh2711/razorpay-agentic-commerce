import { describe, expect, it } from "vitest";
import { buildLogEntry, createLogger, type LogEntry } from "@/lib/logger";
import { REDACTED, redact } from "@/lib/redact";

describe("redaction", () => {
  it("strips credentials and payment instrument data at any depth", () => {
    const output = redact({
      razorpay: {
        RAZORPAY_KEY_SECRET: "rzp_secret_live",
        webhook: { signature: "abc123", payload: { card: "4111111111111111" } },
      },
      authorization: "Bearer token",
      productId: "kbd_001",
    });
    const serialised = JSON.stringify(output);
    expect(serialised).not.toContain("rzp_secret_live");
    expect(serialised).not.toContain("abc123");
    expect(serialised).not.toContain("4111111111111111");
    expect(serialised).toContain("kbd_001");
    expect(output["authorization"]).toBe(REDACTED);
  });

  it("strips hidden model reasoning, which must never enter a financial record", () => {
    const output = redact({
      chain_of_thought: "first I considered...",
      reasoning: "the user probably wants...",
      thinking: "let me check the budget",
      recommendation: "Keychron K2",
    });
    expect(output["chain_of_thought"]).toBe(REDACTED);
    expect(output["reasoning"]).toBe(REDACTED);
    expect(output["thinking"]).toBe(REDACTED);
    expect(output["recommendation"]).toBe("Keychron K2");
  });

  it("truncates oversized strings so one payload cannot flood the log stream", () => {
    const output = redact({ description: "x".repeat(5000) });
    expect(String(output["description"]).length).toBeLessThan(600);
  });
});

describe("log entries", () => {
  it("carries correlation and transaction ids for reconstruction", () => {
    const entry = buildLogEntry(
      "info",
      { category: "payment", correlationId: "corr_1", transactionId: "txn_1" },
      "order created",
      { amountMinorUnits: 299900, currency: "INR" },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(entry).toMatchObject({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      category: "payment",
      correlationId: "corr_1",
      transactionId: "txn_1",
      message: "order created",
    });
    expect(entry.metadata["amountMinorUnits"]).toBe(299900);
  });
});

describe("logger", () => {
  it("suppresses entries below the configured minimum level", () => {
    const captured: LogEntry[] = [];
    const logger = createLogger(
      { category: "system" },
      { sink: (entry) => captured.push(entry), minimumLevel: "warn" },
    );
    logger.debug("noise");
    logger.info("noise");
    logger.warn("worth knowing");
    logger.error("broken");
    expect(captured.map((entry) => entry.level)).toEqual(["warn", "error"]);
  });

  it("redacts metadata passed through the logger itself", () => {
    const captured: LogEntry[] = [];
    const logger = createLogger(
      { category: "webhook" },
      { sink: (entry) => captured.push(entry), minimumLevel: "debug" },
    );
    logger.info("webhook received", {
      signature: "sig_should_not_appear",
      eventType: "captured",
    });
    expect(JSON.stringify(captured)).not.toContain("sig_should_not_appear");
    expect(captured[0]?.metadata["eventType"]).toBe("captured");
  });

  it("binds a transaction id onto every child log line", () => {
    const captured: LogEntry[] = [];
    const base = createLogger(
      { category: "transaction" },
      { sink: (entry) => captured.push(entry), minimumLevel: "debug" },
    );
    base.child({ transactionId: "txn_42" }).info("state transitioned");
    expect(captured[0]?.transactionId).toBe("txn_42");
  });
});
