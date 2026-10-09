import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AboutPage from "@/app/about/page";

/**
 * The `/about` page is static prose, but prose about a system's own
 * capabilities can go stale exactly like a doc can - and unlike `docs/`, this
 * page is what a reviewer visiting the deployed app actually reads. This test
 * exists because the page once claimed inventory commit and final completion
 * were "later objectives... not implemented here", well after both had
 * shipped and been proven in production. That is a regression this test
 * would have caught: the markup must never claim the system stops short of
 * work that has actually landed.
 */
describe("the /about page describes the system as it actually is", () => {
  const markup = renderToStaticMarkup(AboutPage());

  it("does not claim inventory commit or completion are unimplemented", () => {
    expect(markup).not.toMatch(/not implemented here/i);
    expect(markup).not.toMatch(/later objectives/i);
  });

  it("states the lifecycle reaches COMPLETED, not merely PAYMENT_CAPTURED", () => {
    expect(markup).toMatch(/COMPLETED/);
  });

  it("still draws the PAYMENT_VERIFIED vs PAYMENT_CAPTURED distinction", () => {
    expect(markup).toMatch(/PAYMENT_VERIFIED/);
    expect(markup).toMatch(/PAYMENT_CAPTURED/);
  });

  it("never claims the browser or the model can move money", () => {
    expect(markup).not.toMatch(/browser can (charge|capture|complete)/i);
  });

  it("is titled Architecture & Safety, the renamed destination of the homepage's CTA", () => {
    expect(markup).toMatch(/Architecture &amp; Safety/);
  });

  it("presents the seven safety decisions the demo-polish pass organised the page around", () => {
    for (const title of [
      "AI Boundary",
      "Trusted PurchaseQuote",
      "Policy &amp; Human Approval",
      "Inventory Reservation",
      "Razorpay Verification",
      "Failure &amp; Retry",
      "Audit &amp; State Machine",
    ]) {
      expect(markup).toContain(title);
    }
  });

  it("never lets the AI boundary card claim the model can decide policy or state", () => {
    expect(markup).toMatch(
      /cannot control price, authorization, payment, retries, or transaction state/,
    );
  });

  it("puts the product name above the page title, not below it", () => {
    // Regression for a deliberate reorder: "Razorpay Agentic Commerce" is the
    // product and must read first; "Architecture & Safety" is this page and
    // follows it - never the other way round.
    const productIndex = markup.indexOf("Razorpay Agentic Commerce");
    const titleIndex = markup.indexOf("Architecture &amp; Safety");
    expect(productIndex).toBeGreaterThan(-1);
    expect(titleIndex).toBeGreaterThan(-1);
    expect(productIndex).toBeLessThan(titleIndex);
  });

  it("does not repeat the Buildathon line here - the product name already identifies it", () => {
    expect(markup).not.toMatch(/Buildathon/i);
  });

  it("does not surface repo-oriented text like the docs/ path or the liveness endpoint", () => {
    expect(markup).not.toMatch(/Liveness endpoint/i);
    expect(markup).not.toMatch(/docs\//);
    expect(markup).not.toMatch(/api\/health/i);
  });

  it("styles the return link as a visible secondary action, not a bare text link", () => {
    expect(markup).toMatch(/<a class="secondary" href="\/">/);
  });
});
