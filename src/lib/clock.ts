/**
 * The clock, as an injectable dependency.
 *
 * Quote expiry is a financial rule: after `expiresAt` the price it froze is no
 * longer a promise the merchant made. Testing that rule against the real system
 * clock would mean sleeping - which makes a suite slow, flaky, and unable to
 * test the one case that matters most, the exact boundary.
 *
 * So time is passed in rather than read from the ambient environment. The
 * production path uses `systemClock`; tests use `fixedClock` and advance it by
 * hand, which lets "one millisecond before expiry", "exactly at expiry" and
 * "one millisecond after" be three ordinary assertions.
 */
export interface Clock {
  now(): Date;
}

/** Reads the real system time. The only clock production code uses. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A clock frozen at an instant, movable on demand.
 *
 * `advance` returns the new time so a test can read it inline, and the clock is
 * mutable rather than replaced so a service holding a reference sees the
 * change - which is what makes "create a quote, jump past its expiry, validate
 * it" a three-line test.
 */
export interface MutableClock extends Clock {
  advanceMs(milliseconds: number): Date;
  set(instant: Date): Date;
}

export function fixedClock(instant: Date): MutableClock {
  let current = new Date(instant.getTime());
  return {
    now: () => new Date(current.getTime()),
    advanceMs(milliseconds: number): Date {
      current = new Date(current.getTime() + milliseconds);
      return new Date(current.getTime());
    },
    set(next: Date): Date {
      current = new Date(next.getTime());
      return new Date(current.getTime());
    },
  };
}
