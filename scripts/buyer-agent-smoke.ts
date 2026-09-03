import { config as loadEnv } from "dotenv";
import { createGeminiProvider } from "../src/integrations/llm/gemini-provider";
import { createServiceCatalogReader } from "../src/services/buyer-agent/catalog-reader";
import { runBuyerAgent } from "../src/services/buyer-agent/buyer-agent-service";
import { disconnectPrismaClient } from "../src/integrations/persistence/client";
import {
  INTENT_RESPONSE_JSON_SCHEMA,
  structuredPurchaseIntentSchema,
} from "../src/domain/buyer-agent/intent";
import {
  SELECTION_RESPONSE_JSON_SCHEMA,
  modelSelectionSchema,
} from "../src/domain/buyer-agent/decision";
import {
  INTENT_EXTRACTION_INSTRUCTION,
  PRODUCT_SELECTION_INSTRUCTION,
} from "../src/services/buyer-agent/instructions";
import {
  CATALOG_TOOL_DECLARATIONS,
  executeCatalogTool,
} from "../src/services/buyer-agent/catalog-tools";
import type { AiToolResult } from "../src/integrations/llm/provider";
import type { JsonObject } from "../src/lib/json";

loadEnv({ path: ".env.local", quiet: true });

/**
 * The live Buyer Agent smoke test.
 *
 * `gemini:smoke` proves one thing: that a single schema-constrained generation
 * round-trips. It does not touch the part of the agent that actually decides a
 * purchase - the tool loop, where a catalog tool is declared alongside a
 * response schema, real products go back as `function_result` input, and the
 * model's final selection is validated. That path can only be exercised against
 * the real provider and a real catalog, and until this script existed it never
 * had been: the in-memory fakes in the suite always produce complete, perfectly
 * shaped payloads, so nothing deterministic could catch a disagreement between
 * what we tell the provider and what we then demand of it.
 *
 * That class of bug is the reason this exists. It has now happened twice - a
 * clarification question longer than an undeclared cap, and a required-in-Zod
 * field the provider schema never marked required - and both times the symptom
 * was an `AI_PROVIDER_INVALID_RESPONSE` that no local test could reproduce.
 *
 * ## What it does, and what it deliberately does not
 *
 * It runs the real Gemini model against the real hosted catalog, in two passes:
 *
 *  1. a **staged** pass that drives intent extraction, the catalog tool loop and
 *     the final selection by hand, so a failure names the exact stage, the exact
 *     validator issue and the raw text that produced it, and
 *  2. an **end-to-end** pass through `runBuyerAgent`, so the composed path is
 *     proven and not merely its parts.
 *
 * Both are strictly read-only. The Buyer Agent has no capability to write: no
 * transaction, quote, approval, reservation, policy evaluation or payment. The
 * only database access in this script is the catalog service's own SELECTs.
 *
 * It prints no API key, no key length or prefix, no connection string and no
 * hostname. Model output IS printed on failure, because diagnosing a schema
 * disagreement without seeing the payload is guesswork - and model output is
 * neither a credential nor user data here: the prompt is a constant below.
 *
 * On a quota or availability failure it says so and exits 0, exactly as
 * `gemini:smoke` does: an exhausted free tier is a fact about the account, not
 * a defect in the code.
 *
 * Run with: npm run agent:smoke
 */

/** The request the deployed UI fails on. Not a placeholder - the real one. */
const PROMPT = "Find me a mechanical keyboard under ₹3000";

const CORRELATION_ID = "agent-smoke";

/** Mirrors the agent's own bound, so the staged pass cannot outrun it. */
const MAX_TOOL_ITERATIONS = 4;

/**
 * Provider codes that mean "the account or the upstream", not "the code".
 *
 * A rate limit is deliberately absent. It is waited out once per stage, and
 * only counts as environmental if it survives that wait - a decision made at
 * the top of the run rather than at each individual call site.
 */
const ENVIRONMENTAL_CODES = new Set(["AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_TIMEOUT"]);

/**
 * How long to wait out a free-tier window before giving up on a stage.
 *
 * This script makes several calls per run - three or four for the staged pass
 * and the same again end to end - which is enough to exhaust a per-minute free
 * quota partway through. The agent's own retry policy is deliberately much
 * shorter, sized for a transient blip rather than a quota window, so waiting
 * here is the smoke test's job rather than a reason to loosen the agent.
 */
const QUOTA_WAIT_MS = 65_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one stage, waiting out a single rate-limit window before giving up.
 *
 * Only a rate limit is waited on. A timeout or an outage is reported straight
 * away: neither is fixed by sixty-five seconds, and a smoke test that sits
 * quietly for a minute on a real fault is worse than one that says so.
 */
