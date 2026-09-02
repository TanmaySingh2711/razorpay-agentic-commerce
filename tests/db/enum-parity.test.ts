import { describe, expect, it } from "vitest";
import { PAYMENT_FAILURE_CATEGORIES } from "@/domain/payment/failure";
import { TRANSACTION_ACTORS, TRANSACTION_STATES } from "@/domain/transaction/states";
import {
  PaymentFailureCategory,
  TransactionActor,
  TransactionStatus,
} from "@/generated/prisma/enums";

/**
 * The binding between the domain and the database.
 *
 * `src/domain/transaction/states.ts` is the authoritative list of transaction
 * states; the Prisma schema must declare the same values because PostgreSQL
 * needs them as DDL. Prisma schema cannot import TypeScript, so the two lists
 * are physically separate - and this test is what stops them drifting.
 *
 * Adding a state to the domain without migrating the database (or the reverse)
 * fails here rather than at 2am against real money.
 *
 * Needs no database connection: it compares generated types, not rows.
 */
describe("domain / database enum parity", () => {
  it("declares exactly the same transaction states in both places", () => {
    expect(Object.keys(TransactionStatus).sort()).toEqual([...TRANSACTION_STATES].sort());
  });

  it("declares exactly the same transaction actors in both places", () => {
    expect(Object.keys(TransactionActor).sort()).toEqual([...TRANSACTION_ACTORS].sort());
  });

  it("keeps the AI actors representable in the database", () => {
    expect(TransactionActor.buyer_agent).toBe("buyer_agent");
    expect(TransactionActor.product_decision_engine).toBe("product_decision_engine");
  });

  it("declares exactly the same payment failure categories in both places", () => {
    expect(Object.keys(PaymentFailureCategory).sort()).toEqual(
      [...PAYMENT_FAILURE_CATEGORIES].sort(),
    );
  });

  it("keeps the failure vocabulary free of provider words and instrument detail", () => {
    // These values reach a buyer's screen through `describePaymentFailure`, and
    // they are written to an audit record. Neither is a place for a vendor's
    // name or anything about how somebody paid.
    for (const category of Object.keys(PaymentFailureCategory)) {
      expect(category).not.toMatch(/razorpay|stripe|paypal|card|cvv|otp|upi|pin/i);
    }
  });

  it("names no payment vendor in the shared actor vocabulary", () => {
    for (const actor of Object.keys(TransactionActor)) {
      expect(actor).not.toMatch(/razorpay|stripe|paypal/i);
    }
  });
});
