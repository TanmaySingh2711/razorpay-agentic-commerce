import { describe, expect, it } from "vitest";
import {
  messageStatesACeiling,
  parseMinorAmountFromText,
  verifyBudgetClaim,
} from "@/domain/buyer-agent/budget";
import {
  deriveNoMatchReasons,
  isWithinBudget,
  satisfiesConstraint,
  unmetHardRequirements,
  validateSelection,
  type LockedUserAuthority,
} from "@/domain/buyer-agent/validation";
import {
  ATTRIBUTE_NAME_PATTERN,
  INTENT_RESPONSE_JSON_SCHEMA,
  MAX_AMOUNT_MINOR_PATTERN,
  MAX_ATTRIBUTE_NAME_LENGTH,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  MAX_BUDGET_SOURCE_TEXT_LENGTH,
  MAX_CATEGORY_LENGTH,
  MAX_CLARIFICATION_QUESTION_LENGTH,
  MAX_HARD_REQUIREMENTS,
  MAX_PRODUCT_QUERY_LENGTH,
  MAX_QUANTITY,
  MAX_SOFT_PREFERENCES,
  MIN_QUANTITY,
  structuredPurchaseIntentSchema,
} from "@/domain/buyer-agent/intent";
import { productDto } from "./support/fake-ai-provider";
import type { CatalogProductDto } from "@/domain/catalog/contracts";

/**
 * The user's authority, tested as pure deterministic code.
 *
 * Not one test here involves a model, a network, or an API key — which is the
 * whole argument. These rules must hold regardless of what Gemini returns, so
 * they are proven independently of it. The model's role is confined to
 * *locating* a budget in the user's words; the arithmetic, the comparison and
 * the refusal all live here.
 */

const IN_BUDGET: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-00000000a001",
  name: "Aurora TKL",
  amount: { amountMinor: "279900", currency: "INR" },
  attributes: { switchType: "mechanical", layout: "tkl-87", connectivity: "wired" },
});

const OVER_BUDGET: CatalogProductDto = productDto({
  id: "01930000-0000-7000-8000-00000000a002",
  name: "Meridian Pro",
  amount: { amountMinor: "349900", currency: "INR" },
  attributes: { switchType: "mechanical", layout: "tkl-87", connectivity: "bluetooth" },
});

const BUDGET_300000: LockedUserAuthority = {
  maxAmountMinor: 300_000n,
  currency: "INR",
  budgetScope: "PER_UNIT",
  quantity: 1,
  hardRequirements: [],
  category: null,
};

function observed(
  ...products: CatalogProductDto[]
): ReadonlyMap<string, CatalogProductDto> {
  return new Map(products.map((product) => [product.id, product]));
}

describe("budget extraction from the user's own words", () => {
  const forms: ReadonlyArray<readonly [string, bigint]> = [
    ["under ₹3000", 300_000n],
    ["under ₹3,000", 300_000n],
    ["max 3000 rupees", 300_000n],
    ["don't spend more than 3k", 300_000n],
    ["no more than 3 thousand", 300_000n],
    ["budget ₹2,999", 299_900n],
    ["below 2999.50", 299_950n],
    ["up to Rs. 3000", 300_000n],
  ];

  for (const [text, expected] of forms) {
    it(`reads "${text}" as ${expected.toString()} minor units`, () => {
      expect(parseMinorAmountFromText(text, "INR")).toBe(expected);
    });
  }

  it("refuses to guess when the phrase names no single amount", () => {
    expect(parseMinorAmountFromText("something cheap", "INR")).toBeNull();
    expect(parseMinorAmountFromText("between 2000 and 3000", "INR")).toBeNull();
  });

  it("never produces a float", () => {
    // 2999.50 could round to 299949.99999 through a float path. It does not.
    expect(parseMinorAmountFromText("under 2999.50", "INR")).toBe(299_950n);
    expect(typeof parseMinorAmountFromText("under 3000", "INR")).toBe("bigint");
  });
});

