import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { claimStaleVersionReload, isStaleVersionError } from "@/lib/stale-version";

/**
 * What keeps the hosted site quick, and what keeps it working across a redeploy.
 *
 * The region is the one that matters most: the server must run beside the
 * database, or every query crosses an ocean. The loading states make a click
 * change the page at once. And a tab left open over a redeploy reloads by
 * itself, once, rather than showing an error the reader can do nothing about.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/merchant",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe("the hosted server runs beside its database", () => {
  it("pins Vercel functions to Singapore, where the Neon database is", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      regions?: string[];
    };
    // ap-southeast-1. The default, iad1, put a Pacific round trip on every query.
    expect(config.regions).toEqual(["sin1"]);
  });
});

describe("a tab left open across a redeploy", () => {
  it("recognises a script that could not be fetched", () => {
    expect(isStaleVersionError({ name: "ChunkLoadError", message: "x" })).toBe(true);
    expect(
      isStaleVersionError({ name: "Error", message: "Loading chunk 812 failed." }),
    ).toBe(true);
    expect(
      isStaleVersionError({
        name: "TypeError",
        message: "Failed to fetch dynamically imported module: /_next/a.js",
      }),
    ).toBe(true);
  });

  it("leaves every other failure to the error page", () => {
    expect(
      isStaleVersionError({ name: "Error", message: "Can't reach database server" }),
    ).toBe(false);
    expect(isStaleVersionError({ name: "TypeError", message: "x is undefined" })).toBe(
      false,
    );
  });

  function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };
  }

  it("reloads once, then not again within a minute, so it can never loop", () => {
    const storage = memoryStorage();
    expect(claimStaleVersionReload(() => storage, 1_000_000)).toBe(true);
    expect(claimStaleVersionReload(() => storage, 1_030_000)).toBe(false);
    // A later redeploy in the same tab is recovered from too.
    expect(claimStaleVersionReload(() => storage, 1_061_000)).toBe(true);
  });

  it("does not reload where browser storage is blocked", () => {
    expect(
      claimStaleVersionReload(() => {
        throw new DOMException("blocked", "SecurityError");
      }, 1_000_000),
    ).toBe(false);
  });
});

describe("pages that read the database show their frame at once", () => {
  it("merchant: the real header and wording, with the figures still to come", async () => {
    const { default: MerchantLoading } = await import("@/app/merchant/loading");
    const { MERCHANT_LEAD } = await import("@/app/merchant/copy");
    const html = renderToStaticMarkup(MerchantLoading());
    expect(html).toContain("Merchant insights");
    expect(html).toContain(MERCHANT_LEAD);
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/skeleton-tile/g)).toHaveLength(4);
  });

  it("a purchase and its checkout: a heading-shaped placeholder until the state is known", async () => {
    const { default: PurchaseLoading } =
      await import("@/app/shop/[transactionId]/loading");
    const { default: CheckoutLoading } =
      await import("@/app/shop/[transactionId]/checkout/loading");
    for (const html of [
      renderToStaticMarkup(PurchaseLoading()),
      renderToStaticMarkup(CheckoutLoading()),
    ]) {
      expect(html).toContain("skeleton-title");
      expect(html).toContain('role="status"');
      expect(html).not.toContain("<h1");
    }
  });
});
