import type { AgentRequestOutcome } from "@/domain/agent-request";

/**
 * The merchant dashboard's arithmetic, as pure functions.
 *
 * Everything here turns rows the server already holds into numbers a merchant
 * can act on. None of it decides anything: the dashboard is read-only, and
 * the figures are computed from persisted facts - captured payments, processed
 * refunds, the structured shape of agent requests - never from model output.
 *
 * Money stays integer minor units (bigint) end to end; the only division in
 * this file is for rates and averages, which are presentation, not ledger.
 */

/** Median of a list, or null for an empty one. */
export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}

/**
 * Nearest-rank percentile. Chosen over interpolation because every value it
 * returns is one that actually happened - a "p90 latency" that no request ever
 * had is a number nobody can go and look at.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/** A share as a whole percentage, or null when there is nothing to divide by. */
export function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

/** Median of bigint amounts, without ever converting money to a float. */
export function medianAmount(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.ceil(sorted.length / 2) - 1] ?? null;
}

/** One stage of the path from a sentence to settled money. */
export interface FunnelStage {
  readonly label: string;
  readonly count: number;
  /** Share of the first stage, as a whole percentage. */
  readonly ofTotal: number | null;
}

/**
 * The funnel: every stage expressed against the first, so a merchant reads
 * "how many of the people who asked ended up paying", not a chain of
 * stage-to-stage ratios that multiply in their head.
 */
export function buildFunnel(
  stages: readonly { readonly label: string; readonly count: number }[],
): readonly FunnelStage[] {
  const first = stages[0]?.count ?? 0;
  return stages.map((stage) => ({
    label: stage.label,
    count: stage.count,
    ofTotal: rate(stage.count, first),
  }));
}

/** What an unmet request looked like, for grouping. */
export interface UnmetRequest {
  readonly category: string | null;
  readonly maxBudgetMinor: bigint | null;
}

/** A category shoppers asked for that produced no sale. */
export interface UnmetDemand {
  readonly category: string;
  readonly requests: number;
  /** Whether this merchant sells the category at all. */
  readonly soldHere: boolean;
  /** The typical stated budget, when shoppers stated one. */
  readonly medianBudgetMinor: bigint | null;
  /** The cheapest in-stock price in the category, when it is sold here. */
  readonly cheapestMinor: bigint | null;
  /**
   * How many of these requests had a budget below the cheapest price - demand
   * a cheaper product would have converted.
   */
  readonly belowCheapest: number;
}

/**
 * Groups no-match requests into the two things a merchant can do something
 * about: categories they do not stock, and price points they do not reach.
 *
 * Requests with no category are left out rather than lumped into "other": a
 * bucket labelled with nothing tells nobody what to stock.
 */
export function unmetDemand(
  requests: readonly UnmetRequest[],
  cheapestByCategory: ReadonlyMap<string, bigint>,
  limit = 6,
): readonly UnmetDemand[] {
  const groups = new Map<string, UnmetRequest[]>();
  for (const request of requests) {
    if (request.category === null) continue;
    const group = groups.get(request.category) ?? [];
    group.push(request);
    groups.set(request.category, group);
  }

  return [...groups.entries()]
    .map(([category, group]): UnmetDemand => {
      const budgets = group
        .map((request) => request.maxBudgetMinor)
        .filter((amount): amount is bigint => amount !== null);
      const cheapest = cheapestByCategory.get(category) ?? null;
      return {
        category,
        requests: group.length,
        soldHere: cheapestByCategory.has(category),
        medianBudgetMinor: medianAmount(budgets),
        cheapestMinor: cheapest,
        belowCheapest:
          cheapest === null ? 0 : budgets.filter((budget) => budget < cheapest).length,
      };
    })
    .sort((a, b) => b.requests - a.requests || a.category.localeCompare(b.category))
    .slice(0, limit);
}

/** Counts per outcome, with every outcome present - zero included. */
export function countOutcomes(
  outcomes: readonly AgentRequestOutcome[],
  vocabulary: readonly AgentRequestOutcome[],
): Readonly<Record<AgentRequestOutcome, number>> {
  const counts = Object.fromEntries(vocabulary.map((outcome) => [outcome, 0])) as Record<
    AgentRequestOutcome,
    number
  >;
  for (const outcome of outcomes) counts[outcome] += 1;
  return counts;
}
