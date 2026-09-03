import { handleBuyerAgentRequest } from "@/app/api/buyer-agent/handler";

/**
 * The Buyer Agent endpoint.
 *
 * Node runtime because the Gemini adapter and the Prisma catalog are both
 * server-only, and force-dynamic because every request reads live catalog data.
 * The API key never leaves the server: it is read through the config boundary
 * inside the adapter and is not part of any response.
 *
 * `maxDuration` is set explicitly rather than left to the hosting platform's
 * own default. This request's own worst case is bounded by
 * `OVERALL_REQUEST_BUDGET_MS` (50s, in `buyer-agent-service.ts`) - the deadline
 * every provider attempt is checked against before it starts - and 60 is a
 * deliberate application-level cap chosen with margin above that, not a
 * hosting platform ceiling: the current hosting tier allows materially longer
 * executions than this. Declaring a smaller, verified number here is what
 * lets the deadline's own clean, classified error reach the caller instead of
 * whatever the platform would otherwise do with an unbounded one. Without an
 * explicit value here, a production deployment that timed out twice at 30
 * seconds each was terminated with no error at all, because nothing had ever
 * stated - let alone verified - how long this route was meant to run.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleBuyerAgentRequest(request);
}
