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
 *   - Provider config (Anthropic, Razorpay, database) is validated *lazily*,
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

const anthropicEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5"),
});

const razorpayEnvSchema = z.object({
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
});

const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

export type RuntimeConfig = Readonly<z.infer<typeof runtimeEnvSchema>>;
export type AnthropicConfig = Readonly<z.infer<typeof anthropicEnvSchema>>;
export type RazorpayConfig = Readonly<z.infer<typeof razorpayEnvSchema>>;
export type DatabaseConfig = Readonly<z.infer<typeof databaseEnvSchema>>;

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
 * Anthropic credentials. Called only by the LLM provider adapter, on the
 * server, at the moment a model call is made.
 */
export function getAnthropicConfig(source: EnvSource = currentEnv()): AnthropicConfig {
  return Object.freeze(parseSection(anthropicEnvSchema, "Anthropic", source));
}

/**
 * Razorpay credentials. Called only by the Razorpay integration boundary and
 * the webhook verifier. The secret and webhook secret are server-only and must
 * never be forwarded to the browser or written to a log.
 */
export function getRazorpayConfig(source: EnvSource = currentEnv()): RazorpayConfig {
  return Object.freeze(parseSection(razorpayEnvSchema, "Razorpay", source));
}

/** Datastore connection. Called only by the persistence layer. */
export function getDatabaseConfig(source: EnvSource = currentEnv()): DatabaseConfig {
  return Object.freeze(parseSection(databaseEnvSchema, "database", source));
}

/** Reports whether an optional section is configured, without throwing. */
export function isSectionConfigured(
  section: "anthropic" | "razorpay" | "database",
): boolean {
  const schema =
    section === "anthropic"
      ? anthropicEnvSchema
      : section === "razorpay"
        ? razorpayEnvSchema
        : databaseEnvSchema;
  return schema.safeParse(currentEnv()).success;
}

export function isProduction(): boolean {
  return getRuntimeConfig().NODE_ENV === "production";
}

/** Test-only: drops the memoised runtime config. */
export function resetConfigCache(): void {
  runtimeConfigCache = undefined;
}
