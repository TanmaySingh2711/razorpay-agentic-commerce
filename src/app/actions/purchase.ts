"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPrismaClient } from "@/integrations/persistence/client";
import { createLogger } from "@/lib/logger";
import { decideApproval, requestApproval } from "@/services/approval/approval-service";
import { reserveInventory } from "@/services/inventory/reservation-service";
import { evaluateQuotePolicy } from "@/services/policy/policy-service";
import { decidePurchase } from "@/services/product-decision/product-decision-service";
import { runBuyerAgent } from "@/services/buyer-agent/buyer-agent-service";

/**
 * The buyer's actions, as server actions.
 *
 * Every one of these runs on the server and composes the services that already
 * exist. That is the whole design: a Server Action is a function the browser
 * may *invoke*, not a function the browser may *define*. The arguments below
 * are the complete list of what a page can influence — a sentence, and a
 * transaction id — and there is deliberately nowhere to put an amount, a
 * currency, a product id, a policy result, an approval or a retry count.
 *
 * Nothing here decides anything financial. Each action calls the existing
 * boundary and reports what that boundary answered; the amount comes from the
 * persisted quote, the policy is re-run by the policy engine, the attempt limit
 * is counted from rows. A different UI calling these actions in a different
 * order cannot reach a state the server would not otherwise allow, because the
 * gate in every service is the transaction's own persisted state.
 */

const log = createLogger({ category: "transaction" });

/** Ours to generate, never the caller's: it is an idempotency key. */
const operation = (): string => randomUUID();

const messageSchema = z.string().trim().min(1).max(1000);
const transactionIdSchema = z.string().uuid();

/**
 * What the console renders after a request that did not open a purchase.
 *
 * A successful purchase does not appear here — it redirects to the transaction
 * page, so the buyer lands somewhere with a URL they can return to rather than
 * on a result that vanishes on refresh.
 */
export type RequestOutcome =
  | { readonly kind: "IDLE" }
  | { readonly kind: "CLARIFICATION"; readonly question: string }
  | { readonly kind: "NO_MATCH"; readonly summary: string }
  | { readonly kind: "NOT_A_PURCHASE"; readonly summary: string }
  | { readonly kind: "REFUSED"; readonly summary: string }
  | { readonly kind: "ERROR"; readonly message: string };

/**
 * Interprets a sentence and, if it describes a purchase, opens one.
 *
 * The redirect on success is deliberate. It leaves the buyer on a durable URL,
 * makes the back button behave, and means the page that shows money is a server
 * component reading current state rather than a client holding a stale copy of
 * it.
 */
export async function submitRequest(
  _previous: RequestOutcome,
  formData: FormData,
): Promise<RequestOutcome> {
  const parsed = messageSchema.safeParse(formData.get("message"));
  if (!parsed.success) {
    return {
      kind: "ERROR",
      message: "Type what you are looking for, in a sentence or two.",
    };
  }

  let transactionId: string;
  try {
    const decision = await runBuyerAgent({ message: parsed.data });
    const result = await decidePurchase(decision);

    switch (result.kind) {
      case "QUOTE_CREATED":
        transactionId = result.transactionId;
        break;
      case "CLARIFICATION_REQUIRED":
        return { kind: "CLARIFICATION", question: result.question };
      case "NO_QUOTE_REQUIRED":
        return {
          kind: "NOT_A_PURCHASE",
          summary:
            "That reads as browsing rather than buying. Say what you would like to buy and I will price it.",
        };
      case "NO_VALID_CANDIDATE":
        return {
          kind: "NO_MATCH",
          summary: "Nothing in this catalog matches what you asked for.",
        };
      case "AI_SELECTION_REJECTED":
        // The assistant proposed something the server would not stand behind.
        // Worth saying plainly: it is the safety property working, not a fault.
        return {
          kind: "REFUSED",
          summary:
            "The assistant suggested a product the server could not verify against your request, so nothing was opened.",
        };
      case "HARD_REQUIREMENT_UNVERIFIABLE":
        return {
          kind: "REFUSED",
          summary:
            "This catalog does not record enough about the products to confirm one of your requirements, so nothing was opened.",
        };
      case "REEVALUATION_REQUIRED":
        return {
          kind: "REFUSED",
          summary:
            "The product details changed while your request was being priced. Please try again.",
        };
    }

    // Policy runs immediately, so the buyer lands on a page that already knows
    // whether this is allowed, needs them, or is refused.
    const policy = await evaluateQuotePolicy({
      quoteId: result.quote.id,
      operationId: operation(),
    });
    if (policy.kind !== "EVALUATED") {
      log.warn("policy could not evaluate a fresh quote", {
        transactionId,
        outcome: policy.kind,
      });
    }
  } catch (error: unknown) {
    // The message is written here; the cause goes to the operator log. A model
    // or provider failure must not reach a buyer as a stack trace.
    log.error("a buyer request could not be completed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return {
      kind: "ERROR",
      message:
        "The assistant could not be reached just now. Nothing was charged. Please try again.",
    };
  }

  redirect(`/transaction/${transactionId}`);
}

