import { z } from "zod";
import { ConfigurationError } from "@/domain/errors";

/**
 * The single configuration boundary.
 *
 * Nothing else in the codebase reads `process.env` (enforced by an ESLint rule).
 * Config is validated once, typed, and handed out through accessors.
 *
 * Configuration is tiered on purpose:
 *
 *   - Runtime config is required now and fully defaulted, so the foundation
 *     boots, builds and tests with an entirely empty environment. No secret is
 *     needed to run this repository today.
 *   - Provider config (Gemini, Razorpay, database) is validated *lazily*,
 *     at the moment the feature that needs it runs. A missing Razorpay secret
 *     must fail the payment path loudly, not prevent the app from starting.
 *
 * Failures report variable NAMES only. A validation message must never echo a
 * value, because the values here are secrets.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

const runtimeEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/**
 * The runtime AI provider: the Google Gemini Developer API.
 *
 * Validated lazily, at the moment a model call is made, so the application
 * still boots, builds and runs its non-AI tests with no key present. The key is
 * server-only and must never appear in a NEXT_PUBLIC_* variable, a client
 * bundle, a log line or a response.
 *
 * `GEMINI_MODEL` is configuration rather than a constant scattered through the
 * source: changing model must be an environment decision, not a code change in
 * several files at once. The production default is `gemini-3.5-flash-lite`,
 * chosen for latency: the Buyer Agent is a synchronous request inside a user's
 * browser session, and `gemini-3.6-flash` was repeatedly observed in
 * production reaching the full 30-second per-attempt ceiling, leaving no room
 * for a retry inside the overall request budget.
 *
 * `GEMINI_THINKING_LEVEL` bounds how much hidden reasoning the model performs
 * before answering, using the Interactions API's `generation_config.thinking_level`.
 * The Buyer Agent's own work is schema-constrained (intent extraction, product
 * selection) or tool-constrained (catalog access), and every financial
 * decision is deterministic and made outside the model entirely - so there is
 * nothing here that benefits from extended hidden reasoning, only latency it
 * would spend. `minimal` is the default and the intended production value;
 * the variable exists so a deployment can raise it deliberately without a code
 * change, not because a higher value is expected to be needed.
 */
const geminiThinkingLevelSchema = z
  .enum(["minimal", "low", "medium", "high"])
  .default("minimal");

const geminiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).max(100).default("gemini-3.5-flash-lite"),
  GEMINI_THINKING_LEVEL: geminiThinkingLevelSchema,
});

/** The Interactions API's supported `generation_config.thinking_level` values. */
export type GeminiThinkingLevel = z.infer<typeof geminiThinkingLevelSchema>;

/**
 * The API credentials the Razorpay adapter authenticates with.
 *
 * Split out from the full Razorpay section deliberately. Creating a payment
 * order needs a key id and a key secret and nothing else; the webhook secret
 * belongs to a verification path that does not exist yet. Validating all three
 * together would mean an unconfigured webhook blocks order creation - a control
 * failing a path it has no authority over, which is how systems acquire
 * unexplainable outages.
 *
 * `RAZORPAY_KEY_SECRET` is server-only without qualification. It authenticates
 * this application to Razorpay and signs nothing the browser needs, so it must
 * never appear in a NEXT_PUBLIC_* variable, a client bundle, a log line, an
 * audit payload or an API response. `RAZORPAY_KEY_ID` is the public half and
 * Checkout legitimately needs it in the browser.
 *
 * The key id must be a Test Mode key, and that is enforced here rather than
 * described. This project moves no real money, and the smoke scripts already
 * refused to run against a live key - but the scripts are the one path a
 * developer takes deliberately, while this is the path every deployed request
 * takes. Leaving the deployed runtime as the only unguarded entry point had it
 * exactly backwards: a live key pasted into a hosting dashboard would have been
 * accepted silently, and the first sign of the mistake would have been a real
 * charge against a real person.
 *
 * It fails closed and names the mode, never the key.
 */
const RAZORPAY_TEST_KEY_PREFIX = "rzp_test_";

const razorpayCredentialsSchema = z.object({
  RAZORPAY_KEY_ID: z
    .string()
    .min(1)
    .refine((keyId) => keyId.startsWith(RAZORPAY_TEST_KEY_PREFIX), {
      message: `must be a Razorpay Test Mode key id (${RAZORPAY_TEST_KEY_PREFIX}...). This application must never run against live credentials.`,
    }),
  RAZORPAY_KEY_SECRET: z.string().min(1),
});

const razorpayEnvSchema = razorpayCredentialsSchema.extend({
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
});

