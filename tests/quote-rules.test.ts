import { describe, expect, it } from "vitest";
import {
  assessQuote,
  isExpired,
  toQuoteDto,
  type CurrentProductFacts,
  type QuoteSnapshot,
} from "@/domain/quote/rules";
import {
  assessCandidate,
  ineligibilityReasons,
  respectsBudget,
  totalAmountMinor,
  unverifiableRequirements,
  type PurchaseAuthority,
} from "@/domain/product-decision/eligibility";
import { fixedClock } from "@/lib/clock";
import { productDto } from "./support/fake-ai-provider";

/**
 * The trusted-quote rules, without a database and without waiting.
 *
 * Expiry is a financial boundary, so it is tested at the boundary - one
 * millisecond before, exactly on it, and one after - which is only possible
 * because time is injected rather than read from the environment.
 */

const CREATED = new Date("2026-06-01T10:00:00.000Z");
const EXPIRES = new Date("2026-06-01T10:05:00.000Z");

const SNAPSHOT: QuoteSnapshot = {
  quoteId: "01930000-0000-7000-8000-0000000000q1",
  transactionId: "01930000-0000-7000-8000-0000000000t1",
  productId: "01930000-0000-7000-8000-0000000000p1",
  quantity: 1,
  unitAmountMinor: 279_900n,
  totalAmountMinor: 279_900n,
  currency: "INR",
  productVersion: 3,
  status: "ACTIVE",
  createdAt: CREATED,
  expiresAt: EXPIRES,
};

const UNCHANGED: CurrentProductFacts = {
  unitAmountMinor: 279_900n,
  currency: "INR",
  availableQuantity: 5,
  purchasable: true,
  version: 3,
};

const BUDGET_3000: PurchaseAuthority = {
  quantity: 1,
  maxAmountMinor: 300_000n,
  currency: "INR",
  budgetScope: "PER_UNIT",
  hardRequirements: [],
  category: null,
};

describe("money arithmetic", () => {
  it("multiplies unit price by quantity in integer minor units", () => {
    expect(totalAmountMinor(279_900n, 2)).toBe(559_800n);
    expect(totalAmountMinor(279_900n, 1)).toBe(279_900n);
    expect(typeof totalAmountMinor(279_900n, 3)).toBe("bigint");
  });

  it("stays exact past the safe integer range", () => {
    // A float path would have lost digits here; bigint does not.
    const huge = 9_007_199_254_740_993n;
    expect(totalAmountMinor(huge, 3)).toBe(27_021_597_764_222_979n);
  });

  it("refuses a quantity that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => totalAmountMinor(279_900n, bad)).toThrow(RangeError);
    }
  });
});

describe("budget scope", () => {
  const perUnit: PurchaseAuthority = {
    ...BUDGET_3000,
    quantity: 2,
    budgetScope: "PER_UNIT",
  };
  const total: PurchaseAuthority = { ...BUDGET_3000, quantity: 2, budgetScope: "TOTAL" };

  it("PER_UNIT compares the unit price", () => {
    // Two at ₹2,799 is ₹5,598 of spending, and that is what "under ₹3000 each"
    // permits.
    expect(respectsBudget(279_900n, 2, perUnit)).toBe(true);
    expect(respectsBudget(300_001n, 2, perUnit)).toBe(false);
  });

  it("TOTAL compares the line total", () => {
    // The same two keyboards are ₹5,598 against a ₹3,000 order budget: refused.
    expect(respectsBudget(279_900n, 2, total)).toBe(false);
    expect(respectsBudget(149_900n, 2, total)).toBe(true);
  });

  it("treats the two as identical at quantity one", () => {
    expect(respectsBudget(279_900n, 1, { ...BUDGET_3000, budgetScope: "PER_UNIT" })).toBe(
      true,
    );
    expect(respectsBudget(279_900n, 1, { ...BUDGET_3000, budgetScope: "TOTAL" })).toBe(
      true,
    );
  });

  it("accepts an amount exactly on the limit", () => {
    expect(respectsBudget(300_000n, 1, BUDGET_3000)).toBe(true);
    expect(respectsBudget(300_001n, 1, BUDGET_3000)).toBe(false);
  });
});

