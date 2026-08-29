import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  formatMoney,
  isMoneyWithinBudget,
  money,
  multiplyMoney,
  parseMajorUnits,
} from "@/domain/money";
import { DomainRuleError, ValidationError } from "@/domain/errors";

describe("money", () => {
  it("rejects non-integer amounts so no float can ever become a charge", () => {
    expect(() => money(299.5, "INR")).toThrow(ValidationError);
    expect(() => money(Number.NaN, "INR")).toThrow(ValidationError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, "INR")).toThrow(ValidationError);
  });

  it("adds without float drift on amounts that break naive decimal maths", () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in minor units it is exact.
    const total = addMoney(money(10, "INR"), money(20, "INR"));
    expect(total.minorUnits).toBe(30);
  });

  it("refuses to mix currencies rather than guessing", () => {
    const inr = money(1000, "INR");
    const foreign = { minorUnits: 1000, currency: "USD" } as unknown as typeof inr;
    expect(() => addMoney(inr, foreign)).toThrow(DomainRuleError);
    expect(() => compareMoney(inr, foreign)).toThrow(DomainRuleError);
  });

  it("evaluates a budget ceiling inclusively", () => {
    const budget = money(300000, "INR"); // ₹3000.00
    expect(isMoneyWithinBudget(money(299900, "INR"), budget)).toBe(true);
    expect(isMoneyWithinBudget(money(300000, "INR"), budget)).toBe(true);
    expect(isMoneyWithinBudget(money(300001, "INR"), budget)).toBe(false);
  });

  it("multiplies only by non-negative integer quantities", () => {
    expect(multiplyMoney(money(29900, "INR"), 3).minorUnits).toBe(89700);
    expect(() => multiplyMoney(money(29900, "INR"), 1.5)).toThrow(ValidationError);
    expect(() => multiplyMoney(money(29900, "INR"), -1)).toThrow(ValidationError);
  });

  it("formats minor units for display without touching floating point", () => {
    expect(formatMoney(money(29900, "INR"))).toBe("₹299.00");
    expect(formatMoney(money(5, "INR"))).toBe("₹0.05");
    expect(formatMoney(money(0, "INR"))).toBe("₹0.00");
    expect(formatMoney(money(-29900, "INR"))).toBe("-₹299.00");
  });

  it("parses human-entered major units and rejects excess precision", () => {
    expect(parseMajorUnits("3000", "INR").minorUnits).toBe(300000);
    expect(parseMajorUnits("2999.5", "INR").minorUnits).toBe(299950);
    expect(parseMajorUnits("2999.50", "INR").minorUnits).toBe(299950);
    expect(() => parseMajorUnits("2999.999", "INR")).toThrow(ValidationError);
    expect(() => parseMajorUnits("₹3000", "INR")).toThrow(ValidationError);
  });
});