/**
 * Just the webhook secret, for the inbound webhook verifier.
 *
 * Narrow for the same reason the credentials are narrow, in the other
 * direction: verifying an inbound provider event needs no API key, so a
 * deployment missing one must not stop the system from authenticating the
 * events it receives. The two secrets are also genuinely different
 * credentials - the API key secret authenticates us to Razorpay, this one
 * authenticates Razorpay to us - and keeping them in separate sections makes
 * reaching for the wrong one at a call site harder.
 */
const razorpayWebhookSchema = z.object({
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
});

/**
 * PostgreSQL, accessed through Prisma from Objective 2 onward.
 *
 * Two URLs, because a hosted/pooled Postgres needs them: `DATABASE_URL` is the
 * pooled runtime connection the application uses per request, and `DIRECT_URL`
 * is the direct admin connection migrations require - connection poolers
 * generally cannot run DDL. `DIRECT_URL` is optional so a plain unpooled
 * Postgres works with `DATABASE_URL` alone.
 */
const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),
});

/**
 * Which merchant the public catalog serves.
 *
 * Fully defaulted, so the catalog works on a fresh clone against the seeded
 * demo merchant with no environment file at all. It is configuration rather
 * than a request parameter on purpose: if a caller could name the merchant,
 * every catalog endpoint would become a way to enumerate other merchants'
 * products.
 */
const catalogEnvSchema = z.object({
  CATALOG_MERCHANT_SLUG: z.string().min(1).max(80).default("keebworks-india"),
});

/**
 * How long a trusted PurchaseQuote stays usable.
 *
 * One place, one value. A quote freezes a price the merchant is standing
 * behind, so the window has to be long enough for a human to read it and pay,
 * and short enough that the frozen price is still roughly true - a few minutes.
 *
 * Defaulted, so no new secret or online setup is needed, and centralised so the
 * duration cannot drift between the code that stamps expiry and the code that
 * checks it.
 */
const quoteEnvSchema = z.object({
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
});

/**
 * How long a human has to answer an approval request.
 *
 * Long enough that someone can read a notification, look at the price and
 * decide; short enough that an unanswered question does not sit there as a live
 * spending authorization. The approval is bound to one exact quote, and quotes
 * expire on their own clock, so this window is about the person, not the price.
 */
const approvalEnvSchema = z.object({
  APPROVAL_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(900),
});

/**
 * How long reserved stock is held for one transaction.
 *
 * This is the checkout window: the time between "the stock is yours" and "pay
 * or lose it". Too long and a browser tab nobody returns to starves real
 * buyers; too short and a genuine payment fails at the last step.
 */
const reservationEnvSchema = z.object({
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
});

export type RuntimeConfig = Readonly<z.infer<typeof runtimeEnvSchema>>;
export type GeminiConfig = Readonly<z.infer<typeof geminiEnvSchema>>;
export type RazorpayCredentials = Readonly<z.infer<typeof razorpayCredentialsSchema>>;
export type RazorpayConfig = Readonly<z.infer<typeof razorpayEnvSchema>>;
export type RazorpayWebhookConfig = Readonly<z.infer<typeof razorpayWebhookSchema>>;
export type DatabaseConfig = Readonly<z.infer<typeof databaseEnvSchema>>;
export type CatalogConfig = Readonly<z.infer<typeof catalogEnvSchema>>;
export type QuoteConfig = Readonly<z.infer<typeof quoteEnvSchema>>;
export type ApprovalConfig = Readonly<z.infer<typeof approvalEnvSchema>>;
export type ReservationConfig = Readonly<z.infer<typeof reservationEnvSchema>>;

/**
 * Describes one failed variable without ever quoting its value.
 *
 * Naming the variable alone is not always enough. A value that is present but
 * breaks a rule reports identically to one that was never set, so an operator
 * reading "RAZORPAY_KEY_ID" concludes the variable did not save, sets the same
 * rejected value again, and learns nothing. That is a poor failure mode for a
 * configuration error and a genuinely dangerous one for a safety rule.
 *
 * Two things are therefore added, both value-free:
 *
 *  - `missing` versus `invalid`, decided by whether the variable is present in
 *    the environment at all.
 *  - For a `custom` issue - a `.refine()` in this file - the message we wrote
 *    ourselves. Only `custom` qualifies, deliberately: Zod's built-in messages
 *    can echo the received value (an enum mismatch quotes what it got), and no
 *    validator in this file may print a secret. Our own refine messages are
 *    static strings written here, so they cannot contain one.
 */
function describeIssue(issue: z.core.$ZodIssue, source: EnvSource): string {
  const name = String(issue.path[0] ?? "<unknown>");
  if (issue.code === "custom") {
    return `${name} (${issue.message})`;
  }
  return source[name] === undefined ? `${name} (missing)` : `${name} (invalid)`;
}

