import { config as loadEnv } from "dotenv";
import { createRazorpayProvider } from "../src/integrations/payments/razorpay-provider";
import { deriveReceipt } from "../src/domain/payment/rules";

loadEnv({ path: ".env.local", quiet: true });

/**
 * The one live Razorpay call in this repository.
 *
 * Deliberately outside `npm test` and `npm run verify`. The automated suite
 * runs against a fake provider, because the properties worth proving there -
 * one order per purchase, a lost response leaving a recoverable row, a
 * rollback that does not lie - need a timeout and a duplicate on demand, which
 * a live API will not supply. Calling Razorpay from every test run would also
 * be slow, rate-limited, and rude.
 *
 * What one live call proves that a fake cannot: that the Test Mode credentials
 * work, that the Orders endpoint and Basic auth are as documented, that a real
 * `order_…` id comes back, and that the adapter's Zod parsing accepts the shape
 * Razorpay actually serves.
 *
 * Safety properties of this script:
 *
 *  - It refuses to run against a live key. A `rzp_live_` id exits non-zero
 *    before any request is made.
 *  - It creates an order for ₹1.00, the documented minimum, and captures
 *    nothing. An uncaptured Test Mode order costs nothing and moves no money.
 *  - It writes nothing to the database: no Transaction, no PaymentAttempt, no
 *    quote, no audit row. The receipt is synthetic, so no production-domain
 *    record is created or disturbed.
 *  - It prints no key, no key prefix, no fingerprint and no length.
 *
 * Run with: npm run razorpay:smoke
 */

/** ₹1.00 in paise. Razorpay documents this as the minimum order amount. */
const SMOKE_AMOUNT_MINOR = 100n;

/**
 * A synthetic attempt id, so the receipt is well-formed and obviously not a
 * real payment attempt. Never collides with a UUIDv7 the database would issue,
 * because no generator produces this constant.
 */
const SMOKE_ATTEMPT_ID = "00000000-0000-7000-8000-5a20705a5301";

function requireTestMode(): void {
  const keyId = process.env["RAZORPAY_KEY_ID"] ?? "";
  if (keyId.length === 0) {
    throw new Error(
      "RAZORPAY_KEY_ID is not set. Add Test Mode credentials to .env.local. See .env.example.",
    );
  }
  if (!keyId.startsWith("rzp_test_")) {
    // Names the mode, never the key.
    throw new Error(
      "Refusing to run: RAZORPAY_KEY_ID is not a Test Mode key. This script must never touch live credentials.",
    );
  }
}

async function main(): Promise<void> {
  requireTestMode();

  const provider = createRazorpayProvider();
  const receipt = deriveReceipt(SMOKE_ATTEMPT_ID);

  console.log("Razorpay Test Mode smoke test");
  console.log(`  amount   : ${SMOKE_AMOUNT_MINOR.toString()} paise (INR 1.00)`);
  console.log(`  receipt  : ${receipt}`);
  console.log("  capture  : none - this creates an order only\n");

  const outcome = await provider.createOrder({
    amountMinor: SMOKE_AMOUNT_MINOR,
    currency: "INR",
    receipt,
    notes: { purpose: "objective-10-smoke" },
  });

  switch (outcome.kind) {
    case "CREATED":
    case "ALREADY_EXISTS": {
      const order = outcome.order;
      // ALREADY_EXISTS on a rerun is itself a result worth seeing: it is the
      // receipt idempotency this objective's duplicate prevention rests on,
      // demonstrated against the live API.
      console.log(
        outcome.kind === "CREATED"
          ? "Order created."
          : "Order already existed for this receipt, and was recovered by lookup.",
      );
      console.log(`  provider order id : ${order.providerOrderId}`);
      console.log(`  amount            : ${order.amountMinor.toString()} minor units`);
      console.log(`  currency          : ${order.currency}`);
      console.log(`  status            : ${order.status}`);

      if (!order.providerOrderId.startsWith("order_")) {
        throw new Error(
          "The provider returned an identifier that is not a Razorpay order id.",
        );
      }
      if (order.amountMinor !== SMOKE_AMOUNT_MINOR) {
        throw new Error(
          "The provider echoed an amount different from the one requested.",
        );
      }

      console.log(
        "\nSMOKE TEST PASSED: Test Mode order creation and adapter parsing confirmed.",
      );
      console.log("No money moved, no payment was captured, and no row was written.");
      return;
    }
    case "FAILED":
      throw new Error(
        `The provider refused the request (${outcome.failure.category}/${outcome.failure.code}).`,
      );
    case "UNKNOWN":
      // Reported separately rather than treated as a failure, exactly as the
      // service does: an unresolved outcome is not evidence of broken code.
      console.error(
        `Razorpay's outcome could not be confirmed (${outcome.failure.category}). This is a connectivity result, not a test failure. Re-run when the API is reachable.`,
      );
      process.exitCode = 2;
      return;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
