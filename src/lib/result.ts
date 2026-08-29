/**
 * Explicit success/failure results for deterministic engines.
 *
 * The policy engine, product verification and the state machine all answer
 * questions ("is this allowed?") whose negative answer is an expected,
 * auditable outcome rather than an exception. Modelling that as a value forces
 * every caller to handle the "denied" branch instead of letting a missed
 * `catch` fall through toward a payment.
 *
 * Exceptions (see `@/domain/errors`) stay reserved for genuinely exceptional
 * conditions: misconfiguration, provider outages, programmer error.
 */
export type Result<TValue, TError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function err<TError>(error: TError): Result<never, TError> {
  return { ok: false, error };
}

export function isOk<TValue, TError>(
  result: Result<TValue, TError>,
): result is { readonly ok: true; readonly value: TValue } {
  return result.ok;
}

export function isErr<TValue, TError>(
  result: Result<TValue, TError>,
): result is { readonly ok: false; readonly error: TError } {
  return !result.ok;
}