async function withQuotaPatience<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (codeOf(error) !== "AI_PROVIDER_RATE_LIMITED") throw error;
    console.log(
      `  ${stage}: free-tier quota reached; waiting ${String(QUOTA_WAIT_MS / 1000)}s for the window to reset...`,
    );
    await sleep(QUOTA_WAIT_MS);
    try {
      return await run();
    } catch (retried) {
      // A limit that outlives its own window is a daily allowance, not a burst.
      // That is a fact about the account, so it is reported as blocked rather
      // than as a failing implementation - the same call that ran a minute ago.
      if (codeOf(retried) === "AI_PROVIDER_RATE_LIMITED") {
        throw new SmokeBlocked(`${stage}: AI_PROVIDER_RATE_LIMITED (quota exhausted)`);
      }
      throw retried;
    }
  }
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "UNKNOWN";
}

/**
 * The two ways a run ends early.
 *
 * Both are thrown rather than exiting on the spot, so the database connection
 * is closed on the way out. Calling `process.exit` with a live connection pool
 * open is how this script first ended in a libuv assertion instead of a
 * readable sentence.
 */
class SmokeFailure extends Error {}
class SmokeBlocked extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

/** Reports an environmental failure as a non-failure and stops the run. */
function bailOnEnvironment(error: unknown, stage: string): never {
  throw new SmokeBlocked(`${stage}: ${codeOf(error)}`);
}

/**
 * Ends a stage that threw.
 *
 * A quota error is re-thrown untouched so the waiter above can sit out the
 * window and try the stage again - the whole reason the waiter exists. Anything
 * else stops the run here, with the stage named.
 */
function endStage(error: unknown, stage: string, what: string): never {
  if (codeOf(error) === "AI_PROVIDER_RATE_LIMITED") throw error;
  if (ENVIRONMENTAL_CODES.has(codeOf(error))) bailOnEnvironment(error, stage);
  fail(`${what} threw ${codeOf(error)}.`);
}

/**
 * Prints every validator issue, not just the first.
 *
 * The agent reports only the first path in its error message, which is right
 * for a user-facing failure and useless for diagnosis: a payload can disagree
 * with the schema in four places at once, and fixing them one run at a time
 * costs four live requests.
 */
function reportSchemaIssues(
  label: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  rawText: string,
): void {
  console.error(`\n  ${label} did not satisfy the application schema:`);
  for (const issue of issues) {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    console.error(`    - ${path}: ${issue.message}`);
  }
  console.error("\n  raw model output:");
  console.error(`    ${rawText.replace(/\n/g, "\n    ")}`);
}

async function stagedPass(): Promise<void> {
  const apiKey = process.env["GEMINI_API_KEY"] ?? "";
  const modelId = process.env["GEMINI_MODEL"] ?? "gemini-3.5-flash-lite";
  const provider = createGeminiProvider({ apiKey, modelId, timeoutMs: 30_000 });
  const catalog = createServiceCatalogReader();

  // --- Stage 1: intent extraction (no tools). ---
  console.log("Stage 1: intent extraction");
  let intentResponse;
  try {
    intentResponse = await provider.generate({
      systemInstruction: INTENT_EXTRACTION_INSTRUCTION,
      userMessage: PROMPT,
      responseSchema: INTENT_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
      correlationId: CORRELATION_ID,
    });
  } catch (error) {
    endStage(error, "intent", "intent extraction");
  }

  const intentText = intentResponse.text ?? "";
  if (intentText.trim().length === 0) fail("intent extraction returned no output text.");

  const intentParsed = structuredPurchaseIntentSchema.safeParse(
    JSON.parse(intentText) as unknown,
  );
  if (!intentParsed.success) {
    reportSchemaIssues("the intent", intentParsed.error.issues, intentText);
    fail("intent extraction produced output our schema refuses.");
  }
  const intent = intentParsed.data;
  console.log(
    `  ok - ${intent.requestType}, query "${intent.productQuery}", budget ${
      intent.budget === null
        ? "none"
        : `${intent.budget.maxAmountMinor} ${intent.budget.currency}`
    }\n`,
  );

  // --- Stage 2: the tool loop, with tools AND a response schema. ---
  console.log("Stage 2: catalog tool loop");
  const userMessage = [
    `Shopper's request: ${PROMPT}`,
    `Structured intent: ${JSON.stringify(intent)}`,
  ].join("\n\n");

  let response;
  try {
    response = await provider.generate({
      systemInstruction: PRODUCT_SELECTION_INSTRUCTION,
      userMessage,
      responseSchema: SELECTION_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
      tools: CATALOG_TOOL_DECLARATIONS,
      correlationId: CORRELATION_ID,
    });
  } catch (error) {
    endStage(error, "selection", "the first selection turn");
  }

  let observedCount = 0;
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    if (response.toolCalls.length === 0) break;

    const results: AiToolResult[] = [];
    for (const call of response.toolCalls) {
      console.log(
        `  turn ${String(iteration + 1)}: ${call.name}(${JSON.stringify(call.arguments)})`,
      );
      try {
        const execution = await executeCatalogTool(call.name, call.arguments, catalog);
        observedCount += execution.products.length;
        results.push({ callId: call.id, name: call.name, content: execution.payload });
      } catch (error) {
        console.log(`    refused: ${codeOf(error)}`);
        results.push({
          callId: call.id,
          name: call.name,
          content: { error: "refused" },
          isError: true,
        });
      }
    }

    try {
      response = await provider.continueWithToolResults({
        providerStateRef: response.providerStateRef,
        systemInstruction: PRODUCT_SELECTION_INSTRUCTION,
        toolResults: results,
        responseSchema: SELECTION_RESPONSE_JSON_SCHEMA as unknown as JsonObject,
        tools: CATALOG_TOOL_DECLARATIONS,
        correlationId: CORRELATION_ID,
      });
    } catch (error) {
      endStage(error, "tool loop", "continuing with tool results");
    }
  }

  console.log(`  products shown to the model: ${String(observedCount)}`);

  // --- Stage 3: the final selection, validated by the real validator. ---
  console.log("\nStage 3: final selection");
  const selectionText = response.text ?? "";
  if (selectionText.trim().length === 0) {
    console.error("  the final turn returned no output text.");
    console.error(`  tool calls still pending: ${String(response.toolCalls.length)}`);
    fail("the selection turn produced no text (AI_PROVIDER_INVALID_RESPONSE).");
  }

  let selectionJson: unknown;
  try {
    selectionJson = JSON.parse(selectionText) as unknown;
  } catch {
    console.error(`  raw model output:\n    ${selectionText}`);
    fail("the selection was not valid JSON despite the schema constraint.");
  }

  const selection = modelSelectionSchema.safeParse(selectionJson);
  if (!selection.success) {
    reportSchemaIssues("the selection", selection.error.issues, selectionText);
    fail("the selection produced output our schema refuses.");
  }
  console.log(
    `  ok - outcome ${selection.data.outcome}, product ${selection.data.selectedProductId ?? "none"}`,
  );
}

