import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  getGeminiConfig,
  getDatabaseConfig,
  getRazorpayConfig,
  getRazorpayCredentials,
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
    expect(() => getGeminiConfig(EMPTY_ENV)).toThrow(ConfigurationError);
    expect(() => getRazorpayConfig(EMPTY_ENV)).toThrow(ConfigurationError);
    expect(() => getDatabaseConfig(EMPTY_ENV)).toThrow(ConfigurationError);
  });

  it("accepts a pooled PostgreSQL URL alone, and a direct URL when migrations need one", () => {
    const pooledOnly = getDatabaseConfig({
      DATABASE_URL: "postgresql://user@host:5432/db?pgbouncer=true",
    });
    expect(pooledOnly.DIRECT_URL).toBeUndefined();

    const withDirect = getDatabaseConfig({
      DATABASE_URL: "postgresql://user@host:5432/db?pgbouncer=true",
      DIRECT_URL: "postgresql://user@host:5432/db",
    });
    expect(withDirect.DIRECT_URL).toBe("postgresql://user@host:5432/db");
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
    const config = getGeminiConfig({ GEMINI_API_KEY: "placeholder-not-a-real-key" });
    expect(config.GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
  });

  it("defaults the thinking level to minimal, the latency-oriented setting", () => {
    const config = getGeminiConfig({ GEMINI_API_KEY: "placeholder-not-a-real-key" });
    expect(config.GEMINI_THINKING_LEVEL).toBe("minimal");
  });

  it("accepts an explicit thinking level and rejects an unsupported one", () => {
    const raised = getGeminiConfig({
      GEMINI_API_KEY: "placeholder-not-a-real-key",
      GEMINI_THINKING_LEVEL: "high",
    });
    expect(raised.GEMINI_THINKING_LEVEL).toBe("high");

    expect(() =>
      getGeminiConfig({
        GEMINI_API_KEY: "placeholder-not-a-real-key",
        GEMINI_THINKING_LEVEL: "maximum-overdrive",
      }),
    ).toThrow(ConfigurationError);
  });
});

/**
 * Invariants the staging deployment depends on.
 *
 * These are configuration properties rather than code paths, which is exactly
 * why they are easy to break silently: nothing fails locally when a hosting
 * dashboard holds the wrong value, and the first symptom appears in
 * production. Each test below corresponds to a mistake that a deployment can
 * actually make.
 */
