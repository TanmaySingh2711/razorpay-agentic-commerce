import { createHmac, randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import {
  assertLocalHost,
  assertNotDisposableTestDatabase,
} from "./database-target-guard";
// Type-only: erased at runtime, so they cannot bind a database before the
// environment below is settled.
import type { PaymentProvider } from "@/domain/payment/provider";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";

/**
 * `npm run db:dev:demo` - shopper activity for the LOCAL development database.
 *
 * The merchant dashboard and the transaction pages are only as interesting as
 * the purchases behind them, and producing those by hand means spending real
 * Gemini quota and clicking through Razorpay Test Mode a dozen times. This
 * script drives the same purchases through the **real services** instead -
 * product decision, trusted quote, policy, human approval, stock hold, payment
 * order, checkout, signed webhook reconciliation, retry and refund - so every
 * row it leaves behind was written by the code paths production uses.
 *
 * Two things are substituted, and only these two:
 *
 *  - **the model**: each session starts from a Buyer Agent decision written
 *    here, with a plausible trace, rather than from a live Gemini call;
 *  - **the payment provider**: an in-process stand-in that accepts orders and
 *    refunds and signs its own webhooks. No request leaves this machine.
 *
 * It refuses any database that is not on this machine, and the disposable test
 * database, before it connects - the same guard every local command uses.
 */

loadEnv({ path: ".env.development.local", quiet: true });
loadEnv({ path: ".env.local", quiet: true });

const WEBHOOK_SECRET = "dev-demo-activity-webhook-secret";
const KEY_ID = "rzp_test_devdemoactivity";

async function main(): Promise<void> {
  const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Run `npm run db:dev:setup` first - it writes .env.development.local.",
    );
  }
  assertLocalHost(url);
  assertNotDisposableTestDatabase(url, "npm run db:dev:demo");
  // Every service below reads the application connection; point it at the
  // development database this guard just cleared.
  process.env["DATABASE_URL"] = url;

  // Imported after the environment is settled, so the shared client binds to
  // the development database and nothing else.
  const { getPrismaClient } = await import("@/integrations/prisma-client");
  const { systemClock } = await import("@/lib/clock");
  const { decidePurchase } = await import("@/services/product-decision-service");
  const { evaluateQuotePolicy } = await import("@/services/policy-service");
  const { requestApproval, decideApproval } = await import("@/services/approval-service");
  const { reserveInventory } = await import("@/services/reservation-service");
  const { createPaymentOrder } = await import("@/services/payment-order-service");
  const { startCheckout } = await import("@/services/checkout-service");
  const { processWebhook } = await import("@/services/webhook-service");
  const { requestPaymentRetry } = await import("@/services/retry-service");
  const { requestRefund } = await import("@/services/refund-service");
  const { recordAgentRequest } = await import("@/services/agent-request-log");
  const { canonicalCategory } = await import("@/domain/catalog/categories");

  const prisma = getPrismaClient();
  const clock = systemClock;

  // --- The stand-in provider: accepts, never calls out. ---
  let issued = 0;
  const provider: PaymentProvider = {
    name: "RAZORPAY",
    createOrder: (request) => {
      issued += 1;
      return Promise.resolve({
        kind: "CREATED",
        order: {
          providerOrderId: `order_Demo${Date.now().toString(36)}${String(issued)}`,
          amountMinor: request.amountMinor,
          currency: request.currency,
          receipt: request.receipt,
          status: "created",
        },
      });
    },
    findOrderByReceipt: () => Promise.resolve({ kind: "NOT_FOUND" }),
    listOrderPayments: () => Promise.resolve({ kind: "FOUND", payments: [] }),
    createRefund: (request) =>
      Promise.resolve({
        kind: "CREATED",
        refund: {
          providerRefundId: `rfnd_Demo${Date.now().toString(36)}`,
          providerPaymentId: request.providerPaymentId,
          amountMinor: request.amountMinor,
          currency: request.currency,
          receipt: request.receipt,
          status: "processed",
        },
      }),
    findRefundByReceipt: () => Promise.resolve({ kind: "NOT_FOUND" }),
    verifyCheckoutSignature: () => true,
    verifyWebhookSignature: (input) =>
      createHmac("sha256", WEBHOOK_SECRET).update(input.rawBody, "utf8").digest("hex") ===
      input.signature,
  };

  const quote = { prisma, clock, ttlSeconds: 900 };
  const policyDeps = { prisma, clock, quote };
  const reservation = { prisma, clock, ttlSeconds: 1800 };
  const paymentDeps = { prisma, clock, provider, providerKeyId: KEY_ID };

  async function webhook(
    event: "payment.captured" | "payment.failed",
    orderId: string,
    amount: bigint,
  ) {
    const rawBody = JSON.stringify({
      event,
      payload: {
        payment: {
          entity: {
            id: `pay_Demo${randomUUID().replace(/-/g, "").slice(0, 14)}`,
            order_id: orderId,
            amount: Number(amount),
            currency: "INR",
            status: event === "payment.captured" ? "captured" : "failed",
            ...(event === "payment.failed"
              ? {
                  error_code: "BAD_REQUEST_ERROR",
                  error_source: "customer",
                  error_step: "payment_authentication",
                  error_reason: "payment_cancelled",
                }
              : {}),
          },
        },
      },
    });
    return processWebhook(
      {
        rawBody,
        signature: createHmac("sha256", WEBHOOK_SECRET)
          .update(rawBody, "utf8")
          .digest("hex"),
        providerEventId: `evt_demo_${randomUUID()}`,
      },
      { prisma, provider, clock },
    );
  }

  const products = await prisma.product.findMany({
    where: { status: "AVAILABLE", inventory: { gt: 0 } },
    select: {
      id: true,
      name: true,
      category: true,
      unitAmount: true,
      version: true,
      inventory: true,
      updatedAt: true,
    },
    orderBy: { unitAmount: "asc" },
  });
  const pick = (category: string, index: number) => {
    const inCategory = products.filter((product) => product.category === category);
    const product = inCategory[Math.min(index, inCategory.length - 1)];
    if (product === undefined)
      throw new Error(`no ${category} in the catalog - seed it first`);
    return product;
  };

  function decision(
    product: (typeof products)[number],
    budgetMinor: bigint,
    trace: {
      modelCalls: number;
      productsObserved: number;
      durationMs: number;
      turn?: number;
    },
  ): BuyerAgentDecision {
    return {
      kind: "PRODUCT_SELECTED",
      correlationId: randomUUID(),
      selectedProductId: product.id,
      quantity: 1,
      reasonCodes: ["WITHIN_BUDGET", "MATCHES_REQUESTED_CATEGORY", "IN_STOCK"],
      summary: `${product.name} fits the request.`,
      constraints: {
        requestType: "PURCHASE",
        quantity: 1,
        maxBudget: { amountMinor: budgetMinor.toString(), currency: "INR" },
        budgetScope: "PER_UNIT",
        category: product.category,
        hardRequirements: [],
        softPreferences: [],
      },
      observedProduct: {
        productId: product.id,
        name: product.name,
        amount: { amountMinor: product.unitAmount.toString(), currency: "INR" },
        availableQuantity: product.inventory,
        version: product.version,
        updatedAt: product.updatedAt.toISOString(),
      },
      trace: {
        modelCalls: trace.modelCalls,
        toolCalls: trace.modelCalls > 2 ? 1 : 0,
        productsObserved: trace.productsObserved,
        prefetched: true,
        durationMs: trace.durationMs,
        turn: trace.turn ?? 1,
      },
    };
  }

  /** One shopper, from a decision to wherever `until` says to stop. */
  async function session(
    agentDecision: BuyerAgentDecision,
    until: "QUOTED" | "PAID" | "PAID_AFTER_FAILURE" | "REJECTED" | "REFUNDED",
  ): Promise<string | null> {
    const result = await decidePurchase(agentDecision);
    if (result.kind !== "QUOTE_CREATED") return null;
    const transactionId = result.transactionId;
    await recordAgentRequest({
      outcome: "PURCHASE_OPENED",
      decision: agentDecision,
      transactionId,
      durationMs: agentDecision.trace?.durationMs ?? 0,
    });
    const policy = await evaluateQuotePolicy(
      { quoteId: result.quote.id, operationId: randomUUID() },
      policyDeps,
    );
    if (until === "QUOTED" || policy.kind !== "EVALUATED") return transactionId;

    if (policy.decision.decision === "APPROVAL_REQUIRED") {
      const buyer = await prisma.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { buyerProfileId: true },
      });
      const requested = await requestApproval({
        transactionId,
        operationId: randomUUID(),
      });
      if (requested.kind !== "APPROVAL_REQUESTED") return transactionId;
      await decideApproval({
        token: requested.token,
        decision: until === "REJECTED" ? "REJECT" : "APPROVE",
        decidedByBuyerId: buyer.buyerProfileId,
        operationId: randomUUID(),
      });
      if (until === "REJECTED") return transactionId;
    }

    const held = await reserveInventory(
      { transactionId, operationId: randomUUID() },
      reservation,
    );
    if (held.kind !== "RESERVED") return transactionId;
    const order = await createPaymentOrder({ transactionId }, paymentDeps);
    if (order.kind !== "ORDER_CREATED") return transactionId;
    await startCheckout({ transactionId }, paymentDeps);

    if (until === "PAID_AFTER_FAILURE") {
      await webhook(
        "payment.failed",
        order.order.providerOrderId,
        BigInt(order.order.amount.amountMinor),
      );
      const retry = await requestPaymentRetry(
        { transactionId },
        { prisma, clock, provider, reservation, quote, policy: policyDeps },
      );
      if (retry.kind !== "RETRY_STARTED") return transactionId;
      await startCheckout({ transactionId }, paymentDeps);
      const retried = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: retry.paymentAttemptId },
        select: { providerOrderId: true, amount: true },
      });
      if (retried.providerOrderId === null) return transactionId;
      await webhook("payment.captured", retried.providerOrderId, retried.amount);
      return transactionId;
    }

    await webhook(
      "payment.captured",
      order.order.providerOrderId,
      BigInt(order.order.amount.amountMinor),
    );
    if (until === "REFUNDED") {
      await requestRefund({ transactionId }, { prisma, provider, clock, windowDays: 7 });
    }
    return transactionId;
  }

  const opened: string[] = [];
  const keep = (id: string | null) => {
    if (id !== null) opened.push(id);
  };

  // Purchases, across all three categories and every outcome that matters.
  keep(
    await session(
      decision(pick("mechanical-keyboard", 1), 300_000n, {
        modelCalls: 2,
        productsObserved: 7,
        durationMs: 3_900,
      }),
      "PAID",
    ),
  );
  keep(
    await session(
      decision(pick("mouse", 2), 300_000n, {
        modelCalls: 2,
        productsObserved: 5,
        durationMs: 3_100,
      }),
      "PAID",
    ),
  );
  keep(
    await session(
      decision(pick("mouse", 0), 150_000n, {
        modelCalls: 3,
        productsObserved: 4,
        durationMs: 5_600,
        turn: 2,
      }),
      "PAID",
    ),
  );
  keep(
    await session(
      decision(pick("headphones", 5), 600_000n, {
        modelCalls: 2,
        productsObserved: 6,
        durationMs: 4_200,
      }),
      "PAID",
    ),
  );
  keep(
    await session(
      decision(pick("headphones", 2), 300_000n, {
        modelCalls: 2,
        productsObserved: 6,
        durationMs: 3_500,
      }),
      "PAID_AFTER_FAILURE",
    ),
  );
  keep(
    await session(
      decision(pick("mechanical-keyboard", 0), 300_000n, {
        modelCalls: 2,
        productsObserved: 7,
        durationMs: 2_800,
      }),
      "REFUNDED",
    ),
  );
  keep(
    await session(
      decision(pick("headphones", 6), 700_000n, {
        modelCalls: 2,
        productsObserved: 6,
        durationMs: 4_700,
      }),
      "REJECTED",
    ),
  );
  keep(
    await session(
      decision(pick("mechanical-keyboard", 2), 300_000n, {
        modelCalls: 2,
        productsObserved: 7,
        durationMs: 3_300,
      }),
      "QUOTED",
    ),
  );

  // Requests that never became purchases - the demand the dashboard surfaces.
  const unmet: readonly [string, bigint | null][] = [
    ["webcam", 300_000n],
    ["webcam", 250_000n],
    ["webcam", null],
    ["earbuds", 200_000n],
    ["mouse", 50_000n],
    ["mouse", 60_000n],
    ["monitor", 1_500_000n],
  ];
  for (const [category, budget] of unmet) {
    await recordAgentRequest({
      outcome: "NO_MATCH",
      decision: {
        kind: "NO_MATCH",
        correlationId: randomUUID(),
        reasonCodes: ["NO_PRODUCT_IN_CATEGORY"],
        summary: "Nothing matched.",
        constraints: {
          requestType: "PURCHASE",
          quantity: 1,
          maxBudget:
            budget === null ? null : { amountMinor: budget.toString(), currency: "INR" },
          budgetScope: budget === null ? null : "PER_UNIT",
          category: canonicalCategory(category),
          hardRequirements: [],
          softPreferences: [],
        },
        trace: {
          modelCalls: 2,
          toolCalls: 0,
          productsObserved: 0,
          prefetched: true,
          durationMs: 2_400,
          turn: 1,
        },
      },
      durationMs: 2_400,
    });
  }
  for (const outcome of [
    "CLARIFICATION",
    "CLARIFICATION",
    "NOT_A_PURCHASE",
    "REFUSED",
  ] as const) {
    await recordAgentRequest({ outcome, durationMs: 1_900 });
  }

  console.log(`Demo activity written to the development database.`);
  console.log(`  purchases opened : ${String(opened.length)}`);
  console.log(`  unmet requests   : ${String(unmet.length)}`);
  console.log(`\nOpen http://localhost:3000/merchant, or a purchase:`);
  for (const id of opened.slice(0, 3)) console.log(`  http://localhost:3000/shop/${id}`);
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
