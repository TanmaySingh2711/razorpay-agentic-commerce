import { describe, expect, it } from "vitest";
import {
  getAnthropicConfig,
  getRazorpayConfig,
  getRuntimeConfig,
  type EnvSource,
} from "@/config/env";
import { ConfigurationError } from "@/domain/errors";

const EMPTY_ENV: EnvSource = {};

describe("runtime configuration", () => {
  it("boots from a completely empty environment - no secret is required", () => {
    const config = getRuntimeConfig(EMPTY_ENV);
    expect(config.NODE_ENV).toBe("development");
    expect(config.APP_URL).toBe("http://localhost:3000");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("rejects a malformed value instead of silently falling back", () => {
    expect(() => getRuntimeConfig({ APP_URL: "not-a-url" })).toThrow(ConfigurationError);
    expect(() => getRuntimeConfig({ LOG_LEVEL: "verbose" })).toThrow(ConfigurationError);
  });
});

describe("provider configuration", () => {
  it("is validated lazily, so a missing key fails the feature and not the boot", () => {
    // The runtime config above already succeeded against the same empty env.
    expect(() => getAnthropicConfig(EMPTY_ENV)).toThrow(ConfigurationError);
    expect(() => getRazorpayConfig(EMPTY_ENV)).toThrow(ConfigurationError);
  });

  it("names every missing Razorpay variable so the fix is obvious", () => {
    try {
      getRazorpayConfig({ RAZORPAY_KEY_ID: "rzp_test_placeholder" });
      expect.unreachable("expected missing Razorpay secrets to throw");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ConfigurationError);
      const error = thrown as ConfigurationError;
      expect(error.details["variables"]).toEqual([
        "RAZORPAY_KEY_SECRET",
        "RAZORPAY_WEBHOOK_SECRET",
      ]);
    }
  });

  it("never echoes a configured secret value in its error output", () => {
    const secret = "super-secret-value-that-must-not-leak";
    try {
      getRazorpayConfig({ RAZORPAY_KEY_SECRET: secret });
      expect.unreachable("expected incomplete Razorpay config to throw");
    } catch (thrown) {
      const error = thrown as ConfigurationError;
      expect(JSON.stringify(error.toLogPayload())).not.toContain(secret);
      expect(error.message).not.toContain(secret);
    }
  });

  it("applies a default model while still demanding a real API key", () => {
    const config = getAnthropicConfig({ ANTHROPIC_API_KEY: "sk-ant-placeholder" });
    expect(config.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
  });
});
