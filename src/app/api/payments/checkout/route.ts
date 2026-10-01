import { handleStartCheckout } from "@/app/api/payments/handler";
import { withRateLimit } from "@/lib/http/rate-limited";
import { limitPaymentRequest } from "@/services/rate-limit/rate-limit-service";

/**
 * Node runtime because Prisma and the Razorpay adapter are server-only, and
 * force-dynamic because every decision reads live transaction state that must
 * never be served from a cache.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  // A money endpoint: hammering it is refused before any row is read.
  return withRateLimit(
    request,
    (client) => limitPaymentRequest(client),
    () => handleStartCheckout(request),
  );
}
