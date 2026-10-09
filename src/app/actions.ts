"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPrismaClient } from "@/integrations/prisma-client";
import { createLogger } from "@/lib/logger";
import { decideApproval, requestApproval } from "@/services/approval-service";
import { reserveInventory } from "@/services/reservation-service";
import { describeReservationRefusal } from "@/domain/inventory";
import { evaluateQuotePolicy } from "@/services/policy-service";
import { decidePurchase } from "@/services/product-decision-service";
import {
  MAX_ASSISTANT_QUESTION_LENGTH,
  MAX_PRIOR_TURNS,
  runBuyerAgent,
  type ConversationTurn,
} from "@/services/buyer-agent-service";
import {
  limitAgentRequest,
  limitPaymentRequest,
  type RateLimitDecision,
} from "@/services/rate-limit-service";
import { recordAgentRequest } from "@/services/agent-request-log";
import { reconcileRefund, requestRefund } from "@/services/refund-service";
import { describeRefundDenial } from "@/domain/refund";
import { clientKeyFromHeaders } from "@/domain/rate-limit";
import { MERCHANT_CATEGORIES } from "@/domain/catalog/categories";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
import type { MoneyDto } from "@/domain/money";
import { formatMoney } from "@/domain/journey";
import { MAX_HISTORY_ENTRIES } from "@/lib/purchase-history";
import {
  loadPurchaseSummaries,
  type PurchaseSummary,
} from "@/services/purchase-history-service";

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
  | {
      readonly kind: "CLARIFICATION";
      readonly question: string;
      /**
       * The exchange so far, handed back so the next answer can continue it.
       * The browser keeps it and returns it; the server re-validates it and
       * trusts only the shopper's half (see `ConversationTurn`).
       */
      readonly conversation: readonly ConversationTurn[];
    }
  | { readonly kind: "NO_MATCH"; readonly summary: string }
  | { readonly kind: "NOT_A_PURCHASE"; readonly summary: string }
  | {
      /**
       * The shopper asked for advice or options, not a purchase, and the
       * assistant's pick passed every deterministic check. Nothing is opened:
       * the price shown is the catalog's price at this moment, and buying it
       * means sending `buyPrompt` as a new request - which the server prices,
       * checks and quotes from scratch like any other.
       */
      readonly kind: "RECOMMENDATION";
      readonly productName: string;
      readonly price: MoneyDto;
      readonly summary: string;
      readonly buyPrompt: string;
    }
  | { readonly kind: "REFUSED"; readonly summary: string }
  | { readonly kind: "ERROR"; readonly message: string };

/** What a browser may send back as the conversation so far. Bounded like the agent's own check. */
const conversationSchema = z
  .array(
    z.strictObject({
      shopper: z.string().trim().min(1).max(1000),
      assistantQuestion: z.string().trim().max(MAX_ASSISTANT_QUESTION_LENGTH),
    }),
  )
  .max(MAX_PRIOR_TURNS);

