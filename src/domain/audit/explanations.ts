import { formatMoney, moneyFromBigInt, type CurrencyCode } from "@/domain/money";
import { AUDIT_EVENT_TYPES, type AuditEventType } from "@/domain/audit-event";
import type { AuditResult } from "@/domain/audit/record";
import type { JsonObject, JsonValue } from "@/lib/json";

/**
 * Turning an audited fact into one sentence a person can read.
 *
 * Derived, never stored. The row holds a reason code and the trusted numbers
 * the decision turned on; this renders those into prose at read time. Storing
 * the sentence instead would create a second source of truth that drifts the
 * first time somebody rewords it — and, worse, would leave a free-text field in
 * a financial record for narration to leak into.
 *
 * Every sentence here is built from server-derived values. There is no branch
 * that can emit "the AI thought this seemed safe", because model narration is
 * not an input to this file.
 */

/** `formatMoney` from a minor-unit string, or null when the facts are absent. */
function amount(payload: JsonObject, key: string): string | null {
  const minor = readString(payload, key);
  const currency = readString(payload, "currency");
  if (minor === null || currency === null) return null;
  try {
    return formatMoney(moneyFromBigInt(BigInt(minor), currency as CurrencyCode));
  } catch {
    // An amount that cannot be represented is not worth a sentence; the
    // structured fields on the record still carry it exactly.
    return null;
  }
}