async function endToEndPass(): Promise<void> {
  console.log("\nEnd to end: runBuyerAgent");
  try {
    const decision = await withQuotaPatience("end to end", () =>
      runBuyerAgent({ message: PROMPT, correlationId: CORRELATION_ID }),
    );
    console.log(`  decision: ${decision.kind}`);
    if (decision.kind === "PRODUCT_SELECTED") {
      console.log(`  product : ${decision.observedProduct.name}`);
      // The amount is the catalog's, read by the server. The model never saw a
      // field it could have written it into.
      console.log(
        `  price   : ${decision.observedProduct.amount.amountMinor} ${decision.observedProduct.amount.currency} (server-read)`,
      );
      console.log(`  reasons : ${decision.reasonCodes.join(", ")}`);
    } else if (decision.kind === "NEEDS_CLARIFICATION") {
      console.log(`  question: ${decision.clarificationQuestion}`);
    } else {
      console.log(`  reasons : ${decision.reasonCodes.join(", ")}`);
    }
  } catch (error) {
    endStage(error, "end to end", "runBuyerAgent");
  }
}

async function main(): Promise<void> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    console.log("GEMINI_API_KEY is not set. Skipping the live Buyer Agent smoke test.");
    return;
  }
  if ((process.env["DATABASE_URL"] ?? "").length === 0) {
    console.log("DATABASE_URL is not set. Skipping the live Buyer Agent smoke test.");
    return;
  }

  console.log("Buyer Agent live smoke test (read-only)");
  console.log("  provider : gemini (@google/genai)");
  console.log(`  model    : ${process.env["GEMINI_MODEL"] ?? "gemini-3.5-flash-lite"}`);
  console.log("  key      : present (never printed)");
  console.log("  catalog  : the configured hosted database (never printed)");
  console.log(`  prompt   : ${PROMPT}\n`);

  const startedAt = Date.now();
  await withQuotaPatience("staged", stagedPass);
  await endToEndPass();

  console.log(`\nCompleted in ${String(Date.now() - startedAt)}ms.`);
  console.log("BUYER AGENT SMOKE PASSED: intent, tool loop and selection all validated.");
  console.log("No transaction, quote, approval, reservation or payment was created.");
}

main()
  .catch((error: unknown) => {
    if (error instanceof SmokeBlocked) {
      console.log(`\nBLOCKED BY THE PROVIDER at ${error.message}.`);
      console.log("This is an account or upstream limit, not an implementation failure.");
      return;
    }
    if (error instanceof SmokeFailure) {
      console.error(`\nBUYER AGENT SMOKE FAILED: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => disconnectPrismaClient());
