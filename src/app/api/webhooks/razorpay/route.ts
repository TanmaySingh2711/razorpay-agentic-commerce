import { handleRazorpayWebhook } from "@/app/api/webhooks/razorpay/handler";

/**
 * The Razorpay webhook endpoint.
 *
 * Node runtime because verification needs `node:crypto` for a timing-safe HMAC
 * and reconciliation needs Prisma over TCP; neither has an edge equivalent
 * here. Force-dynamic because a signed provider event must never be answered
 * from a cache.
 *
 * Only POST is exported. Anything else gets the framework's 405, which is the
 * right answer and costs this file nothing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleRazorpayWebhook(request);
}