// ---------------------------------------------------------------------------
// Decisions a person makes about an open purchase
// ---------------------------------------------------------------------------

export type DecisionOutcome =
  | { readonly kind: "IDLE" }
  | { readonly kind: "DONE"; readonly message: string }
  | { readonly kind: "ERROR"; readonly message: string };

/**
 * Records the buyer's answer to an approval question.
 *
 * ## Why the token never reaches the browser
 *
 * The approval token is the security primitive: it is minted once, hashed, and
 * bound to this transaction, this quote, this exact amount and currency, and
 * the policy version in force. `requestApproval` returns the plaintext exactly
 * once and no operation ever returns it again.
 *
 * A production deployment sends that token to the person out of band — an
 * email, a push, a message — and their possession of it is what proves the
 * approval came from them. This demo has no authentication and therefore no
 * such channel, so there is no honest way to *use* an out-of-band token here.
 *
 * Rather than invent a weaker scheme, or ship the token to the browser where it
 * could be read or replayed, this action mints and consumes it inside one
 * server call. What that preserves is everything the token binds: the decision
 * still applies to one specific quote and amount, it is still single-use, and
 * it is still verified by digest. What it does not provide is proof of *who*
 * clicked — which this demo could not provide anyway, and which is stated here
 * rather than implied by a token-shaped ceremony.
 *
 * The browser sends a transaction id and the word approve or reject. Nothing
 * else.
 */
async function decide(
  transactionId: string,
  decision: "APPROVE" | "REJECT",
): Promise<DecisionOutcome> {
  const id = transactionIdSchema.safeParse(transactionId);
  if (!id.success) return { kind: "ERROR", message: "Unknown purchase." };

  try {
    const requested = await requestApproval({
      transactionId: id.data,
      operationId: operation(),
    });

    if (requested.kind === "APPROVAL_NOT_REQUIRED") {
      return { kind: "ERROR", message: "This purchase is not waiting for approval." };
    }
    if (requested.kind === "APPROVAL_ALREADY_PENDING") {
      // The plaintext is never stored, so a token issued by an earlier call
      // cannot be recovered - by design. Saying so is more useful than a
      // generic failure, because the buyer has not done anything wrong.
      return {
        kind: "ERROR",
        message:
          "An approval for this purchase is already open and must be answered where it was issued.",
      };
    }

    const buyer = await getPrismaClient().transaction.findUnique({
      where: { id: id.data },
      select: { buyerProfileId: true },
    });
    if (buyer === null) return { kind: "ERROR", message: "Unknown purchase." };

    const answered = await decideApproval({
      token: requested.token,
      decision,
      decidedByBuyerId: buyer.buyerProfileId,
      operationId: operation(),
    });

    switch (answered.kind) {
      case "AUTHORIZED":
        return { kind: "DONE", message: "Approved. You can pay when you are ready." };
      case "REJECTED":
        return { kind: "DONE", message: "Rejected. Nothing has been charged." };
      default:
        return {
          kind: "ERROR",
          message: "That approval is no longer valid. Nothing has been charged.",
        };
    }
  } catch (error: unknown) {
    log.error("an approval decision could not be recorded", {
      transactionId: id.data,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "ERROR", message: "That could not be recorded. Nothing was charged." };
  }
}

export async function approvePurchase(
  _previous: DecisionOutcome,
  formData: FormData,
): Promise<DecisionOutcome> {
  return await decide(String(formData.get("transactionId") ?? ""), "APPROVE");
}

export async function rejectPurchase(
  _previous: DecisionOutcome,
  formData: FormData,
): Promise<DecisionOutcome> {
  return await decide(String(formData.get("transactionId") ?? ""), "REJECT");
}

/**
 * Holds stock for an authorized purchase.
 *
 * Separate from approval, and from payment, because it is a separate promise:
 * the item is set aside for a bounded window. The service refuses anything not
 * `AUTHORIZED`, so this cannot be used to hold stock for a purchase nobody has
 * agreed to pay for.
 */
export async function reserveStock(
  _previous: DecisionOutcome,
  formData: FormData,
): Promise<DecisionOutcome> {
  const id = transactionIdSchema.safeParse(formData.get("transactionId"));
  if (!id.success) return { kind: "ERROR", message: "Unknown purchase." };

  try {
    const result = await reserveInventory({
      transactionId: id.data,
      operationId: operation(),
    });
    return result.kind === "RESERVED"
      ? { kind: "DONE", message: "The item is held for you." }
      : {
          kind: "ERROR",
          message: "That item could not be held. It may no longer be available.",
        };
  } catch (error: unknown) {
    log.error("stock could not be held", {
      transactionId: id.data,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "ERROR", message: "The item could not be held just now." };
  }
}
