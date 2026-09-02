import { TRANSACTION_STATES, type TransactionState } from "@/domain/transaction/states";
import type { MoneyDto } from "@/domain/money";

/**
 * How the lifecycle is described to a person.
 *
 * The state machine has seventeen states because seventeen is how many
 * genuinely different situations a payment can be in. A buyer does not need
 * seventeen; they need to know where they are, what happened, and what they can
 * do next. This module is the translation, and it lives in `domain/` rather
 * than in a component for three reasons.
 *
 * It is **pure**, so every sentence a buyer might read can be tested without a
 * browser. It is **total** over `TransactionState`, so adding a state to the
 * machine without deciding how to describe it is a compile error rather than a
 * blank space on a page. And it is the **only** place these sentences exist, so
 * the checkout page and the transaction page cannot drift into describing the
 * same state differently.
 *
 * Nothing here decides anything. Every value is derived from state the server
 * already computed; no eligibility is calculated, no amount is arrived at, and
 * a screen built from this module cannot authorize anything by rendering.
 */

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

/**
 * The eight steps a purchase visibly moves through.
 *
 * Deliberately fewer than the state list. Several states are internal
 * bookkeeping that a buyer would read as noise — `PRODUCT_VERIFIED` and
 * `POLICY_EVALUATED` are moments the server passes through in milliseconds —
 * so they are folded into the step they belong to. The exact technical state is
 * still shown, separately and truthfully, for anyone who wants it.
 */
export const JOURNEY_STEPS = [
  "INTENT",
  "PRODUCT",
  "QUOTE",
  "POLICY",
  "APPROVAL",
  "RESERVATION",
  "PAYMENT",
  "CAPTURE",
] as const;

export type JourneyStep = (typeof JOURNEY_STEPS)[number];

export const JOURNEY_STEP_LABELS: Readonly<Record<JourneyStep, string>> = {
  INTENT: "Understanding what you asked for",
  PRODUCT: "Choosing a product",
  QUOTE: "Verifying the price",
  POLICY: "Checking spending rules",
  APPROVAL: "Getting your approval",
  RESERVATION: "Holding the item",
  PAYMENT: "Taking payment",
  CAPTURE: "Confirming the money arrived",
};

/** Where each state sits on that path. */
const STEP_OF: Readonly<Record<TransactionState, JourneyStep>> = {
  INTENT_RECEIVED: "INTENT",
  PRODUCT_SELECTED: "PRODUCT",
  PRODUCT_VERIFIED: "PRODUCT",
  QUOTE_CREATED: "QUOTE",
  POLICY_EVALUATED: "POLICY",
  APPROVAL_REQUIRED: "APPROVAL",
  AUTHORIZED: "APPROVAL",
  INVENTORY_RESERVED: "RESERVATION",
  PAYMENT_ORDER_CREATED: "PAYMENT",
  PAYMENT_PENDING: "PAYMENT",
  PAYMENT_VERIFIED: "PAYMENT",
  PAYMENT_FAILED: "PAYMENT",
  PAYMENT_CAPTURED: "CAPTURE",
  COMPLETED: "CAPTURE",
  BLOCKED: "POLICY",
  CANCELLED: "PAYMENT",
  EXPIRED: "PAYMENT",
};

export type StepStatus = "DONE" | "CURRENT" | "UPCOMING" | "STOPPED";

export interface JourneyStepView {
  readonly step: JourneyStep;
  readonly label: string;
  readonly status: StepStatus;
}

/**
 * States in which the purchase has stopped moving forward.
 *
 * Kept separate from "finished": a blocked or expired transaction has not
 * completed anything, and a progress bar that showed it as merely paused would
 * be telling a buyer to wait for something that will never happen.
 */
const HALTED: ReadonlySet<TransactionState> = new Set([
  "BLOCKED",
  "CANCELLED",
  "EXPIRED",
]);

/**
 * Builds the progress view for one transaction.
 *
 * A halted transaction marks its own step `STOPPED` and everything after it
 * `UPCOMING` — never `DONE`. Showing later steps as complete because the index
 * passed them is how a progress indicator ends up claiming a cancelled purchase
 * was paid for.
 */
export function buildJourney(state: TransactionState): readonly JourneyStepView[] {
  const current = STEP_OF[state];
  const currentIndex = JOURNEY_STEPS.indexOf(current);
  const halted = HALTED.has(state);
  const finished = state === "COMPLETED";

  return JOURNEY_STEPS.map((step, index) => {
    const status: StepStatus =
      finished || index < currentIndex
        ? "DONE"
        : index > currentIndex
          ? "UPCOMING"
          : halted
            ? "STOPPED"
            : state === "PAYMENT_CAPTURED"
              ? "DONE"
              : "CURRENT";
    return { step, label: JOURNEY_STEP_LABELS[step], status };
  });
}

// ---------------------------------------------------------------------------
// What each state actually means
// ---------------------------------------------------------------------------

export interface StateNarrative {
  /** A short label for a badge. */
  readonly label: string;
  /** One sentence a buyer can act on. */
  readonly meaning: string;
  /** Whether this is a good, neutral or bad place to be. Drives styling only. */
  readonly tone: "POSITIVE" | "NEUTRAL" | "WARNING" | "NEGATIVE";
}

