import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertServerOnly } from "@/lib/server-only";
import { getRazorpayCredentials } from "@/config/env";
import { createLogger } from "@/lib/logger";
import type {
  CheckoutSignatureInput,
  PaymentOrderRequest,
  PaymentProvider,
  ProviderFailure,
  ProviderFailureCategory,
  ProviderLookupOutcome,
  ProviderOrder,
  ProviderOrderOutcome,
} from "@/domain/payment/provider";
import { assessPayableAmount, toProviderAmount } from "@/domain/payment/rules";

/**
 * Razorpay, and the only file in this repository that knows it exists.
 *
 * Everything above the port in `@/domain/payment/provider` speaks in
 * application terms; this module is where those become `POST /v1/orders`, HTTP
 * Basic auth, and a JSON body whose shape belongs to somebody else.
 *
 * **Why the documented REST API rather than the `razorpay` npm SDK.** The
 * official SDK is a thin wrapper that makes exactly these calls over axios, and
 * its published types are loose enough that provider responses would arrive
 * here as effectively untyped objects. This repository's whole posture is that
 * external data is parsed at the boundary before anything financial reads it,
 * so the response is validated with Zod either way — and doing it directly
 * keeps the timeout explicit, adds no runtime dependency, and leaves the port
 * as the only thing the service depends on. Swapping in the SDK later means
 * rewriting this file and nothing else.
 *
 * **The rule that matters most in here**: `createOrder` calls the create
 * endpoint at most once, ever. Every recovery path is a *read*. An ambiguous
 * answer is resolved by looking the receipt up, never by asking again, because
 * asking again is how one purchase becomes two payment orders.
 *
 * Razorpay makes that possible because the receipt is documented as the
 * idempotency identity for order creation — "a second create call with the same
 * value is rejected" — and because orders can be fetched by receipt. Those two
 * facts, together, are what let this adapter be safe without a distributed lock.
 */
assertServerOnly("src/integrations/payments/razorpay-provider.ts");

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

/**
 * Long enough for a slow but healthy provider, short enough that a request
 * thread is not held indefinitely. A timeout here is explicitly *ambiguous*:
 * we stopped listening, which says nothing about whether Razorpay acted.
 */
const REQUEST_TIMEOUT_MS = 15_000;

const log = createLogger({ category: "payment" });

/**
 * The provider response, as much of it as this application relies on.
 *
 * Unknown keys are allowed — Razorpay adds fields, and refusing an order
 * because a new one appeared would be a self-inflicted outage. What is *not*
 * allowed is a missing or wrong-typed field among the ones below, because those
 * carry the money.
 */
const razorpayOrderSchema = z.object({
  id: z.string().min(1).max(128),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
  receipt: z.string().max(40).nullish(),
  status: z.string().min(1).max(32),
});

const razorpayOrderListSchema = z.object({
  items: z.array(razorpayOrderSchema),
});

const razorpayErrorSchema = z.object({
  error: z.object({
    code: z.string().max(64).optional(),
    reason: z.string().max(128).nullish(),
  }),
});

export interface RazorpayProviderOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected in tests so no HTTP stack is involved. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Builds the adapter from validated configuration.
 *
 * Credentials are read here, at construction, and never again — and they are
 * held only to build an Authorization header. They are not stored on the
 * returned object's enumerable surface, not logged, and not included in any
 * error this module throws.
 */
