import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOG_LIMIT,
  DEFAULT_CATALOG_SORT,
  MAX_ATTRIBUTE_FILTERS,
  MAX_CATALOG_LIMIT,
  parseCatalogQuery,
  parseProductId,
} from "@/domain/catalog/query";
import { AppError } from "@/domain/errors";

/**
 * The query contract, tested as a boundary.
 *
 * Everything here runs before the database is touched. The catalog accepts a
 * small, closed set of parameters, and this suite is what proves the set is
 * actually closed - that a caller cannot smuggle in a filter, a price, or an
 * unbounded request, and that a mistyped budget fails loudly instead of
 * quietly returning products the caller cannot afford.
 */

function parse(queryString: string) {
  return parseCatalogQuery(new URLSearchParams(queryString));
}

/** Asserts the query is refused with a specific machine-readable code. */
function expectRejected(queryString: string, code: string): void {
  let thrown: unknown;
  try {
    parse(queryString);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(code);
}

describe("defaults", () => {
  it("resolves an empty query to bounded, deterministic defaults", () => {
    const query = parse("");
    expect(query).toEqual({
      attributes: [],
      sort: DEFAULT_CATALOG_SORT,
      limit: DEFAULT_CATALOG_LIMIT,
      offset: 0,
    });
  });

  it("never leaves the page size unbounded", () => {
    expect(parse("").limit).toBeLessThanOrEqual(MAX_CATALOG_LIMIT);
  });
});

describe("unknown parameters", () => {
  it("rejects a parameter the contract does not define", () => {
    expectRejected("colour=black", "INVALID_QUERY");
  });

  it("rejects a mistyped budget rather than ignoring it", () => {
    // The dangerous case: silently dropping this would return products above
    // the caller's budget while they believe the filter applied.
    expectRejected("maxAmount=300000&currency=INR", "INVALID_QUERY");
  });

  it("refuses any attempt to state a product's price", () => {
    // There is no parameter for what a product costs, and there must not be.
    for (const attempt of ["price=1", "unitAmount=1", "amountMinor=1"]) {
      expectRejected(attempt, "INVALID_QUERY");
    }
  });

  it("refuses any attempt to state stock or status", () => {
    for (const attempt of ["inventory=99", "status=AVAILABLE", "purchasable=true"]) {
      expectRejected(attempt, "INVALID_QUERY");
    }
  });
});

describe("budget", () => {
  it("accepts whole minor units with an explicit currency", () => {
    const query = parse("maxAmountMinor=300000&currency=INR");
    expect(query.maxAmountMinor).toBe(300_000n);
    expect(query.currency).toBe("INR");
  });

  it("keeps the budget as a bigint, never a float", () => {
    expect(typeof parse("maxAmountMinor=300000&currency=INR").maxAmountMinor).toBe(
      "bigint",
    );
  });

  it("requires the currency to be explicit", () => {
    // No default: guessing is exactly how amounts get compared across currencies.
    expectRejected("maxAmountMinor=300000", "INVALID_QUERY");
  });

  it("rejects a currency this catalog does not quote", () => {
    expectRejected("maxAmountMinor=300000&currency=USD", "UNSUPPORTED_CURRENCY");
  });

  it("accepts a lowercase currency code", () => {
    expect(parse("maxAmountMinor=1&currency=inr").currency).toBe("INR");
  });

  const badBudgets = [
    ["negative", "-1"],
    ["a decimal", "2999.50"],
    ["scientific notation", "1e6"],
    ["a thousands separator", "3,00,000"],
    ["a leading plus", "+300000"],
    ["hexadecimal", "0x100"],
    ["whitespace", " 300000 "],
    ["empty", ""],
    ["a word", "cheap"],
    ["sixteen digits", "1234567890123456"],
  ] as const;

  for (const [label, value] of badBudgets) {
    it(`rejects ${label}`, () => {
      expectRejected(
        `maxAmountMinor=${encodeURIComponent(value)}&currency=INR`,
        "INVALID_QUERY",
      );
    });
  }
});

describe("category", () => {
  it("accepts a slug", () => {
    expect(parse("category=mechanical-keyboard").category).toBe("mechanical-keyboard");
  });

  const badCategories = [
    ["SQL-shaped input", "'; DROP TABLE product; --"],
    ["a script tag", "<script>alert(1)</script>"],
    ["a percent wildcard", "%"],
    ["a null byte", "keyboard\u0000"],
    ["confusable Unicode", "keyboaｒd"],
    ["a right-to-left override", "keyboard‮"],
    ["an over-long value", "x".repeat(200)],
    ["an empty value", ""],
  ] as const;

  for (const [label, value] of badCategories) {
    it(`rejects ${label}`, () => {
      expectRejected(`category=${encodeURIComponent(value)}`, "INVALID_QUERY");
    });
  }
});

describe("attribute filters", () => {
  it("reads a scalar string attribute", () => {
    expect(parse("attribute.switchType=linear-red").attributes).toEqual([
      { key: "switchType", value: "linear-red" },
    ]);
  });

  it("interprets booleans and numbers by the documented rules", () => {
    expect(parse("attribute.hotSwappable=true").attributes[0]?.value).toBe(true);
    expect(parse("attribute.hotSwappable=false").attributes[0]?.value).toBe(false);
    expect(parse("attribute.ratingScore=4.4").attributes[0]?.value).toBe(4.4);
    expect(parse("attribute.slots=87").attributes[0]?.value).toBe(87);
    expect(parse("attribute.layout=tkl-87").attributes[0]?.value).toBe("tkl-87");
  });

  it("accepts several attributes at once", () => {
    expect(
      parse("attribute.switchType=linear-red&attribute.layout=tkl-87").attributes,
    ).toHaveLength(2);
  });

  it("rejects the same attribute filtered twice", () => {
    // AND yields nothing, OR silently widens. Neither is a defensible guess.
    expectRejected(
      "attribute.layout=tkl-87&attribute.layout=compact-65",
      "INVALID_FILTER",
    );
  });

  it("rejects more filters than the bound allows", () => {
    const many = Array.from(
      { length: MAX_ATTRIBUTE_FILTERS + 1 },
      (_unused, index) => `attribute.key${String(index)}=v`,
    ).join("&");
    expectRejected(many, "INVALID_FILTER");
  });

  const badFilters = [
    ["an empty name", "attribute.=x"],
    ["a name starting with a digit", "attribute.1switch=x"],
    ["a dotted path", "attribute.a.b=x"],
    ["a JSON-shaped name", 'attribute.{"$ne":null}=x'],
    ["an over-long name", `attribute.${"k".repeat(60)}=x`],
    ["an empty value", "attribute.switchType="],
    ["an over-long value", `attribute.switchType=${"v".repeat(200)}`],
  ] as const;

  for (const [label, value] of badFilters) {
    it(`rejects ${label}`, () => {
      expectRejected(value, "INVALID_FILTER");
    });
  }

  it("accepts an unknown but well-formed attribute name", () => {
    // Documented behaviour: an attribute nobody has is a filter that matches
    // nothing, not an error. It does not reveal which keys exist.
    expect(parse("attribute.noSuchAttribute=x").attributes).toEqual([
      { key: "noSuchAttribute", value: "x" },
    ]);
  });
});

describe("paging and ordering", () => {
  it("accepts bounded paging", () => {
    const query = parse("limit=10&offset=20");
    expect(query.limit).toBe(10);
    expect(query.offset).toBe(20);
  });

  for (const bad of ["limit=0", "limit=101", "limit=-5", "limit=1.5", "limit=abc"]) {
    it(`rejects ${bad}`, () => {
      expectRejected(bad, "INVALID_QUERY");
    });
  }

  for (const bad of ["offset=-1", "offset=1000000", "offset=x"]) {
    it(`rejects ${bad}`, () => {
      expectRejected(bad, "INVALID_QUERY");
    });
  }

  it("accepts every declared sort order", () => {
    for (const sort of ["updated_desc", "amount_asc", "amount_desc", "name_asc"]) {
      expect(parse(`sort=${sort}`).sort).toBe(sort);
    }
  });

  it("rejects an undeclared sort order", () => {
    expectRejected("sort=price", "INVALID_QUERY");
    expectRejected("sort=unitAmount%20DESC%3B%20DROP%20TABLE%20product", "INVALID_QUERY");
  });
});

describe("product id", () => {
  it("accepts a UUID", () => {
    const id = "01930000-0000-7000-8000-0000000000c1";
    expect(parseProductId(id)).toBe(id);
  });

  const badIds = [
    "not-a-uuid",
    "",
    "1",
    "01930000-0000-7000-8000-0000000000c1 OR 1=1",
    "'; DROP TABLE product; --",
    "../../etc/passwd",
    "01930000-0000-7000-8000-0000000000c1extra",
    "x".repeat(500),
  ];

  for (const id of badIds) {
    it(`rejects ${JSON.stringify(id.slice(0, 40))}`, () => {
      let thrown: unknown;
      try {
        parseProductId(id);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("INVALID_PRODUCT_ID");
    });
  }
});

describe("error responses stay safe", () => {
  it("never echoes an unbounded caller value back to the client", () => {
    let thrown: unknown;
    try {
      parse(`${"z".repeat(500)}=1`);
    } catch (error) {
      thrown = error;
    }
    const publicMessage = (thrown as AppError).toPublicPayload().message;
    expect(publicMessage.length).toBeLessThan(200);
  });
});
