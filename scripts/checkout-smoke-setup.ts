import { config as loadEnv } from "dotenv";
import { getPrismaClient } from "../src/integrations/persistence/client";
import { createTransaction } from "../src/services/transaction/creation-service";
import { applyTransactionEvent } from "../src/services/transaction/transition-service";
import { createTrustedQuote } from "../src/services/quote/quote-service";
import { evaluateQuotePolicy } from "../src/services/policy/policy-service";
import { reserveInventory } from "../src/services/inventory/reservation-service";
import { createPaymentOrder } from "../src/services/payment/payment-order-service";
import { createRazorpayProvider } from "../src/integrations/payments/razorpay-provider";
import { getRazorpayCredentials } from "../src/config/env";
import { systemClock } from "../src/lib/clock";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Prepares one real Test Mode purchase for the manual checkout smoke test.
 *
 * Checkout requires an explicit human action, and this objective's whole point
 * is that nothing may bypass that. So this script does everything *up to* the
 * Pay button and then stops: it creates a real Razorpay Test Mode order and
 * prints the URL a person must open. It does not open checkout, does not
 * simulate a payment, and does not touch the callback endpoint.
 *
 * Everything it creates is marked `smoke-` so demo data is obvious and can be
 * told apart from a real run at a glance. The amount is ₹1.00 - the documented
 * provider minimum - and Test Mode moves no money.
 *
 * Run with: npm run checkout:smoke
 */

/** ₹1.00 in paise. The provider's documented minimum order amount. */
const SMOKE_AMOUNT_MINOR = 100n;

/** One hour - the maximum `RESERVATION_TTL_SECONDS` the config boundary allows. */
const MANUAL_TEST_HOLD_SECONDS = 3600;

function requireTestMode(): void {
  const keyId = process.env["RAZORPAY_KEY_ID"] ?? "";
  if (!keyId.startsWith("rzp_test_")) {
    // Names the mode, never the key.
    throw new Error(
      "Refusing to run: RAZORPAY_KEY_ID is not a Test Mode key. This script must never touch live credentials.",
    );
  }
}

async function main(): Promise<void> {
  requireTestMode();
  const prisma = getPrismaClient();
  const stamp = Date.now().toString(36);

  try {
    const buyer = await prisma.buyerProfile.create({
      data: { displayName: "Checkout Smoke Buyer" },
    });
    const merchant = await prisma.merchant.create({
      data: { name: "Keebworks India", slug: `smoke-${stamp}`, status: "ACTIVE" },
    });
    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        sku: `SMOKE-${stamp}`,
        name: "Checkout smoke test item",
        description: "A one-rupee item that exists only to exercise Test Mode checkout.",
        category: "mechanical-keyboard",
        unitAmount: SMOKE_AMOUNT_MINOR,
        currency: "INR",
        inventory: 1,
        status: "AVAILABLE",
        attributes: {},
      },
    });
    await prisma.authorizationPolicy.create({
      data: {
        buyerProfileId: buyer.id,
        // Comfortably above ₹1.00, so policy authorizes without a human. The
        // approval gate has its own tests; this smoke test is about checkout.
        maxAutoApproveAmount: 100_000n,
        currency: "INR",
        autoPurchaseAllowed: true,
        status: "ACTIVE",
        version: 1,
      },
    });

    const transaction = await createTransaction(
      {
        buyerProfileId: buyer.id,
        merchantId: merchant.id,
        correlationId: `smoke-${stamp}`,
      },
      { prisma },
    );

    for (const [event, actor] of [
      ["PRODUCT_SELECTION_CONFIRMED", "buyer_agent"],
      ["PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service"],
    ] as const) {
      await applyTransactionEvent(
        { transactionId: transaction.id, event, actor },
        { prisma },
      );
    }

    const quote = await createTrustedQuote(
      {
        transactionId: transaction.id,
        productId: product.id,
        quantity: 1,
        authority: {
          quantity: 1,
          maxAmountMinor: null,
          currency: null,
          budgetScope: null,
          hardRequirements: [],
          category: null,
        },
        idempotencyKey: `smoke-quote-${stamp}`,
      },
      { prisma, clock: systemClock, ttlSeconds: 900 },
    );

    const evaluated = await evaluateQuotePolicy(
      { quoteId: quote.snapshot.quoteId, operationId: `smoke-policy-${stamp}` },
      {
        prisma,
        clock: systemClock,
        quote: { prisma, clock: systemClock, ttlSeconds: 900 },
      },
    );
    if (evaluated.kind !== "EVALUATED") {
      throw new Error(`Policy did not evaluate: ${evaluated.kind}`);
    }

    // The longest hold the configuration boundary permits. A manual test has a
    // human in the middle of it, and a person reading instructions, switching
    // windows and picking a test card needs more time than a script does - a
    // hold expiring mid-test looks like a bug and is only impatience.
    const reserved = await reserveInventory(
      { transactionId: transaction.id, operationId: `smoke-reserve-${stamp}` },
      { prisma, clock: systemClock, ttlSeconds: MANUAL_TEST_HOLD_SECONDS },
    );
    if (reserved.kind !== "RESERVED") {
      throw new Error(`Inventory was not reserved: ${reserved.refusal}`);
    }

    // The one real Test Mode order this script creates.
    const order = await createPaymentOrder(
      { transactionId: transaction.id },
      {
        prisma,
        clock: systemClock,
        provider: createRazorpayProvider(),
        // This script's whole purpose is one real Test Mode order, so unlike
        // the automated suite it is meant to read real configuration here.
        providerKeyId: getRazorpayCredentials().RAZORPAY_KEY_ID,
      },
    );
    if (order.kind !== "ORDER_CREATED") {
      throw new Error(`No payment order was created: ${order.kind}`);
    }

    const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";

    console.log("\nTest Mode checkout is ready.\n");
    console.log(`  transaction      : ${transaction.id}`);
    console.log(`  payment attempt  : ${order.order.paymentAttemptId}`);
    console.log(`  provider order   : ${order.order.providerOrderId}`);
    console.log(
      `  amount           : ${order.order.amount.amountMinor} paise (INR 1.00)`,
    );
    console.log(`  state            : ${order.transactionState}\n`);
    console.log(
      `  hold expires     : ${new Date(Date.now() + MANUAL_TEST_HOLD_SECONDS * 1000).toLocaleTimeString()}  (re-run this script after that)`,
    );
    console.log("Now do this by hand - checkout requires a real human action:\n");
    console.log("  1. npm run dev");
    console.log(`  2. open  ${appUrl}/checkout/${transaction.id}`);
    console.log('  3. press "Pay"');
    console.log("  4. in Razorpay Test Checkout choose any test method and complete it");
    console.log("     (Test Mode - no real money moves)\n");
    console.log("Expected result: the page reports the confirmation was verified, and");
    console.log("the transaction reaches PAYMENT_VERIFIED - not PAYMENT_CAPTURED.\n");
    console.log("Check it with:");
    console.log(`  npx tsx scripts/checkout-smoke-check.ts ${transaction.id}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
