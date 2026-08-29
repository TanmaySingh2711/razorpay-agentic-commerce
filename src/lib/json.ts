/**
 * A conservative JSON value model.
 *
 * Structured logs, decision records and audit events must all be serialisable
 * and inspectable. Typing their payloads as JSON (rather than `unknown` or
 * `any`) keeps redaction possible: you cannot scrub a value you cannot walk.
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
