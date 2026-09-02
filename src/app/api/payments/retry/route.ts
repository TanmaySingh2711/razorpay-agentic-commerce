import { handleRetryPayment } from "@/app/api/payments/handler";

/**
 * The payment retry endpoint.
 *
 * Node runtime because Prisma, the policy recheck and the Razorpay adapter are
 * all server-only. Force-dynamic because a retry decision is made from live
 * quote, reservation, policy and attempt rows, and an answer served from a
 * cache would be a decision made about a moment that has passed.
 *
 * Only POST is exported. A retry is an action a person takes, so it must not be
 * reachable by a render, a prefetch, a crawler or a link preview - and anything
 * other than POST gets the framework's 405.
 *
 * The body is `{ "transactionId": "..." }`. There is no retry count, no amount
 * and no order id to send: the server counts attempts from its own rows and
 * reads the amount from the persisted quote.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleRetryPayment(request);
}
