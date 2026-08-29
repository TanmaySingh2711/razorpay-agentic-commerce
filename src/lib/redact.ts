import { isJsonObject, type JsonObject, type JsonValue } from "@/lib/json";

export const REDACTED = "[REDACTED]";

/**
 * Keys whose values must never reach a log sink, an audit record, or a browser.
 *
 * Two families are covered. The first is credentials and payment instrument
 * data. The second is model internals: `reasoning`, `thinking` and
 * `chain_of_thought` are excluded because hidden reasoning is unverified text
 * that must not become part of a financial record.
 */
const SENSITIVE_KEY_PATTERN =
  /(secret|password|passwd|token|api[_-]?key|authorization|auth|signature|cookie|session|credential|private[_-]?key|card|cvv|cvc|pan|upi|vpa|otp|chain[_-]?of[_-]?thought|reasoning|thinking|prompt)/i;

/** Long strings are truncated so a stray payload cannot flood the log stream. */
const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 6;

function redactValue(value: JsonValue, depth: number): JsonValue {
  if (depth > MAX_DEPTH) return "[TRUNCATED_DEPTH]";

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  if (isJsonObject(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactValue(entry, depth + 1);
    }
    return output;
  }

  return value;
}

/** Returns a copy of the metadata with sensitive keys replaced by a marker. */
export function redact(metadata: JsonObject): JsonObject {
  const redacted = redactValue(metadata, 0);
  return isJsonObject(redacted) ? redacted : {};
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
