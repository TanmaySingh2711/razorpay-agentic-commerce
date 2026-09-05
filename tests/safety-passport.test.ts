import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildSafetyPassport,
  countPassportEvidence,
  PASSPORT_CHECK_IDS,
  SAFETY_PASSPORT_TITLE,
  type PassportCheck,
  type PassportCheckId,
  type PassportEvidence,
  type SafetyPassportFacts,
  type SafetyPassportViewModel,
} from "@/domain/safety/passport";
import type { MoneyDto } from "@/domain/money";

/**
 * The Safety Passport, tested as the pure function it is.
 *
 * The passport's only claim to being useful is that it never says something
 * flattering that the records do not support, so most of what follows is
 * negative: no "captured" from a verified callback, no "committed" from a
 * capture, no "exactly once" from a single present-tense row, no "approval
 * required" for a purchase that never needed one. A summary panel that fails
 * any of those is worse than no panel, because a reviewer would believe it.
 *
 * Everything here runs without a database on purpose. The mapping from records
 * to claims is where the mistakes live, and it is decidable from values alone -
 * `tests/db/safety-passport.test.ts` proves the *records* are what this file
 * assumes, against real PostgreSQL and the real service boundaries.
 */

const NO_EVIDENCE: PassportEvidence = countPassportEvidence([]);

function inr(minor: string): MoneyDto {
  return { amountMinor: minor, currency: "INR" };
}

function evidence(overrides: Partial<PassportEvidence>): PassportEvidence {
  return { ...NO_EVIDENCE, ...overrides };
}

/** A quoted, not-yet-decided purchase. Every scenario starts from here. */
function facts(overrides: Partial<SafetyPassportFacts> = {}): SafetyPassportFacts {
  return {
    transactionId: "01a068ee-b304-7756-83d6-3e709f3c1c37",
    state: "QUOTE_CREATED",
    trustedAmount: inr("289900"),
    trustedQuoteStatus: "ACTIVE",
    quoteUsable: true,
    quotes: [{ status: "ACTIVE", totalAmount: inr("289900") }],
    policyDecision: null,
    policyReasonCode: null,
    approvalStatuses: [],
    reservationStatuses: [],
    attempts: [],
    maxAttempts: 3,
    retryAvailable: null,
    retryDenial: null,
    evidence: NO_EVIDENCE,
    ...overrides,
  };
}

