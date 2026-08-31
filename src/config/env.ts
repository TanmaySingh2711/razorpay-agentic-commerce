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
 * several files at once.
 */
const geminiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).max(100).default("gemini-3.6-flash"),
});

const razorpayEnvSchema = z.object({
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
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

/** Server-side application secret, for future session and CSRF signing. */
const appSecretEnvSchema = z.object({
  APP_SECRET: z.string().min(32),
});

export type RuntimeConfig = Readonly<z.infer<typeof runtimeEnvSchema>>;
export type GeminiConfig = Readonly<z.infer<typeof geminiEnvSchema>>;
export type RazorpayConfig = Readonly<z.infer<typeof razorpayEnvSchema>>;
export type DatabaseConfig = Readonly<z.infer<typeof databaseEnvSchema>>;
export type CatalogConfig = Readonly<z.infer<typeof catalogEnvSchema>>;
export type QuoteConfig = Readonly<z.infer<typeof quoteEnvSchema>>;
export type ApprovalConfig = Readonly<z.infer<typeof approvalEnvSchema>>;
export type ReservationConfig = Readonly<z.infer<typeof reservationEnvSchema>>;
export type AppSecretConfig = Readonly<z.infer<typeof appSecretEnvSchema>>;

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
    throw new ConfigurationError({
      code: "CONFIG_INVALID",
      message: `Invalid or missing ${sectionName} configuration: ${variableNames.join(", ")}. See .env.example.`,
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

/** Application secret. Called only by the session/CSRF layer, server-side. */
export function getAppSecretConfig(source: EnvSource = currentEnv()): AppSecretConfig {
  return Object.freeze(parseSection(appSecretEnvSchema, "application secret", source));
}

export type OptionalConfigSection = "gemini" | "razorpay" | "database" | "appSecret";

const OPTIONAL_SECTION_SCHEMAS: Record<OptionalConfigSection, z.ZodType> = {
  gemini: geminiEnvSchema,
  razorpay: razorpayEnvSchema,
  database: databaseEnvSchema,
  appSecret: appSecretEnvSchema,
};

/** Reports whether a later-objective section is configured, without throwing. */
export function isSectionConfigured(section: OptionalConfigSection): boolean {
  return OPTIONAL_SECTION_SCHEMAS[section].safeParse(currentEnv()).success;
}

export function isProduction(): boolean {
  return getRuntimeConfig().NODE_ENV === "production";
}

/** Test-only: drops the memoised runtime config. */
export function resetConfigCache(): void {
  runtimeConfigCache = undefined;
}
