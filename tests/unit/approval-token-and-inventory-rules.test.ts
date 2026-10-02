import { readFileSync } from "node:fs";
import { describeReservationRefusal, RESERVATION_REFUSALS } from "@/domain/inventory";
import { describe, expect, it } from "vitest";
import {
  approvalTokenMatches,
  hashApprovalToken,
  issueApprovalToken,
  NONCE_HASH_LENGTH,
} from "@/domain/approval/token";

/**
 * The pure pieces of Objective 8: the approval credential, and what a refused
 * stock hold tells the buyer.
 *
 * Neither needs a database. The stock arithmetic itself is enforced by atomic
 * SQL in the reservation service and is proved against PostgreSQL in
 * `tests/db/approval-and-reservation.test.ts`.
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

describe("what a refused hold tells the person who pressed the button", () => {
  /**
   * A refusal that only says "could not be held" reads, on a payment screen, as
   * "something happened to my money". Every sentence here therefore answers
   * both questions - what happened, and whether anything was charged - and the
   * two recoverable cases point at the next step rather than stopping.
   */
  it("describes every refusal in the vocabulary, with no gaps", () => {
    for (const refusal of RESERVATION_REFUSALS) {
      const sentence = describeReservationRefusal(refusal);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).toMatch(/[.!]$/);
      // No refusal may imply a charge occurred.
      expect(sentence).not.toMatch(/charged you|payment failed/i);
    }
  });

  it("says plainly that nothing was charged", () => {
    for (const refusal of RESERVATION_REFUSALS) {
      expect(describeReservationRefusal(refusal)).toMatch(/nothing has been charged/i);
    }
  });

  it("offers a next step for the two refusals a new purchase can fix", () => {
    // Sold out and a lapsed price are both recoverable by starting again.
    expect(describeReservationRefusal("INSUFFICIENT_STOCK")).toMatch(
      /start a new purchase/i,
    );
    expect(describeReservationRefusal("QUOTE_NOT_USABLE")).toMatch(
      /start a new purchase/i,
    );
  });

  it("names sold-out stock as the ordinary thing it is, not a failure", () => {
    const sentence = describeReservationRefusal("INSUFFICIENT_STOCK");
    expect(sentence).toMatch(/sold out/i);
    // It must not blame the shopper or imply a defect.
    expect(sentence).not.toMatch(/error|invalid|failed/i);
  });
});
