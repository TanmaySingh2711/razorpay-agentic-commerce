import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@/domain/money";
import { MAX_BUDGET_MINOR, type BudgetClaim } from "@/domain/buyer-agent/intent";

/**
 * Deterministic verification of a budget the model claims the human stated.
 *
 * This module exists because of one specific danger: the model returns a number
 * that caps spending, and nothing else in the system can tell a real limit from
 * a hallucinated one. "₹3,000" misread as `30000` minor units would silently
 * halve the shopper's budget; misread as `3000000` would multiply it by ten.
 * Neither is detectable downstream — the amount looks perfectly well-formed.
 *
 * So the model is not trusted to *compute* the budget. It is trusted only to
 * *locate* it: to point at the span of the user's own message the limit came
 * from. This module then does three things, in order:
 *
 *   1. confirms the quoted span really occurs in the human's message;
 *   2. re-parses the amount from that span with plain deterministic code;
 *   3. requires the re-parsed amount to equal the model's claim.
 *
 * A mismatch is not repaired. The claim is discarded and the caller asks the
 * human, because a budget the server cannot verify is not a budget.
 *
 * This is deliberately a small parser for the handful of ways people write a
 * price ceiling, not a natural-language understanding engine. When it cannot
 * confidently read the span, it says so and the agent asks for clarification —
 * which is the correct answer, not a limitation.
 */

/** Minor-unit exponent per currency. INR: 100 paise to a rupee. */
const MINOR_UNITS_PER_MAJOR: Record<CurrencyCode, bigint> = { INR: 100n };

export type BudgetVerification =
  | {
      readonly kind: "VERIFIED";
      readonly maxAmountMinor: bigint;
      readonly currency: CurrencyCode;
    }
  | { readonly kind: "REJECTED"; readonly reason: string };

/**
 * Normalises text for span matching.
 *
 * Models reliably paraphrase whitespace and casing even when told to copy
 * verbatim, and rejecting a genuine budget over a double space would push users
 * into needless clarification. Digits, currency words and magnitude suffixes —
 * everything the amount actually depends on — are untouched.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Reads an amount out of a phrase and returns it in **minor units**.
 *
 * Minor units throughout, never a mix: a function that returned rupees for
 * "3000" and paise for "2999.50" would be a factor-of-a-hundred bug waiting for
 * whichever caller forgot which. Handles the forms people actually write:
 * `3000`, `3,000`, `2,999.50`, `3k`, `3 thousand`, `Rs. 3000`.
 *
 * Returns null when the phrase contains no single unambiguous amount —
 * including when it contains several, since choosing between them is a guess.
 */
export function parseMinorAmountFromText(
  text: string,
  currency: CurrencyCode,
): bigint | null {
  const perMajor = MINOR_UNITS_PER_MAJOR[currency];
  const cleaned = normalise(text).replace(/[₹$]/g, " ");

  // `3k` / `3 k` / `3 thousand`. Checked first: "3k" also contains the bare
  // number 3, and reading it as ₹3 would be catastrophically wrong.
  const thousands = /(\d+(?:\.\d+)?)\s*(?:k\b|thousand\b)/.exec(cleaned);
  if (thousands !== null) {
    const major = Number(thousands[1]) * 1000;
    if (!Number.isFinite(major) || !Number.isInteger(major)) return null;
    return BigInt(major) * perMajor;
  }

  // Plain numbers, with or without grouping separators. Indian and Western
  // grouping both collapse to the same digits once commas are removed.
  const numbers = [...cleaned.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)].map((match) =>
    match[0].replace(/,/g, ""),
  );
  if (numbers.length !== 1) return null;

  const only = numbers[0] as string;
  if (!only.includes(".")) {
    return BigInt(only) * perMajor;
  }

  // A decimal major amount: 2999.50 -> 299950 minor units, computed by string
  // arithmetic so no float ever touches an amount.
  const [whole = "0", fraction = ""] = only.split(".");
  const exponent = perMajor.toString().length - 1;
  const padded = fraction.padEnd(exponent, "0").slice(0, exponent);
  return BigInt(whole) * perMajor + BigInt(padded === "" ? "0" : padded);
}

/**
 * Whether a phrase reads as an upper bound rather than a target or a floor.
 *
 * "under ₹3000" caps spending; "around ₹3000" does not, and "at least ₹3000" is
 * the opposite. Treating any of them as a maximum would either overspend or
 * silently exclude valid products, so only recognised ceiling phrasings — or a
 * bare amount, which the caller has already framed as a budget — are accepted.
 */
