import { config as loadEnv } from "dotenv";
import { createGeminiProvider } from "../src/integrations/llm/gemini-provider";
import {
  INTENT_RESPONSE_JSON_SCHEMA,
  structuredPurchaseIntentSchema,
} from "../src/domain/buyer-agent/intent";
import { INTENT_EXTRACTION_INSTRUCTION } from "../src/services/buyer-agent/instructions";
import type { AiGenerationResponse } from "../src/integrations/llm/provider";
import type { JsonObject } from "../src/lib/json";

loadEnv({ path: ".env.local", quiet: true });

/**
 * The one live call to Gemini in this repository.
 *
 * Deliberately outside `npm test`. The automated suite runs against a scripted
 * provider, because a test whose result depends on what a model chose to say
 * cannot prove a safety property - and because hammering a free tier from CI is
 * how a demo stops working the morning it matters.
 *
 * What this proves, in one request, is the handful of things a fake cannot:
 * that the credentials work, that the model id is real, that the Interactions
 * API surface we build against is the one Google actually serves, and that
 * schema-constrained output comes back in a shape our validator accepts.
 *
 * It prints no key, no key prefix, no fingerprint and no length. On a quota
 * failure it says so and exits 0: an exhausted free tier is a fact about the
 * account, not a defect in the code, and it must not read as a broken build.
 *
 * Run with: npm run gemini:smoke
 */

const PROMPT = "Find me a mechanical keyboard under ₹3000 and buy it.";

/**
 * Bounded retries for transient upstream failures.
 *
 * The Gemini free tier allows only a handful of requests per minute, and the
 * service itself returns a 500 "high demand" from time to time. Both are
 * retryable conditions, and the agent already treats them that way, so the
 * smoke test uses the same policy rather than reporting a temporary blip as a
 * broken implementation. An authentication failure is still fatal on the first
 * attempt: retrying it cannot succeed.
 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 65_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  console.error(`\nSMOKE TEST FAILED: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const apiKey = process.env["GEMINI_API_KEY"];
  const modelId = process.env["GEMINI_MODEL"] ?? "gemini-3.5-flash-lite";

  if (apiKey === undefined || apiKey.length === 0) {
    console.log("GEMINI_API_KEY is not set. Skipping the live smoke test.");
    return;
  }

  console.log("Gemini live smoke test");
  console.log("  provider : gemini (@google/genai)");
  console.log(`  model    : ${modelId}`);
  console.log("  key      : present (never printed)");
  console.log(`  prompt   : ${PROMPT}\n`);

  const provider = createGeminiProvider({ apiKey, modelId, timeoutMs: 30_000 });
  const startedAt = Date.now();

  let response: AiGenerationResponse | undefined;
  let lastCode = "UNKNOWN";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await provider.generate({
        systemInstruction: INTENT_EXTRACTION_INSTRUCTION,
        userMessage: PROMPT,
        responseSchema: INTENT_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
        correlationId: "smoke-test",
      });
      break;
    } catch (error) {
      // Already translated into the application taxonomy by the adapter, so
      // nothing provider-specific is printed here either.
      lastCode = (error as { code?: string }).code ?? "UNKNOWN";

      if (lastCode === "AI_PROVIDER_AUTH_FAILURE") {
        fail("the provider rejected the credentials (check GEMINI_API_KEY).");
      }
      if (attempt === MAX_ATTEMPTS) break;

      const waitSeconds = String(RETRY_DELAY_MS / 1000);
      console.log(
        `  attempt ${String(attempt)} failed with ${lastCode}; waiting ${waitSeconds}s for the free-tier window to reset...`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  if (response === undefined) {
    if (
      lastCode === "AI_PROVIDER_RATE_LIMITED" ||
      lastCode === "AI_PROVIDER_UNAVAILABLE"
    ) {
      console.log(
        `\nBLOCKED BY FREE-TIER QUOTA / PROVIDER: ${lastCode} after ${String(MAX_ATTEMPTS)} attempts.`,
      );
      console.log("This is an account or upstream limit, not an implementation failure.");
      return;
    }
    fail(`the provider call failed with ${lastCode}.`);
  }

  console.log(`Received a response in ${String(Date.now() - startedAt)}ms.`);

  if (response.text === null || response.text.trim().length === 0) {
    fail("the response contained no output text.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.text) as unknown;
  } catch {
    fail("the response was not valid JSON despite the schema constraint.");
  }

  // The same validator the agent uses. Structured output is only useful if it
  // satisfies our schema, not merely the provider's copy of it.
  const validated = structuredPurchaseIntentSchema.safeParse(parsedJson);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    console.error(
      `  schema issue: ${issue?.path.join(".") ?? "unknown"} - ${issue?.message ?? ""}`,
    );
    fail("the structured output did not satisfy the application schema.");
  }

  const intent = validated.data;
  console.log("\nStructured output validated against the application schema:");
  console.log(`  requestType  : ${intent.requestType}`);
  console.log(`  productQuery : ${intent.productQuery}`);
  console.log(`  quantity     : ${String(intent.quantity)}`);
  console.log(
    `  budget       : ${
      intent.budget === null
        ? "none"
        : `${intent.budget.maxAmountMinor} ${intent.budget.currency} (from "${intent.budget.sourceText}")`
    }`,
  );
  console.log(`  clarify      : ${String(intent.needsClarification)}`);

  console.log(
    "\nSMOKE TEST PASSED: Gemini connectivity and structured output confirmed.",
  );
  console.log("No transaction, quote, payment or catalog write occurred.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
