import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * House style for what the pages say.
 *
 * The site's copy is written in plain sentences: no em or en dashes, no arrow
 * characters standing in for words, no typographic ellipsis, and no page
 * numbers in front of page names. Each page is rendered and read the way a
 * visitor would read it, so a dash slipped into any string - a title, a
 * badge, a flowchart box - fails here rather than on screen.
 */

vi.mock("@/app/actions", () => ({
  submitRequest: vi.fn(),
  loadPurchaseHistory: vi.fn(),
}));
vi.mock("@/services/merchant-insights-service", () => ({
  loadMerchantInsights: vi.fn(() => Promise.reject(new Error("database down"))),
}));

const FORBIDDEN: readonly [string, RegExp][] = [
  ["an em dash", /—/],
  ["an en dash", /–/],
  ["an arrow", /[←-⇿]/],
  ["a typographic ellipsis", /…/],
  ["a spaced hyphen standing in for a dash", / - /],
  ["a page number in the navigation", /class="nav-index"|>0[1-5]</],
];

/** Visible text and attribute values only: tags and inline styles removed. */
function visibleText(markup: string): string {
  return markup
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "");
}

const PAGES: readonly [string, () => Promise<string>][] = [
  ["overview", async () => renderToStaticMarkup((await import("@/app/page")).default())],
  ["shop", async () => renderToStaticMarkup((await import("@/app/shop/page")).default())],
  [
    "how it works",
    async () => renderToStaticMarkup((await import("@/app/how-it-works/page")).default()),
  ],
  [
    "history",
    async () => renderToStaticMarkup((await import("@/app/history/page")).default()),
  ],
  [
    "merchant",
    async () =>
      renderToStaticMarkup(await (await import("@/app/merchant/page")).default()),
  ],
];

describe("every page is written in plain sentences", () => {
  for (const [page, render] of PAGES) {
    for (const [what, pattern] of FORBIDDEN) {
      it(`the ${page} page contains no ${what.replace(/^an? /, "")}`, async () => {
        expect(visibleText(await render())).not.toMatch(pattern);
      });
    }
  }
});

describe("the header", () => {
  it("draws the mark inline and names the product", async () => {
    const markup = await PAGES[0]![1]();
    expect(markup).toMatch(/<a class="brand"[^>]*href="\/"><svg class="brand-mark"/);
    expect(markup).toContain("Agentic Commerce");
  });

  it("lists the five pages by name only", async () => {
    const markup = await PAGES[0]![1]();
    const labels = [...markup.matchAll(/class="nav-link"[^>]*>([^<]+)</g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(["Overview", "Shop", "How it works", "History", "Merchant"]);
  });
});

describe("the merchant page without its database", () => {
  it("says the insights could not be loaded instead of crashing", async () => {
    const markup = await PAGES[4]![1]();
    expect(markup).toContain("The insights could not be loaded");
    expect(markup).toContain('role="alert"');
    // The cause stays in the server log, never on the page.
    expect(markup).not.toContain("database down");
  });
});
