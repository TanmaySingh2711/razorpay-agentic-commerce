import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The homepage's own claims, held to the same standard as `/about`'s.
 *
 * This is a presentation regression suite, added alongside the demo-polish
 * pass that: gave the page a slim product header carrying the Test Mode
 * badge, added a one-line trust-flow strip, replaced a text link that was
 * easy to miss with a visible secondary link, and reordered the submit button
 * ahead of the character counter. None of that touches a server action, a
 * service, or the database - so these assertions are about words and markup
 * shape, not behaviour, and stay separate from `tests/db/` and the
 * buyer-agent test files that cover the logic these buttons call into.
 *
 * `submitRequest` is mocked at the module boundary purely so this file can
 * import the page without pulling in Gemini, Prisma or the config boundary -
 * the console is never actually submitted here.
 */
vi.mock("@/app/actions/purchase", () => ({
  submitRequest: vi.fn(),
}));

describe("the homepage reads as a product, not a submission banner", () => {
  it("puts the competition name on a page other than home", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).not.toMatch(/Buildathon/i);
  });

  it("still carries the Test Mode fact, as a fixed badge", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).toMatch(/Test Mode/i);
    expect(markup).toMatch(/no real money/i);
  });

  it("names the product in full in the top bar", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).toMatch(/Razorpay Agentic Commerce/);
  });

  it("states the trust flow without ever putting an AI actor before it executes", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).toMatch(/AI proposes/);
    expect(markup).toMatch(/Razorpay executes/);
    // The one sentence this strip must never become: an AI actor with a verb
    // that means "made this happen".
    expect(markup).not.toMatch(/AI (executes|authorizes|approves|verifies)/i);
  });

  it("keeps every clause of what the AI cannot do", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).toMatch(/No AI output can directly cause a payment/);
    expect(markup).toMatch(/authoritative price/i);
    expect(markup).toMatch(/approve a purchase/i);
    expect(markup).toMatch(/retry a payment/i);
    expect(markup).toMatch(/advance transaction state/i);
    expect(markup).toMatch(/declare a payment successful/i);
  });

  it("uses the end-to-end example, not the recommendation-only one", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).toMatch(/Find me the best mechanical keyboard under ₹3000 and buy it/);
  });

  it("links to the Architecture & Safety page as a visible secondary action", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).toMatch(/href="\/about"/);
    expect(markup).toMatch(/View Architecture/);
  });

  it("labels the submit button Find, the word the console actually does", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    expect(markup).toContain(">Find<");
    expect(markup).not.toContain(">Ask<");
  });

  it("orders the Find button before the character counter in the markup", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    const findIndex = markup.indexOf(">Find<");
    const counterIndex = markup.indexOf("0/1000");
    expect(findIndex).toBeGreaterThan(-1);
    expect(counterIndex).toBeGreaterThan(-1);
    expect(findIndex).toBeLessThan(counterIndex);
  });

  it("describes the five real steps, naming no step the system cannot back", async () => {
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(HomePage());
    for (const step of [
      "You describe",
      "AI proposes",
      "Server verifies",
      "Policy / Approval",
      "Razorpay payment",
    ]) {
      expect(markup).toContain(step);
    }
  });
});
