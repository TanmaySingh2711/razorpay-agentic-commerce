import { config as loadEnv } from "dotenv";
import { getPrismaClient } from "../src/integrations/persistence/client";
import { getTransactionAuditHistory } from "../src/services/audit/audit-service";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Reports what actually happened to a smoke-test transaction after a human
 * completed Test Mode checkout.
 *
 * Read-only. It asserts nothing and changes nothing; it prints the lifecycle,
 * the stored provider references and the audit trail so the outcome can be
 * judged rather than asserted by the same code that produced it.
 *
 * It prints no secret. Provider order and payment ids are external references,
 * not credentials.
 *
 * Run with: npx tsx scripts/checkout-smoke-check.ts <transactionId>
 */
async function main(): Promise<void> {
  const transactionId = process.argv[2];
  if (transactionId === undefined) {
    throw new Error("Usage: npx tsx scripts/checkout-smoke-check.ts <transactionId>");
  }

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

    const verified = transaction.status === "PAYMENT_VERIFIED";
    console.log(
      verified
        ? "\nPAYMENT_VERIFIED reached. The confirmation was proved genuine server-side."
        : `\nNot verified. Current state: ${transaction.status}.`,
    );
    if (verified) {
      console.log(
        "This is NOT proof of capture or completion - by design, those belong to a later objective.",
      );
    }
    console.log();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
