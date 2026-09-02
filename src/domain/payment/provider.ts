import type { CurrencyCode } from "@/domain/money";

/**
 * The payment provider, as this application chooses to see one.
 *
 * Vendor-neutral by construction: nothing in this file names Razorpay, uses a
 * Razorpay type, or assumes a Razorpay field. The adapter in
 * `@/integrations/payments/razorpay-provider` translates; everything above it
 * — the payment order service, the state machine, the audit trail — speaks only
 * the vocabulary declared here.
 *
 * That boundary is not tidiness. Provider responses are the least trustworthy
 * data in the system: they arrive over a network that drops answers, they carry
 * vendor error taxonomies that change, and their shapes are documented rather
 * than guaranteed. Letting one leak upward would put an unvalidated external
 * object next to the code that decides whether money moves.
 *
 * The single most important thing this interface expresses is that **a provider
 * call has three outcomes, not two**. It can succeed, it can definitely fail,
 * and it can leave us not knowing — and the third is the one that creates
 * duplicate charges when a design pretends it does not exist.
 */

/** What the application asks a provider to create. Entirely server-derived. */
export interface PaymentOrderRequest {
  /** Integer minor units. Already minor: never multiplied by 100 again. */
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  /**
   * Our own stable reference for this logical order creation.
   *
   * It is the idempotency identity of the external call, so it must be
   * identical across every retry of the same operation and unique across
   * different ones.
   */
  readonly receipt: string;
  /** Minimal, safe, non-identifying context. Never a secret, never model text. */
  readonly notes?: Readonly<Record<string, string>>;
}

/** A provider order, reduced to the fields this application relies on. */
export interface ProviderOrder {
  readonly providerOrderId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly receipt: string | null;
  /** The provider's own lifecycle word, kept verbatim for reconciliation. */
  readonly status: string;
}

/**
 * Why a provider call did not produce a confirmed order.
 *
 * Application-owned, closed, and mapped from whatever the vendor said. A caller
 * branches on these; it never reads a provider error code, and no provider
 * message reaches a user.
 */
export const PROVIDER_FAILURE_CATEGORIES = [
  /** Our credentials were refused. A configuration fault, never retried. */
  "AUTHENTICATION_FAILED",
  /** The provider rejected the request itself. Retrying sends the same thing. */
  "INVALID_REQUEST",
  /** This receipt was already used. The order exists; find it, do not remake it. */
  "DUPLICATE_RECEIPT",
  /** We are calling too often. Safe to retry later, with backoff. */
  "RATE_LIMITED",
  /** The provider failed on its side. */
  "PROVIDER_UNAVAILABLE",
  /** The request never reached the provider, or the answer never came back. */
  "NETWORK_FAILURE",
  /** We stopped waiting. Says nothing about whether the provider acted. */
  "TIMEOUT",
  /** A response arrived that does not match the documented shape. */
  "UNREADABLE_RESPONSE",
] as const;

export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

/**
 * Failures after which the provider may still have created the order.
 *
 * The defining question is not "did it fail" but "did our request possibly
 * reach them". A rejected credential never created anything; a timeout may have
 * created everything and lost the receipt on the way home. Only the second kind
 * may be retried, and only after checking.
 *
 * Kept as data, not as a comment, so the decision is made once and cannot drift
 * between call sites.
 */
const AMBIGUOUS_CATEGORIES: readonly ProviderFailureCategory[] = [
  "NETWORK_FAILURE",
  "TIMEOUT",
  "UNREADABLE_RESPONSE",
];

export function isAmbiguousFailure(category: ProviderFailureCategory): boolean {
  return AMBIGUOUS_CATEGORIES.includes(category);
}

/**
 * Failures a caller may retry without any chance of creating a second order.
 *
 * Deliberately excludes every ambiguous category. An ambiguous outcome is
 * resolved by *looking the order up*, never by asking for another one — that
 * rule outranks any retry policy, because a retry that duplicates a payment
 * order is worse than a request that fails.
 */
const SAFELY_RETRYABLE: readonly ProviderFailureCategory[] = [
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
];

export function isSafelyRetryable(category: ProviderFailureCategory): boolean {
  return SAFELY_RETRYABLE.includes(category);
}

