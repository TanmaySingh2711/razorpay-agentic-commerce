import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { metadata, viewport } from "@/app/layout";
import { BrandMark } from "@/components/site-header";

/**
 * Markup that colour-changing browser extensions leave alone.
 *
 * Dark Reader rewrote the logo's `fill` and `stroke` attributes before React
 * hydrated, and every visitor running it saw a hydration error. Two defences,
 * each enough on its own, are pinned here: the page tells Dark Reader it is
 * already dark, and the logo has no colour attributes for anything to rewrite.
 */

describe("the Dark Reader opt-out", () => {
  it("is declared, with a value Next.js will actually render", () => {
    const other = metadata.other ?? {};
    // Next.js drops a meta tag whose content is empty, which silently removed
    // the first version of this opt-out.
    expect(other["darkreader-lock"]).toBeTruthy();
  });

  it("declares the page dark to the browser", () => {
    expect(viewport.colorScheme).toBe("dark");
  });
});

describe("the logo", () => {
  const markup = renderToStaticMarkup(BrandMark({}));

  it("carries no colour attributes an extension could rewrite", () => {
    expect(markup).not.toMatch(/\s(fill|stroke)=/);
    expect(markup).not.toMatch(/style=/);
  });

  it("is still drawn: four shapes, each coloured by a class", () => {
    expect(markup.match(/class="mark-(tile|handle|bag|tick)"/g)).toHaveLength(4);
  });
});
