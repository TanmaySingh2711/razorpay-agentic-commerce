import { describe, expect, it } from "vitest";
import {
  AUDIT_RESULTS,
  auditPayloadSchema,
  isAiActor,
  sanitizeAuditPayload,
} from "@/domain/audit/record";
import { explainAuditEvent } from "@/domain/audit/explanations";
import { AUDIT_EVENT_TYPES } from "@/domain/audit-event";

/**
 * The two pure halves of the audit boundary: what may become an audited fact,
 * and how an audited fact reads back to a person.
 *
 * These need no database, and they are where the guarantees live. An allow-list
 * with a hole in it cannot be rescued by anything downstream, and an
 * explanation assembled from untrusted text is exactly what this system is
 * built not to produce.
 */

describe("the trusted-input allow-list", () => {
  it("accepts the facts an action is supposed to carry", () => {
    const payload = sanitizeAuditPayload("policy_evaluated", {
      quoteId: "quote-1",
      policyId: "policy-1",
      policyVersion: 3,
      decision: "ALLOWED",
      amountMinor: "279900",
      currency: "INR",
      autoApproveLimitMinor: "300000",
    });
    expect(payload["amountMinor"]).toBe("279900");
    expect(payload["policyVersion"]).toBe(3);
  });

  it("refuses a field the action never declared", () => {
    // Not stripped - refused. An audit record is evidence, and a trail that
    // silently absorbs whatever arrives becomes a dumping ground.
    expect(() =>
      sanitizeAuditPayload("policy_evaluated", {
        quoteId: "quote-1",
        policyId: null,
        policyVersion: 1,
        decision: "ALLOWED",
        amountMinor: "1",
        currency: "INR",
        somethingNobodyDeclared: "value",
      }),
    ).toThrow(/trusted-input contract/);
  });

  it("refuses anything that looks like a secret", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "GEMINI_API_KEY",
      "authorization",
      "sessionToken",
      "approvalToken",
      "password",
      "databaseCredential",
      "privateKey",
      "cardNumber",
      "cvv",
    ]) {
      expect(() =>
        sanitizeAuditPayload("policy_evaluated", {
          quoteId: "quote-1",
          [key]: "whatever-this-is",
        }),
      ).toThrow(/secret or model reasoning/);
    }
  });

  it("refuses model reasoning by any of its usual names", () => {
    for (const key of [
      "reasoning",
      "chainOfThought",
      "chain_of_thought",
      "thinking",
      "prompt",
    ]) {
      expect(() =>
        sanitizeAuditPayload("product_selected", {
          productId: "p1",
          quantity: 1,
          [key]: "First I considered the budget, then I...",
        }),
      ).toThrow(/secret or model reasoning/);
    }
  });

  it("finds a secret nested inside the payload, not just at the top", () => {
    expect(() =>
      sanitizeAuditPayload("product_selected", {
        productId: "p1",
        quantity: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately hostile shape
        nested: { deeper: { apiKey: "sk-live-nope" } } as any,
      }),
    ).toThrow(/secret or model reasoning/);
  });

  it("refuses an amount that is not integer minor units", () => {
    // "2799.00" is the shape of a bug that quietly becomes a hundredth of the
    // real number somewhere downstream.
    expect(() =>
      sanitizeAuditPayload("policy_evaluated", {
        quoteId: "q1",
        policyId: null,
        policyVersion: 1,
        decision: "ALLOWED",
        amountMinor: "2799.00",
        currency: "INR",
      }),
    ).toThrow(/trusted-input contract/);
  });

  it("declares an allow-list for every action in the vocabulary", () => {
    // Exhaustive by construction, asserted anyway: an event type with no
    // declared payload would be one that accepts anything.
    for (const action of AUDIT_EVENT_TYPES) {
      expect(auditPayloadSchema(action)).toBeDefined();
    }
  });
});

describe("actor is not authority", () => {
  it("marks the agent as an AI actor and the deterministic services as not", () => {
    expect(isAiActor("buyer_agent")).toBe(true);
    for (const actor of [
      "policy_engine",
      "quote_service",
      "approval_gate",
      "inventory_service",
      "merchant_service",
    ] as const) {
      expect(isAiActor(actor)).toBe(false);
    }
  });
});

describe("derived explanations", () => {
  it("cites both numbers and the rule that compared them", () => {
    const sentence = explainAuditEvent({
      action: "policy_evaluated",
      result: "SUCCESS",
      reasonCode: "WITHIN_AUTO_APPROVE_LIMIT",
      trustedInputs: {
        amountMinor: "279900",
        currency: "INR",
        autoApproveLimitMinor: "300000",
        policyVersion: 4,
      },
    });
    expect(sentence).toContain("₹2799.00");
    expect(sentence).toContain("₹3000.00");
    expect(sentence).toContain("policy version 4");
  });

  it("explains an escalation in terms a person can check", () => {
    const sentence = explainAuditEvent({
      action: "policy_evaluated",
      result: "PENDING",
      reasonCode: "EXCEEDS_AUTO_APPROVE_LIMIT",
      trustedInputs: {
        amountMinor: "400000",
        currency: "INR",
        autoApproveLimitMinor: "300000",
      },
    });
    expect(sentence).toContain("₹4000.00");
    expect(sentence).toContain("above");
    expect(sentence).toContain("person must approve");
  });

  it("produces a sentence for every action, with no model narration in it", () => {
    for (const action of AUDIT_EVENT_TYPES) {
      for (const result of AUDIT_RESULTS) {
        const sentence = explainAuditEvent({
          action,
          result,
          reasonCode: null,
          trustedInputs: {},
        });
        expect(sentence.length).toBeGreaterThan(0);
        // No hedging, no narration, no first person.
        expect(sentence).not.toMatch(
          /\b(I |the AI|model|thought|seemed|probably|believe)\b/i,
        );
      }
    }
  });

  it("never returns undefined for an event type it does not know", () => {
    // `AuditEvent.eventType` is a VARCHAR, not a database enum, so the type
    // assertion that reaches the explanation rules is a claim rather than a
    // guarantee. An exhaustive switch matches nothing here and would otherwise
    // return undefined from a function declared to return string.
    const sentence = explainAuditEvent({
      action: "an_event_type_from_the_future" as never,
      result: "SUCCESS",
      reasonCode: null,
      trustedInputs: {},
    });
    expect(typeof sentence).toBe("string");
    expect(sentence).toContain("no explanation rule");
    // The unvalidated column text is never interpolated into the prose.
    expect(sentence).not.toContain("an_event_type_from_the_future");
  });

  it("degrades to a factual sentence when the numbers are missing", () => {
    // Never invents a figure it was not given.
    const sentence = explainAuditEvent({
      action: "policy_evaluated",
      result: "SUCCESS",
      reasonCode: "WITHIN_AUTO_APPROVE_LIMIT",
      trustedInputs: {},
    });
    expect(sentence).toContain("within the automatic purchase limit");
    expect(sentence).not.toContain("₹");
  });
});