describe("candidate eligibility", () => {
  const inBudget = productDto({
    id: "p-1",
    amount: { amountMinor: "279900", currency: "INR" },
    attributes: { switchType: "mechanical" },
  });

  it("accepts a compliant candidate and says why", () => {
    const assessment = assessCandidate(inBudget, BUDGET_3000);
    expect(assessment.kind).toBe("ELIGIBLE");
    if (assessment.kind !== "ELIGIBLE") return;
    expect(assessment.reasons).toContain("WITHIN_BUDGET");
    expect(assessment.reasons).toContain("CURRENCY_MATCH");
    expect(assessment.reasons).toContain("IN_STOCK");
  });

  it("refuses an over-budget candidate", () => {
    const over = productDto({
      id: "p-2",
      amount: { amountMinor: "349900", currency: "INR" },
    });
    expect(ineligibilityReasons(over, BUDGET_3000)).toContain("OVER_BUDGET");
  });

  it("refuses an unpurchasable candidate", () => {
    const gone = productDto({
      id: "p-3",
      availability: { status: "OUT_OF_STOCK", quantity: 0, purchasable: false },
    });
    expect(ineligibilityReasons(gone, BUDGET_3000)).toContain("NOT_PURCHASABLE");
  });

  it("refuses insufficient stock for the requested quantity", () => {
    const scarce = productDto({
      id: "p-4",
      availability: { status: "AVAILABLE", quantity: 1, purchasable: true },
    });
    expect(
      ineligibilityReasons(scarce, {
        ...BUDGET_3000,
        quantity: 3,
        budgetScope: "PER_UNIT",
      }),
    ).toContain("INSUFFICIENT_INVENTORY");
  });

  it("refuses a mismatched currency without comparing amounts", () => {
    const usd = productDto({
      id: "p-5",
      amount: { amountMinor: "100", currency: "USD" as never },
    });
    const reasons = ineligibilityReasons(usd, BUDGET_3000);
    expect(reasons).toContain("CURRENCY_MISMATCH");
    // A trivially cheap amount in another currency must not read as "in budget".
    expect(reasons).not.toContain("WITHIN_BUDGET");
  });

  it("refuses an unmet hard requirement from structured attributes only", () => {
    const membrane = productDto({
      id: "p-6",
      description: "Feels mechanical! A truly mechanical experience.",
      attributes: { switchType: "membrane" },
    });
    expect(
      ineligibilityReasons(membrane, {
        ...BUDGET_3000,
        hardRequirements: [
          { attribute: "switchType", operator: "EQUALS", value: "mechanical" },
        ],
      }),
    ).toContain("UNMET_HARD_REQUIREMENT");
  });

  it("collects every failing reason, not just the first", () => {
    const bad = productDto({
      id: "p-7",
      amount: { amountMinor: "999900", currency: "INR" },
      availability: { status: "OUT_OF_STOCK", quantity: 0, purchasable: false },
    });
    const reasons = ineligibilityReasons(bad, BUDGET_3000);
    expect(reasons).toContain("OVER_BUDGET");
    expect(reasons).toContain("NOT_PURCHASABLE");
  });
});

describe("unverifiable hard requirements", () => {
  const product = productDto({ id: "p-8", attributes: { switchType: "mechanical" } });

  it("accepts a requirement the catalog carries a field for", () => {
    expect(
      unverifiableRequirements(
        [product],
        [{ attribute: "switchType", operator: "EQUALS", value: "mechanical" }],
      ),
    ).toEqual([]);
  });

  it("reports one the catalog cannot answer", () => {
    // "must be good for gaming" is not a column. The model's belief that a
    // product satisfies it is an opinion, and an opinion is not a hard check.
    const unverifiable = unverifiableRequirements(
      [product],
      [{ attribute: "goodForGaming", operator: "EQUALS", value: "true" }],
    );
    expect(unverifiable.map((r) => r.attribute)).toEqual(["goodForGaming"]);
  });

  it("treats category as verifiable", () => {
    expect(
      unverifiableRequirements(
        [product],
        [{ attribute: "category", operator: "EQUALS", value: "mechanical-keyboard" }],
      ),
    ).toEqual([]);
  });
});

describe("quote expiry", () => {
  it("is not expired before expiresAt", () => {
    expect(isExpired(EXPIRES, new Date(EXPIRES.getTime() - 1))).toBe(false);
  });

  it("IS expired exactly at expiresAt", () => {
    // The documented boundary: now >= expiresAt. Inclusive would leave a
    // one-millisecond window whose behaviour depends on clock resolution.
    expect(isExpired(EXPIRES, EXPIRES)).toBe(true);
  });

  it("is expired after expiresAt", () => {
    expect(isExpired(EXPIRES, new Date(EXPIRES.getTime() + 1))).toBe(true);
  });

  it("reports EXPIRED from the clock, not from the status column", () => {
    const clock = fixedClock(new Date(EXPIRES.getTime() + 1_000));
    // The row still says ACTIVE; the clock disagrees, and the clock wins.
    const verdict = assessQuote(SNAPSHOT, UNCHANGED, clock.now());
    expect(verdict.kind).toBe("EXPIRED");
  });

  it("advances deterministically without sleeping", () => {
    const clock = fixedClock(CREATED);
    expect(assessQuote(SNAPSHOT, UNCHANGED, clock.now()).kind).toBe("VALID");
    clock.advanceMs(5 * 60 * 1000);
    expect(assessQuote(SNAPSHOT, UNCHANGED, clock.now()).kind).toBe("EXPIRED");
  });
});