describe("budget provenance", () => {
  const message = "Find me the best mechanical keyboard under ₹3000 and buy it.";

  it("accepts a claim that matches the user's words exactly", () => {
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "300000",
          currency: "INR",
          explicit: true,
          scope: null,
          sourceText: "under ₹3000",
        },
        message,
      ),
    ).toEqual({ kind: "VERIFIED", maxAmountMinor: 300_000n, currency: "INR" });
  });

  it("rejects an inflated amount attached to a genuine span", () => {
    // The exact attack this check exists for: real source text, invented number.
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "500000",
          currency: "INR",
          explicit: true,
          scope: null,
          sourceText: "under ₹3000",
        },
        message,
      ).kind,
    ).toBe("REJECTED");
  });

  it("rejects a span the user never wrote", () => {
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "900000",
          currency: "INR",
          explicit: true,
          scope: null,
          sourceText: "under ₹9000",
        },
        message,
      ).kind,
    ).toBe("REJECTED");
  });

  it("rejects a lower bound dressed up as a maximum", () => {
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "300000",
          currency: "INR",
          explicit: true,
          scope: null,
          sourceText: "at least ₹3000",
        },
        "spend at least ₹3000 on a keyboard",
      ).kind,
    ).toBe("REJECTED");
  });

  it("rejects an approximation, which is not a ceiling", () => {
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "300000",
          currency: "INR",
          explicit: true,
          scope: null,
          sourceText: "around ₹3000",
        },
        "a keyboard around ₹3000",
      ).kind,
    ).toBe("REJECTED");
  });

  it("rejects a budget the user did not state", () => {
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "300000",
          currency: "INR",
          explicit: false,
          scope: null,
          sourceText: "cheap",
        },
        "buy me a cheap keyboard",
      ).kind,
    ).toBe("REJECTED");
  });

  it("rejects an absurd budget", () => {
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "999999999999999",
          currency: "INR",
          explicit: true,
          scope: null,
          sourceText: "under ₹9999999999999",
        },
        "under ₹9999999999999",
      ).kind,
    ).toBe("REJECTED");
  });

  it("tolerates whitespace and casing differences in the quoted span", () => {
    expect(
      verifyBudgetClaim(
        {
          maxAmountMinor: "300000",
          currency: "INR",
          explicit: true,
          scope: null,
          sourceText: "Under  ₹3000",
        },
        message,
      ).kind,
    ).toBe("VERIFIED");
  });
});

describe("the explicit budget cannot be widened", () => {
  it("accepts a product at ₹2,799 under a ₹3,000 ceiling", () => {
    const result = validateSelection(IN_BUDGET.id, 1, BUDGET_300000, observed(IN_BUDGET));
    expect(result.kind).toBe("VALID");
  });

  it("refuses a product at ₹3,499 under a ₹3,000 ceiling", () => {
    const result = validateSelection(
      OVER_BUDGET.id,
      1,
      BUDGET_300000,
      observed(IN_BUDGET, OVER_BUDGET),
    );
    expect(result).toMatchObject({ kind: "REJECTED" });
  });

  it("refuses the over-budget product even when it is the only candidate", () => {
    // No fallback, no "close enough", no widening because nothing else fits.
    const result = validateSelection(
      OVER_BUDGET.id,
      1,
      BUDGET_300000,
      observed(OVER_BUDGET),
    );
    expect(result.kind).toBe("REJECTED");
  });

  it("refuses it one paisa over", () => {
    const justOver = productDto({
      id: "01930000-0000-7000-8000-00000000a003",
      amount: { amountMinor: "300001", currency: "INR" },
    });
    expect(
      validateSelection(justOver.id, 1, BUDGET_300000, observed(justOver)).kind,
    ).toBe("REJECTED");
  });

  it("accepts it exactly on the limit", () => {
    const exact = productDto({
      id: "01930000-0000-7000-8000-00000000a004",
      amount: { amountMinor: "300000", currency: "INR" },
    });
    expect(validateSelection(exact.id, 1, BUDGET_300000, observed(exact)).kind).toBe(
      "VALID",
    );
  });

  it("never compares across currencies", () => {
    const usd = productDto({
      id: "01930000-0000-7000-8000-00000000a005",
      amount: { amountMinor: "1000", currency: "INR" },
    });
    // A cheap amount in a different currency must not pass by numeric luck.
    expect(
      isWithinBudget(
        { ...usd, amount: { amountMinor: "1000", currency: "USD" as never } },
        300_000n,
        "INR",
      ),
    ).toBe(false);
  });
});

