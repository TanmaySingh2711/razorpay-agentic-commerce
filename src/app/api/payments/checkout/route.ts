import { handleStartCheckout } from "@/app/api/payments/handler";

/**
 * Node runtime because Prisma and the Razorpay adapter are server-only, and
 * force-dynamic because every decision reads live transaction state that must
 * never be served from a cache.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleStartCheckout(request);
}
