import { handleProductSearchRequest } from "@/app/api/catalog/handlers";

/**
 * Deterministic catalog list/search.
 *
 * Never cached: price, stock and availability are authoritative facts a stale
 * response could misreport to an agent about to spend money.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleProductSearchRequest(request);
}