function checkOf(passport: SafetyPassportViewModel, id: PassportCheckId): PassportCheck {
  const found = passport.checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no passport check with id ${id}`);
  return found;
}

/** A completed purchase, driven only by evidence a real run would leave. */
function completedFacts(): SafetyPassportFacts {
  return facts({
    state: "COMPLETED",
    quoteUsable: false,
    policyDecision: "ALLOWED",
    policyReasonCode: "WITHIN_AUTO_APPROVE_LIMIT",
    reservationStatuses: ["COMMITTED"],
    attempts: [
      {
        attemptNumber: 1,
        status: "CAPTURED",
        amount: inr("289900"),
        failureCategory: null,
      },
    ],
    retryAvailable: false,
    retryDenial: "TRANSACTION_STATE_INVALID",
    evidence: evidence({
      productVerified: 1,
      quoteCreated: 1,
      policyEvaluated: 1,
      inventoryReserved: 1,
      inventoryCommitted: 1,
      paymentVerified: 1,
      paymentCaptured: 1,
      stateTransitions: 11,
      auditedFacts: 8,
    }),
  });
}

describe("counting the evidence a transaction actually left", () => {
  it("separates lifecycle transitions from audited decisions", () => {
    const counts = countPassportEvidence([
      { action: "state_transitioned" },
      { action: "state_transitioned" },
      { action: "policy_evaluated" },
      { action: "inventory_committed" },
    ]);
    expect(counts.stateTransitions).toBe(2);
    expect(counts.auditedFacts).toBe(2);
    expect(counts.policyEvaluated).toBe(1);
    expect(counts.inventoryCommitted).toBe(1);
  });

  it("ignores an audit action it has not been taught, rather than failing", () => {
    // The audited vocabulary grows with every objective. A passport that threw
    // on an unknown event type would turn a new audit record into a dead page.
    const counts = countPassportEvidence([
      { action: "some_event_a_later_objective_adds" },
      { action: "payment_captured" },
    ]);
    expect(counts.auditedFacts).toBe(2);
    expect(counts.paymentCaptured).toBe(1);
  });
});

describe("the passport reports what happened, for every kind of transaction", () => {
  it("shows an ALLOWED purchase as allowed and needing nobody", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "AUTHORIZED",
        policyDecision: "ALLOWED",
        policyReasonCode: "WITHIN_AUTO_APPROVE_LIMIT",
        evidence: evidence({
          productVerified: 1,
          policyEvaluated: 1,
          stateTransitions: 6,
        }),
      }),
    );

    expect(checkOf(passport, "POLICY").status).toBe("ALLOWED");
    expect(checkOf(passport, "POLICY").value).toBe("ALLOWED");
    expect(checkOf(passport, "HUMAN_APPROVAL").status).toBe("NOT_REQUIRED");
    expect(checkOf(passport, "AI_BOUNDED").status).toBe("VERIFIED");
    expect(passport.subtitle).toMatch(/move forward/);
  });

  it("shows an approval that was demanded and then granted, once", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "AUTHORIZED",
        policyDecision: "APPROVAL_REQUIRED",
        policyReasonCode: "EXCEEDS_AUTO_APPROVE_LIMIT",
        approvalStatuses: ["CONSUMED"],
        evidence: evidence({
          productVerified: 1,
          policyEvaluated: 1,
          approvalGranted: 1,
        }),
      }),
    );

    const approval = checkOf(passport, "HUMAN_APPROVAL");
    expect(checkOf(passport, "POLICY").status).toBe("REQUIRED");
    expect(approval.status).toBe("APPROVED");
    expect(approval.value).toBe("Approved once");
    expect(approval.tone).toBe("POSITIVE");
  });

  it("shows a purchase waiting on a person as required, not approved", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "APPROVAL_REQUIRED",
        policyDecision: "APPROVAL_REQUIRED",
        approvalStatuses: ["PENDING"],
        evidence: evidence({ policyEvaluated: 1 }),
      }),
    );

    const approval = checkOf(passport, "HUMAN_APPROVAL");
    expect(approval.status).toBe("REQUIRED");
    expect(approval.tone).toBe("WARNING");
    expect(checkOf(passport, "TRANSACTION").status).toBe("REQUIRED");
  });

  it("shows a BLOCKED purchase without inventing a success story", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "BLOCKED",
        policyDecision: "BLOCKED",
        policyReasonCode: "AUTO_PURCHASE_DISABLED",
        evidence: evidence({ productVerified: 1, policyEvaluated: 1 }),
      }),
    );

    expect(checkOf(passport, "POLICY").status).toBe("BLOCKED");
    expect(checkOf(passport, "TRANSACTION").status).toBe("BLOCKED");
    expect(passport.subtitle).toMatch(/where it stopped/);
    // Nothing downstream of policy may read as done.
    for (const id of [
      "INVENTORY",
      "PAYMENT_AMOUNT",
      "CALLBACK_VERIFIED",
      "PROVIDER_CAPTURE",
      "INVENTORY_COMMITTED",
    ] as const) {
      expect(checkOf(passport, id).status).toBe("NOT_REACHED");
      expect(checkOf(passport, id).tone).not.toBe("POSITIVE");
    }
  });

  it("shows a failed payment as failed, naming the safe failure category", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_FAILED",
        quoteUsable: false,
        policyDecision: "ALLOWED",
        reservationStatuses: ["ACTIVE"],
        attempts: [
          {
            attemptNumber: 1,
            status: "FAILED",
            amount: inr("289900"),
            failureCategory: "DECLINED_BY_BANK",
          },
        ],
        retryAvailable: true,
        evidence: evidence({
          productVerified: 1,
          policyEvaluated: 1,
          inventoryReserved: 1,
          paymentFailed: 1,
        }),
      }),
    );

    const capture = checkOf(passport, "PROVIDER_CAPTURE");
    expect(capture.status).toBe("FAILED");
    expect(capture.tone).toBe("NEGATIVE");
    expect(capture.value).toMatch(/declined by bank/);
    expect(checkOf(passport, "INVENTORY").status).toBe("RESERVED");
    expect(checkOf(passport, "INVENTORY_COMMITTED").status).toBe("NOT_REACHED");
    expect(passport.subtitle).toMatch(/where it stopped/);
  });

  it("shows a completed purchase as completed, committed exactly once", () => {
    const passport = buildSafetyPassport(completedFacts());

    expect(checkOf(passport, "TRANSACTION").status).toBe("COMPLETED");
    expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("CAPTURED");
    const committed = checkOf(passport, "INVENTORY_COMMITTED");
    expect(committed.status).toBe("COMMITTED");
    expect(committed.value).toBe("Committed exactly once");
    expect(committed.tone).toBe("POSITIVE");
  });

  it("shows a captured-but-not-yet-completed purchase as captured", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_CAPTURED",
        policyDecision: "ALLOWED",
        reservationStatuses: ["COMMITTED"],
        attempts: [
          {
            attemptNumber: 1,
            status: "CAPTURED",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        evidence: evidence({ paymentCaptured: 1, inventoryCommitted: 1 }),
      }),
    );

    expect(checkOf(passport, "TRANSACTION").status).toBe("CAPTURED");
    expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("CAPTURED");
  });
});

describe("the two payment facts are never collapsed into one", () => {
  it("does not claim capture when only the callback was verified", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_VERIFIED",
        policyDecision: "ALLOWED",
        reservationStatuses: ["ACTIVE"],
        attempts: [
          {
            attemptNumber: 1,
            status: "VERIFIED",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        evidence: evidence({ paymentVerified: 1 }),
      }),
    );

    expect(checkOf(passport, "CALLBACK_VERIFIED").status).toBe("VERIFIED");

    const capture = checkOf(passport, "PROVIDER_CAPTURE");
    expect(capture.status).toBe("PENDING");
    expect(capture.status).not.toBe("CAPTURED");
    expect(capture.tone).not.toBe("POSITIVE");
  });

  it("does not commit inventory on a verified callback alone", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_VERIFIED",
        policyDecision: "ALLOWED",
        reservationStatuses: ["ACTIVE"],
        attempts: [
          {
            attemptNumber: 1,
            status: "VERIFIED",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        evidence: evidence({ paymentVerified: 1 }),
      }),
    );

    const committed = checkOf(passport, "INVENTORY_COMMITTED");
    expect(committed.status).toBe("NOT_REACHED");
    expect(committed.tone).not.toBe("POSITIVE");
    expect(checkOf(passport, "INVENTORY").status).toBe("RESERVED");
  });

  it("reports a capture with no commit yet as pending rather than committed", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_CAPTURED",
        policyDecision: "ALLOWED",
        reservationStatuses: ["ACTIVE"],
        attempts: [
          {
            attemptNumber: 1,
            status: "CAPTURED",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        evidence: evidence({ paymentCaptured: 1 }),
      }),
    );

    expect(checkOf(passport, "INVENTORY_COMMITTED").status).toBe("PENDING");
  });

  /**
   * The browser callback and the provider's webhook race, and the webhook can
   * win - or the browser can never report at all, because the tab was closed on
   * the provider's own page. The purchase still completes, because settlement
   * was never the browser's to prove.
   *
   * This used to render as "Razorpay callback verification - PENDING, no
   * confirmation yet" beside a captured, committed, completed transaction: a
   * permanent warning about a step that was not outstanding and never would be.
   */
  it("stops calling the browser callback pending once the provider has confirmed capture", () => {
    const passport = buildSafetyPassport(
      facts({
        ...completedFacts(),
        // The whole point: no browser callback ever arrived.
        evidence: evidence({ ...completedFacts().evidence, paymentVerified: 0 }),
      }),
    );

    const callback = checkOf(passport, "CALLBACK_VERIFIED");
    expect(callback.status).toBe("NOT_REQUIRED");
    expect(callback.status).not.toBe("PENDING");
    // Neutral, not a warning: nothing here needs anybody to do anything.
    expect(callback.tone).toBe("NEUTRAL");
    expect(callback.tone).not.toBe("WARNING");

    // And the distinction it exists to keep is intact - a missing callback is
    // reported as not needed, never as verified.
    expect(callback.status).not.toBe("VERIFIED");
    expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("CAPTURED");
  });

  it("still reports a genuinely outstanding callback as pending", () => {
    // No capture anywhere: the confirmation really has not arrived yet, and
    // saying so is correct. The fix above must not silence this case.
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_PENDING",
        policyDecision: "ALLOWED",
        reservationStatuses: ["ACTIVE"],
        attempts: [
          {
            attemptNumber: 1,
            status: "PENDING",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        evidence: evidence({}),
      }),
    );

    expect(checkOf(passport, "CALLBACK_VERIFIED").status).toBe("PENDING");
  });

  it("keeps reporting a verified callback as verified when capture follows it", () => {
    // Both facts present: the callback was genuinely checked, so it is not
    // downgraded to "not needed" just because settlement later confirmed.
    const passport = buildSafetyPassport(facts(completedFacts()));

    expect(checkOf(passport, "CALLBACK_VERIFIED").status).toBe("VERIFIED");
    expect(checkOf(passport, "PROVIDER_CAPTURE").status).toBe("CAPTURED");
  });
});

describe("no positive claim outruns its evidence", () => {
  it("refuses 'exactly once' when the audit trail records two commits", () => {
    const passport = buildSafetyPassport(
      facts({
        ...completedFacts(),
        evidence: evidence({ ...completedFacts().evidence, inventoryCommitted: 2 }),
      }),
    );

    const committed = checkOf(passport, "INVENTORY_COMMITTED");
    expect(committed.value).toBe("Committed");
    expect(committed.value).not.toMatch(/exactly once/);
    expect(committed.tone).toBe("WARNING");
  });

  it("refuses 'exactly once' when two reservations carry a commit", () => {
    const passport = buildSafetyPassport(
      facts({
        ...completedFacts(),
        reservationStatuses: ["COMMITTED", "COMMITTED"],
      }),
    );

    expect(checkOf(passport, "INVENTORY_COMMITTED").value).not.toMatch(/exactly once/);
  });

  it("refuses 'approved once' when more than one approval is recorded", () => {
    const passport = buildSafetyPassport(
      facts({
        policyDecision: "APPROVAL_REQUIRED",
        approvalStatuses: ["CONSUMED", "CONSUMED"],
        evidence: evidence({ approvalGranted: 2 }),
      }),
    );

    const approval = checkOf(passport, "HUMAN_APPROVAL");
    expect(approval.value).toBe("Approved");
    expect(approval.tone).toBe("WARNING");
  });

  it("does not claim an approval was required when policy allowed the spend", () => {
    const passport = buildSafetyPassport(
      facts({ policyDecision: "ALLOWED", evidence: evidence({ policyEvaluated: 1 }) }),
    );

    const approval = checkOf(passport, "HUMAN_APPROVAL");
    expect(approval.status).toBe("NOT_REQUIRED");
    expect(approval.status).not.toBe("REQUIRED");
    // "Not required" is a fact, not an achievement, so it is not painted green.
    expect(approval.tone).toBe("NEUTRAL");
  });

  it("does not claim the catalog bound the AI when no verification is recorded", () => {
    const passport = buildSafetyPassport(facts());
    expect(checkOf(passport, "AI_BOUNDED").status).toBe("NOT_REACHED");
    expect(passport.properties.find((p) => p.label === "Bounded")?.evidenced).toBe(false);
  });

  it("flags a payment attempt whose amount this transaction never quoted", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_PENDING",
        attempts: [
          {
            attemptNumber: 1,
            status: "PENDING",
            amount: inr("100"),
            failureCategory: null,
          },
        ],
      }),
    );

    const amount = checkOf(passport, "PAYMENT_AMOUNT");
    expect(amount.status).toBe("BLOCKED");
    expect(amount.tone).toBe("NEGATIVE");
  });

  it("marks a double capture as an anomaly rather than a clean settlement", () => {
    const passport = buildSafetyPassport(
      facts({
        ...completedFacts(),
        evidence: evidence({
          ...completedFacts().evidence,
          multipleCaptureDetected: 1,
        }),
      }),
    );

    const capture = checkOf(passport, "PROVIDER_CAPTURE");
    expect(capture.status).toBe("CAPTURED");
    expect(capture.tone).toBe("NEGATIVE");
    expect(passport.properties.find((p) => p.label === "Failure-safe")?.evidenced).toBe(
      false,
    );
  });
});

describe("retry, re-quote and replay history", () => {
  it("is absent for a purchase that was paid on the first attempt", () => {
    expect(buildSafetyPassport(completedFacts()).retry).toBeNull();
  });

  it("appears after a single failed attempt, because retry is then a live question", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_FAILED",
        policyDecision: "ALLOWED",
        attempts: [
          {
            attemptNumber: 1,
            status: "FAILED",
            amount: inr("289900"),
            failureCategory: "DECLINED_BY_BANK",
          },
        ],
        retryAvailable: true,
        evidence: evidence({ paymentFailed: 1 }),
      }),
    );

    const rows = passport.retry?.rows ?? [];
    expect(passport.retry?.attemptsUsed).toBe(1);
    expect(rows[0]?.value).toMatch(/^FAILED · declined by bank$/);
    expect(rows.find((row) => row.label === "Retry eligibility")?.value).toBe(
      "AVAILABLE",
    );
  });

  it("names the server's own refusal when a retry is no longer available", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "PAYMENT_FAILED",
        attempts: [
          {
            attemptNumber: 1,
            status: "FAILED",
            amount: inr("289900"),
            failureCategory: null,
          },
          {
            attemptNumber: 2,
            status: "FAILED",
            amount: inr("289900"),
            failureCategory: null,
          },
          {
            attemptNumber: 3,
            status: "FAILED",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        retryAvailable: false,
        retryDenial: "RETRY_LIMIT_REACHED",
        evidence: evidence({ paymentFailed: 3, retryRequested: 2 }),
      }),
    );

    const rows = passport.retry?.rows ?? [];
    expect(passport.retry?.attemptsUsed).toBe(3);
    expect(rows.find((row) => row.label === "Retry eligibility")?.value).toBe(
      "RETRY LIMIT REACHED",
    );
  });

  it("lists both attempts, their outcomes and who triggered the second", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "COMPLETED",
        policyDecision: "ALLOWED",
        reservationStatuses: ["COMMITTED"],
        attempts: [
          {
            attemptNumber: 1,
            status: "FAILED",
            amount: inr("289900"),
            failureCategory: "INSUFFICIENT_FUNDS",
          },
          {
            attemptNumber: 2,
            status: "CAPTURED",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        retryAvailable: false,
        retryDenial: "PAYMENT_ALREADY_CAPTURED",
        evidence: evidence({
          paymentFailed: 1,
          retryRequested: 1,
          paymentCaptured: 1,
          inventoryCommitted: 1,
        }),
      }),
    );

    const retry = passport.retry;
    expect(retry).not.toBeNull();
    expect(retry?.attemptsUsed).toBe(2);
    expect(retry?.maxAttempts).toBe(3);

    const rows = retry?.rows ?? [];
    expect(rows[0]?.label).toBe("Attempt 1");
    expect(rows[0]?.value).toMatch(/^FAILED/);
    expect(rows[0]?.tone).toBe("NEGATIVE");
    expect(rows[1]?.label).toBe("Attempt 2");
    expect(rows[1]?.value).toBe("CAPTURED");
    expect(rows.some((row) => row.label === "Retry authority")).toBe(true);
  });

  it("shows a stale-quote re-quote as a fresh quote, a policy rerun and a reused hold", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "INVENTORY_RESERVED",
        trustedQuoteStatus: "ACTIVE",
        quotes: [
          { status: "ACTIVE", totalAmount: inr("289900") },
          { status: "SUPERSEDED", totalAmount: inr("279900") },
        ],
        policyDecision: "ALLOWED",
        reservationStatuses: ["ACTIVE"],
        attempts: [
          {
            attemptNumber: 1,
            status: "FAILED",
            amount: inr("279900"),
            failureCategory: "DECLINED_BY_BANK",
          },
        ],
        retryAvailable: true,
        evidence: evidence({
          quoteCreated: 1,
          quoteReissued: 1,
          policyEvaluated: 2,
          inventoryReserved: 1,
          inventoryRequoted: 1,
          retryRequested: 1,
          paymentFailed: 1,
        }),
      }),
    );

    const rows = passport.retry?.rows ?? [];
    const valueOf = (label: string): string | undefined =>
      rows.find((row) => row.label === label)?.value;

    expect(valueOf("Fresh quote on retry")).toBe("VERIFIED");
    expect(valueOf("Policy re-evaluated")).toBe("YES");
    expect(valueOf("Existing stock hold")).toBe("REUSED");
    expect(valueOf("Retry eligibility")).toBe("AVAILABLE");

    // The superseded price is history; the trusted amount is the fresh one, and
    // the old attempt's amount is still one this transaction genuinely quoted.
    expect(checkOf(passport, "PRICE_VERIFIED").value).toMatch(/2,899\.00/);
    expect(checkOf(passport, "PAYMENT_AMOUNT").status).toBe("VERIFIED");
    expect(checkOf(passport, "INVENTORY").note).toMatch(/rebound/);
  });

  it("does not claim a reused hold when a second reservation exists", () => {
    const passport = buildSafetyPassport(
      facts({
        state: "INVENTORY_RESERVED",
        reservationStatuses: ["RELEASED", "ACTIVE"],
        evidence: evidence({ inventoryRequoted: 1, quoteReissued: 1 }),
      }),
    );

    expect(checkOf(passport, "INVENTORY").note).not.toMatch(/rebound/);
  });

  it("reports a redelivered provider event as deduplicated", () => {
    const passport = buildSafetyPassport(
      facts({
        ...completedFacts(),
        evidence: evidence({ ...completedFacts().evidence, webhookDuplicate: 1 }),
      }),
    );

    const rows = passport.retry?.rows ?? [];
    expect(rows.find((row) => row.label === "Duplicate provider event")?.value).toBe(
      "DEDUPLICATED",
    );
    expect(passport.properties.find((p) => p.label === "Failure-safe")?.evidenced).toBe(
      true,
    );
  });
});

describe("the passport's own shape", () => {
  it("always renders every check, so a missing line can never read as a pass", () => {
    for (const state of [
      "INTENT_RECEIVED",
      "COMPLETED",
      "CANCELLED",
      "EXPIRED",
    ] as const) {
      const passport = buildSafetyPassport(facts({ state }));
      expect(passport.checks.map((entry) => entry.id)).toEqual([...PASSPORT_CHECK_IDS]);
    }
  });

  it("states the two authorities in the same words on every transaction", () => {
    for (const state of ["INTENT_RECEIVED", "BLOCKED", "COMPLETED"] as const) {
      const passport = buildSafetyPassport(facts({ state }));
      expect(passport.aiAuthority.value).toBe("Product proposal only");
      expect(passport.financialAuthority.value).toBe("Deterministic server");
      expect(passport.priceSource).toMatch(/server-verified merchant data/i);
    }
  });

  it("never uses absolute safety language anywhere in its output", () => {
    // "Secure", "guaranteed" and "fraud-proof" are not facts about a
    // transaction, and a passport that used them would be making a promise the
    // records cannot support.
    const rendered = JSON.stringify(buildSafetyPassport(completedFacts()));
    for (const banned of [/\bsecure\b/i, /guarantee/i, /fraud-proof/i, /100% safe/i]) {
      expect(rendered).not.toMatch(banned);
    }
  });

  it("carries the five properties, each with evidence from this transaction", () => {
    const passport = buildSafetyPassport(completedFacts());
    expect(passport.properties.map((property) => property.label)).toEqual([
      "Explainable",
      "Bounded",
      "Human-gated when required",
      "Auditable",
      "Failure-safe",
    ]);
    expect(passport.properties.every((property) => property.evidenced)).toBe(true);
    expect(passport.properties.every((property) => property.evidence.length > 0)).toBe(
      true,
    );
  });

  it("leaves the five properties unevidenced when a transaction has no history", () => {
    const passport = buildSafetyPassport(
      facts({ state: "INTENT_RECEIVED", trustedAmount: null, quotes: [] }),
    );
    const unevidenced = passport.properties.filter((property) => !property.evidenced);
    expect(unevidenced.map((property) => property.label)).toEqual([
      "Explainable",
      "Bounded",
      "Human-gated when required",
      "Auditable",
    ]);
  });
});

describe("the passport panel, rendered", () => {
  it("draws every check, the two authorities and the timeline pointer", async () => {
    const { SafetyPassport } = await import("@/components/transaction/safety-passport");
    const markup = renderToStaticMarkup(
      SafetyPassport({ passport: buildSafetyPassport(completedFacts()) }),
    );

    expect(markup).toContain(SAFETY_PASSPORT_TITLE);
    expect(markup).toContain("Product proposal only");
    expect(markup).toContain("Deterministic server");
    expect(markup).toContain("Committed exactly once");
    // The panel must point at the trail rather than pretend to replace it.
    expect(markup).toContain("What happened");
    expect(markup).toMatch(/No part of it is written by a language model/);
  });

  it("draws a pending capture without a positive mark", () => {
    const pending = buildSafetyPassport(
      facts({
        state: "PAYMENT_VERIFIED",
        policyDecision: "ALLOWED",
        reservationStatuses: ["ACTIVE"],
        attempts: [
          {
            attemptNumber: 1,
            status: "VERIFIED",
            amount: inr("289900"),
            failureCategory: null,
          },
        ],
        evidence: evidence({ paymentVerified: 1 }),
      }),
    );

    const capture = checkOf(pending, "PROVIDER_CAPTURE");
    expect(capture.tone).toBe("WARNING");
    // The glyph is a function of tone, so a warning tone cannot draw a tick.
    expect(capture.tone).not.toBe("POSITIVE");
  });
});

describe("the row-to-fact mapping the service performs", () => {
  /**
   * `toSafetyPassportFacts` is the seam between persisted rows and the pure
   * builder, and it makes three decisions of its own that are worth pinning:
   * which quote is the trusted one, what a missing retry status means, and what
   * to do with a policy decision it does not recognise.
   */
  const rows = {
    quotes: [
      { status: "ACTIVE", totalAmount: inr("289900") },
      { status: "SUPERSEDED", totalAmount: inr("279900") },
    ],
    trustedQuote: { status: "ACTIVE", totalAmount: inr("289900") },
    approvalStatuses: ["CONSUMED"],
    reservationStatuses: ["COMMITTED"],
    attempts: [],
  };

  it("carries the trusted quote through as the amount and its status", async () => {
    const { toSafetyPassportFacts } = await import("@/services/safety/passport-service");
    const built = toSafetyPassportFacts({
      transactionId: "t-1",
      state: "COMPLETED",
      quoteUsable: false,
      policyDecision: "ALLOWED",
      policyReasonCode: "WITHIN_AUTO_APPROVE_LIMIT",
      retry: null,
      timeline: [{ action: "policy_evaluated" }],
      rows,
    });

    expect(built.trustedAmount).toEqual(inr("289900"));
    expect(built.trustedQuoteStatus).toBe("ACTIVE");
    expect(built.policyDecision).toBe("ALLOWED");
    expect(built.evidence.policyEvaluated).toBe(1);
  });

  it("falls back to the shared attempt limit when no retry status exists", async () => {
    const { toSafetyPassportFacts } = await import("@/services/safety/passport-service");
    const { MAX_PAYMENT_ATTEMPTS } = await import("@/domain/payment/retry");
    const built = toSafetyPassportFacts({
      transactionId: "t-1",
      state: "QUOTE_CREATED",
      quoteUsable: true,
      policyDecision: null,
      policyReasonCode: null,
      retry: null,
      timeline: [],
      rows,
    });

    // Never a literal: the passport must report the same bound the retry gate
    // actually enforces, so the two cannot drift.
    expect(built.maxAttempts).toBe(MAX_PAYMENT_ATTEMPTS);
    expect(built.retryAvailable).toBeNull();
  });

  it("refuses a policy decision outside the engine's three outcomes", async () => {
    const { toSafetyPassportFacts } = await import("@/services/safety/passport-service");
    const built = toSafetyPassportFacts({
      transactionId: "t-1",
      state: "QUOTE_CREATED",
      quoteUsable: true,
      // Not a value the engine can return. Reporting it verbatim would let an
      // unexpected string render as though it were a decision.
      policyDecision: "PROBABLY_FINE",
      policyReasonCode: null,
      retry: null,
      timeline: [],
      rows,
    });

    expect(built.policyDecision).toBeNull();
  });
});
