import { handleBuyerAgentRequest } from "@/app/api/buyer-agent/handler";

/**
 * The Buyer Agent endpoint.
 *
 * Node runtime because the Gemini adapter and the Prisma catalog are both
 * server-only, and force-dynamic because every request reads live catalog data.
 * The API key never leaves the server: it is read through the config boundary
 * inside the adapter and is not part of any response.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleBuyerAgentRequest(request);
}
