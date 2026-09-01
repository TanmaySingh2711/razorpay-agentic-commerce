import { handleCreatePaymentOrder } from "@/app/api/payments/handler";

/**
 * The payment-order endpoint.
 *
 * Node runtime because Prisma and the Razorpay adapter are both server-only,
 * and force-dynamic because the decision depends on live quote, reservation and
 * policy rows that must never be served from a cache.
 *
 * The body is `{ "transactionId": "..." }`. Nothing financial is accepted from
 * the caller, and `RAZORPAY_KEY_SECRET` never leaves the server.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleCreatePaymentOrder(request);
}
