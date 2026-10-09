import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The overview's and the shop's own claims.
 *
 * The old homepage was split in two: what this is (`/`) and the place to use
 * it (`/shop`). Every claim the homepage was held to is held by whichever page
 * now carries it - the Test Mode badge and the trust rule on both, the
 * console's wording and layout on the shop.
 *
 * None of this touches a server action, a service or the database, so these
 * assertions are about words and markup shape, not behaviour. `submitRequest`
 * is mocked at the module boundary purely so the shop page can be imported
 * without pulling in Gemini, Prisma or the config boundary - the console is
 * never actually submitted here.
 */
vi.mock("@/app/actions", () => ({
  submitRequest: vi.fn(),
}));

const overview = async () => {
  const { default: OverviewPage } = await import("@/app/page");
  return renderToStaticMarkup(OverviewPage());
};

const shop = async () => {
  const { default: ShopPage } = await import("@/app/shop/page");
  return renderToStaticMarkup(ShopPage());
};

describe("both pages read as a product, not a submission banner", () => {
  it.each([
    ["overview", overview],
    ["shop", shop],
  ])("the %s page names no competition", async (_name, render) => {
    expect(await render()).not.toMatch(/Buildathon|hackathon/i);
  });

  it.each([
    ["overview", overview],
    ["shop", shop],
  ])(
    "the %s page carries the Test Mode fact, as a fixed badge",
    async (_name, render) => {
      const markup = await render();
      expect(markup).toMatch(/Test Mode/i);
      expect(markup).toMatch(/no real money/i);
    },
  );

  it.each([
    ["overview", overview],
    ["shop", shop],
  ])("the %s page names the product in full in the top bar", async (_name, render) => {
    expect(await render()).toMatch(/Razorpay Agentic Commerce/);
  });

  it.each([
    ["overview", overview],
    ["shop", shop],
  ])(
    "the %s page never puts an AI actor in front of a verb that means it made this happen",
    async (_name, render) => {
      expect(await render()).not.toMatch(/AI (executes|authorizes|approves|verifies)/i);
    },
  );
});

describe("the overview", () => {
  it("keeps every clause of what the AI cannot do", async () => {
    const markup = await overview();
    expect(markup).toMatch(/No AI output can directly cause a payment/);
    expect(markup).toMatch(/authoritative price/i);
    expect(markup).toMatch(/approve a purchase/i);
    expect(markup).toMatch(/retry a payment/i);
    expect(markup).toMatch(/advance transaction state/i);
    expect(markup).toMatch(/declare a payment successful/i);
  });

  it("describes the five real steps, naming no step the system cannot back", async () => {
    const markup = await overview();
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

  it("marks exactly one of the five steps as the AI's", async () => {
    const markup = await overview();
    expect(markup.match(/data-ai="true"/g)).toHaveLength(1);
  });

  it("leads to the shop and to how it works as visible controls", async () => {
    const markup = await overview();
    expect(markup).toMatch(/<a class="primary" href="\/shop">/);
    expect(markup).toMatch(/<a class="secondary" href="\/how-it-works">/);
  });

  it("links every other page of the dashboard", async () => {
    const markup = await overview();
    for (const href of ["/shop", "/how-it-works", "/history", "/merchant"]) {
      expect(markup).toContain(`href="${href}"`);
    }
  });

  it("shows the work behind it as measured figures", async () => {
    const markup = await overview();
    expect(markup).toContain("Lines of application code");
    expect(markup).toContain("Test cases written");
    expect(markup).toContain("Design documents");
    // A measured figure is a number, never a placeholder or an unfilled value.
    expect(markup).not.toMatch(/NaN|undefined|\{\{/);
  });

  it("links each design document to its real file", async () => {
    const markup = await overview();
    expect(markup).toMatch(
      /href="https:\/\/github\.com\/TanmaySingh2711\/razorpay-agentic-commerce\/blob\/main\/docs\/01-overview\.md"/,
    );
  });
});

describe("the shop", () => {
  it("uses the end-to-end example, not the recommendation-only one", async () => {
    expect(await shop()).toMatch(
      /Find me the best mechanical keyboard under ₹3000 and buy it/,
    );
  });

  it("labels the submit button Find, the word the console actually does", async () => {
    const markup = await shop();
    expect(markup).toContain(">Find<");
    expect(markup).not.toContain(">Ask<");
  });

  it("orders the Find button before the character counter in the markup", async () => {
    const markup = await shop();
    const findIndex = markup.indexOf(">Find<");
    const counterIndex = markup.indexOf("0/1000");
    expect(findIndex).toBeGreaterThan(-1);
    expect(counterIndex).toBeGreaterThan(-1);
    expect(findIndex).toBeLessThan(counterIndex);
  });

  it("says what happens after Find, with the AI owning only the suggestion", async () => {
    const markup = await shop();
    expect(markup).toContain("After you press Find");
    expect(markup.match(/data-ai="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/Searching never charges anything/);
  });

  it("links to the full flow as a visible secondary action", async () => {
    expect(await shop()).toMatch(/<a class="secondary" href="\/how-it-works">/);
  });

  it("declares the server action's time limit on the route that invokes it", async () => {
    const { maxDuration } = await import("@/app/shop/page");
    expect(maxDuration).toBe(60);
  });
});