function readsAsUpperBound(text: string): boolean {
  const t = normalise(text);
  if (/\b(at least|minimum|min\.?|more than|over|above|starting at)\b/.test(t)) {
    return false;
  }
  if (/\b(around|about|approximately|roughly|near|~)\b/.test(t)) return false;
  if (
    /\b(under|below|less than|at most|max|maximum|up to|within|budget|no more than|don'?t spend more than|not more than|upto|cheaper than)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // A bare amount, e.g. sourceText "₹3000" from "keyboard ₹3000". The model
  // identified it as the budget and the amount is unambiguous; accept it.
  return /^[^a-z]*\d[\d,]*(?:\.\d{1,2})?[^a-z]*$/.test(t);
}

/**
 * Ceiling words, paired with an amount somewhere after them.
 *
 * Used only to answer "did this person appear to state a spending limit?" — not
 * to decide what the limit is.
 */
const STATED_CEILING_PATTERN =
  /\b(under|below|less than|at most|max|maximum|up to|upto|within|budget|no more than|not more than|don'?t spend more than|cheaper than)\b[^.!?]{0,40}?\d/i;

/**
 * Whether the human's message appears to state a spending ceiling at all.
 *
 * This exists because of a failure the live smoke test exposed. Asked to
 * extract intent from "Find me a mechanical keyboard under ₹3000 and buy it",
 * the model returned no budget and did not flag the request as ambiguous. The
 * agent would then have proceeded with **no ceiling at all** — the budget check
 * in `validateSelection` is skipped when there is nothing to check against — so
 * a shopper who named a limit could have been shown something above it.
 *
 * That is a fail-open, and the whole design here is meant to fail closed. So
 * the server does not rely on the model noticing a budget. It looks for one
 * itself, and when the message plainly states a ceiling that the model did not
 * report, the agent stops and asks rather than shopping without a limit.
 *
 * Deliberately crude: a ceiling word followed closely by a digit. It answers
 * one yes/no question and never decides an amount — `verifyBudgetClaim` remains
 * the only path to an actual number. Being over-eager here costs a clarifying
 * question; being under-eager costs an unbounded purchase.
 */
export function messageStatesACeiling(message: string): boolean {
  return STATED_CEILING_PATTERN.test(normalise(message));
}

/**
 * Verifies a model-claimed budget against the human's own words.
 *
 * Returns VERIFIED only when the span exists in the message, reads as a
 * ceiling, and re-parses to exactly the claimed amount.
 */
export function verifyBudgetClaim(
  claim: BudgetClaim,
  humanMessage: string,
): BudgetVerification {
  if (!claim.explicit) {
    return { kind: "REJECTED", reason: "the budget was not stated by the user" };
  }

  const currency = SUPPORTED_CURRENCIES.find((code) => code === claim.currency);
  if (currency === undefined) {
    return { kind: "REJECTED", reason: "the budget currency is not supported" };
  }

  let claimed: bigint;
  try {
    claimed = BigInt(claim.maxAmountMinor);
  } catch {
    return { kind: "REJECTED", reason: "the budget amount is not an integer" };
  }
  if (claimed <= 0n) {
    return { kind: "REJECTED", reason: "the budget must be greater than zero" };
  }
  if (claimed > MAX_BUDGET_MINOR) {
    return { kind: "REJECTED", reason: "the budget exceeds the supported maximum" };
  }

  // Provenance: the span must genuinely come from the human's message.
  if (!normalise(humanMessage).includes(normalise(claim.sourceText))) {
    return {
      kind: "REJECTED",
      reason: "the quoted budget text does not appear in the request",
    };
  }

  if (!readsAsUpperBound(claim.sourceText)) {
    return {
      kind: "REJECTED",
      reason: "the quoted text does not state a maximum",
    };
  }

  // The decisive check. The model located the span; this is the amount.
  const recomputed = parseMinorAmountFromText(claim.sourceText, currency);
  if (recomputed === null) {
    return {
      kind: "REJECTED",
      reason: "the budget amount could not be read from the quoted text",
    };
  }
  if (recomputed !== claimed) {
    return {
      kind: "REJECTED",
      reason: "the budget amount does not match the user's own words",
    };
  }

  return { kind: "VERIFIED", maxAmountMinor: claimed, currency };
}
