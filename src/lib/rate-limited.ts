import { RateLimitedError } from "@/domain/errors";
import { jsonError } from "@/lib/api-response";
import { clientKeyFromHeaders } from "@/domain/rate-limit/rules";
import type { RateLimitDecision } from "@/services/rate-limit/rate-limit-service";

/**
 * Runs `handler` only if the caller is within its ceilings.
 *
 * Used by the thin `route.ts` files rather than inside the handlers, so a
 * handler's own tests stay what they are - pure functions of a request - and
 * the limiter is tested once, against PostgreSQL, where it actually lives.
 *
 * A refusal is a 429 in the ordinary error envelope with a `Retry-After`
 * header, so a well-behaved client knows when to come back. A limiter that
 * cannot answer at all (the database is unreachable) refuses too: see "Failing
 * closed" in the rate-limit service.
 */
export async function withRateLimit(
  request: Request,
  limit: (clientKey: string) => Promise<RateLimitDecision>,
  handler: () => Promise<Response>,
): Promise<Response> {
  let decision: RateLimitDecision;
  try {
    decision = await limit(clientKeyFromHeaders(request.headers));
  } catch (error) {
    return jsonError(error);
  }
  if (decision.kind === "LIMITED") {
    const response = jsonError(
      new RateLimitedError(decision.retryAfterSeconds, { rule: decision.rule }),
    );
    response.headers.set("retry-after", String(decision.retryAfterSeconds));
    return response;
  }
  return handler();
}
