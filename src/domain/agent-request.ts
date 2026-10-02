/**
 * How one Buyer Agent request ended, as a merchant is allowed to see it.
 *
 * The authoritative list; the `agent_request_outcome` database enum mirrors it
 * and `tests/db/enum-parity.test.ts` fails the build if the two drift.
 *
 * It is coarser than the agent's own decision on purpose. A merchant needs to
 * know that a request became a purchase, needed a question, or found nothing -
 * not which internal check refused a proposal - and every value here can be
 * shown on a dashboard without explaining the safety architecture first.
 */
export const AGENT_REQUEST_OUTCOMES = [
  /** A trusted quote exists: the request became a purchase in progress. */
  "PURCHASE_OPENED",
  /** The agent needed one more fact from the shopper before it could act. */
  "CLARIFICATION",
  /** Nothing the merchant sells satisfied the request. Unmet demand. */
  "NO_MATCH",
  /** The shopper was browsing or asking for advice, not buying. */
  "NOT_A_PURCHASE",
  /** The server refused what the assistant proposed. The safety net working. */
  "REFUSED",
  /** The request could not be completed - the AI provider failed, for example. */
  "ERROR",
  /** Turned away by the abuse and cost limits before any model was called. */
  "RATE_LIMITED",
] as const;

export type AgentRequestOutcome = (typeof AGENT_REQUEST_OUTCOMES)[number];

/** The longest category string an insight row may carry. */
export const MAX_INSIGHT_CATEGORY_LENGTH = 40;

/**
 * Reduces a category term to something safe to store and chart.
 *
 * The value may have come from a model (the shopper's own word for a thing
 * this merchant does not sell), so it is treated as untrusted text: lowercased,
 * stripped to letters, digits, spaces and hyphens, whitespace collapsed, and
 * bounded. What survives is a label, not a sentence - an instruction smuggled
 * into a category name has nowhere left to live. Empty becomes null.
 */
export function normaliseInsightCategory(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INSIGHT_CATEGORY_LENGTH)
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}
