import { config as loadEnv } from "dotenv";
import { getPrismaClient } from "../src/integrations/persistence/client";
import { getTransactionAuditHistory } from "../src/services/audit/audit-service";
import { TRANSACTION_STATES } from "../src/domain/transaction/states";
import { MAX_PAYMENT_ATTEMPTS } from "../src/domain/payment/retry";
import type { TransactionState } from "../src/domain/transaction/states";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Reports what actually happened to a smoke-test transaction, and checks it
 * against the outcome the operator expected.
 *
 * Read-only: it prints the lifecycle, every payment attempt, the stored
 * provider references and the audit trail, and changes nothing.
 *
 * **The expected state is an argument, and that is the point.** This was
 * written for Objective 11, where the only successful ending was
 * PAYMENT_VERIFIED, so it reported every other state - including the entirely
 * correct PAYMENT_CAPTURED and PAYMENT_FAILED that Objectives 13 and 14
 * produce - as a failure. Naming the expected outcome fixes that without
 * weakening anything: it is still an assertion with a non-zero exit, it simply
 * no longer assumes one right answer for every objective. Omitting the argument
 * keeps the original PAYMENT_VERIFIED expectation.
 *
 * It prints no secret. Provider order and payment ids are external references,
 * not credentials.
 *
 * Run with: npx tsx scripts/checkout-smoke-check.ts <transactionId> [expectedState]
 */
async function main(): Promise<void> {
  const transactionId = process.argv[2];
  if (transactionId === undefined) {
    throw new Error(
      "Usage: npx tsx scripts/checkout-smoke-check.ts <transactionId> [expectedState]",
    );
  }

  const requested = process.argv[3];
  if (
    requested !== undefined &&
    !(TRANSACTION_STATES as readonly string[]).includes(requested)
  ) {
    // A typo must fail loudly. Falling back to a default here would turn
    // "check for PAYMENT_CAPTURD" into a silent check for something else.
    throw new Error(
      `Unknown expected state: ${requested}. One of: ${TRANSACTION_STATES.join(", ")}`,
    );
  }
  const expected = (requested ?? "PAYMENT_VERIFIED") as TransactionState;

  const prisma = getPrismaClient();
  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        attempts: { orderBy: { attemptNumber: "asc" } },
        reservations: true,
        transitions: { orderBy: { sequence: "asc" } },
      },
    });
    if (transaction === null) throw new Error(`No such transaction: ${transactionId}`);

    console.log(`\nTransaction ${transactionId}`);
    console.log(`  status : ${transaction.status}\n`);

    console.log("Lifecycle:");
    for (const step of transaction.transitions) {
      console.log(
        `  ${String(step.sequence).padStart(2)}. ${step.fromStatus} -> ${step.toStatus}  (${step.actor}, ${step.reasonCode})`,
      );
    }

    console.log("\nPayment attempts:");
    for (const attempt of transaction.attempts) {
      console.log(`  #${String(attempt.attemptNumber)}  status=${attempt.status}`);
      console.log(`      order   : ${attempt.providerOrderId ?? "-"}`);
      console.log(`      payment : ${attempt.providerPaymentId ?? "-"}`);
      console.log(`      amount  : ${attempt.amount.toString()} ${attempt.currency}`);
    }

    console.log("\nInventory:");
    for (const reservation of transaction.reservations) {
      console.log(`  ${reservation.status}  quantity=${String(reservation.quantity)}`);
    }

    console.log("\nAudit trail:");
    const history = await getTransactionAuditHistory(transactionId, { prisma });
    for (const entry of history) {
      console.log(`  [${entry.result}] ${entry.action}`);
      console.log(`      ${entry.conciseExplanation}`);
    }

    console.log("\nRetry budget:");
    console.log(
      `  ${String(transaction.attempts.length)} of ${String(MAX_PAYMENT_ATTEMPTS)} payment attempts used`,
    );

    const met = transaction.status === expected;
    console.log(
      met
        ? `\nExpected state reached: ${expected}.`
        : `\nExpected ${expected}, but this transaction is ${transaction.status}.`,
    );
    console.log(MEANINGS[transaction.status]);
    if (!met) {
      // A non-zero exit, so this stays usable as a check rather than a report.
      process.exitCode = 1;
    }
    console.log();
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * What each ending actually means, in the terms this system defines.
 *
 * Written out because the distinctions are the substance of the objectives and
 * are the easiest thing to misread: a verified signature is not captured money,
 * and captured money is not a completed transaction.
 */
const MEANINGS: Record<TransactionState, string> = {
  INTENT_RECEIVED: "  Nothing has been quoted yet.",
  PRODUCT_SELECTED: "  An agent proposed a product; nothing is verified.",
  PRODUCT_VERIFIED: "  The catalog facts were re-read; no price is frozen yet.",
  QUOTE_CREATED: "  A price is frozen; no policy decision has been made.",
  POLICY_EVALUATED: "  Policy has run; the purchase is not yet authorized.",
  APPROVAL_REQUIRED: "  A person must approve before money can move.",
  AUTHORIZED: "  Authorized, but no stock is held yet.",
  INVENTORY_RESERVED: "  Stock is held; no provider order exists yet.",
  PAYMENT_ORDER_CREATED: "  A provider order exists; nobody has pressed Pay.",
  PAYMENT_PENDING: "  Checkout was handed to a person; no outcome yet.",
  PAYMENT_VERIFIED:
    "  The confirmation was proved genuine server-side. This is NOT proof that funds were captured.",
  PAYMENT_CAPTURED:
    "  The provider confirmed capture. This is NOT completion: inventory is not committed and nothing is fulfilled.",
  COMPLETED: "  Settled and fulfilled.",
  PAYMENT_FAILED:
    "  A payment attempt failed. Recoverable: a bounded, human-triggered retry may still be available.",
  BLOCKED: "  A deterministic control refused this purchase. Terminal.",
  CANCELLED: "  Abandoned before completion. Terminal.",
  EXPIRED: "  A quote, hold or payment window elapsed. Terminal.",
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
