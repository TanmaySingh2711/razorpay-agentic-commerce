import { z } from "zod";
import { DomainRuleError, ValidationError } from "@/domain/errors";

/**
 * Money, as integer minor units plus an explicit currency.
 *
 * Invariant 18 of the system: no float ever represents an amount. ₹299.00 is
 * `{ minorUnits: 29900, currency: "INR" }`. Razorpay's API also speaks in
 * paise, so this representation is what leaves the system unchanged, with no
 * rounding step between the authoritative price and the charged amount.
 *
 * Currency is stored, never inferred, so a future multi-currency merchant
 * cannot silently add rupees to dollars.
 */
export const SUPPORTED_CURRENCIES = ["INR"] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Digits after the decimal point when a currency is displayed. */
const MINOR_UNIT_EXPONENT: Record<CurrencyCode, number> = { INR: 2 };

const CURRENCY_SYMBOL: Record<CurrencyCode, string> = { INR: "₹" };

export interface Money {
  readonly minorUnits: number;
  readonly currency: CurrencyCode;
}

export const currencyCodeSchema = z.enum(SUPPORTED_CURRENCIES);

export const moneySchema = z.object({
  minorUnits: z.int(),
  currency: currencyCodeSchema,
});

/** Constructs money, rejecting anything that is not a safe integer. */
export function money(minorUnits: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new ValidationError({
      code: "MONEY_NOT_INTEGER",
      message: `Money must be a safe integer number of minor units, received ${String(minorUnits)}.`,
      details: { currency },
    });
  }
  return { minorUnits, currency };
}

export function zeroMoney(currency: CurrencyCode): Money {
  return { minorUnits: 0, currency };
}

function assertSameCurrency(left: Money, right: Money, operation: string): void {
  if (left.currency !== right.currency) {
    throw new DomainRuleError({
      code: "MONEY_CURRENCY_MISMATCH",
      message: `Cannot ${operation} amounts in ${left.currency} and ${right.currency}.`,
      details: { operation, left: left.currency, right: right.currency },
    });
  }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right, "add");
  return money(left.minorUnits + right.minorUnits, left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right, "subtract");
  return money(left.minorUnits - right.minorUnits, left.currency);
}

/** Multiplies a unit price by an integer quantity. Quantities are never fractional. */
export function multiplyMoney(amount: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new ValidationError({
      code: "MONEY_INVALID_QUANTITY",
      message: `Quantity must be a non-negative safe integer, received ${String(quantity)}.`,
    });
  }
  return money(amount.minorUnits * quantity, amount.currency);
}

/** Returns -1, 0 or 1. Throws on currency mismatch rather than guessing. */
export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right, "compare");
  if (left.minorUnits < right.minorUnits) return -1;
  if (left.minorUnits > right.minorUnits) return 1;
  return 0;
}

export function isMoneyWithinBudget(amount: Money, budget: Money): boolean {
  return compareMoney(amount, budget) <= 0;
}

export function isNonNegativeMoney(amount: Money): boolean {
  return amount.minorUnits >= 0;
}

/**
 * Display formatting. Built with integer string arithmetic so no float is ever
 * introduced, not even transiently for presentation.
 */
export function formatMoney(amount: Money): string {
  const exponent = MINOR_UNIT_EXPONENT[amount.currency];
  const negative = amount.minorUnits < 0;
  const digits = Math.abs(amount.minorUnits)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  const body = exponent === 0 ? whole : `${whole}.${fraction}`;
  return `${negative ? "-" : ""}${CURRENCY_SYMBOL[amount.currency]}${body}`;
}

/**
 * Parses a human/major-unit string such as "3000" or "2999.50" into minor
 * units. Used only at the edges (e.g. a budget typed by a human); authoritative
 * prices are always stored as minor units and never pass through here.
 */
export function parseMajorUnits(input: string, currency: CurrencyCode): Money {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (match === null) {
    throw new ValidationError({
      code: "MONEY_UNPARSEABLE",
      message: "Amount must be a plain decimal number.",
      details: { currency },
    });
  }
  const exponent = MINOR_UNIT_EXPONENT[currency];
  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2] ?? "0";
  const rawFraction = match[3] ?? "";
  if (rawFraction.length > exponent) {
    throw new ValidationError({
      code: "MONEY_TOO_PRECISE",
      message: `${currency} supports at most ${String(exponent)} decimal places.`,
      details: { currency },
    });
  }
  const fraction = rawFraction.padEnd(exponent, "0");
  return money(sign * Number(`${whole}${fraction}`), currency);
}

/**
 * BigInt boundary.
 *
 * PostgreSQL stores every authoritative amount as BIGINT, which Prisma surfaces
 * as a JavaScript `bigint`. The domain `Money` type uses `number`, guarded by
 * `Number.isSafeInteger`. These two functions are the only sanctioned crossing
 * between them, and the conversion is *checked*, never blind.
 *
 * The range is not a practical constraint: `Number.MAX_SAFE_INTEGER` paise is
 * roughly ninety trillion rupees. But an unchecked `Number(bigint)` would
 * silently round past that instead of failing, and silently wrong money is the
 * one outcome this system may never produce - so the check exists and throws.
 */
export function moneyFromBigInt(minorUnits: bigint, currency: CurrencyCode): Money {
  if (
    minorUnits > BigInt(Number.MAX_SAFE_INTEGER) ||
    minorUnits < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new ValidationError({
      code: "MONEY_EXCEEDS_SAFE_RANGE",
      message: `Stored amount ${minorUnits.toString()} exceeds the safe integer range and cannot be represented without precision loss.`,
      details: { currency },
    });
  }
  return money(Number(minorUnits), currency);
}

/** Converts domain money to the BIGINT representation the database expects. */
export function moneyToBigInt(amount: Money): bigint {
  return BigInt(amount.minorUnits);
}

/**
 * Wire representation of an amount.
 *
 * `JSON.stringify` throws on a `bigint`, and a JSON number would lose precision
 * at the top of the range, so amounts cross the API boundary as a decimal
 * *string* of minor units. The field is named `amountMinor`, never `amount`, so
 * a consumer cannot mistake paise for rupees.
 */
export interface MoneyDto {
  readonly amountMinor: string;
  readonly currency: CurrencyCode;
}

export const moneyDtoSchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/, "amountMinor must be an integer string"),
  currency: currencyCodeSchema,
});

export function toMoneyDto(amount: Money): MoneyDto {
  return { amountMinor: amount.minorUnits.toString(), currency: amount.currency };
}

export function fromMoneyDto(dto: MoneyDto): Money {
  const parsed = moneyDtoSchema.safeParse(dto);
  if (!parsed.success) {
    throw new ValidationError({
      code: "MONEY_DTO_INVALID",
      message: "Money DTO did not match the expected shape.",
    });
  }
  return moneyFromBigInt(BigInt(parsed.data.amountMinor), parsed.data.currency);
}
