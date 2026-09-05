import { describe, expect, it } from "vitest";
import { MERCHANT_CATEGORIES, canonicalCategory } from "@/domain/catalog/categories";
import {
  assessCandidate,
  eligibleCandidates,
  ineligibilityReasons,
  nextBestAlternative,
  refusedOnlyForAvailability,
  type PurchaseAuthority,
} from "@/domain/product-decision/eligibility";
import { productDto } from "./support/fake-ai-provider";
import {
  AVAILABILITY_STATUSES,
  PUBLICLY_LISTED_PRODUCT_STATUSES,
  type CatalogProductDto,
} from "@/domain/catalog/contracts";

/**
 * A catalog that sells three kinds of thing, and the rule that keeps them apart.
 *
 * Category is compared by equality, and until this suite existed nothing proved
 * that comparison ever ran on the purchase path: the shopper's category was
 * extracted into the intent, dropped on the way to `NormalizedUserConstraints`,
 * and arrived at `assessCandidate` as `null`. With one category in the catalog
 * that was invisible. With mice and headphones beside the keyboards it is the
 * difference between "find me a mouse" returning a mouse and it returning
 * whatever the model liked best.
 *
 * Everything below is pure - no model, no database, no clock - so a failure
 * here is a failure of the rule itself and not of anything around it.
 */

const KEYBOARD: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-0000000000k1",
  name: "Aurora TKL Mechanical Keyboard",
  category: "mechanical-keyboard",
  amount: { amountMinor: "249900", currency: "INR" },
});

const MOUSE_CHEAP: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-0000000000m1",
  name: "Dart Lite Wired Optical Mouse",
  category: "mouse",
  amount: { amountMinor: "79900", currency: "INR" },
  attributes: { connectivity: "wired", use: "office" },
});

const MOUSE_GAMING: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-0000000000m2",
  name: "Pulse 6K Lightweight Gaming Mouse",
  category: "mouse",
  amount: { amountMinor: "299900", currency: "INR" },
  attributes: { connectivity: "wired", use: "gaming" },
});

const MOUSE_PREMIUM: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-0000000000m3",
  name: "Apex 26K Pro Wireless Gaming Mouse",
  category: "mouse",
  amount: { amountMinor: "449900", currency: "INR" },
  attributes: { connectivity: "wireless", use: "gaming" },
});

const MOUSE_OUT_OF_STOCK: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-0000000000m4",
  name: "Quartz Mini Travel Mouse",
  category: "mouse",
  amount: { amountMinor: "149900", currency: "INR" },
  availability: { status: "OUT_OF_STOCK", quantity: 0, purchasable: false },
});

const HEADPHONES: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-0000000000h1",
  name: "Cadence BT Wireless Headphones",
  category: "headphones",
  amount: { amountMinor: "179900", currency: "INR" },
  attributes: { connectivity: "wireless", batteryLifeHours: 40 },
});

const CATALOG: readonly CatalogProductDto[] = [
  KEYBOARD,
  MOUSE_CHEAP,
  MOUSE_GAMING,
  MOUSE_PREMIUM,
  MOUSE_OUT_OF_STOCK,
  HEADPHONES,
];

function wanting(
  category: string | null,
  maxAmountMinor: bigint | null = 300_000n,
): PurchaseAuthority {
  return {
    quantity: 1,
    maxAmountMinor,
    currency: "INR",
    budgetScope: "PER_UNIT",
    hardRequirements: [],
    category,
  };
}

describe("the shopper's words reach the catalog's own category", () => {
  it("maps every way a person names these products onto a category that exists", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["mouse", "mouse"],
      ["mice", "mouse"],
      ["Gaming Mouse", "mouse"],
      ["gaming-mouse", "mouse"],
      ["wireless mouse", "mouse"],
      ["headphones", "headphones"],
      ["headphone", "headphones"],
      ["headset", "headphones"],
      ["Gaming Headset", "headphones"],
      ["keyboard", "mechanical-keyboard"],
      ["mechanical keyboard", "mechanical-keyboard"],
      ["MECHANICAL-KEYBOARD", "mechanical-keyboard"],
    ];
    for (const [stated, canonical] of expected) {
      expect(canonicalCategory(stated), `"${stated}"`).toBe(canonical);
    }
  });

  it("leaves a category this merchant does not sell alone", () => {
    // The correct answer to "find me a webcam" is nothing, not a keyboard.
    // Passing it through unchanged is what makes the hard filter refuse it.
    expect(canonicalCategory("webcam")).toBe("webcam");
    expect(canonicalCategory("earbuds")).toBe("earbuds");
    expect(MERCHANT_CATEGORIES).not.toContain("webcam");
  });

  it("does not invent a category for a shopper who named none", () => {
    expect(canonicalCategory(null)).toBeNull();
    expect(canonicalCategory("   ")).toBeNull();
  });
});