function readString(payload: JsonObject, key: string): string | null {
  const value: JsonValue | undefined = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(payload: JsonObject, key: string): number | null {
  const value: JsonValue | undefined = payload[key];
  return typeof value === "number" ? value : null;
}

function readReasons(payload: JsonObject): readonly string[] {
  const value: JsonValue | undefined = payload["reasons"];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function units(quantity: number | null): string {
  if (quantity === null) return "the item";
  return quantity === 1 ? "1 unit" : `${String(quantity)} units`;
}

/**
 * The policy sentences, which are the ones people actually ask about.
 *
 * "Quote total ₹2799.00 is within the ₹3000.00 automatic purchase limit" is an
 * answer someone can check against their own policy. It names both numbers and
 * the rule that compared them.
 */
function explainPolicy(payload: JsonObject, reasonCode: string | null): string {
  const total = amount(payload, "amountMinor");
  const limit = amount(payload, "autoApproveLimitMinor");
  const version = readNumber(payload, "policyVersion");
  const underVersion = version === null ? "" : ` (policy version ${String(version)})`;

  switch (reasonCode) {
    case "WITHIN_AUTO_APPROVE_LIMIT":
      return total !== null && limit !== null
        ? `Quote total ${total} is within the ${limit} automatic purchase limit${underVersion}.`
        : `The quoted total is within the automatic purchase limit${underVersion}.`;
    case "EXCEEDS_AUTO_APPROVE_LIMIT":
      return total !== null && limit !== null
        ? `Quote total ${total} is above the ${limit} automatic purchase limit${underVersion}, so a person must approve it.`
        : `The quoted total is above the automatic purchase limit${underVersion}, so a person must approve it.`;
    case "AUTO_PURCHASE_DISABLED":
      return `This buyer's policy does not permit unattended purchases${underVersion}, so a person must approve it.`;
    case "NO_POLICY_FOUND":
      return "No authorization policy exists for this buyer, so the purchase was blocked.";
    case "POLICY_NOT_ACTIVE":
      return `This buyer's authorization policy is not active${underVersion}, so the purchase was blocked.`;
    case "POLICY_CURRENCY_MISMATCH":
      return "The quote and the authorization policy are in different currencies, so the purchase was blocked.";
    case "UNSUPPORTED_CURRENCY":
      return "The quote is in a currency this service does not support, so the purchase was blocked.";
    case "INVALID_QUOTE_AMOUNT":
      return "The quoted amount is not a valid payable amount, so the purchase was blocked.";
    case "INVALID_POLICY_LIMIT":
      return "The spending limit on this buyer's policy is not usable, so the purchase was blocked.";
    default:
      return `Policy evaluated${underVersion}.`;
  }
}

/**
 * What is said about an event whose type this file does not know.
 *
 * `AuditEvent.eventType` is a `VARCHAR`, not a database enum, so the type
 * assertion that hands an action to this function is a claim rather than a
 * guarantee - a legacy row, a direct insert, or a vocabulary that moved on
 * would all arrive here as an unrecognised string. The exhaustive `switch`
 * below would then match nothing and return `undefined` from a function
 * declared to return `string`, which is the kind of hole that surfaces as a
 * blank line in someone's transaction history.
 *
 * The action itself is deliberately not interpolated: it is free text from a
 * column, and prose assembled from unvalidated input is exactly what this
 * system avoids. The structured `action` field on the record still carries it
 * exactly.
 */
const UNRECOGNISED_EVENT =
  "This event type has no explanation rule yet; its structured fields are still exact.";

/**
 * The payment-order sentences.
 *
 * Three outcomes need three genuinely different sentences, because the
 * difference between them is the whole point of the record. "Created" is good
 * news; "refused" is ordinary; "we do not know" is the one a person must be
 * able to read plainly, because it is the state in which a provider order may
 * exist that this system has not finished accounting for. Softening that into
 * "the payment order failed" would hide the one fact worth surfacing.
 */
function explainPaymentOrder(
  payload: JsonObject,
  result: AuditResult,
  reasonCode: string | null,
): string {
  const total = amount(payload, "amountMinor");
  const forTotal = total === null ? "" : ` for ${total}`;

  if (result === "SUCCESS") {
    const orderId = readString(payload, "providerOrderId");
    const at = orderId === null ? "" : ` (provider order ${orderId})`;
    return `A payment order was created at the payment provider${forTotal}${at}.`;
  }
  if (result === "PENDING") {
    return `The payment provider's response was lost, so it is not yet known whether an order${forTotal} exists. No second order will be created; the reference is being reconciled.`;
  }
  const cause = reasonCode === null ? "" : ` (${reasonCode})`;
  return `No payment order was created${forTotal}${cause}.`;
}

function isKnownAction(action: string): action is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(action);
}

/**
 * One sentence per audited fact.
 *
 * The `switch` is exhaustive over the action vocabulary, so a new event type
 * cannot be added without deciding how it reads to a person. Membership is
 * checked at runtime first, because the type system cannot police a column.
 */
export function explainAuditEvent(input: {
  readonly action: AuditEventType;
  readonly result: AuditResult;
  readonly reasonCode: string | null;
  readonly trustedInputs: JsonObject;
}): string {
  if (!isKnownAction(input.action)) return UNRECOGNISED_EVENT;

  const { action, reasonCode, trustedInputs: facts } = input;
  const quantity = readNumber(facts, "quantity");
  const reasons = readReasons(facts);
  const reasonTail = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";

  switch (action) {
    case "intent_received":
      return "A purchase request was received.";
    case "intent_interpreted": {
      const budget = amount(facts, "maxBudgetMinor");
      return budget === null
        ? "The request was interpreted into a structured purchase intent."
        : `The request was interpreted with a stated limit of ${budget}.`;
    }
    case "clarification_requested":
      return (
        readString(facts, "question") ??
        "The request was too ambiguous to price, so a clarifying question was returned."
      );
    case "no_candidate_matched": {
      const considered = readNumber(facts, "candidatesConsidered");
      const scope =
        considered === null ? "the catalog" : `${String(considered)} candidates`;
      return `Nothing in ${scope} met the stated requirements${reasonTail}.`;
    }

    case "product_selected":
      return `The agent proposed a product and the server accepted it as a candidate${reasonTail}.`;
    case "product_selection_rejected":
      return `The proposed product was refused${reasonTail}.`;
    case "product_verified": {
      const unit = amount(facts, "unitAmountMinor");
      return unit === null
        ? "The product's authoritative price and stock were re-read from the catalog."
        : `The catalog confirms this product at ${unit}.`;
    }
    case "product_verification_failed":
      return `The product no longer matches what was proposed${reasonTail}.`;

    case "quote_created":
    case "quote_reissued": {
      const total = amount(facts, "totalAmountMinor");
      const verb = action === "quote_created" ? "Quoted" : "Re-quoted";
      return total === null
        ? `${verb} against the authoritative catalog price.`
        : `${verb} ${units(quantity)} at ${total}, frozen until the quote expires.`;
    }
    case "quote_expired":
      return "The quote's validity window elapsed, so its price is no longer offered.";
    case "quote_invalidated":
      return `The product changed after the quote was made${reasonTail}, so the quote can no longer be used.`;

    case "policy_evaluated":
      return explainPolicy(facts, reasonCode);

    case "approval_requested": {
      const total = amount(facts, "amountMinor");
      return total === null
        ? "A person was asked to approve this purchase."
        : `A person was asked to approve ${total}.`;
    }
    case "approval_granted": {
      const total = amount(facts, "amountMinor");
      return total === null
        ? "A person approved this exact purchase."
        : `A person approved ${total} for this purchase.`;
    }
    case "approval_denied":
      return "A person refused this purchase.";
    case "approval_expired":
      return "Nobody answered the approval request before it expired.";
    case "approval_replay_rejected":
      return "An approval credential was presented again after it had already been used.";

    case "inventory_reserved":
      return `${units(quantity)} held for this purchase until the checkout window closes.`;
    case "inventory_reservation_failed":
      return `Stock could not be held for this purchase${reasonTail}.`;
    case "inventory_reservation_expired":
      return `The hold on ${units(quantity)} lapsed and the stock returned to availability.`;
    case "inventory_released":
      return `${units(quantity)} released back into availability.`;
    case "inventory_committed": {
      const remaining = readNumber(facts, "remainingInventory");
      const tail = remaining === null ? "" : `; ${String(remaining)} remain in stock`;
      return `${units(quantity)} permanently deducted from stock${tail}.`;
    }

    case "state_transitioned": {
      const from = readString(facts, "fromStatus");
      const to = readString(facts, "toStatus");
      return from !== null && to !== null
        ? `The transaction moved from ${from} to ${to}.`
        : "The transaction changed state.";
    }
    case "transaction_completed":
      return "The transaction completed successfully.";
    case "transaction_blocked":
      return "The transaction was blocked by a deterministic control.";
    case "transaction_cancelled":
      return "The transaction was cancelled.";
    case "transaction_expired":
      return "The transaction expired before it could complete.";

    case "payment_order_created":
      return explainPaymentOrder(facts, input.result, reasonCode);
    case "payment_attempt_started":
      return "A person chose to pay, and checkout was handed to them.";
    case "payment_checkout_dismissed":
      return "The buyer closed the payment window without completing payment. Nothing was charged, and the purchase is unchanged.";
    case "payment_verified":
      // Deliberately says what a signature proves and what it does not. A
      // reader who takes "verified" to mean "paid" would draw exactly the wrong
      // conclusion, and this sentence is where that is headed off.
      return "The payment confirmation was proved genuine server-side. This authenticates the confirmation; it is not yet proof that funds were captured.";
    case "payment_callback_rejected":
      return `A payment confirmation was refused because it could not be trusted${reasonTail}. No payment was recorded and the purchase was left unchanged.`;
    case "payment_captured":
      return "The provider confirmed the payment was captured.";
    case "payment_failed":
      return `The payment attempt did not succeed${reasonTail}.`;
    case "webhook_received":
      return "A provider webhook was received.";
    case "webhook_rejected":
      return `A provider webhook was rejected${reasonTail}.`;
  }
}