function parseSection<TSchema extends z.ZodType>(
  schema: TSchema,
  sectionName: string,
  source: EnvSource,
): z.infer<TSchema> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const variableNames = [
      ...new Set(
        parsed.error.issues.map((issue) => String(issue.path[0] ?? "<unknown>")),
      ),
    ].sort();
    const described = [
      ...new Set(parsed.error.issues.map((issue) => describeIssue(issue, source))),
    ].sort();
    throw new ConfigurationError({
      code: "CONFIG_INVALID",
      message: `Invalid or missing ${sectionName} configuration: ${described.join(", ")}. See .env.example.`,
      details: { section: sectionName, variables: variableNames },
    });
  }
  return parsed.data;
}

function currentEnv(): EnvSource {
  return process.env;
}

let runtimeConfigCache: RuntimeConfig | undefined;

/** Validated runtime configuration. Always available; never requires a secret. */
export function getRuntimeConfig(source: EnvSource = currentEnv()): RuntimeConfig {
  if (source === currentEnv() && runtimeConfigCache !== undefined) {
    return runtimeConfigCache;
  }
  const config = Object.freeze(parseSection(runtimeEnvSchema, "runtime", source));
  if (source === currentEnv()) {
    runtimeConfigCache = config;
  }
  return config;
}

/**
 * Gemini credentials and model. Called only by the Gemini provider adapter, on
 * the server, at the moment a model call is made. Never reached from a client
 * component - the adapter asserts server-only on import.
 */
export function getGeminiConfig(source: EnvSource = currentEnv()): GeminiConfig {
  return Object.freeze(parseSection(geminiEnvSchema, "Gemini", source));
}

/**
 * Razorpay credentials. Called only by the Razorpay integration boundary and
 * the webhook verifier. The secret and webhook secret are server-only and must
 * never be forwarded to the browser or written to a log.
 */
export function getRazorpayConfig(source: EnvSource = currentEnv()): RazorpayConfig {
  return Object.freeze(parseSection(razorpayEnvSchema, "Razorpay", source));
}

/**
 * Just the API credentials, for the order and payment adapter.
 *
 * Called at the moment a provider request is made, never at import time, so a
 * repository with no Razorpay account still boots, builds and runs every
 * deterministic test. The returned secret is passed straight into an
 * Authorization header and is never returned, rendered or logged.
 */
export function getRazorpayCredentials(
  source: EnvSource = currentEnv(),
): RazorpayCredentials {
  return Object.freeze(
    parseSection(razorpayCredentialsSchema, "Razorpay credentials", source),
  );
}

/**
 * The webhook secret alone. Called only by the inbound webhook verifier, on the
 * server, at the moment a signature is checked. Never returned or logged.
 */
export function getRazorpayWebhookConfig(
  source: EnvSource = currentEnv(),
): RazorpayWebhookConfig {
  return Object.freeze(parseSection(razorpayWebhookSchema, "Razorpay webhook", source));
}

/** PostgreSQL connection. Called only by the Prisma persistence boundary. */
export function getDatabaseConfig(source: EnvSource = currentEnv()): DatabaseConfig {
  return Object.freeze(parseSection(databaseEnvSchema, "database", source));
}

/** Catalog configuration. Always available; needs no secret. */
export function getCatalogConfig(source: EnvSource = currentEnv()): CatalogConfig {
  return Object.freeze(parseSection(catalogEnvSchema, "catalog", source));
}

/** Quote lifetime. Always available; needs no secret. */
export function getQuoteConfig(source: EnvSource = currentEnv()): QuoteConfig {
  return Object.freeze(parseSection(quoteEnvSchema, "quote", source));
}

/** Approval window. Always available; needs no secret. */
export function getApprovalConfig(source: EnvSource = currentEnv()): ApprovalConfig {
  return Object.freeze(parseSection(approvalEnvSchema, "approval", source));
}

/** Reservation window. Always available; needs no secret. */
export function getReservationConfig(
  source: EnvSource = currentEnv(),
): ReservationConfig {
  return Object.freeze(parseSection(reservationEnvSchema, "reservation", source));
}

export type OptionalConfigSection =
  "gemini" | "razorpay" | "razorpayCredentials" | "razorpayWebhook" | "database";

const OPTIONAL_SECTION_SCHEMAS: Record<OptionalConfigSection, z.ZodType> = {
  gemini: geminiEnvSchema,
  razorpay: razorpayEnvSchema,
  razorpayCredentials: razorpayCredentialsSchema,
  razorpayWebhook: razorpayWebhookSchema,
  database: databaseEnvSchema,
};

/** Reports whether an optional section is configured, without throwing. */
export function isSectionConfigured(section: OptionalConfigSection): boolean {
  return OPTIONAL_SECTION_SCHEMAS[section].safeParse(currentEnv()).success;
}
