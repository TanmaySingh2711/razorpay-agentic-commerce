import { describe, expect, it } from "vitest";
import {
  JOURNEY_STEPS,
  awaitsProvider,
  buildJourney,
  describeState,
  formatDateTime,
  formatMoney,
  formatTime,
} from "@/domain/ui/journey";
import { TRANSACTION_STATES } from "@/domain/transaction/states";
import type { TransactionState } from "@/domain/transaction/states";

/**
 * What the interface says, tested without a browser.
 *
 * Every sentence a buyer reads about the state of their money is produced here,
 * so this is where those sentences are held to account. The properties worth
 * protecting are not visual - they are about honesty:
 *
 *  - a payment that has not settled must never be described as settled;
 *  - a purchase that stopped must never show later steps as complete;
 *  - no state may be left without a description, ever;
 *  - a price must never render as `NaN`.
 *
 * None of those need a DOM to check, and testing them here means they hold for
 * every page that renders a state rather than for whichever page a component
 * test happened to mount.
 */

describe("every state can be explained", () => {
  it("describes all seventeen states, with no gaps", () => {
    // A state added to the machine without a sentence would otherwise reach a
    // buyer as a blank space where an explanation of their money should be.
    for (const state of TRANSACTION_STATES) {
      const narrative = describeState(state);
      expect(narrative.label.length).toBeGreaterThan(0);
      expect(narrative.meaning.length).toBeGreaterThan(15);
      expect(narrative.meaning.trim()).toBe(narrative.meaning);
    }
  });

  it("never leaks an internal state name into what a buyer reads", () => {
    for (const state of TRANSACTION_STATES) {
      const { label, meaning } = describeState(state);
      expect(`${label} ${meaning}`).not.toMatch(/[A-Z]{4,}_[A-Z]/);
    }
  });

  it("keeps verification and capture as different claims", () => {
    // The single most expensive mistake a payment UI can make is to say "paid"
    // when it means "the message was authentic".
    const verified = describeState("PAYMENT_VERIFIED");
    expect(verified.meaning).toMatch(/not confirmed yet|waiting/i);
    expect(verified.tone).not.toBe("POSITIVE");

    const captured = describeState("PAYMENT_CAPTURED");
    expect(captured.meaning).toMatch(/confirmed/i);
    expect(captured.tone).toBe("POSITIVE");
  });

  it("says plainly that nothing was charged wherever that is true", () => {
    for (const state of ["PAYMENT_FAILED", "BLOCKED", "CANCELLED", "EXPIRED"] as const) {
      expect(describeState(state).meaning).toMatch(/no money|nothing was charged/i);
    }
  });

  it("marks only the two waiting states as waiting on the provider", () => {
    const waiting = TRANSACTION_STATES.filter((state) => awaitsProvider(state));
    expect([...waiting].sort()).toEqual(["PAYMENT_PENDING", "PAYMENT_VERIFIED"]);
  });
});

describe("the progress rail", () => {
  it("gives every state a place on the path", () => {
    for (const state of TRANSACTION_STATES) {
      const journey = buildJourney(state);
      expect(journey).toHaveLength(JOURNEY_STEPS.length);
      // Exactly one step is live, unless the purchase has finished or stopped.
      const live = journey.filter((step) => step.status === "CURRENT").length;
      const stopped = journey.filter((step) => step.status === "STOPPED").length;
      expect(live + stopped).toBeLessThanOrEqual(1);
    }
  });

  it("does not mark later steps done when a purchase was blocked", () => {
    // The failure this guards: an index-based progress bar that shows payment
    // and capture as complete because the state sits at the end of a list.
    const journey = buildJourney("BLOCKED");
    const payment = journey.find((step) => step.step === "PAYMENT");
    const capture = journey.find((step) => step.step === "CAPTURE");
    expect(payment?.status).toBe("UPCOMING");
    expect(capture?.status).toBe("UPCOMING");
    expect(journey.some((step) => step.status === "STOPPED")).toBe(true);
  });

  it("does not mark capture done merely because payment was verified", () => {
    const journey = buildJourney("PAYMENT_VERIFIED");
    expect(journey.find((step) => step.step === "CAPTURE")?.status).toBe("UPCOMING");
  });

  it("marks capture done once the provider has confirmed", () => {
    expect(
      buildJourney("PAYMENT_CAPTURED").find((s) => s.step === "CAPTURE")?.status,
    ).toBe("DONE");
  });

  it("shows a fresh purchase as barely started", () => {
    const journey = buildJourney("INTENT_RECEIVED");
    expect(journey[0]?.status).toBe("CURRENT");
    expect(journey.slice(1).every((step) => step.status === "UPCOMING")).toBe(true);
  });

  it("uses human labels rather than state names", () => {
    for (const step of buildJourney("QUOTE_CREATED")) {
      expect(step.label).not.toMatch(/_/);
      expect(step.label[0]).toBe(step.label[0]?.toUpperCase());
    }
  });
});

