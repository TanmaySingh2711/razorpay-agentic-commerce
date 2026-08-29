import { describe, expect, it } from "vitest";
import {
  DECISION_REASON_MAX_LENGTH,
  decisionRecordSchema,
  type DecisionRecord,
} from "@/domain/decision-record";
import { auditEventSchema } from "@/domain/audit-event";

const validDecision: DecisionRecord = {
  decisionId: "dec_1",
  transactionId: "txn_1",
  decisionType: "policy_evaluation",
  actor: "policy_engine",
  inputs: { verifiedAmountMinorUnits: 299900, budgetMinorUnits: 300000, currency: "INR" },
  ruleApplied: "BUDGET_CEILING",
  result: "allowed",
  reason: "Verified price ₹2999.00 is within the ₹3000.00 budget for this intent.",
  occurredAt: "2026-01-01T00:00:00.000Z",
};

describe("decision record contract", () => {
  it("accepts a complete deterministic policy decision", () => {
    expect(decisionRecordSchema.safeParse(validDecision).success).toBe(true);
  });

  it("bounds the reason field so model reasoning cannot be dumped into it", () => {
    const overlong = {
      ...validDecision,
      reason: "x".repeat(DECISION_REASON_MAX_LENGTH + 1),
    };
    expect(decisionRecordSchema.safeParse(overlong).success).toBe(false);
  });

  it("requires a rule identifier slot even when the decision is AI-owned", () => {
    const missingRule: Record<string, unknown> = { ...validDecision };
    delete missingRule["ruleApplied"];
    expect(decisionRecordSchema.safeParse(missingRule).success).toBe(false);

    const aiDecision = {
      ...validDecision,
      decisionType: "product_selection",
      actor: "buyer_agent",
      ruleApplied: null,
      result: "selected",
      reason: "Best rated mechanical keyboard in the catalog under the stated budget.",
    };
    expect(decisionRecordSchema.safeParse(aiDecision).success).toBe(true);
  });
});

describe("audit event contract", () => {
  it("requires everything needed to reconstruct a step of a transaction", () => {
    const event = {
      eventId: "evt_1",
      transactionId: "txn_1",
      eventType: "payment_captured",
      actor: "razorpay_webhook",
      occurredAt: "2026-01-01T00:00:05.000Z",
      result: "success",
      details: {
        amountMinorUnits: 299900,
        currency: "INR",
        razorpayOrderId: "order_test_1",
      },
      decisionId: null,
      correlationId: "corr_1",
    };
    expect(auditEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an event type outside the audited vocabulary", () => {
    const event = {
      eventId: "evt_2",
      transactionId: "txn_1",
      eventType: "something_undocumented",
      actor: "system",
      occurredAt: "2026-01-01T00:00:05.000Z",
      result: "success",
      details: {},
      decisionId: null,
      correlationId: null,
    };
    expect(auditEventSchema.safeParse(event).success).toBe(false);
  });
});
