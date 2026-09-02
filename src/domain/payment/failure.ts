/**
 * What a failed payment is allowed to be recorded as.
 *
 * A `payment.failed` event carries more than a code. Razorpay reports where the
 * failure came from (`error_source`), how far the payment got before it stopped
 * (`error_step`), and a machine reason (`error_reason`) — and all of that is
 * genuinely useful when someone asks why a purchase did not go through. It is
 * also the part of a payment payload that sits closest to information nobody
 * should keep.
 *
 * So this module draws the line once. It maps the provider's vocabulary onto a
 * small, closed, application-owned set, and everything downstream — the
 * database column, the audit record, the sentence a buyer reads — is expressed
 * in that set rather than in the provider's words.
 *
 * ## What is deliberately not here
 *
 * There is no field for a card number, an expiry, a CVV, an OTP, a UPI PIN, a
 * cardholder name, an issuer token, or the provider's verbatim
 * `error_description`. The first six are never sent to us and must never be
 * stored if they were. The last one is withheld on purpose: a vendor's free
 * text is written for a merchant's support desk, not for a buyer's screen, and
 * it changes without warning. Storing it would make a user-facing string an
 * uncontrolled provider output.
 *
 * ## Unknown values are normal, not exceptional
 *
 * A payment provider may add a new `error_reason` on any Tuesday. An
 * unrecognised value must therefore never make reconciliation fail — the money
 * moved (or did not) regardless of whether we have a name for why. Every
 * function here is total: anything unrecognised becomes `UNKNOWN`, which is a
 * real answer meaning "authentically reported, not classifiable", and never a
 * thrown error.
 */

/**
 * The safe, user-facing classification of a failed payment.
 *
 * Closed and application-owned, so a screen or an audit record branches on
 * these and never on a provider code. Ordered roughly from "the buyer can do
 * something about it" to "nobody outside can".
 */
export const PAYMENT_FAILURE_CATEGORIES = [
  /** The bank or issuer refused. The commonest real decline. */
  "DECLINED_BY_BANK",
  /** Not enough money on the instrument. */
  "INSUFFICIENT_FUNDS",
  /** A 3-D Secure, OTP or PIN check did not pass. */
  "AUTHENTICATION_FAILED",
  /** The instrument itself is unusable: expired, wrong details, unsupported. */
  "INSTRUMENT_INVALID",
  /** A per-transaction or daily limit was hit. */
  "LIMIT_EXCEEDED",
  /** The buyer stopped the payment, or the window timed out on their side. */
  "CANCELLED_BY_CUSTOMER",
  /** The provider, gateway or network failed. Nothing the buyer did. */
  "PROVIDER_UNAVAILABLE",
  /** Our own request or configuration was wrong. A fault on this side. */
  "REQUEST_REJECTED",
  /** Authentic, correlated, and not classifiable. Kept honestly as itself. */
  "UNKNOWN",
] as const;

export type PaymentFailureCategory = (typeof PAYMENT_FAILURE_CATEGORIES)[number];

/**
 * Where the provider says the failure originated, normalised.
 *
 * Razorpay documents `customer`, `business`, `bank`, `gateway` and `internal`.
 * Kept as a bounded string rather than a database enum because it is the
 * provider's vocabulary, not ours: a value we have never seen must be storable
 * so a real capture or decline still reconciles.
 */
export const PAYMENT_FAILURE_SOURCES = [
  "CUSTOMER",
  "BUSINESS",
  "BANK",
  "GATEWAY",
  "INTERNAL",
  "UNKNOWN",
] as const;

export type PaymentFailureSource = (typeof PAYMENT_FAILURE_SOURCES)[number];

/**
 * How far the payment got, normalised.
 *
 * Razorpay documents `payment_initiation`, `payment_authentication`,
 * `payment_authorization` and `payment_response`.
 */
export const PAYMENT_FAILURE_STEPS = [
  "INITIATION",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "RESPONSE",
  "UNKNOWN",
] as const;