describe("product id provenance", () => {
  it("rejects an id that no catalog search returned", () => {
    // A perfectly well-formed UUID the model invented.
    expect(
      validateSelection(
        "01930000-0000-7000-8000-0000000fffff",
        1,
        BUDGET_300000,
        observed(IN_BUDGET),
      ),
    ).toMatchObject({ kind: "REJECTED" });
  });

  it("accepts an id that was observed", () => {
    expect(
      validateSelection(IN_BUDGET.id, 1, BUDGET_300000, observed(IN_BUDGET)).kind,
    ).toBe("VALID");
  });

  it("rejects everything when no product was ever observed", () => {
    expect(validateSelection(IN_BUDGET.id, 1, BUDGET_300000, new Map()).kind).toBe(
      "REJECTED",
    );
  });
});

describe("availability", () => {
  it("refuses an out-of-stock product", () => {
    const outOfStock = productDto({
      id: "01930000-0000-7000-8000-00000000b001",
      availability: { status: "OUT_OF_STOCK", quantity: 0, purchasable: false },
    });
    expect(
      validateSelection(outOfStock.id, 1, BUDGET_300000, observed(outOfStock)).kind,
    ).toBe("REJECTED");
  });

  it("refuses a product with insufficient stock for the quantity asked for", () => {
    const scarce = productDto({
      id: "01930000-0000-7000-8000-00000000b002",
      availability: { status: "AVAILABLE", quantity: 1, purchasable: true },
    });
    expect(
      validateSelection(scarce.id, 2, { ...BUDGET_300000, quantity: 2 }, observed(scarce))
        .kind,
    ).toBe("REJECTED");
  });

  it("refuses a quantity the user did not ask for", () => {
    expect(
      validateSelection(IN_BUDGET.id, 3, BUDGET_300000, observed(IN_BUDGET)).kind,
    ).toBe("REJECTED");
  });
});

describe("hard requirements versus soft preferences", () => {
  const mechanical = {
    attribute: "switchType",
    operator: "EQUALS" as const,
    value: "mechanical",
  };

  it("is satisfied by a structured attribute", () => {
    expect(satisfiesConstraint(IN_BUDGET, mechanical)).toBe(true);
  });

  it("is never satisfied by marketing text", () => {
    // The description says the word; the attribute does not. Prose is not evidence.
    const prose = productDto({
      id: "01930000-0000-7000-8000-00000000c001",
      description: "Feels wonderfully mechanical, a true mechanical experience.",
      attributes: { switchType: "membrane" },
    });
    expect(satisfiesConstraint(prose, mechanical)).toBe(false);
    expect(
      validateSelection(
        prose.id,
        1,
        { ...BUDGET_300000, hardRequirements: [mechanical] },
        observed(prose),
      ).kind,
    ).toBe("REJECTED");
  });

  it("refuses a product that misses any hard requirement", () => {
    const authority: LockedUserAuthority = {
      ...BUDGET_300000,
      hardRequirements: [
        mechanical,
        { attribute: "connectivity", operator: "EQUALS", value: "bluetooth" },
      ],
    };
    // IN_BUDGET is mechanical but wired.
    expect(validateSelection(IN_BUDGET.id, 1, authority, observed(IN_BUDGET)).kind).toBe(
      "REJECTED",
    );
  });

  it("does not treat a soft preference as a requirement", () => {
    // Bluetooth is only preferred; the wired product remains selectable.
    const authority: LockedUserAuthority = {
      ...BUDGET_300000,
      hardRequirements: [mechanical],
    };
    expect(validateSelection(IN_BUDGET.id, 1, authority, observed(IN_BUDGET)).kind).toBe(
      "VALID",
    );
  });

  it("handles NOT_EQUALS against a missing attribute", () => {
    const noConnectivity = productDto({
      id: "01930000-0000-7000-8000-00000000c002",
      attributes: { switchType: "mechanical" },
    });
    expect(
      satisfiesConstraint(noConnectivity, {
        attribute: "connectivity",
        operator: "NOT_EQUALS",
        value: "wired",
      }),
    ).toBe(true);
  });

  it("lists exactly the unmet requirements", () => {
    const unmet = unmetHardRequirements(IN_BUDGET, [
      mechanical,
      { attribute: "connectivity", operator: "EQUALS", value: "bluetooth" },
    ]);
    expect(unmet.map((requirement) => requirement.attribute)).toEqual(["connectivity"]);
  });
});

