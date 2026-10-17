import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Unknown addresses get the site's own not-found page, not a framework one.
 * (An unknown purchase answers not-found too: `pages-render.test.ts`.)
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/nope",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe("the not-found page", () => {
  it("keeps the site's header and offers a way on", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    const markup = renderToStaticMarkup(NotFound());

    expect(markup).toContain('class="product-bar"');
    expect(markup).toContain("There is nothing at this address.");
    expect(markup).toMatch(/<a class="primary" href="\/shop">/);
    expect(markup).not.toMatch(/[–—…]| - /);
  });
});
