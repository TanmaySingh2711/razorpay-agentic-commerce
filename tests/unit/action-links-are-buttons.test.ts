import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Action links must look and behave like the actions they are.
 *
 * The three navigation controls in this application - "Find" aside, which is a
 * real `<button>` - are anchors that *do* something: they leave the page a
 * person is on. Styled as bare text they read as footnotes, which is how "Start
 * another purchase" ended up being missed at the exact moment somebody needed
 * it, after a purchase they could not complete.
 *
 * Asserted against the source rather than a rendered tree because the property
 * is about the markup a reviewer would inspect: every one of these carries the
 * shared `.secondary` class, so it is keyboard reachable as a link, has the
 * project's visible focus ring, and gets the same hover and press feedback as
 * every other control. A future link added without that class fails here.
 */

const PAGES = [
  "src/app/page.tsx",
  "src/app/about/page.tsx",
  "src/app/transaction/[transactionId]/page.tsx",
  "src/components/transaction/decision-form.tsx",
] as const;

/** Every `<Link …>` opening tag in a file, with its attributes. */
function linkTags(source: string): readonly string[] {
  return [...source.matchAll(/<Link\b[^>]*>/g)].map((match) => match[0]);
}

describe("every navigation action is styled as a control", () => {
  for (const page of PAGES) {
    it(`gives every Link in ${page} a button style`, () => {
      const source = readFileSync(page, "utf8");
      const tags = linkTags(source);
      // Each page under test genuinely has at least one, so a regex that
      // silently stopped matching would fail here rather than pass vacuously.
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag).toMatch(/className="(primary|secondary)"/);
      }
    });
  }

  it("styles the transaction page's own escape hatch", () => {
    const source = readFileSync("src/app/transaction/[transactionId]/page.tsx", "utf8");
    expect(source).toMatch(/className="secondary"[\s\S]{0,80}Start another purchase/);
  });

  it("offers a real control, not just a sentence, when a hold is refused", () => {
    const source = readFileSync("src/components/transaction/decision-form.tsx", "utf8");
    // The recovery control appears only after the server actually refused.
    expect(source).toMatch(/outcome\.kind === "ERROR"/);
    expect(source).toMatch(/recoveryHref/);
  });
});
