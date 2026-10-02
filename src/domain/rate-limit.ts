import { createHash } from "node:crypto";

/**
 * Fixed-window rate limiting, as pure rules.
 *
 * Everything that decides *whether* a request is over a limit lives here, with
 * no clock and no database, so every boundary - the last millisecond of a
 * window, the first of the next, a header that lies - can be tested exactly.
 * `src/services/rate-limit-service.ts` supplies the time and the
 * counter; this module supplies the arithmetic.
 *
 * ## Why fixed windows
 *
 * A fixed window can admit up to twice its limit across a boundary (the end of
 * one minute and the start of the next). For this purpose that is fine: the
 * limits exist to stop quota exhaustion and hammering, not to meter a paid API
 * to the request, and a fixed window costs one atomic upsert per check where a
 * sliding log would cost a row per request. The daily ceilings bound the total
 * regardless of where the minute boundaries fall.
 */

export interface RateLimitRule {
  /** Stable, short, and part of the stored bucket key. */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export const MINUTE_SECONDS = 60;
export const DAY_SECONDS = 86_400;

/**
 * How long a window row is worth keeping. Twice the longest window, so a
 * window is never pruned while it can still be the current one.
 */
export const RETENTION_SECONDS = DAY_SECONDS * 2;

/** The start of the window `now` falls in, aligned to the Unix epoch. */
export function windowStartOf(now: Date, windowSeconds: number): Date {
  const windowMs = windowSeconds * 1_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Whole seconds until the current window ends - what a `Retry-After` header
 * should say. Never zero: a client told to retry in zero seconds retries now.
 */
export function secondsUntilWindowEnds(now: Date, windowSeconds: number): number {
  const end = windowStartOf(now, windowSeconds).getTime() + windowSeconds * 1_000;
  return Math.max(1, Math.ceil((end - now.getTime()) / 1_000));
}

/** Whether a counter that has just been incremented to `hits` is over the rule. */
export function isOverLimit(hits: number, rule: RateLimitRule): boolean {
  return hits > rule.limit;
}

/** The stored bucket key for one rule and one subject. */
export function bucketKey(scope: string, rule: RateLimitRule, subject: string): string {
  return `${scope}:${rule.name}:${subject}`;
}

/** The subject every client shares, for deployment-wide ceilings. */
export const GLOBAL_SUBJECT = "global";

/**
 * A stable, anonymous identity for the caller.
 *
 * Read from the headers the hosting platform sets. Vercel overwrites both
 * `x-real-ip` and `x-forwarded-for` at its edge, so a client cannot choose its
 * own bucket there; behind a proxy that does not, a caller could rotate the
 * header, which is exactly why a deployment-wide daily ceiling exists beside
 * the per-client ones.
 *
 * The address is hashed before it goes anywhere near storage. The limiter
 * needs "the same caller as before", not "who the caller is", and a digest
 * answers the first without keeping the second. A request with no address at
 * all shares one bucket with every other such request - which fails towards
 * *more* limiting, never less.
 */
export function clientKeyFromHeaders(headers: Pick<Headers, "get">): string {
  const realIp = headers.get("x-real-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address =
    realIp !== undefined && realIp.length > 0
      ? realIp
      : forwarded !== undefined && forwarded.length > 0
        ? forwarded
        : "unknown";
  return createHash("sha256")
    .update(`agentic-commerce:rate-limit:v1:${address.slice(0, 64)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