export interface ProviderFailure {
  readonly category: ProviderFailureCategory;
  /**
   * A short, mapped, safe code. Never the provider's verbatim message, which
   * can echo request content back at us.
   */
  readonly code: string;
  /** Present only when the provider answered with a status. */
  readonly httpStatus: number | null;
}

/**
 * The outcome of asking a provider to create an order.
 *
 * Three arms, matching the three real possibilities. `UNKNOWN` exists so that a
 * caller must write code for the case where nobody knows what happened; if it
 * were folded into `FAILED`, the natural next line would be a retry, and the
 * natural consequence would be two orders for one purchase.
 */
export type ProviderOrderOutcome =
  | { readonly kind: "CREATED"; readonly order: ProviderOrder }
  | {
      /** The order already existed and was recovered by its receipt. */
      readonly kind: "ALREADY_EXISTS";
      readonly order: ProviderOrder;
    }
  | { readonly kind: "FAILED"; readonly failure: ProviderFailure }
  | {
      /** The provider may or may not hold an order for this receipt. */
      readonly kind: "UNKNOWN";
      readonly failure: ProviderFailure;
    };

/** Looking an order up by our own receipt. Read-only, and therefore always safe. */
export type ProviderLookupOutcome =
  | { readonly kind: "FOUND"; readonly order: ProviderOrder }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "FAILED"; readonly failure: ProviderFailure };

/**
 * The port. One implementation in production, one fake in tests.
 *
 * `createOrder` is expected to resolve its own ambiguity where it safely can —
 * by looking the receipt up — because the adapter is the only layer that knows
 * which vendor mechanisms make that sound. What it may never do is call create
 * twice.
 */
export interface PaymentProvider {
  /** Matches the persisted `PaymentProvider` enum. */
  readonly name: "RAZORPAY";
  createOrder(request: PaymentOrderRequest): Promise<ProviderOrderOutcome>;
  findOrderByReceipt(receipt: string): Promise<ProviderLookupOutcome>;
  /**
   * Decides whether a checkout callback genuinely came from the provider.
   *
   * Synchronous and total: it is a local cryptographic check, not a network
   * call, so there is no failure mode between "authentic" and "not". Anything
   * malformed answers `false` rather than throwing - a signature this code
   * cannot parse is exactly as unauthentic as one that does not match, and a
   * thrown error on the rejection path is how a verifier accidentally becomes
   * a way to crash the endpoint.
   *
   * `providerOrderId` must be the id **this server stored** when it created the
   * order. The provider's own documentation is explicit that the order id
   * returned to the browser must not be used here, and the parameter is named
   * for the server's copy so a call site passing the client's is visibly wrong.
   */
  verifyCheckoutSignature(input: CheckoutSignatureInput): boolean;

  /**
   * Decides whether an inbound webhook genuinely came from the provider.
   *
   * Takes the **raw body** as it arrived, never a re-serialisation of parsed
   * JSON. Two payloads can be equal as objects and different as bytes - key
   * order, whitespace, unicode escaping - and the provider signed the bytes.
   * Re-encoding would therefore reject authentic events, and, worse, invites a
   * design where parsing happens before authentication.
   *
   * Signed with the *webhook* secret, which is a different credential from the
   * API key secret used to authenticate outbound calls. They are not
   * interchangeable, and using one for the other fails closed but for the wrong
   * reason, which is a hard mistake to debug.
   *
   * Synchronous and total, for the same reasons as the checkout verifier: a
   * malformed signature answers `false` rather than throwing.
   */
  verifyWebhookSignature(input: WebhookSignatureInput): boolean;
}

/** What an inbound webhook must prove. */
export interface WebhookSignatureInput {
  /** Exactly the bytes received, before any parsing. */
  readonly rawBody: string;
  /** The value of the provider's signature header. */
  readonly signature: string;
}

/** What a checkout callback must prove. */
export interface CheckoutSignatureInput {
  /** From our database. Never the value the browser posted. */
  readonly serverStoredOrderId: string;
  readonly providerPaymentId: string;
  /** The signature the browser presented. Untrusted, length-unchecked input. */
  readonly signature: string;
}
