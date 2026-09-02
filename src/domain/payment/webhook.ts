import { z } from "zod";
import { MAX_PROVIDER_REFERENCE_LENGTH } from "@/domain/payment/rules";

/**
 * The inbound provider webhook, as a domain contract.
 *
 * A webhook is the only signal in this system that can assert money actually
 * moved. The browser callback proves a message was authentic; it does not
 * prove capture, because the browser is not the party that captures. So this
 * file draws one line very deliberately: nothing here is trusted until a
 * signature has been checked, and even then a genuine signature only proves
 * *Razorpay sent this*. Whether the event belongs to a particular internal
 * transaction is a separate question with a separate answer, made against
 * persisted facts.
 *
 * Two distinct failures follow from that, and they are kept apart everywhere
 * below:
 *
 *   - **unauthenticated** - we cannot tell who sent this. Nothing is written.
 *   - **authenticated but uncorrelated** - Razorpay really sent it, and it does
 *     not match what we stored. That is a security-relevant fact worth
 *     recording, and it must still never move money.
 */

/**
 * Events this system acts on.
 *
 * Deliberately a closed list rather than a switch with a default branch.
 * Razorpay emits dozens of event types and a merchant can subscribe to more at
 * any time from a dashboard, without a code change - so an unrecognised event
 * must be a normal, silent, idempotent no-op rather than something that falls
 * through into a reconciliation path written for a different shape of payload.
 */
export const SUPPORTED_WEBHOOK_EVENTS = ["payment.captured", "payment.failed"] as const;

export type SupportedWebhookEvent = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];

export function isSupportedWebhookEvent(event: string): event is SupportedWebhookEvent {
  return (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event);
}

/** Why an inbound request was refused before it could be trusted. */
export const WEBHOOK_REJECTIONS = [
  "SIGNATURE_MISSING",
  "SIGNATURE_INVALID",
  "EVENT_ID_MISSING",
  "BODY_TOO_LARGE",
  "BODY_MALFORMED",
  "PAYLOAD_UNRECOGNISED",
] as const;

export type WebhookRejection = (typeof WEBHOOK_REJECTIONS)[number];

/**
 * Why an authenticated event could not be reconciled.
 *
 * Separated from `WebhookRejection` because the two have different security
 * meanings and different responses. A rejection is an unauthenticated caller
 * and gets nothing. A mismatch is Razorpay telling us something true about a
 * payment we cannot line up with our own records - which is either our bug or
 * an attempt to bind a real payment to the wrong transaction, and either way is
 * worth an audit row and never a state change.
 */
export const WEBHOOK_MISMATCHES = [
  "ORDER_NOT_FOUND",
  "PAYMENT_ID_CONFLICT",
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
] as const;

export type WebhookMismatch = (typeof WEBHOOK_MISMATCHES)[number];

/**
 * The minimum shape we read out of an authenticated payload.
 *
 * `passthrough` is not used and nested data beyond these fields is not read:
 * the payload is authentic, but "authentic" is not "safe to walk arbitrarily".
 * Everything financial here is re-checked against persisted state before it is
 * allowed to mean anything.
 */
const paymentEntitySchema = z.object({
  id: z.string().min(1).max(MAX_PROVIDER_REFERENCE_LENGTH),
  order_id: z.string().min(1).max(MAX_PROVIDER_REFERENCE_LENGTH).nullish(),
  /** Integer minor units. Razorpay sends paise; no float ever appears. */
  amount: z.number().int().nonnegative(),
  currency: z.string().min(3).max(8),
  status: z.string().max(40).optional(),
  error_code: z.string().max(64).nullish(),
  error_description: z.string().max(500).nullish(),
});

export const razorpayWebhookSchema = z.object({
  event: z.string().min(1).max(80),
  payload: z.object({
    payment: z.object({ entity: paymentEntitySchema }),
  }),
});

export type RazorpayWebhookEvent = z.infer<typeof razorpayWebhookSchema>;

/** The facts a verified event asserts, after parsing and before correlation. */
export interface AuthenticatedWebhookFacts {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerPaymentId: string;
  readonly providerOrderId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly failureCode: string | null;
}

/**
 * What happened to one inbound webhook.
 *
 * Every arm is a terminal answer, and only `RECONCILED` may have changed state.
 * `IGNORED` and `DUPLICATE` are successes: the provider is owed a 2xx so it
 * stops retrying something we have correctly decided needs no action.
 */
export type WebhookOutcome =
  | {
      readonly kind: "RECONCILED";
      readonly providerEventId: string;
      readonly transactionId: string;
      readonly eventType: SupportedWebhookEvent;
      /** The state the transaction ended in, whether or not this event moved it. */
      readonly transactionState: string;
      /** True when the state machine judged the event already accounted for. */
      readonly alreadyAccountedFor: boolean;
    }
  | {
      readonly kind: "DUPLICATE";
      readonly providerEventId: string;
    }
  | {
      readonly kind: "IGNORED";
      readonly providerEventId: string;
      readonly eventType: string;
    }
  | {
      readonly kind: "MISMATCHED";
      readonly providerEventId: string;
      readonly mismatch: WebhookMismatch;
      /** Null when the event could not be tied to a transaction at all. */
      readonly transactionId: string | null;
    }
  | {
      readonly kind: "REJECTED";
      readonly rejection: WebhookRejection;
    };