describe("money on screen", () => {
  it("renders rupees from minor units", () => {
    expect(formatMoney({ amountMinor: "279900", currency: "INR" })).toBe("₹2,799.00");
    expect(formatMoney({ amountMinor: "100", currency: "INR" })).toBe("₹1.00");
    expect(formatMoney({ amountMinor: "0", currency: "INR" })).toBe("₹0.00");
  });

  it("groups large amounts and keeps both decimal places", () => {
    expect(formatMoney({ amountMinor: "123456789", currency: "INR" })).toBe(
      "₹1,234,567.89",
    );
    expect(formatMoney({ amountMinor: "5", currency: "INR" })).toBe("₹0.05");
  });

  it("does not parse the amount into a float", () => {
    // The server keeps money as a bigint precisely so precision cannot be lost.
    // A value beyond Number.MAX_SAFE_INTEGER must still render exactly.
    expect(formatMoney({ amountMinor: "900719925474099100", currency: "INR" })).toBe(
      "₹9,007,199,254,740,991.00",
    );
  });

  it("never renders NaN when the amount is unreadable", () => {
    // A broken number on a payment screen must not look like a real one.
    for (const amountMinor of ["", "abc", "12.5", "1e3"]) {
      const rendered = formatMoney({ amountMinor, currency: "INR" });
      expect(rendered).not.toContain("NaN");
      expect(rendered).toContain("INR");
    }
  });

  it("keeps a negative amount negative", () => {
    expect(formatMoney({ amountMinor: "-2500", currency: "INR" })).toBe("-₹25.00");
  });
});

describe("the tone a state is shown in", () => {
  it("uses a negative tone for exactly the states where something went wrong", () => {
    const negative = TRANSACTION_STATES.filter(
      (state: TransactionState) => describeState(state).tone === "NEGATIVE",
    );
    expect([...negative].sort()).toEqual([
      "BLOCKED",
      "CANCELLED",
      "EXPIRED",
      "PAYMENT_FAILED",
    ]);
  });

  it("uses a positive tone only once money is confirmed", () => {
    const positive = TRANSACTION_STATES.filter(
      (state: TransactionState) => describeState(state).tone === "POSITIVE",
    );
    expect([...positive].sort()).toEqual(["COMPLETED", "PAYMENT_CAPTURED"]);
  });
});

describe("displayed times do not depend on where the server runs", () => {
  /**
   * The regression this locks down.
   *
   * These pages are server components, so the string a buyer reads is rendered
   * by the host. A Vercel function sets no `TZ`, so Node used UTC, and a quote
   * expiring at 2:46 pm in Delhi was shown to its owner as 9:16 am - a
   * five-and-a-half-hour error on a deadline they were expected to act before.
   *
   * The instant below is chosen so the two readings fall on either side of
   * noon: under UTC it reads "am", under India time "pm". A test that only
   * checked the shape of the string would pass in both worlds, so these assert
   * the actual clock reading.
   */
  const NINE_SIXTEEN_UTC = "2026-09-03T09:16:25.000Z";

  it("renders a deadline in India time, not the host's", () => {
    expect(formatDateTime(NINE_SIXTEEN_UTC)).toContain("2:46:25 pm");
    expect(formatDateTime(NINE_SIXTEEN_UTC)).not.toContain("9:16");
  });

  it("renders a timeline entry in India time, not the host's", () => {
    expect(formatTime(NINE_SIXTEEN_UTC)).toContain("2:46:25 pm");
    expect(formatTime(NINE_SIXTEEN_UTC)).not.toContain("9:16");
  });

  it("is stable whatever TZ the process was started with", () => {
    // Proves the zone comes from the formatter rather than the environment:
    // whatever this run inherited, the answer is the same one asserted above.
    const before = process.env["TZ"];
    try {
      for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
        process.env["TZ"] = zone;
        expect(formatDateTime(NINE_SIXTEEN_UTC), zone).toContain("2:46:25 pm");
      }
    } finally {
      if (before === undefined) delete process.env["TZ"];
      else process.env["TZ"] = before;
    }
  });

  it("shows an unparseable timestamp as itself rather than as Invalid Date", () => {
    // A broken date on a payment screen must not look like a real deadline.
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatTime("")).toBe("");
  });
});
