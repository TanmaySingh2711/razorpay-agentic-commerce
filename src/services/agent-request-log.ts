import { assertServerOnly } from "@/lib/server-only";
import { createLogger } from "@/lib/logger";
import { getPrismaClient } from "@/integrations/prisma-client";
import {
  normaliseInsightCategory,
  type AgentRequestOutcome,
} from "@/domain/agent-request";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Writes one row per Buyer Agent request, for the merchant dashboard.
 *
 * Best-effort by design. This row is insight, not evidence: the audit trail is
 * the record of what happened to money, and it is written inside the
 * transactions that move it. If this insert fails, a shopper must still get
 * their answer - so a failure here is logged and swallowed, never thrown into
 * the purchase path.
 *
 * What is stored is the *structured* shape of the request - category, budget,
 * outcome, cost - and never the sentence the shopper typed.
 */
assertServerOnly("src/services/agent-request-log.ts");

const log = createLogger({ category: "agent" });

export interface AgentRequestEntry {
  readonly outcome: AgentRequestOutcome;
  /** The agent's decision, when it got far enough to make one. */
  readonly decision?: BuyerAgentDecision;
  readonly transactionId?: string | null;
  /** Used when there is no decision to take the timing from. */
  readonly durationMs: number;
  readonly turn?: number;
}

export async function recordAgentRequest(
  entry: AgentRequestEntry,
  prisma: PrismaClient = getPrismaClient(),
): Promise<void> {
  const constraints = entry.decision?.constraints;
  const trace = entry.decision?.trace;
  const budget = constraints?.maxBudget ?? null;
  try {
    await prisma.agentRequest.create({
      data: {
        outcome: entry.outcome,
        requestType: constraints?.requestType ?? null,
        category: normaliseInsightCategory(constraints?.category),
        maxBudgetMinor: budget === null ? null : BigInt(budget.amountMinor),
        currency: budget?.currency ?? null,
        transactionId: entry.transactionId ?? null,
        turn: trace?.turn ?? entry.turn ?? 1,
        modelCalls: trace?.modelCalls ?? null,
        toolCalls: trace?.toolCalls ?? null,
        productsObserved: trace?.productsObserved ?? null,
        durationMs: Math.max(0, Math.round(trace?.durationMs ?? entry.durationMs)),
      },
    });
  } catch (error) {
    log.warn("agent request insight was not recorded", {
      outcome: entry.outcome,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}