describe("deployment configuration", () => {
  const TEST_CREDENTIALS: EnvSource = {
    RAZORPAY_KEY_ID: "rzp_test_stagingkey",
    RAZORPAY_KEY_SECRET: "staging-secret-not-real",
  };

  const messageFrom = (env: EnvSource): string => {
    try {
      getRazorpayCredentials(env);
      return "";
    } catch (thrown) {
      return (thrown as ConfigurationError).message;
    }
  };

  it("refuses a live Razorpay key id", () => {
    // The whole project moves no real money. A live key pasted into a hosting
    // dashboard must fail closed at the configuration boundary, before any
    // request reaches the provider - not be caught by a code review.
    try {
      getRazorpayCredentials({
        ...TEST_CREDENTIALS,
        RAZORPAY_KEY_ID: "rzp_live_shouldneverbeaccepted",
      });
      expect.unreachable("expected a live Razorpay key id to be refused");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ConfigurationError);
      const error = thrown as ConfigurationError;
      expect(error.details["variables"]).toEqual(["RAZORPAY_KEY_ID"]);
      // The refusal names the variable and the mode, never the key itself.
      expect(error.message).not.toContain("rzp_live_shouldneverbeaccepted");
    }
  });

  it("says why a key was refused, not merely which variable failed", () => {
    // Without this, a refused live key reported identically to one that was
    // never set: the operator concludes the variable did not save, pastes the
    // same rejected value again, and never learns the rule. A safety control
    // that cannot explain itself gets worked around rather than obeyed.
    const missing = messageFrom({});
    const live = messageFrom({
      ...TEST_CREDENTIALS,
      RAZORPAY_KEY_ID: "rzp_live_shouldneverbeaccepted",
    });

    expect(missing).toContain("RAZORPAY_KEY_ID (missing)");
    expect(live).toContain("Test Mode");
    expect(live).not.toContain("(missing)");
  });

  it("still refuses to quote a rejected value back, on either path", () => {
    // The reason above is safe only because it is a string written in this
    // repository. Zod's own messages are not: an enum mismatch quotes what it
    // received, so those stay collapsed to "(invalid)" and never reach a log.
    const rejected = "rzp_live_thisexactstringmustnotappear";
    expect(messageFrom({ ...TEST_CREDENTIALS, RAZORPAY_KEY_ID: rejected })).not.toContain(
      rejected,
    );

    const secretish = "verbose-value-that-must-not-be-echoed";
    const runtimeMessage = (() => {
      try {
        getRuntimeConfig({ LOG_LEVEL: secretish });
        return "";
      } catch (thrown) {
        return (thrown as ConfigurationError).message;
      }
    })();
    expect(runtimeMessage).toContain("LOG_LEVEL (invalid)");
    expect(runtimeMessage).not.toContain(secretish);
  });

  it("refuses a key id from no recognised namespace at all", () => {
    expect(() =>
      getRazorpayCredentials({ ...TEST_CREDENTIALS, RAZORPAY_KEY_ID: "some-key" }),
    ).toThrow(ConfigurationError);
  });

  it("accepts the Test Mode credentials staging actually runs on", () => {
    const credentials = getRazorpayCredentials(TEST_CREDENTIALS);
    expect(credentials.RAZORPAY_KEY_ID).toBe("rzp_test_stagingkey");
  });

  it("starts the payment path without a webhook secret", () => {
    // The webhook secret belongs to a verification path that does not exist
    // yet. Requiring it here would let an unconfigured webhook block order
    // creation - a control failing a path it has no authority over.
    expect(() => getRazorpayCredentials(TEST_CREDENTIALS)).not.toThrow();
    expect(() => getRazorpayConfig(TEST_CREDENTIALS)).toThrow(ConfigurationError);
  });

  it("runs on the pooled DATABASE_URL alone, with no direct URL deployed", () => {
    // The deployed runtime uses the pooled endpoint; the direct endpoint is a
    // migration concern. Requiring it at runtime would put an admin connection
    // string in a hosting dashboard for no reason.
    const config = getDatabaseConfig({ DATABASE_URL: "postgresql://pooled/host" });
    expect(config.DIRECT_URL).toBeUndefined();
  });

  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
    });

  /**
   * The file with its comments removed.
   *
   * Both scans below look for a bare variable name, and both would otherwise
   * be answered by prose: `src/config/env.ts` documents at length that nothing
   * may be prefixed `NEXT_PUBLIC_`, and a comment saying so must not read as
   * the violation it warns about. Stripping comments first means these tests
   * search code, which is the only place the mistake can actually be made.
   */
  const codeOf = (file: string): string =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*/g, " ");

  const filesContaining = (needle: string): string[] =>
    sourceFiles("src").filter((file) => codeOf(file).includes(needle));

  it("never lets a test-only variable become a deployed runtime dependency", () => {
    // TEST_DIRECT_URL exists so the test schema can be built over a direct
    // connection. If application code ever read it, the deployment would need
    // a test variable set to serve real traffic.
    expect(filesContaining("TEST_DIRECT_URL")).toEqual([]);
  });

  it("declares no NEXT_PUBLIC_ variable anywhere in application source", () => {
    // Anything so prefixed is inlined into the client bundle at build time.
    // No configuration this application holds belongs there, so the safe
    // number of them is zero rather than "only the harmless ones".
    //
    // Matched as a plain substring rather than against `process.env[...]`.
    // An earlier version of this test anchored on the bracket form and so
    // missed `process.env.NEXT_PUBLIC_KEY` - the way the mistake is most
    // naturally written - which made it a test that passed while the leak it
    // was written to catch went through.
    expect(filesContaining("NEXT_PUBLIC_")).toEqual([]);
  });
});