describe("no-match reasons come from the catalog", () => {
  it("reports an empty catalog result", () => {
    expect(deriveNoMatchReasons([], BUDGET_300000)).toEqual(["EMPTY_CATALOG_RESULT"]);
  });

  it("reports that nothing was within budget", () => {
    expect(deriveNoMatchReasons([OVER_BUDGET], BUDGET_300000)).toEqual([
      "NO_PRODUCT_WITHIN_BUDGET",
    ]);
  });

  it("reports an unmet required attribute", () => {
    expect(
      deriveNoMatchReasons([IN_BUDGET], {
        ...BUDGET_300000,
        hardRequirements: [
          { attribute: "connectivity", operator: "EQUALS", value: "bluetooth" },
        ],
      }),
    ).toEqual(["NO_PRODUCT_WITH_REQUIRED_ATTRIBUTE"]);
  });

  it("reports that nothing is in stock", () => {
    const outOfStock = productDto({
      id: "01930000-0000-7000-8000-00000000d001",
      availability: { status: "OUT_OF_STOCK", quantity: 0, purchasable: false },
    });
    expect(deriveNoMatchReasons([outOfStock], BUDGET_300000)).toEqual([
      "NO_PRODUCT_IN_STOCK",
    ]);
  });
});

describe("intent schema", () => {
  it("rejects a fractional quantity", () => {
    const result = structuredPurchaseIntentSchema.safeParse({
      requestType: "PURCHASE",
      productQuery: "keyboard",
      category: null,
      quantity: 1.5,
      budget: null,
      hardRequirements: [],
      softPreferences: [],
      needsClarification: false,
      clarificationQuestion: null,
    });
    expect(result.success).toBe(false);
  });

  for (const quantity of [0, -1, 999]) {
    it(`rejects a quantity of ${String(quantity)}`, () => {
      const result = structuredPurchaseIntentSchema.safeParse({
        requestType: "PURCHASE",
        productQuery: "keyboard",
        category: null,
        quantity,
        budget: null,
        hardRequirements: [],
        softPreferences: [],
        needsClarification: false,
        clarificationQuestion: null,
      });
      expect(result.success).toBe(false);
    });
  }

  it("rejects a decimal budget amount", () => {
    const result = structuredPurchaseIntentSchema.safeParse({
      requestType: "PURCHASE",
      productQuery: "keyboard",
      category: null,
      quantity: 1,
      budget: {
        maxAmountMinor: "3000.00",
        currency: "INR",
        explicit: true,
        scope: null,
        sourceText: "under 3000",
      },
      hardRequirements: [],
      softPreferences: [],
      needsClarification: false,
      clarificationQuestion: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported currency", () => {
    const result = structuredPurchaseIntentSchema.safeParse({
      requestType: "PURCHASE",
      productQuery: "keyboard",
      category: null,
      quantity: 1,
      budget: {
        maxAmountMinor: "300000",
        currency: "USD",
        explicit: true,
        scope: null,
        sourceText: "under $3000",
      },
      hardRequirements: [],
      softPreferences: [],
      needsClarification: false,
      clarificationQuestion: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown request type", () => {
    const result = structuredPurchaseIntentSchema.safeParse({
      requestType: "STEAL",
      productQuery: "keyboard",
      category: null,
      quantity: 1,
      budget: null,
      hardRequirements: [],
      softPreferences: [],
      needsClarification: false,
      clarificationQuestion: null,
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Regressions found by the live Gemini smoke test.
 *
 * Both were invisible to the in-memory fakes, which always produced complete,
 * well-formed payloads. A real model does neither reliably, which is exactly
 * why the one live call earns its place.
 */
describe("regressions from the live provider", () => {
  it("accepts an intent whose optional fields are omitted rather than null", () => {
    // Gemini omits a field that is not in the schema's `required` list. That is
    // correct JSON Schema behaviour; the validator used to reject it.
    const parsed = structuredPurchaseIntentSchema.safeParse({
      requestType: "PURCHASE",
      productQuery: "mechanical keyboard",
      quantity: 1,
      hardRequirements: [],
      softPreferences: [],
      needsClarification: false,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Absent is normalised to null, so downstream code has one case to handle.
    expect(parsed.data.category).toBeNull();
    expect(parsed.data.budget).toBeNull();
    expect(parsed.data.clarificationQuestion).toBeNull();
  });

  /**
   * Every bound the runtime enforces must also be stated to the provider.
   *
   * The observed failure: the model returned a clarification question longer
   * than the runtime cap and the whole request died as
   * AI_PROVIDER_INVALID_RESPONSE. The provider schema declared no length at
   * all, so the model was being judged against a limit it was never given.
   * The other fields had the same silent gap and had simply not been hit yet.
   *
   * Each case asserts the declared bound *equals the runtime constant* rather
   * than a literal. That is what makes these regression tests: changing a
   * runtime limit without telling the provider fails here.
   */
  const properties = INTENT_RESPONSE_JSON_SCHEMA.properties;

  const baseIntent = {
    requestType: "PURCHASE" as const,
    productQuery: "keyboard",
    quantity: 1,
    hardRequirements: [],
    softPreferences: [],
    needsClarification: false,
  };

  const text = (length: number): string => "a".repeat(length);
  const constraints = (count: number): { attribute: string; operator: string }[] =>
    Array.from({ length: count }, (_, index) => ({
      attribute: `attr${String(index)}`,
      operator: "EQUALS",
      value: "x",
    })) as { attribute: string; operator: string }[];

  const cases = [
    {
      field: "productQuery",
      limit: MAX_PRODUCT_QUERY_LENGTH,
      declared: properties.productQuery.maxLength,
      atLimit: { ...baseIntent, productQuery: text(MAX_PRODUCT_QUERY_LENGTH) },
      overLimit: { ...baseIntent, productQuery: text(MAX_PRODUCT_QUERY_LENGTH + 1) },
    },
    {
      field: "category",
      limit: MAX_CATEGORY_LENGTH,
      declared: properties.category.maxLength,
      atLimit: { ...baseIntent, category: text(MAX_CATEGORY_LENGTH) },
      overLimit: { ...baseIntent, category: text(MAX_CATEGORY_LENGTH + 1) },
    },
    {
      field: "clarificationQuestion",
      limit: MAX_CLARIFICATION_QUESTION_LENGTH,
      declared: properties.clarificationQuestion.maxLength,
      atLimit: {
        ...baseIntent,
        needsClarification: true,
        clarificationQuestion: text(MAX_CLARIFICATION_QUESTION_LENGTH),
      },
      overLimit: {
        ...baseIntent,
        needsClarification: true,
        clarificationQuestion: text(MAX_CLARIFICATION_QUESTION_LENGTH + 1),
      },
    },
    {
      field: "hardRequirements",
      limit: MAX_HARD_REQUIREMENTS,
      declared: properties.hardRequirements.maxItems,
      atLimit: { ...baseIntent, hardRequirements: constraints(MAX_HARD_REQUIREMENTS) },
      overLimit: {
        ...baseIntent,
        hardRequirements: constraints(MAX_HARD_REQUIREMENTS + 1),
      },
    },
    {
      field: "softPreferences",
      limit: MAX_SOFT_PREFERENCES,
      declared: properties.softPreferences.maxItems,
      atLimit: { ...baseIntent, softPreferences: constraints(MAX_SOFT_PREFERENCES) },
      overLimit: {
        ...baseIntent,
        softPreferences: constraints(MAX_SOFT_PREFERENCES + 1),
      },
    },
  ];

  for (const testCase of cases) {
    it(`states the ${testCase.field} bound to the provider and enforces it`, () => {
      expect(testCase.declared).toBe(testCase.limit);
      // Exactly at the bound is allowed - the limit is inclusive, and a fix
      // that quietly tightened it would be a change to runtime behaviour.
      expect(
        structuredPurchaseIntentSchema.safeParse(testCase.atLimit).success,
        "at the bound",
      ).toBe(true);
      // One past it is still refused, so nothing was loosened.
      expect(
        structuredPurchaseIntentSchema.safeParse(testCase.overLimit).success,
        "one over the bound",
      ).toBe(false);
    });
  }

  /**
   * The same bounds, one level down.
   *
   * `budget` and each constraint are nested objects, which is the only reason
   * they were missed when the top-level fields were aligned. The drift is
   * identical in kind and so is the consequence.
   */
  const budgetProperties = properties.budget.properties;
  const constraintProperties = properties.hardRequirements.items.properties;

  const withBudget = (sourceText: string) => ({
    ...baseIntent,
    productQuery: "keyboard",
    budget: {
      maxAmountMinor: "300000",
      currency: "INR",
      explicit: true,
      sourceText,
    },
  });

  const withConstraint = (attribute: string, value: string) => ({
    ...baseIntent,
    hardRequirements: [{ attribute, operator: "EQUALS", value }],
  });

  const nestedCases = [
    {
      field: "budget.sourceText",
      limit: MAX_BUDGET_SOURCE_TEXT_LENGTH,
      declared: budgetProperties.sourceText.maxLength,
      atLimit: withBudget(text(MAX_BUDGET_SOURCE_TEXT_LENGTH)),
      overLimit: withBudget(text(MAX_BUDGET_SOURCE_TEXT_LENGTH + 1)),
    },
    {
      field: "constraint.attribute",
      limit: MAX_ATTRIBUTE_NAME_LENGTH,
      declared: constraintProperties.attribute.maxLength,
      // Attribute names are identifiers, so the boundary string has to be a
      // legal one - padding with 'a' keeps it inside the identifier pattern.
      atLimit: withConstraint(text(MAX_ATTRIBUTE_NAME_LENGTH), "x"),
      overLimit: withConstraint(text(MAX_ATTRIBUTE_NAME_LENGTH + 1), "x"),
    },
    {
      field: "constraint.value",
      limit: MAX_ATTRIBUTE_VALUE_LENGTH,
      declared: constraintProperties.value.maxLength,
      atLimit: withConstraint("layout", text(MAX_ATTRIBUTE_VALUE_LENGTH)),
      overLimit: withConstraint("layout", text(MAX_ATTRIBUTE_VALUE_LENGTH + 1)),
    },
  ];

  for (const testCase of nestedCases) {
    it(`states the ${testCase.field} bound to the provider and enforces it`, () => {
      expect(testCase.declared).toBe(testCase.limit);
      expect(
        structuredPurchaseIntentSchema.safeParse(testCase.atLimit).success,
        "at the bound",
      ).toBe(true);
      expect(
        structuredPurchaseIntentSchema.safeParse(testCase.overLimit).success,
        "one over the bound",
      ).toBe(false);
    });
  }

  /**
   * Bounds that are neither lengths nor counts.
   *
   * A numeric range and two regexes, each enforced at runtime and previously
   * not stated to the provider at all. They fail the same way as the length
   * bounds did - the model emits something the contract permitted and the
   * runtime refuses it - so they are tested the same way.
   */
  it("states the quantity range to the provider and enforces it", () => {
    expect(properties.quantity.minimum).toBe(MIN_QUANTITY);
    expect(properties.quantity.maximum).toBe(MAX_QUANTITY);

    const withQuantity = (quantity: number) => ({ ...baseIntent, quantity });
    for (const quantity of [MIN_QUANTITY, MAX_QUANTITY]) {
      expect(
        structuredPurchaseIntentSchema.safeParse(withQuantity(quantity)).success,
        `at the bound: ${String(quantity)}`,
      ).toBe(true);
    }
    for (const quantity of [MIN_QUANTITY - 1, MAX_QUANTITY + 1]) {
      expect(
        structuredPurchaseIntentSchema.safeParse(withQuantity(quantity)).success,
        `outside the bound: ${String(quantity)}`,
      ).toBe(false);
    }
  });

  it("states the attribute-name pattern to the provider and enforces it", () => {
    // Compared as source, because that is the only form JSON Schema can carry
    // and therefore the only place the two can disagree.
    expect(constraintProperties.attribute.pattern).toBe(ATTRIBUTE_NAME_PATTERN.source);

    for (const attribute of ["layout", "keySwitch", "switch_type", "a"]) {
      expect(
        structuredPurchaseIntentSchema.safeParse(withConstraint(attribute, "x")).success,
        attribute,
      ).toBe(true);
    }
    // Leading digit, punctuation, spaces and emptiness are all refused - an
    // attribute name is an identifier, not free text.
    for (const attribute of ["1layout", "key-switch", "key switch", "_layout", ""]) {
      expect(
        structuredPurchaseIntentSchema.safeParse(withConstraint(attribute, "x")).success,
        attribute,
      ).toBe(false);
    }
  });

  it("states the maxAmountMinor pattern to the provider and enforces it", () => {
    expect(budgetProperties.maxAmountMinor.pattern).toBe(MAX_AMOUNT_MINOR_PATTERN.source);

    const withAmount = (maxAmountMinor: string) => ({
      ...baseIntent,
      budget: {
        maxAmountMinor,
        currency: "INR",
        explicit: true,
        sourceText: "under 3000",
      },
    });
    for (const amount of ["1", "300000", "999999999999999"]) {
      expect(
        structuredPurchaseIntentSchema.safeParse(withAmount(amount)).success,
        amount,
      ).toBe(true);
    }
    // A decimal is the failure this pattern exists to stop: "3000.00" read as
    // minor units is a hundredfold error in the field that caps spending.
    for (const amount of ["3000.00", "-1", "1e5", "", "1234567890123456", "₹3000"]) {
      expect(
        structuredPurchaseIntentSchema.safeParse(withAmount(amount)).success,
        amount,
      ).toBe(false);
    }
  });

  it("declares the same constraint bounds in both requirement arrays", () => {
    // The two arrays hold the same shape. Declaring a bound on one and not the
    // other would leave exactly the gap this whole block exists to close.
    expect(properties.softPreferences.items.properties).toEqual(
      properties.hardRequirements.items.properties,
    );
  });

  it("states the minimum length of productQuery to the provider", () => {
    // An empty productQuery would search the catalog for nothing at all.
    expect(properties.productQuery.minLength).toBe(1);
    expect(
      structuredPurchaseIntentSchema.safeParse({ ...baseIntent, productQuery: "" })
        .success,
    ).toBe(false);
  });

  it("notices a stated ceiling the model failed to report", () => {
    // The observed failure: asked about "under ₹3000", the model returned no
    // budget and did not flag ambiguity. Without this the agent would shop with
    // no ceiling at all.
    for (const message of [
      "Find me a mechanical keyboard under ₹3000 and buy it.",
      "Buy a keyboard, max 3000 rupees.",
      "I need a keyboard, don't spend more than 3k.",
      "keyboard below 2999",
      "budget is 3000 for a keyboard",
      "get me one up to ₹2,500",
    ]) {
      expect(messageStatesACeiling(message), message).toBe(true);
    }
  });

  it("does not see a ceiling where none was stated", () => {
    for (const message of [
      "Buy me a cheap keyboard.",
      "Recommend a good mechanical keyboard.",
      "Show me what you have.",
      "I want a keyboard with 87 keys",
    ]) {
      expect(messageStatesACeiling(message), message).toBe(false);
    }
  });
});
