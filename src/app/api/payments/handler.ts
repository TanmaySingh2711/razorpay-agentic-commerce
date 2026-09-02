import { z } from "zod";
import { jsonData, respond } from "@/lib/api-response";
import { ValidationError } from "@/domain/errors";
import { checkRequestOrigin } from "@/lib/http/same-origin";
import { getRuntimeConfig } from "@/config/env";
import { getRazorpayCredentials } from "@/config/env";
import { MAX_PROVIDER_REFERENCE_LENGTH } from "@/domain/payment/rules";
import {
  createPaymentOrder,
  defaultPaymentOrderDeps,
  type PaymentOrderServiceDeps,
} from "@/services/payment/payment-order-service";
import {
  recordCheckoutDismissal,
  startCheckout,
  verifyCheckoutCallback,
  defaultCheckoutDeps,
  type CheckoutServiceDeps,
} from "@/services/payment/checkout-service";
import {
  requestPaymentRetry,
  defaultRetryDeps,
  type RetryServiceDeps,
} from "@/services/payment/retry-service";
import type { PaymentRetryResult } from "@/domain/payment/retry";
import type { PaymentOrderResult } from "@/domain/payment/contracts";
import type {
  CheckoutCallbackResult,
  CheckoutStartResult,
} from "@/domain/payment/checkout";
import type { JsonObject, JsonValue } from "@/lib/json";

/**
 * HTTP for payment-order creation.
 *
 * The request schema is the security boundary, and it is deliberately almost
 * empty. `z.strictObject` rejects unknown keys outright, so a caller who sends
 * `amount`, `currency`, `quoteId` or `providerOrderId` gets a 400 rather than
 * having those fields quietly ignored — a difference that matters, because
 * "ignored" is indistinguishable from "honoured" to whoever is probing, and a
 * loud refusal is what makes the boundary testable.
 *
 * Every financial value in the response is loaded server-side from the
 * persisted quote. The response carries the public key id for a later Checkout
 * objective; `RAZORPAY_KEY_SECRET` is never read here and could not be
 * serialised into this envelope even by accident, because nothing on this path
 * ever holds it.
 */

const requestSchema = z.strictObject({
  transactionId: z.string().min(1).max(64),
  /** Correlates this call in logs and audit. It is not the idempotency key. */
  operationId: z.string().min(1).max(64).optional(),
});

/**
 * HTTP statuses for outcomes that are not errors.
 *
 * `409 Conflict` for a claim another request owns, and `202 Accepted` for an
 * unresolved provider outcome. Neither is a 200 — a client must be able to tell
 * "your order is ready" from "we do not yet know" without parsing prose — and
 * neither is a 5xx, because nothing malfunctioned.
 */
const STATUS_BY_KIND: Record<PaymentOrderResult["kind"], number> = {
  ORDER_CREATED: 200,
  REFUSED: 422,
  PROVIDER_FAILED: 502,
  RECONCILIATION_REQUIRED: 202,
  CREATION_IN_PROGRESS: 409,
};

export function handleCreatePaymentOrder(
  request: Request,
  deps: PaymentOrderServiceDeps = defaultPaymentOrderDeps(),
): Promise<Response> {
  return respond(async () => {
    const parsed = await readBody(
      requestSchema,
      request,
      "PAYMENT_ORDER_REQUEST_INVALID",
      "Send only a transactionId. Amounts and prices are determined by the server.",
    );

    const result = await createPaymentOrder(
      {
        transactionId: parsed.transactionId,
        ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
      },
      deps,
    );

    return jsonData(
      result as unknown as JsonValue,
      checkoutMeta(result),
      STATUS_BY_KIND[result.kind],
    );
  });
}

/**
 * The public key id, returned only alongside a real order.
 *
 * Razorpay Checkout needs `key_id` in the browser and it is designed to be
 * public — it identifies the merchant and authorizes nothing on its own. It is
 * still withheld unless there is an order to pay for, so an endpoint probe
 * cannot be used to read configuration out of the server.
 *
 * The Checkout flow itself belongs to the next objective. This is the one field
 * it will need, placed here so that objective adds a page rather than reworking
 * this contract.
 */
