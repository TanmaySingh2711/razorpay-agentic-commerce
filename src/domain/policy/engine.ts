import { SUPPORTED_CURRENCIES } from "@/domain/money";
import {
  explainPolicyReason,
  type EvaluableQuote,
  type PolicyDecision,
  type PolicyDecisionKind,
  type PolicyReasonCode,
  type PolicySnapshot,
} from "@/domain/policy/decision";

/**
 * The deterministic policy engine.
 *
 * This function is the whole of Objective 7's authority. It is a pure function
 * of two values, and that purity is the security property, not a style
 * preference:
 *
 *  - no Gemini call, so no sentence anyone types can change the answer;
 *  - no Prisma call, so it cannot be handed a row a caller chose;
 *  - no network and no clock, so it cannot drift or fail halfway;
 *  - no browser reachability, so no client can invoke it with its own numbers.
 *
 * Given the same quote and the same policy it returns the same decision,
 * forever. That is what makes an audit record replayable: "quote Q, policy
 * version P, decision D" can be re-derived years later and must still agree.
 *
 * The one thing this file must never grow is a parameter that lets the caller
 * express a preference about the outcome.
 */

/**
 * Every path out of this function starts from a refusal.
 *
 * `ALLOWED` is produced in exactly one place, at the very end, after every
 * condition below has been positively established. Nothing earlier can reach
 * it, and no `default` branch can fall into it. The consequence is that a
 * future check inserted anywhere in the chain fails closed by construction: the
 * worst a mistake can do is refuse a purchase that should have been permitted,
 * which is a complaint, not a loss.
 */
export function evaluatePolicy(
  quote: EvaluableQuote,
  policy: PolicySnapshot | null,
): PolicyDecision {
  const amount = quote.totalAmountMinor;

  // --- The policy must exist and be in force. ---------------------------------
  //
  // A buyer with no policy row is not a buyer with unlimited authority. Absence
  // of a rule is the most tempting thing in the world to read as permission,
  // and it is the single most expensive way for a system like this to be wrong.
  if (policy === null) {
    return refuse("BLOCKED", "NO_POLICY_FOUND", quote, null);
  }
  if (policy.status !== "ACTIVE") {
    return refuse("BLOCKED", "POLICY_NOT_ACTIVE", quote, policy);
  }

  // --- Currency is settled before any amount is compared. ---------------------
  //
  // Comparing 300000 paise against a limit denominated in something else is not
  // a stricter or looser comparison, it is a meaningless one. There is no
  // conversion step here and there never will be: a rate this system invented
  // would be a number nobody agreed to.
  if (!isSupportedCurrency(quote.currency)) {
    return refuse("BLOCKED", "UNSUPPORTED_CURRENCY", quote, policy);
  }
  if (policy.currency !== quote.currency) {
    return refuse("BLOCKED", "POLICY_CURRENCY_MISMATCH", quote, policy);
  }

  // --- The amount must be a payable amount, and must add up. ------------------
  //
  // The database already enforces `totalAmount = unitAmount * quantity` with a
  // CHECK constraint. Re-deriving it here costs one multiplication and means
  // the engine's own arithmetic is what it authorizes against - so a total that
  // ever disagreed with its line maths, however it got that way, is refused
  // rather than paid.
  if (!isPayableAmount(amount, quote)) {
    return refuse("BLOCKED", "INVALID_QUOTE_AMOUNT", quote, policy);
  }

  // --- The ceiling must itself be usable. -------------------------------------
  //
  // A negative limit is not "very strict", it is a corrupt row, and treating it
  // as a comparison operand would silently make every purchase require approval
  // for a reason nobody could explain. Say so instead.
  if (policy.maxAutoApproveAmountMinor < 0n) {
    return refuse("BLOCKED", "INVALID_POLICY_LIMIT", quote, policy);
  }

  // --- Unattended purchasing must be switched on. -----------------------------
  //
  // This is a refusal of *automatic* authority, not of the purchase, so it
  // escalates to a person rather than blocking. That is not a softening: the
  // server still authorizes nothing, and Objective 8's approval gate is the
  // only thing that can supply the missing authority.
  if (!policy.autoPurchaseAllowed) {
    return refuse("APPROVAL_REQUIRED", "AUTO_PURCHASE_DISABLED", quote, policy);
  }

  // --- The comparison itself. -------------------------------------------------
  //
  // Inclusive: a limit of 300000 authorizes a total of exactly 300000. A
  // ceiling a shopper set to "three thousand rupees" that quietly refused three
  // thousand rupees would be wrong in the way people actually notice. Both
  // operands are BigInt minor units read from PostgreSQL - no float touches
  // this line, so there is no boundary case that depends on rounding.
  if (amount > policy.maxAutoApproveAmountMinor) {
    return refuse("APPROVAL_REQUIRED", "EXCEEDS_AUTO_APPROVE_LIMIT", quote, policy);
  }

  return decide("ALLOWED", "WITHIN_AUTO_APPROVE_LIMIT", quote, policy);
}

function isSupportedCurrency(currency: string): boolean {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}

/**
 * Whether this is an amount that could be charged at all.
 *
 * Zero is refused along with negatives. A zero-rupee "purchase" is not a free
 * gift the agent may help itself to; it is a quote that did not come out of a
 * real price, and authorizing it would put the system's name behind a number
 * nobody computed.
 */
function isPayableAmount(amount: bigint, quote: EvaluableQuote): boolean {
  if (amount <= 0n) return false;
  if (quote.unitAmountMinor <= 0n) return false;
  if (!Number.isSafeInteger(quote.quantity) || quote.quantity <= 0) return false;
  return quote.unitAmountMinor * BigInt(quote.quantity) === amount;
}

function decide(
  decision: PolicyDecisionKind,
  reasonCode: PolicyReasonCode,
  quote: EvaluableQuote,
  policy: PolicySnapshot | null,
): PolicyDecision {
  return {
    decision,
    reasonCode,
    explanation: explainPolicyReason(reasonCode),
    policyId: policy?.policyId ?? null,
    policyVersion: policy?.version ?? null,
    evaluatedAmountMinor: quote.totalAmountMinor,
    currency: quote.currency,
    // Only reported once the limit has been established as usable, so a
    // decision can never cite a ceiling it did not actually compare against.
    autoApproveLimitMinor:
      policy !== null && policy.maxAutoApproveAmountMinor >= 0n
        ? policy.maxAutoApproveAmountMinor
        : null,
  };
}

/** Named separately from `decide` so every refusal reads as one at the call site. */
function refuse(
  decision: Exclude<PolicyDecisionKind, "ALLOWED">,
  reasonCode: PolicyReasonCode,
  quote: EvaluableQuote,
  policy: PolicySnapshot | null,
): PolicyDecision {
  return decide(decision, reasonCode, quote, policy);
}