describe("quote invalidation", () => {
  const now = new Date(CREATED.getTime() + 60_000);

  it("stays valid when nothing changed", () => {
    expect(assessQuote(SNAPSHOT, UNCHANGED, now).kind).toBe("VALID");
  });

  it("invalidates on a price increase", () => {
    const verdict = assessQuote(
      SNAPSHOT,
      { ...UNCHANGED, unitAmountMinor: 299_900n, version: 4 },
      now,
    );
    expect(verdict.kind).toBe("INVALIDATED");
    if (verdict.kind !== "INVALIDATED") return;
    expect(verdict.reasons).toContain("PRICE_CHANGED");
  });

  it("invalidates on a price DEcrease too", () => {
    // The snapshot froze a specific amount. Re-pricing it in either direction
    // would make the record a lie about what was promised.
    const verdict = assessQuote(
      SNAPSHOT,
      { ...UNCHANGED, unitAmountMinor: 199_900n },
      now,
    );
    expect(verdict.kind).toBe("INVALIDATED");
  });

  it("invalidates on a currency change without converting", () => {
    const verdict = assessQuote(SNAPSHOT, { ...UNCHANGED, currency: "USD" }, now);
    expect(verdict.kind).toBe("INVALIDATED");
    if (verdict.kind !== "INVALIDATED") return;
    expect(verdict.reasons).toContain("CURRENCY_CHANGED");
  });

  it("invalidates when stock falls below the quoted quantity", () => {
    const forThree: QuoteSnapshot = {
      ...SNAPSHOT,
      quantity: 3,
      totalAmountMinor: 839_700n,
    };
    const verdict = assessQuote(forThree, { ...UNCHANGED, availableQuantity: 2 }, now);
    expect(verdict.kind).toBe("INVALIDATED");
    if (verdict.kind !== "INVALIDATED") return;
    expect(verdict.reasons).toContain("INSUFFICIENT_STOCK");
  });

  it("invalidates when the product stops being purchasable", () => {
    const verdict = assessQuote(SNAPSHOT, { ...UNCHANGED, purchasable: false }, now);
    expect(verdict.kind).toBe("INVALIDATED");
    if (verdict.kind !== "INVALIDATED") return;
    expect(verdict.reasons).toContain("PRODUCT_UNAVAILABLE");
  });

  it("invalidates on a version bump alone", () => {
    // Catches every change the field comparisons cannot see - a required
    // attribute among them.
    const verdict = assessQuote(SNAPSHOT, { ...UNCHANGED, version: 4 }, now);
    expect(verdict.kind).toBe("INVALIDATED");
    if (verdict.kind !== "INVALIDATED") return;
    expect(verdict.reasons).toContain("PRODUCT_VERSION_CHANGED");
  });

  it("reports a superseded quote as invalidated", () => {
    const verdict = assessQuote({ ...SNAPSHOT, status: "SUPERSEDED" }, UNCHANGED, now);
    expect(verdict.kind).toBe("INVALIDATED");
    if (verdict.kind !== "INVALIDATED") return;
    expect(verdict.reasons).toContain("SUPERSEDED_BY_NEWER_QUOTE");
  });

  it("prefers expiry over invalidation when both apply", () => {
    const late = new Date(EXPIRES.getTime() + 1);
    expect(assessQuote(SNAPSHOT, { ...UNCHANGED, unitAmountMinor: 1n }, late).kind).toBe(
      "EXPIRED",
    );
  });
});

describe("quote DTO", () => {
  it("serialises money as minor-unit strings", () => {
    const dto = toQuoteDto({ ...SNAPSHOT, quantity: 2, totalAmountMinor: 559_800n });
    expect(dto.unitAmount).toEqual({ amountMinor: "279900", currency: "INR" });
    expect(dto.totalAmount).toEqual({ amountMinor: "559800", currency: "INR" });
    expect(() => JSON.stringify(dto)).not.toThrow();
  });

  it("exposes no raw bigint", () => {
    const serialised = JSON.stringify(toQuoteDto(SNAPSHOT));
    expect(serialised).toContain('"279900"');
    expect(serialised).not.toMatch(/\d+n/);
  });

  it("carries freshness information for later objectives", () => {
    const dto = toQuoteDto(SNAPSHOT);
    expect(dto.productVersion).toBe(3);
    expect(dto.expiresAt).toBe(EXPIRES.toISOString());
  });
});