/** Reads the hidden conversation field. Absent or blank means a fresh request. */
function readConversation(
  raw: FormDataEntryValue | null,
): readonly ConversationTurn[] | null {
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return [];
  if (typeof raw !== "string") return null;
  try {
    const parsed = conversationSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The categories this shop sells, in words a person reads. */
const SOLD_HERE = MERCHANT_CATEGORIES.map((category) => category.replace(/-/g, " ")).join(
  ", ",
);

/**
 * A browse or advice answer, turned into something the shopper can act on.
 *
 * The suggested follow-up restates the shopper's own verified ceiling in
 * words the budget check reads back exactly ("under ₹3,000.00"), so buying
 * the recommendation keeps the limit they set rather than dropping it.
 */
function recommendationFrom(
  decision: Extract<BuyerAgentDecision, { kind: "PRODUCT_SELECTED" }>,
): Extract<RequestOutcome, { kind: "RECOMMENDATION" }> {
  const budget = decision.constraints.maxBudget;
  return {
    kind: "RECOMMENDATION",
    productName: decision.observedProduct.name,
    price: decision.observedProduct.amount,
    summary: decision.summary,
    buyPrompt: `Buy the ${decision.observedProduct.name}${
      budget === null ? "" : ` under ${formatMoney(budget)}`
    }`,
  };
}

/** The caller's rate-limit identity, from the request this action is serving. */
async function clientKey(): Promise<string> {
  return clientKeyFromHeaders(await headers());
}

/** One sentence for a refusal by the abuse ceilings. */
function rateLimitedMessage(decision: RateLimitDecision): string {
  if (decision.kind !== "LIMITED") return "";
  return decision.rule === "agent-global-day"
    ? "The assistant has reached today's usage limit for this demo. Please come back tomorrow - nothing was charged."
    : `You are sending requests faster than this demo allows. Please wait ${String(
        Math.min(decision.retryAfterSeconds, 3600),
      )} seconds and try again - nothing was charged.`;
}

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
  const conversation = readConversation(formData.get("conversation"));
  if (conversation === null) {
    return {
      kind: "ERROR",
      message: "That conversation could not be continued. Please start a new request.",
    };
  }
  const turn = conversation.length + 1;
  const startedAt = Date.now();

  // The abuse and cost ceilings come before the model does. A refusal here
  // spends no quota, and it is still worth a row: a merchant seeing a wall of
  // rate-limited requests is looking at an attack, not at demand.
  let limited: RateLimitDecision;
  try {
    limited = await limitAgentRequest(await clientKey());
  } catch (error: unknown) {
    log.error("the rate limiter could not answer", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return {
      kind: "ERROR",
      message:
        "The assistant is unavailable just now. Nothing was charged. Please try again.",
    };
  }
  if (limited.kind === "LIMITED") {
    await recordAgentRequest({ outcome: "RATE_LIMITED", durationMs: 0, turn });
    return { kind: "ERROR", message: rateLimitedMessage(limited) };
  }

  let transactionId: string;
  let decision: BuyerAgentDecision | undefined;
  try {
    decision = await runBuyerAgent({ message: parsed.data, priorTurns: conversation });
    const result = await decidePurchase(decision);
    const insight = (
      outcome: Parameters<typeof recordAgentRequest>[0]["outcome"],
      opened: string | null = null,
    ) =>
      recordAgentRequest({
        outcome,
        ...(decision === undefined ? {} : { decision }),
        transactionId: opened,
        durationMs: Date.now() - startedAt,
        turn,
      });

    switch (result.kind) {
      case "QUOTE_CREATED":
        transactionId = result.transactionId;
        await insight("PURCHASE_OPENED", transactionId);
        break;
      case "CLARIFICATION_REQUIRED": {
        await insight("CLARIFICATION");
        // The conversation continues only while there is room for another
        // turn; past that, the next message starts fresh rather than being
        // refused for carrying too much history.
        const next = [
          ...conversation,
          { shopper: parsed.data, assistantQuestion: result.question },
        ];
        return {
          kind: "CLARIFICATION",
          question: result.question,
          conversation: next.length > MAX_PRIOR_TURNS ? [] : next,
        };
      }
      case "NO_QUOTE_REQUIRED":
        await insight("NOT_A_PURCHASE");
        if (decision.kind === "PRODUCT_SELECTED") {
          return recommendationFrom(decision);
        }
        return {
          kind: "NOT_A_PURCHASE",
          summary:
            "That reads as browsing rather than buying. Say what you would like to buy and I will price it.",
        };
      case "NO_VALID_CANDIDATE": {
        await insight("NO_MATCH");
        // Being out of stock and being the wrong product are different
        // disappointments, and only one of them is worth coming back for. The
        // reasons come from the deterministic candidate check, so this is
        // reporting what the server found rather than guessing.
        const soldOut = result.reasons.some(
          (reason) => reason === "NOT_PURCHASABLE" || reason === "INSUFFICIENT_INVENTORY",
        );
        return {
          kind: "NO_MATCH",
          summary: soldOut
            ? "Nothing matching your request is in stock right now, so nothing was opened. Please try again later, or describe something a little different."
            : `Nothing in this catalog matches what you asked for. This shop sells ${SOLD_HERE}.`,
        };
      }
      case "AI_SELECTION_REJECTED":
        await insight("REFUSED", result.transactionId);
        // The assistant proposed something the server would not stand behind.
        // Worth saying plainly: it is the safety property working, not a fault.
        return {
          kind: "REFUSED",
          summary:
            "The assistant suggested a product the server could not verify against your request, so nothing was opened.",
        };
      case "HARD_REQUIREMENT_UNVERIFIABLE":
        await insight("REFUSED");
        return {
          kind: "REFUSED",
          summary:
            "This catalog does not record enough about the products to confirm one of your requirements, so nothing was opened.",
        };
      case "REEVALUATION_REQUIRED":
        await insight("REFUSED", result.transactionId);
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
    await recordAgentRequest({
      outcome: "ERROR",
      ...(decision === undefined ? {} : { decision }),
      durationMs: Date.now() - startedAt,
      turn,
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
    // Read the buyer *before* minting anything.
    //
    // The token is returned in plaintext exactly once and is never stored, so
    // every step between minting it and spending it is a step that can strand
    // it: the approval row is left PENDING, the plaintext is gone, and this
    // purchase cannot be approved again until the window expires. This lookup
    // used to sit in that gap, which meant a transaction that had been deleted
    // - or one round trip that failed - cost the buyer the approval. Nothing
    // here needs the approval to exist, so nothing here belongs after it.
    const buyer = await getPrismaClient().transaction.findUnique({
      where: { id: id.data },
      select: { buyerProfileId: true },
    });
    if (buyer === null) return { kind: "ERROR", message: "Unknown purchase." };

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

    const answered = await decideApproval({
      token: requested.token,
      decision,
      decidedByBuyerId: buyer.buyerProfileId,
      operationId: operation(),
    });

    switch (answered.kind) {
      case "AUTHORIZED":
        // The transaction's state has genuinely moved, so the page that renders
        // it is now stale. Without this the buyer sees the old step until they
        // press F5 - the decision landed, but the journey appeared frozen.
        revalidatePath(`/transaction/${id.data}`);
        return { kind: "DONE", message: "Approved. You can pay when you are ready." };
      case "REJECTED":
        revalidatePath(`/transaction/${id.data}`);
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
    if (result.kind === "RESERVED") {
      // Same reason as the approval decision above: the hold changes the state
      // the page is rendering, so the page must be re-read rather than left for
      // the buyer to refresh by hand.
      revalidatePath(`/transaction/${id.data}`);
      return { kind: "DONE", message: "The item is held for you." };
    }

    // A refusal is not a dead end, and the four reasons are not the same
    // problem. The stock case in particular is ordinary - somebody else
    // finished checking out first - and the buyer needs to be told what to do
    // next rather than left reading "could not be held". No substitution is
    // attempted *here*: this transaction's quote, policy decision and any
    // approval are all bound to one product and one amount, and quietly
    // swapping the product underneath them would invalidate every one of those
    // bindings. The honest move is a fresh purchase, which re-runs all of it.
    return { kind: "ERROR", message: describeReservationRefusal(result.refusal) };
  } catch (error: unknown) {
    log.error("stock could not be held", {
      transactionId: id.data,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "ERROR", message: "The item could not be held just now." };
  }
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Asks for a completed purchase's money back.
 *
 * Like every action here, the browser sends a transaction id and nothing
 * else: which payment, how much and in which currency are all read from the
 * captured attempt by the refund service. The payment ceiling applies, since
 * this reaches the payment provider.
 */
export async function refundPurchase(
  _previous: DecisionOutcome,
  formData: FormData,
): Promise<DecisionOutcome> {
  const id = transactionIdSchema.safeParse(formData.get("transactionId"));
  if (!id.success) return { kind: "ERROR", message: "Unknown purchase." };

  try {
    const limited = await limitPaymentRequest(await clientKey());
    if (limited.kind === "LIMITED") {
      return {
        kind: "ERROR",
        message: `Too many requests. Please wait ${String(limited.retryAfterSeconds)} seconds and try again.`,
      };
    }

    const result = await requestRefund({
      transactionId: id.data,
      operationId: operation(),
    });
    revalidatePath(`/transaction/${id.data}`);
    switch (result.kind) {
      case "REFUND_STARTED":
        return {
          kind: "DONE",
          message:
            result.status === "PROCESSED"
              ? "Refunded. The money is on its way back to your original payment method."
              : "Refund accepted. The payment provider is returning the money.",
        };
      case "DENIED":
        return { kind: "ERROR", message: describeRefundDenial(result.denial) };
      case "PROVIDER_FAILED":
        return {
          kind: "ERROR",
          message:
            "The payment provider could not process the refund. Nothing changed; you can try again.",
        };
      case "RECONCILIATION_REQUIRED":
        return {
          kind: "DONE",
          message:
            "The refund was sent, but the payment provider has not confirmed it yet. It will never be sent twice - use Check refund status in a moment.",
        };
    }
  } catch (error: unknown) {
    log.error("a refund could not be requested", {
      transactionId: id.data,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "ERROR", message: "The refund could not be requested just now." };
  }
}

/**
 * Asks the provider where an open refund stands. Read-only towards the
 * provider: this can settle a refund's status but never create one.
 */
export async function checkRefundStatus(
  _previous: DecisionOutcome,
  formData: FormData,
): Promise<DecisionOutcome> {
  const id = transactionIdSchema.safeParse(formData.get("transactionId"));
  if (!id.success) return { kind: "ERROR", message: "Unknown purchase." };
  try {
    const limited = await limitPaymentRequest(await clientKey());
    if (limited.kind === "LIMITED") {
      return { kind: "ERROR", message: "Too many requests. Please wait a moment." };
    }
    const status = await reconcileRefund(id.data);
    revalidatePath(`/transaction/${id.data}`);
    return {
      kind: "DONE",
      message:
        status === null
          ? "There is no open refund on this purchase."
          : `Refund status: ${status.replace(/_/g, " ").toLowerCase()}.`,
    };
  } catch (error: unknown) {
    log.error("a refund status check failed", {
      transactionId: id.data,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "ERROR", message: "The refund status could not be checked just now." };
  }
}

// ---------------------------------------------------------------------------
// Purchase history
// ---------------------------------------------------------------------------

export type PurchaseHistoryOutcome =
  | { readonly kind: "LOADED"; readonly purchases: readonly PurchaseSummary[] }
  | { readonly kind: "ERROR"; readonly message: string };

const historyIdsSchema = z.array(z.string()).max(MAX_HISTORY_ENTRIES);

/**
 * Where each remembered purchase stands now.
 *
 * The browser keeps the ids (there is no login, so it is the only place a
 * person's own history can live); this returns, for exactly those ids, what
 * their purchase pages would show. Read-only: no limit is consumed and
 * nothing is written, because nothing here costs money or quota.
 */
export async function loadPurchaseHistory(ids: unknown): Promise<PurchaseHistoryOutcome> {
  const parsed = historyIdsSchema.safeParse(ids);
  if (!parsed.success) {
    return { kind: "ERROR", message: "The saved history could not be read." };
  }
  try {
    return { kind: "LOADED", purchases: await loadPurchaseSummaries(parsed.data) };
  } catch (error: unknown) {
    log.error("purchase history could not be loaded", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return {
      kind: "ERROR",
      message: "Your purchases could not be loaded just now. Please try again.",
    };
  }
}
