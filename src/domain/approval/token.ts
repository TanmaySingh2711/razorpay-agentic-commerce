import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The approval token: the one bearer credential in this system.
 *
 * Whoever holds it can authorize a specific purchase, so it is treated the way
 * a password is treated - generated from a cryptographic source, never stored
 * in plaintext, and compared without leaking how nearly a guess matched.
 *
 * Three rules, and all three are enforceable by reading this file:
 *
 *  1. **The plaintext exists only in the reply that issues it.** It is returned
 *     once, to the human-facing flow, and never written to the database, a log,
 *     an audit event, a test assertion or this repository.
 *  2. **The database holds a digest.** `ApprovalRequest.nonceHash` is
 *     `CHAR(64)` - a SHA-256 hex digest - and unique. A dump of the approvals
 *     table therefore grants nobody the ability to approve anything.
 *  3. **Comparison is timing-safe.** A byte-by-byte `===` on a secret leaks its
 *     prefix to an attacker who can measure the reply, one character at a time.
 */

/**
 * 256 bits of cryptographically secure randomness.
 *
 * `crypto.randomBytes` draws from the operating system's CSPRNG.
 * `Math.random()` is explicitly not used and must never be: it is a fast
 * statistical generator with a recoverable internal state, and an attacker who
 * observes a few outputs can predict the rest. Nor is anything derived from a
 * transaction id, quote id, counter or timestamp - all of them are guessable by
 * someone who has watched the system work.
 */
const TOKEN_BYTES = 32;

/** SHA-256 in hex. Fixed at 64 characters, which is what the column stores. */
export const NONCE_HASH_LENGTH = 64;

export interface IssuedApprovalToken {
  /**
   * The plaintext, base64url-encoded. Returned to the caller once and never
   * persisted. Do not log it, put it in audit metadata, or return it from any
   * read path.
   */
  readonly token: string;
  /** The SHA-256 digest, hex. This is the only form that reaches storage. */
  readonly nonceHash: string;
}

/** Mints a fresh single-use approval token and the digest to store for it. */
export function issueApprovalToken(): IssuedApprovalToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, nonceHash: hashApprovalToken(token) };
}

/**
 * The deterministic digest of a token.
 *
 * Plain SHA-256 with no salt and no work factor, deliberately. This is not a
 * password: it is 256 bits of uniform randomness, so there is no dictionary to
 * attack and nothing for a slow KDF to defend against - while the digest being
 * deterministic is what allows a presented token to be found by unique index
 * instead of by scanning every open approval.
 */
export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a presented token matches a stored digest, in constant time.
 *
 * The lookup that finds the candidate row is an ordinary index probe; this is
 * the check that actually decides. Comparing hex digests rather than raw tokens
 * means both sides are always the same length, so the comparison cannot fall
 * out early on a length mismatch and leak that much.
 */
export function approvalTokenMatches(token: string, storedHash: string): boolean {
  if (storedHash.length !== NONCE_HASH_LENGTH) return false;

  const presented = Buffer.from(hashApprovalToken(token), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (presented.length !== stored.length) return false;

  return timingSafeEqual(presented, stored);
}