export function createRazorpayProvider(
  options?: Partial<RazorpayProviderOptions>,
): PaymentProvider {
  const credentials =
    options?.keyId !== undefined && options.keySecret !== undefined
      ? { RAZORPAY_KEY_ID: options.keyId, RAZORPAY_KEY_SECRET: options.keySecret }
      : getRazorpayCredentials();

  const baseUrl = options?.baseUrl ?? RAZORPAY_API_BASE;
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const doFetch = options?.fetchImpl ?? fetch;

  const authorization = `Basic ${Buffer.from(
    `${credentials.RAZORPAY_KEY_ID}:${credentials.RAZORPAY_KEY_SECRET}`,
    "utf8",
  ).toString("base64")}`;

  async function call(
    path: string,
    init: { readonly method: "GET" | "POST"; readonly body?: string },
  ): Promise<HttpOutcome> {
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization,
          accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" as const }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();
      return { kind: "ANSWERED", status: response.status, text };
    } catch (error) {
      // A thrown fetch means no answer arrived. Which of the two it was
      // changes nothing about safety — both are ambiguous — but an operator
      // reading a log wants to know whether we gave up or were refused.
      const timedOut =
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return { kind: "NO_ANSWER", category: timedOut ? "TIMEOUT" : "NETWORK_FAILURE" };
    }
  }

  async function findOrderByReceipt(receipt: string): Promise<ProviderLookupOutcome> {
    const query = new URLSearchParams({ receipt, count: "1" });
    const outcome = await call(`/orders?${query.toString()}`, { method: "GET" });

    if (outcome.kind === "NO_ANSWER") {
      return { kind: "FAILED", failure: failure(outcome.category, null, null) };
    }
    if (outcome.status !== 200) {
      return {
        kind: "FAILED",
        failure: classifyStatus(outcome.status, outcome.text),
      };
    }

    const parsed = parseJson(outcome.text, razorpayOrderListSchema);
    if (parsed === null) {
      return {
        kind: "FAILED",
        failure: failure("UNREADABLE_RESPONSE", 200, "ORDER_LIST_UNPARSABLE"),
      };
    }

    // The filter is the provider's; matching the receipt exactly here means a
    // broadened server-side filter could never hand us somebody else's order.
    const match = parsed.items.find((item) => item.receipt === receipt);
    return match === undefined
      ? { kind: "NOT_FOUND" }
      : { kind: "FOUND", order: toProviderOrder(match) };
  }

  return {
    name: "RAZORPAY",

    findOrderByReceipt,

    /**
     * Razorpay's documented checkout-callback signature.
     *
     *     expected = HMAC_SHA256(`${order_id}|${payment_id}`, key_secret)
     *
     * Two rules from the official documentation are load-bearing here, and both
     * are the difference between a check and the appearance of one.
     *
     * **The order id must come from our database.** Razorpay states it plainly:
     * do not use the `razorpay_order_id` returned to the browser, retrieve it
     * from your server. If the client supplied both halves of the payload it
     * would be signing its own homework - an attacker with any valid order of
     * their own could present it against somebody else's transaction and the
     * HMAC would verify perfectly. The parameter is named `serverStoredOrderId`
     * so that a call site handing it client input reads as wrong.
     *
     * **The comparison is timing-safe.** A byte-by-byte `===` leaks how much of
     * a guessed signature was correct, which turns forgery into a few thousand
     * requests rather than an impossibility. `timingSafeEqual` throws on
     * unequal lengths, so the shape is validated first and the length checked
     * before it is ever called - malformed input fails closed and never throws.
     *
     * The secret is used here and only here. It is never returned, logged, put
     * in an error, or included in anything this function hands back.
     */
    verifyCheckoutSignature(input: CheckoutSignatureInput): boolean {
      // A Razorpay signature is a SHA-256 hex digest: 64 hex characters. Anything
      // else cannot be a signature, and `Buffer.from(x, "hex")` would silently
      // truncate rather than reject it - so the shape is checked explicitly.
      if (!/^[0-9a-f]{64}$/i.test(input.signature)) return false;
      if (input.serverStoredOrderId.length === 0) return false;
      if (input.providerPaymentId.length === 0) return false;

      const expected = createHmac("sha256", credentials.RAZORPAY_KEY_SECRET)
        .update(`${input.serverStoredOrderId}|${input.providerPaymentId}`, "utf8")
        .digest();
      const received = Buffer.from(input.signature, "hex");

      if (received.length !== expected.length) return false;
      return timingSafeEqual(expected, received);
    },

    async createOrder(request: PaymentOrderRequest): Promise<ProviderOrderOutcome> {
      // Last-line amount check. The service has already done this; the point of
      // repeating it is that this is the final frame before the number leaves
      // the process, and no path may skip it.
      const amount = assessPayableAmount(request.amountMinor, request.currency);
      if (amount.kind !== "PAYABLE") {
        return {
          kind: "FAILED",
          failure: failure("INVALID_REQUEST", null, `AMOUNT_${amount.refusal}`),
        };
      }

      const body = JSON.stringify({
        amount: toProviderAmount(amount),
        currency: request.currency,
        receipt: request.receipt,
        ...(request.notes === undefined ? {} : { notes: request.notes }),
      });

      const outcome = await call("/orders", { method: "POST", body });

      if (outcome.kind === "ANSWERED" && outcome.status === 200) {
        const parsed = parseJson(outcome.text, razorpayOrderSchema);
        if (parsed !== null) {
          return { kind: "CREATED", order: toProviderOrder(parsed) };
        }
        // A 200 we cannot read is the worst case: an order very probably
        // exists and we cannot say which. Fall through to recovery.
      }

      const initialFailure =
        outcome.kind === "NO_ANSWER"
          ? failure(outcome.category, null, null)
          : outcome.status === 200
            ? failure("UNREADABLE_RESPONSE", 200, "ORDER_UNPARSABLE")
            : classifyStatus(outcome.status, outcome.text);

      return resolveByLookup(initialFailure, request);
    },
  };

  /**
   * Turns a failed create into a definite answer wherever the provider will
   * give us one.
   *
   * Two categories are answered without asking. If our credentials were
   * refused, nothing was created and a lookup would be refused identically. If
   * we were rate limited, the request was rejected before it was processed. In
   * both cases a second call only costs a round trip and muddies the log.
   *
   * Everything else gets a lookup, and the lookup is what makes the ambiguity
   * go away: finding the order means it was created despite the failure, and
   * finding nothing means it definitively was not. Only a lookup that itself
   * fails leaves us in UNKNOWN — the state that must never be retried blindly.
   */
  async function resolveByLookup(
    initial: ProviderFailure,
    request: PaymentOrderRequest,
  ): Promise<ProviderOrderOutcome> {
    if (
      initial.category === "AUTHENTICATION_FAILED" ||
      initial.category === "RATE_LIMITED"
    ) {
      return { kind: "FAILED", failure: initial };
    }

    const lookup = await findOrderByReceipt(request.receipt);

    if (lookup.kind === "FOUND") {
      // Guard against the receipt naming something we did not ask for. It
      // should be impossible - receipts are unique per attempt - but "should be
      // impossible" is not a reason to adopt an order on faith.
      const matches =
        lookup.order.amountMinor === request.amountMinor &&
        lookup.order.currency === request.currency;
      if (!matches) {
        log.error("recovered provider order does not match the request", {
          receipt: request.receipt,
          providerOrderId: lookup.order.providerOrderId,
        });
        return {
          kind: "UNKNOWN",
          failure: failure(initial.category, initial.httpStatus, "RECOVERED_MISMATCH"),
        };
      }
      return { kind: "ALREADY_EXISTS", order: lookup.order };
    }

    if (lookup.kind === "NOT_FOUND") {
      // Authoritative: no order exists for this receipt, so the failure is
      // definite even if the original symptom was a timeout.
      return { kind: "FAILED", failure: initial };
    }

    return { kind: "UNKNOWN", failure: initial };
  }
}