function checkoutMeta(result: PaymentOrderResult): JsonObject {
  if (result.kind !== "ORDER_CREATED") return {};
  return { razorpayKeyId: getRazorpayCredentials().RAZORPAY_KEY_ID };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Starting checkout is a POST, and that is a design decision rather than a REST
 * convention.
 *
 * It moves the transaction to `PAYMENT_PENDING`, which must mean "a person
 * pressed Pay". If the session were handed out by rendering a page, that state
 * would also be reached by a refresh, a prefetch, a link preview or a crawler -
 * and would then mean nothing. A side-effecting verb, reached only from an
 * explicit click, is what keeps the state honest.
 */
const startSchema = z.strictObject({
  transactionId: z.string().min(1).max(64),
});

const CHECKOUT_START_STATUS: Record<CheckoutStartResult["kind"], number> = {
  CHECKOUT_READY: 200,
  REFUSED: 422,
};

export function handleStartCheckout(
  request: Request,
  deps: CheckoutServiceDeps = defaultCheckoutDeps(),
): Promise<Response> {
  return respond(async () => {
    const parsed = await readBody(startSchema, request, "CHECKOUT_REQUEST_INVALID");
    const result = await startCheckout({ transactionId: parsed.transactionId }, deps);
    return jsonData(
      result as unknown as JsonValue,
      {},
      CHECKOUT_START_STATUS[result.kind],
    );
  });
}

/**
 * The callback boundary.
 *
 * `presentedOrderId` is accepted and immediately distrusted. The provider's own
 * documentation says the order id returned to the browser must not be used for
 * verification, and this server does not use it: it loads its own copy and
 * signs over that. Keeping the field lets a mismatch be *detected and audited*
 * rather than silently discarded - a tampered order id is a security event, not
 * a stray parameter.
 *
 * Nothing else about money is accepted. There is no amount, no currency, and no
 * status field, so no request can assert that a payment succeeded.
 */
const callbackSchema = z.strictObject({
  transactionId: z.string().min(1).max(64),
  paymentAttemptId: z.string().min(1).max(64).optional(),
  // Bounded by the same constant the audit allow-list uses, so nothing this
  // endpoint accepts can be too long for the trail to record.
  razorpay_payment_id: z.string().min(1).max(MAX_PROVIDER_REFERENCE_LENGTH),
  razorpay_signature: z.string().min(1).max(256),
  razorpay_order_id: z.string().min(1).max(MAX_PROVIDER_REFERENCE_LENGTH).optional(),
});

const CALLBACK_STATUS: Record<CheckoutCallbackResult["kind"], number> = {
  PAYMENT_VERIFIED: 200,
  // 422, not 400: the request was well formed and the server understood it
  // perfectly - it simply refused to believe it.
  REJECTED: 422,
};

export function handleCheckoutCallback(
  request: Request,
  deps: CheckoutServiceDeps = defaultCheckoutDeps(),
): Promise<Response> {
  return respond(async () => {
    const body = await readBody(callbackSchema, request, "CALLBACK_REQUEST_INVALID");
    const result = await verifyCheckoutCallback(
      {
        transactionId: body.transactionId,
        ...(body.paymentAttemptId === undefined
          ? {}
          : { paymentAttemptId: body.paymentAttemptId }),
        providerPaymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
        ...(body.razorpay_order_id === undefined
          ? {}
          : { presentedOrderId: body.razorpay_order_id }),
      },
      deps,
    );
    return jsonData(result as unknown as JsonValue, {}, CALLBACK_STATUS[result.kind]);
  });
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * The retry boundary, and the reason it is this small.
 *
 * `z.strictObject` with two fields means every interesting attack is a `400`
 * rather than something quietly ignored: `retryCount: 0`, `retryLimit: 999`,
 * `amount: 1`, `currency: "USD"`, `providerOrderId: "order_theirs"`,
 * `policy: "ALLOWED"` and `approved: true` are all unknown keys and are all
 * refused by name. There is nothing to sanitise because there is nothing
 * accepted - the server counts attempts from `payment_attempt` rows, reads the
 * amount from the persisted quote, and re-derives the policy verdict itself.
 *
 * It is a POST because it is an action a person takes. Nothing reaches it from
 * a render, a prefetch or a webhook, and the buyer agent has no tool for it.
 */
const retrySchema = z.strictObject({
  transactionId: z.string().min(1).max(64),
  /** Correlates this call in logs and audit. It is not the idempotency key. */
  operationId: z.string().min(1).max(64).optional(),
});

/**
 * The status for an outcome that is not a started retry.
 *
 * `ORDER_NOT_READY` carries the payment-order boundary's own discriminator, and
 * it is mapped back to that boundary's own statuses rather than collapsed into
 * one code. The distinctions are the whole reason that union has four arms: a
 * definite provider failure, an outcome nobody can resolve yet, and a claim
 * another request already owns call for three different responses, and a client
 * told `202 Accepted` for all of them would treat "we do not know whether an
 * order exists" as "try again shortly" — which is how a duplicate order gets
 * created.
 *
 * These are the same numbers `/api/payments/order` answers with, so a client
 * needs one implementation for both.
 */
function retryStatus(result: PaymentRetryResult): number {
  switch (result.kind) {
    case "RETRY_STARTED":
      return 200;
    // Understood perfectly, and declined on its merits.
    case "DENIED":
      return 422;
    case "ORDER_NOT_READY":
      switch (result.reason) {
        case "REFUSED":
          return 422;
        case "PROVIDER_FAILED":
          return 502;
        // Nobody knows whether an order exists. Not an error, and emphatically
        // not a green light.
        case "RECONCILIATION_REQUIRED":
          return 202;
        case "CREATION_IN_PROGRESS":
          return 409;
      }
  }
}

export function handleRetryPayment(
  request: Request,
  deps: RetryServiceDeps = defaultRetryDeps(),
): Promise<Response> {
  return respond(async () => {
    const parsed = await readBody(retrySchema, request, "PAYMENT_RETRY_REQUEST_INVALID");
    const result = await requestPaymentRetry(
      {
        transactionId: parsed.transactionId,
        ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
      },
      deps,
    );
    return jsonData(result as unknown as JsonValue, {}, retryStatus(result));
  });
}

/** The buyer closed the payment window. Recorded; nothing is decided by it. */
export function handleCheckoutDismissed(
  request: Request,
  deps: CheckoutServiceDeps = defaultCheckoutDeps(),
): Promise<Response> {
  return respond(async () => {
    const parsed = await readBody(startSchema, request, "CHECKOUT_REQUEST_INVALID");
    const result = await recordCheckoutDismissal(
      { transactionId: parsed.transactionId },
      deps,
    );
    return jsonData(result as unknown as JsonValue);
  });
}

/**
/**
 * Refuses a state-changing request that another website caused.
 *
 * The refusal is a `ValidationError`, so it takes the same sanitised path to
 * the browser as every other rejection here: a stable code and a short public
 * message, with the detail kept in the operator log. It deliberately does not
 * say which origin was expected - that is a fact about the deployment, and the
 * caller already knows the one it sent.
 */
function assertNotCrossSite(request: Request, code: string): void {
  const verdict = checkRequestOrigin(request, getRuntimeConfig().APP_URL);
  if (verdict.allowed) return;
  throw new ValidationError({
    code,
    message: `A state-changing request arrived from a different site (${verdict.site}).`,
    publicMessage: "This request did not come from this site.",
  });
}

/**
 * Parses a request body against a strict schema.
 *
 * `z.strictObject` throughout, so an unexpected field is a `400` rather than
 * something quietly ignored. On these endpoints that matters more than usual:
 * a caller probing with `amount` or `status` must be told no, not left unable
 * to tell whether it worked.
 */
async function readBody<TSchema extends z.ZodType>(
  schema: TSchema,
  request: Request,
  code: string,
  /** A tailored sentence for the caller, when the generic one says too little. */
  publicMessage = "The request was not in the expected shape.",
): Promise<z.infer<TSchema>> {
  // Before the body is even read. This is the single door into every
  // state-changing payment endpoint, which is exactly why the cross-site
  // refusal lives here: a route cannot forget to call it and still read a body.
  assertNotCrossSite(request, code);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError({
      code,
      message: "The request body was not valid JSON.",
      publicMessage: "The request could not be read.",
    });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = rejectedFields(parsed.error.issues);
    throw new ValidationError({
      code,
      message: `Rejected fields: ${fields.join(", ")}.`,
      publicMessage,
      details: { fields },
    });
  }
  return parsed.data;
}

/**
 * Names what was actually wrong with a body.
 *
 * The `unrecognized_keys` case has to be read specially, and it is the one that
 * matters most here. Zod reports it with an **empty path** and the offending
 * names in `issue.keys`, so reading `path[0]` alone reduced every hostile field
 * - `amount`, `retryCount`, `providerOrderId` - to the single useless token
 * `<root>`. That is the difference between an operator seeing "somebody posted
 * an amount to the retry endpoint" and seeing "a request was malformed".
 *
 * These names go to the operational log and the internal message only. The
 * public payload carries a code, a category and a dull sentence, so echoing a
 * caller's own field names back to them is not a channel this opens.
 */
function rejectedFields(issues: readonly z.core.$ZodIssue[]): readonly string[] {
  const names = new Set<string>();
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) names.add(key);
      continue;
    }
    names.add(String(issue.path[0] ?? "<root>"));
  }
  return [...names].sort();
}
