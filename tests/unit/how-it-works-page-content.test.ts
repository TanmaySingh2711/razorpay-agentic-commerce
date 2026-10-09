import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HowItWorksPage from "@/app/how-it-works/page";
import nextConfig from "../../next.config";

/**
 * `/how-it-works` is static prose and diagrams, but prose about a system's own
 * capabilities can go stale exactly like a doc can - and unlike `docs/`, this
 * page is what a reviewer visiting the deployed app actually reads.
 *
 * It took over the old `/about` page ("Architecture & Safety"), and every
 * claim that page was held to is held here. The first of them exists because
 * that page once claimed inventory commit and final completion were "later
 * objectives... not implemented here", well after both had shipped and been
 * proven in production: the markup must never claim the system stops short of
 * work that has actually landed.
 */
describe("the /how-it-works page describes the system as it actually is", () => {
  const markup = renderToStaticMarkup(HowItWorksPage());

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
    expect(markup).not.toMatch(/AI (executes|authorizes|approves|verifies)/i);
  });

  it("keeps the Architecture & Safety section the old /about page became", () => {
    expect(markup).toMatch(/Architecture &amp; Safety/);
    expect(markup).toMatch(/id="safety"/);
  });

  it("presents the seven safety decisions", () => {
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

  it("puts the product name above the section title, not below it", () => {
    const productIndex = markup.indexOf("Razorpay Agentic Commerce");
    const titleIndex = markup.indexOf("Architecture &amp; Safety");
    expect(productIndex).toBeGreaterThan(-1);
    expect(titleIndex).toBeGreaterThan(-1);
    expect(productIndex).toBeLessThan(titleIndex);
  });

  it("does not mention a competition", () => {
    expect(markup).not.toMatch(/Buildathon|hackathon/i);
  });

  it("keeps repo-oriented text like the docs/ path and the liveness endpoint out of the safety section", () => {
    // The design documents are deliberately linked further down, under "The
    // work behind it". The safety section - what the old /about page was -
    // stays free of repository detail.
    const safety = markup.slice(
      markup.indexOf('id="safety"'),
      markup.indexOf('id="work"'),
    );
    expect(safety.length).toBeGreaterThan(500);
    expect(safety).not.toMatch(/Liveness endpoint/i);
    expect(safety).not.toMatch(/docs\//);
    expect(markup).not.toMatch(/api\/health/i);
  });

  it("offers the way back and the way forward as visible controls", () => {
    expect(markup).toMatch(/<a class="secondary" href="\/">/);
    expect(markup).toMatch(/<a class="primary" href="\/shop">/);
  });
});

describe("the four flowcharts", () => {
  const markup = renderToStaticMarkup(HowItWorksPage());

  it("draws all four, each as an ordered list a screen reader can follow", () => {
    for (const label of [
      "How the AI is built",
      "How a purchase works",
      "What is in this dashboard",
      "How you use it",
    ]) {
      expect(markup).toContain(`<ol class="flow" aria-label="${label}">`);
    }
  });

  it("marks only proposal steps as the AI's, and never a money step", () => {
    const aiTitles = [
      ...markup.matchAll(
        /data-actor="ai"><span class="flow-actor">[^<]*<\/span><strong class="flow-title">([^<]+)</g,
      ),
    ].map((match) => match[1]);
    expect(aiTitles).toEqual(["First pass: intent", "Second pass: selection", "Shop"]);
    for (const title of aiTitles) {
      expect(title).not.toMatch(/pay|price|quote|approv|refund|hold|order/i);
    }
  });

  it("names the three read-only tools the agent is actually given", () => {
    expect(markup).toContain("search_catalog");
    expect(markup).toContain("get_product_by_id");
    expect(markup).toContain("get_merchant_info");
  });

  it("shows where a branch ends instead of leaving it hanging", () => {
    expect(markup).toMatch(/data-end="stop"/);
    expect(markup).toMatch(/data-end="loop"/);
  });
});

describe("the work behind it", () => {
  const markup = renderToStaticMarkup(HowItWorksPage());

  it("shows the work as measured figures", () => {
    expect(markup).toContain('id="work"');
    expect(markup).toContain("Lines of application code");
    expect(markup).toContain("Test cases written");
    expect(markup).toContain("Design documents");
    // A measured figure is a number, never a placeholder or an unfilled value.
    expect(markup).not.toMatch(/NaN|undefined|\{\{/);
  });

  it("links each design document to its real file", () => {
    expect(markup).toMatch(
      /href="https:\/\/github\.com\/TanmaySingh2711\/razorpay-agentic-commerce\/blob\/main\/docs\/01-overview\.md"/,
    );
  });

  it("is reachable from the jump links at the top", () => {
    expect(markup).toContain('href="#work"');
    expect(markup).toContain('href="#safety"');
  });
});

describe("the old /about address", () => {
  it("redirects permanently to /how-it-works", async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toContainEqual({
      source: "/about",
      destination: "/how-it-works",
      permanent: true,
    });
  });
});