export type PaymentFailureStep = (typeof PAYMENT_FAILURE_STEPS)[number];

/** The complete, storable classification of one failed attempt. */
export interface PaymentFailureClassification {
  readonly category: PaymentFailureCategory;
  readonly source: PaymentFailureSource;
  readonly step: PaymentFailureStep;
  /** The provider's own code, bounded. Diagnostic only; never shown to a buyer. */
  readonly providerCode: string | null;
  /** The provider's machine reason, bounded. Diagnostic only, never free text. */
  readonly providerReason: string | null;
}

/** What the provider told us, before any of it is trusted or interpreted. */
export interface ProviderFailureSignals {
  readonly errorCode?: string | null | undefined;
  readonly errorSource?: string | null | undefined;
  readonly errorStep?: string | null | undefined;
  readonly errorReason?: string | null | undefined;
}

const MAX_PROVIDER_TOKEN = 64;

/**
 * Provider identifiers only: lowercase letters, digits and underscores.
 *
 * `error_reason` and `error_code` are machine tokens, and constraining them to
 * that shape means a provider that ever put a sentence — or anything a person
 * typed — into one of these fields cannot have it land in our database through
 * this path.
 */
const PROVIDER_TOKEN = /^[a-z0-9_]+$/i;

function token(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROVIDER_TOKEN) return null;
  return PROVIDER_TOKEN.test(trimmed) ? trimmed : null;
}

const SOURCES: Readonly<Record<string, PaymentFailureSource>> = {
  customer: "CUSTOMER",
  business: "BUSINESS",
  merchant: "BUSINESS",
  bank: "BANK",
  issuer: "BANK",
  gateway: "GATEWAY",
  internal: "INTERNAL",
};

const STEPS: Readonly<Record<string, PaymentFailureStep>> = {
  payment_initiation: "INITIATION",
  payment_authentication: "AUTHENTICATION",
  payment_authorization: "AUTHORIZATION",
  payment_response: "RESPONSE",
};

export function normaliseFailureSource(
  value: string | null | undefined,
): PaymentFailureSource {
  const key = token(value)?.toLowerCase();
  return (key === undefined ? undefined : SOURCES[key]) ?? "UNKNOWN";
}

export function normaliseFailureStep(
  value: string | null | undefined,
): PaymentFailureStep {
  const key = token(value)?.toLowerCase();
  return (key === undefined ? undefined : STEPS[key]) ?? "UNKNOWN";
}

/**
 * Reason substrings, most specific first.
 *
 * Substrings rather than exact keys because providers version these names
 * (`card_expired`, `payment_card_expired`) and a near-miss should still land in
 * the right bucket. Order is load-bearing: the first match wins, so narrow
 * patterns are listed before broad ones — `insufficient_funds` must be checked
 * before anything matching `funds`, and `incorrect_otp` before `otp`.
 */
const REASON_PATTERNS: readonly (readonly [string, PaymentFailureCategory])[] = [
  ["insufficient_funds", "INSUFFICIENT_FUNDS"],
  ["insufficient_balance", "INSUFFICIENT_FUNDS"],
  ["incorrect_otp", "AUTHENTICATION_FAILED"],
  ["invalid_otp", "AUTHENTICATION_FAILED"],
  ["otp_expired", "AUTHENTICATION_FAILED"],
  ["auth_failed", "AUTHENTICATION_FAILED"],
  ["authentication", "AUTHENTICATION_FAILED"],
  ["3ds", "AUTHENTICATION_FAILED"],
  ["pin_", "AUTHENTICATION_FAILED"],
  ["expired", "INSTRUMENT_INVALID"],
  ["invalid_cvv", "INSTRUMENT_INVALID"],
  ["invalid_card", "INSTRUMENT_INVALID"],
  ["incorrect_card", "INSTRUMENT_INVALID"],
  ["card_disabled", "INSTRUMENT_INVALID"],
  ["not_supported", "INSTRUMENT_INVALID"],
  // An international or restricted instrument the issuer will not use here.
  ["not_allowed", "INSTRUMENT_INVALID"],
  ["not_permitted", "INSTRUMENT_INVALID"],
  ["invalid_vpa", "INSTRUMENT_INVALID"],
  ["limit_exceed", "LIMIT_EXCEEDED"],
  ["exceeded", "LIMIT_EXCEEDED"],
  ["cancel", "CANCELLED_BY_CUSTOMER"],
  ["abort", "CANCELLED_BY_CUSTOMER"],
  ["timeout", "PROVIDER_UNAVAILABLE"],
  ["timed_out", "PROVIDER_UNAVAILABLE"],
  ["gateway", "PROVIDER_UNAVAILABLE"],
  ["declin", "DECLINED_BY_BANK"],
  ["refused", "DECLINED_BY_BANK"],
];