describe("a request for one kind of product never returns another", () => {
  it("returns mice, and only mice, for a mouse request", () => {
    const eligible = eligibleCandidates(CATALOG, wanting("mouse"));

    expect(eligible.length).toBeGreaterThan(0);
    for (const product of eligible) expect(product.category).toBe("mouse");
    expect(eligible.map((p) => p.id)).not.toContain(KEYBOARD.id);
    expect(eligible.map((p) => p.id)).not.toContain(HEADPHONES.id);
  });

  it("returns headphones, and only headphones, for a headphone request", () => {
    const eligible = eligibleCandidates(CATALOG, wanting("headphones"));

    expect(eligible.length).toBeGreaterThan(0);
    for (const product of eligible) expect(product.category).toBe("headphones");
    expect(eligible.map((p) => p.id)).not.toContain(KEYBOARD.id);
    expect(eligible.map((p) => p.id)).not.toContain(MOUSE_CHEAP.id);
  });

  it("still returns keyboards for a keyboard request", () => {
    const eligible = eligibleCandidates(CATALOG, wanting("mechanical-keyboard"));

    expect(eligible.map((p) => p.id)).toEqual([KEYBOARD.id]);
  });

  it("refuses a keyboard proposed against a mouse request, by name", () => {
    expect(assessCandidate(KEYBOARD, wanting("mouse"))).toEqual({
      kind: "INELIGIBLE",
      reasons: ["WRONG_CATEGORY"],
    });
  });

  it("refuses a mouse proposed against a headphone request, by name", () => {
    expect(ineligibilityReasons(MOUSE_CHEAP, wanting("headphones"))).toContain(
      "WRONG_CATEGORY",
    );
  });

  it("finds nothing at all when the merchant does not sell what was asked for", () => {
    // The honest empty result. No substitution, no nearest match.
    expect(eligibleCandidates(CATALOG, wanting("webcam"))).toEqual([]);
  });
});

describe("the other hard constraints still bind inside a category", () => {
  it("keeps a stated budget binding on a mouse request", () => {
    const eligible = eligibleCandidates(CATALOG, wanting("mouse", 200_000n));

    // The ₹2,999 and ₹4,499 mice are both over ₹2,000 and both excluded.
    expect(eligible.map((p) => p.id)).toEqual([MOUSE_CHEAP.id]);
    expect(ineligibilityReasons(MOUSE_PREMIUM, wanting("mouse", 200_000n))).toContain(
      "OVER_BUDGET",
    );
  });

  it("never offers an out-of-stock product", () => {
    const eligible = eligibleCandidates(CATALOG, wanting("mouse"));

    expect(eligible.map((p) => p.id)).not.toContain(MOUSE_OUT_OF_STOCK.id);
    expect(ineligibilityReasons(MOUSE_OUT_OF_STOCK, wanting("mouse"))).toContain(
      "NOT_PURCHASABLE",
    );
  });

  it("never lists a discontinued product in the first place", () => {
    // Discontinued is not an availability state a candidate can carry: such a
    // product is excluded by the repository's visibility filter, so it never
    // becomes a candidate at all. Asserting the vocabulary is asserting that,
    // rather than fabricating a DTO the type system forbids.
    expect(PUBLICLY_LISTED_PRODUCT_STATUSES).not.toContain("DISCONTINUED");
    expect(AVAILABILITY_STATUSES).not.toContain("DISCONTINUED");
  });
});

describe("substituting an alternative never crosses a category", () => {
  it("replaces an unavailable mouse with another mouse", () => {
    const authority = wanting("mouse");
    // The sold-out mouse was the proposal; the server picks its own next best.
    const alternative = nextBestAlternative(CATALOG, authority, MOUSE_OUT_OF_STOCK.id);

    expect(alternative).not.toBeNull();
    expect(alternative?.category).toBe("mouse");
    expect(alternative?.id).toBe(MOUSE_CHEAP.id);
  });

  it("offers no alternative at all rather than one from another category", () => {
    // Every headphone is gone. A keyboard and three mice are still in stock and
    // must not be reached for.
    const soldOut = CATALOG.map((product) =>
      product.category === "headphones"
        ? productDto({
            ...product,
            availability: { status: "OUT_OF_STOCK", quantity: 0, purchasable: false },
          })
        : product,
    );

    const alternative = nextBestAlternative(
      soldOut,
      wanting("headphones"),
      HEADPHONES.id,
    );
    expect(alternative).toBeNull();
  });

  it("substitutes only when availability was the sole objection", () => {
    // Out of stock is recoverable by offering something else. Over budget is
    // not: offering an alternative would imply the original was ever available
    // to them at that price.
    expect(refusedOnlyForAvailability(["NOT_PURCHASABLE"])).toBe(true);
    expect(refusedOnlyForAvailability(["NOT_PURCHASABLE", "WRONG_CATEGORY"])).toBe(false);
    expect(refusedOnlyForAvailability(["WRONG_CATEGORY"])).toBe(false);
  });
});

describe("the model proposes, and the server still decides", () => {
  it("refuses an id that is not in the server's own eligible set", () => {
    const authority = wanting("mouse");
    const eligible = eligibleCandidates(CATALOG, authority);

    // The keyboard is a real catalog product, and the model might well name it
    // for a mouse request. Membership is what the server checks, so a real id
    // in the wrong category is refused exactly like an invented one.
    expect(eligible.some((product) => product.id === KEYBOARD.id)).toBe(false);
    expect(
      eligible.some((product) => product.id === "01930000-0000-7000-8000-00000000fake"),
    ).toBe(false);
  });
});