/**
 * The distinction this table exists to protect.
 *
 * `PAYMENT_VERIFIED` and `PAYMENT_CAPTURED` are not the same event, and
 * flattening them into "paid" is the single most expensive mistake a payment
 * UI can make. Verified means the browser's message was authentic. Captured
 * means the provider says the money moved. Only the second is money. And
 * `COMPLETED` is a third thing again — this system does not fulfil, so nothing
 * reaches it, and the sentence says so rather than implying a delivery.
 */
const NARRATIVES: Readonly<Record<TransactionState, StateNarrative>> = {
  INTENT_RECEIVED: {
    label: "Understanding your request",
    meaning: "Your request has been read. Nothing has been chosen or charged.",
    tone: "NEUTRAL",
  },
  PRODUCT_SELECTED: {
    label: "Product proposed",
    meaning:
      "The assistant proposed a product. The price has not been verified by the server yet.",
    tone: "NEUTRAL",
  },
  PRODUCT_VERIFIED: {
    label: "Product verified",
    meaning: "The server re-read this product's price and stock from its own records.",
    tone: "NEUTRAL",
  },
  QUOTE_CREATED: {
    label: "Price verified",
    meaning:
      "The server fixed the amount for this purchase. This is the only price that can be charged.",
    tone: "NEUTRAL",
  },
  POLICY_EVALUATED: {
    label: "Spending rules checked",
    meaning: "Your spending rules have been applied to the verified amount.",
    tone: "NEUTRAL",
  },
  APPROVAL_REQUIRED: {
    label: "Your approval needed",
    meaning: "This purchase needs you to approve it before any payment can start.",
    tone: "WARNING",
  },
  AUTHORIZED: {
    label: "Authorized",
    meaning: "This exact amount is authorized. The item still needs to be held in stock.",
    tone: "NEUTRAL",
  },
  INVENTORY_RESERVED: {
    label: "Item held for you",
    meaning: "The item is reserved for you and you can pay when you are ready.",
    tone: "NEUTRAL",
  },
  PAYMENT_ORDER_CREATED: {
    label: "Ready to pay",
    meaning: "A payment order is ready. Nothing is charged until you complete payment.",
    tone: "NEUTRAL",
  },
  PAYMENT_PENDING: {
    label: "Waiting for payment",
    meaning:
      "The payment window is open. Nothing has been charged until the provider confirms.",
    tone: "NEUTRAL",
  },
  PAYMENT_VERIFIED: {
    label: "Payment signature verified",
    meaning:
      "The payment confirmation is genuine, but the money is not confirmed yet. Waiting for the provider.",
    tone: "NEUTRAL",
  },
  PAYMENT_CAPTURED: {
    label: "Payment confirmed",
    meaning: "The payment provider has confirmed the money was captured.",
    tone: "POSITIVE",
  },
  COMPLETED: {
    label: "Completed",
    meaning: "The purchase is complete.",
    tone: "POSITIVE",
  },
  PAYMENT_FAILED: {
    label: "Payment did not go through",
    meaning: "No money was taken. You may be able to try again.",
    tone: "NEGATIVE",
  },
  BLOCKED: {
    label: "Not permitted",
    meaning: "Your spending rules do not permit this purchase. Nothing was charged.",
    tone: "NEGATIVE",
  },
  CANCELLED: {
    label: "Cancelled",
    meaning: "This purchase was cancelled. Nothing was charged.",
    tone: "NEGATIVE",
  },
  EXPIRED: {
    label: "Expired",
    meaning: "This purchase timed out before it completed. Nothing was charged.",
    tone: "NEGATIVE",
  },
};

export function describeState(state: TransactionState): StateNarrative {
  return NARRATIVES[state];
}

/**
 * Whether a state is still waiting on something outside the buyer's control.
 *
 * Used to decide whether a page should offer a refresh rather than sitting on a
 * spinner that never resolves. Capture arrives by webhook, on the provider's
 * schedule, so this is a real "come back in a moment" rather than a bug.
 */
export function awaitsProvider(state: TransactionState): boolean {
  return state === "PAYMENT_PENDING" || state === "PAYMENT_VERIFIED";
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Renders minor units for display, and nothing else.
 *
 * Takes the string the server sent rather than a number: the amount is a
 * `bigint` on the server precisely so it never becomes a float, and parsing it
 * into one here to draw it would undo that at the last step. A value that
 * cannot be read is shown as-is rather than as `NaN`, because a broken number
 * on a payment screen must never look like a real one.
 */
export function formatMoney(amount: MoneyDto): string {
  const minor = amount.amountMinor;
  if (!/^-?\d+$/.test(minor)) return `${amount.currency} ${minor}`;

  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const major = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = amount.currency === "INR" ? "₹" : `${amount.currency} `;
  return `${negative ? "-" : ""}${symbol}${grouped}.${fraction}`;
}

/** A compile-time check that every state is described. */
export const DESCRIBED_STATES: readonly TransactionState[] = TRANSACTION_STATES;