/**
 * Classifies one authenticated failure into the closed set above.
 *
 * Deterministic and total. The order of evidence is deliberate: the provider's
 * specific machine reason first, because it says the most; then the step, which
 * distinguishes a failed authentication from a refused authorization; then the
 * source, which at least separates "their side" from "ours". Anything left is
 * `UNKNOWN`, recorded as such rather than guessed into a category that would
 * put words in the bank's mouth.
 */
export function classifyPaymentFailure(
  signals: ProviderFailureSignals,
): PaymentFailureClassification {
  const providerCode = token(signals.errorCode);
  const providerReason = token(signals.errorReason);
  const source = normaliseFailureSource(signals.errorSource);
  const step = normaliseFailureStep(signals.errorStep);

  const haystack = `${providerReason ?? ""}|${providerCode ?? ""}`.toLowerCase();
  let category: PaymentFailureCategory | null = null;
  for (const [pattern, mapped] of REASON_PATTERNS) {
    if (haystack.includes(pattern)) {
      category = mapped;
      break;
    }
  }

  if (category === null && step === "AUTHENTICATION") category = "AUTHENTICATION_FAILED";
  if (category === null && step === "AUTHORIZATION") category = "DECLINED_BY_BANK";
  if (category === null) {
    switch (source) {
      case "BANK":
        category = "DECLINED_BY_BANK";
        break;
      case "GATEWAY":
      case "INTERNAL":
        category = "PROVIDER_UNAVAILABLE";
        break;
      case "BUSINESS":
        category = "REQUEST_REJECTED";
        break;
      default:
        category = "UNKNOWN";
    }
  }

  return { category, source, step, providerCode, providerReason };
}

/**
 * One sentence a buyer can read, per category.
 *
 * Every string is written here, in full, rather than assembled from provider
 * output — which is what makes it safe to render. None of them names an
 * instrument, a bank, an internal state, a policy detail or a provider code,
 * and each says what the person can actually do next.
 */
export function describePaymentFailure(category: PaymentFailureCategory): string {
  switch (category) {
    case "DECLINED_BY_BANK":
      return "The bank declined this payment. Trying a different payment method usually works.";
    case "INSUFFICIENT_FUNDS":
      return "There were not enough funds available for this payment.";
    case "AUTHENTICATION_FAILED":
      return "The payment could not be verified. The one-time password or PIN was not accepted.";
    case "INSTRUMENT_INVALID":
      return "That payment method could not be used. It may have expired, or the details may be incorrect.";
    case "LIMIT_EXCEEDED":
      return "This payment is over a limit set on the payment method.";
    case "CANCELLED_BY_CUSTOMER":
      return "The payment was cancelled before it completed.";
    case "PROVIDER_UNAVAILABLE":
      return "The payment service could not be reached. Nothing was charged; trying again shortly usually works.";
    case "REQUEST_REJECTED":
      return "This payment could not be started. Nothing was charged.";
    case "UNKNOWN":
      return "The payment did not complete. Nothing was charged.";
  }
}
