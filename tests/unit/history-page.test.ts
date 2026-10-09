import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The history page as the server sends it.
 *
 * The list lives in browser storage, which does not exist on the server, so
 * the server-rendered page must be the loading state - never an "empty"
 * message that would flash before the real list arrives - and must say
 * plainly where the list lives and what clearing it does.
 */
vi.mock("@/app/actions", () => ({ loadPurchaseHistory: vi.fn() }));

async function markup(): Promise<string> {
  const { default: HistoryPage } = await import("@/app/history/page");
  return renderToStaticMarkup(HistoryPage());
}

describe("the history page", () => {
  it("is marked as the current page in the top bar", async () => {
    expect(await markup()).toMatch(/aria-current="page"[^>]*>.*?History</);
  });

  it("renders the loading state on the server, not an empty list", async () => {
    const page = await markup();
    expect(page).toContain('aria-busy="true"');
    expect(page).toContain("Loading purchases");
    expect(page).not.toContain("Nothing here yet.");
  });

  it("explains that clearing forgets the list here and deletes nothing on the server", async () => {
    const page = await markup();
    expect(page).toMatch(/lives only in this browser/);
    expect(page).toMatch(/never deletes a purchase or its records on the server/);
  });

  it("offers every filter", async () => {
    const page = await markup();
    for (const label of ["All", "Completed", "In progress", "Refunded", "Stopped"]) {
      expect(page).toContain(`>${label}</button>`);
    }
    expect(page).toMatch(/aria-pressed="true"[^>]*>All</);
  });

  it("still carries the Test Mode badge", async () => {
    expect(await markup()).toMatch(/Test Mode/);
  });
});
