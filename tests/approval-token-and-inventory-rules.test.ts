import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  approvalTokenMatches,
  hashApprovalToken,
  issueApprovalToken,
  NONCE_HASH_LENGTH,
} from "@/domain/approval/token";
import {
  canReserve,
  isReservationExpired,
  reservableQuantity,
} from "@/domain/inventory/rules";

/**
 * The two pure pieces of Objective 8: the approval credential, and the
 * arithmetic of what is left in stock.
 *
 * Neither needs a database, and both are where the objective's guarantees
 * actually live - a token that is guessable or an availability sum that is off
 * by one cannot be rescued by anything downstream.
 */

describe("the approval token", () => {
  it("carries 256 bits of randomness", () => {
    const { token } = issueApprovalToken();
    // 32 bytes, base64url, unpadded.
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      seen.add(issueApprovalToken().token);
    }
    expect(seen.size).toBe(500);
  });

  it("is stored only as a fixed-length digest", () => {
    const { token, nonceHash } = issueApprovalToken();
    expect(nonceHash).toHaveLength(NONCE_HASH_LENGTH);
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
    // The digest must not contain the secret it stands for.
    expect(nonceHash).not.toContain(token);
  });

  it("accepts the right token and refuses everything else", () => {
    const { token, nonceHash } = issueApprovalToken();
    expect(approvalTokenMatches(token, nonceHash)).toBe(true);

    expect(approvalTokenMatches(issueApprovalToken().token, nonceHash)).toBe(false);
    expect(approvalTokenMatches("", nonceHash)).toBe(false);
    expect(approvalTokenMatches(`${token}x`, nonceHash)).toBe(false);
    // A truncated or malformed stored digest authorizes nothing either.
    expect(approvalTokenMatches(token, nonceHash.slice(0, 32))).toBe(false);
    expect(approvalTokenMatches(token, "")).toBe(false);
  });

  it("hashes deterministically, so a presented token can be found by index", () => {
    const { token, nonceHash } = issueApprovalToken();
    expect(hashApprovalToken(token)).toBe(nonceHash);
    expect(hashApprovalToken(token)).toBe(hashApprovalToken(token));
  });

  it("is generated from the cryptographic source, not Math.random", () => {
    // Asserted against the source: this is the one property that cannot be
    // observed from outside, because a weak generator still returns a string
    // that looks exactly like a strong one.
    const source = readFileSync("src/domain/approval/token.ts", "utf8");
    expect(source).toContain("randomBytes");
    expect(source).toContain("timingSafeEqual");

    // Comments are stripped first: this file explains at length why Math.random
    // must never be used here, and a test that could not tell an explanation
    // from a call would fail on its own documentation.
    const code = source
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith("*") &&
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("/*")
        );
      })
      .join("\n");
    expect(code).not.toMatch(/Math\.random\(/);
    expect(code).not.toMatch(/Date\.now\(/);
  });
});

describe("reservable stock", () => {
  it("is on-hand inventory minus what is already held", () => {
    expect(reservableQuantity(10, 0)).toBe(10);
    expect(reservableQuantity(10, 4)).toBe(6);
    expect(reservableQuantity(1, 1)).toBe(0);
  });

  it("never reports a negative figure", () => {
    // Should be unreachable - a CHECK constraint forbids it - but a negative
    // "available" would read as stock rather than as a broken row.
    expect(reservableQuantity(2, 5)).toBe(0);
  });

  it("permits a claim only when enough is genuinely free", () => {
    expect(canReserve(1, 0, 1, true)).toBe(true);
    expect(canReserve(1, 1, 1, true)).toBe(false);
    expect(canReserve(5, 3, 2, true)).toBe(true);
    expect(canReserve(5, 3, 3, true)).toBe(false);
  });

  it("refuses a product nobody may buy, however much is on the shelf", () => {
    expect(canReserve(100, 0, 1, false)).toBe(false);
  });

  it("refuses a nonsensical quantity", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(canReserve(100, 0, quantity, true)).toBe(false);
    }
  });
});

describe("the reservation expiry boundary", () => {
  const expiresAt = new Date("2026-07-01T10:00:00.000Z");

  it("is inclusive: at the stamped instant the hold is already over", () => {
    // The same boundary a quote uses. Two expiry rules differing by one
    // millisecond is a bug nobody finds until it is a disputed charge.
    expect(isReservationExpired(expiresAt, new Date(expiresAt.getTime() - 1))).toBe(
      false,
    );
    expect(isReservationExpired(expiresAt, expiresAt)).toBe(true);
    expect(isReservationExpired(expiresAt, new Date(expiresAt.getTime() + 1))).toBe(true);
  });
});