type HttpOutcome =
  | { readonly kind: "ANSWERED"; readonly status: number; readonly text: string }
  | { readonly kind: "NO_ANSWER"; readonly category: ProviderFailureCategory };

function toProviderOrder(order: z.infer<typeof razorpayOrderSchema>): ProviderOrder {
  return {
    providerOrderId: order.id,
    // The provider's integer is minor units, exactly as we sent it. Widening to
    // bigint is the only transformation; there is no arithmetic on this path.
    amountMinor: BigInt(order.amount),
    currency: order.currency,
    receipt: order.receipt ?? null,
    status: order.status,
  };
}

/**
 * Maps an HTTP status onto an application category.
 *
 * The provider's own `description` is deliberately never carried forward: it is
 * prose that can echo request content, and a mapped code is what callers and
 * audit records are allowed to see. Only the short, enumerable `code`/`reason`
 * fields are kept, and only after length-bounded parsing.
 */
function classifyStatus(status: number, text: string): ProviderFailure {
  const parsed = parseJson(text, razorpayErrorSchema);
  const code = parsed?.error.code ?? parsed?.error.reason ?? null;

  if (status === 401 || status === 403) {
    return failure("AUTHENTICATION_FAILED", status, code);
  }
  if (status === 429) {
    return failure("RATE_LIMITED", status, code);
  }
  if (status >= 500) {
    return failure("PROVIDER_UNAVAILABLE", status, code);
  }
  return failure("INVALID_REQUEST", status, code);
}

function failure(
  category: ProviderFailureCategory,
  httpStatus: number | null,
  code: string | null,
): ProviderFailure {
  return { category, code: code ?? category, httpStatus };
}

function parseJson<TSchema extends z.ZodType>(
  text: string,
  schema: TSchema,
): z.infer<TSchema> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
