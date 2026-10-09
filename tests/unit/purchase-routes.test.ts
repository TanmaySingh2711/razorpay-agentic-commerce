import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { purchaseCheckoutPath, purchasePath } from "@/lib/routes";

/**
 * A purchase lives inside the shop, and the old addresses still find it.
 *
 * Purchase links have been shared, bookmarked and kept in browser history
 * under /transaction/:id and /checkout/:id. Moving the pages must not break a
 * single one of them.
 */

const ID = "01a068ee-b304-7756-83d6-3e709f3c1c37";

describe("purchase addresses", () => {
  it("puts a purchase, and its checkout, under /shop", () => {
    expect(purchasePath(ID)).toBe(`/shop/${ID}`);
    expect(purchaseCheckoutPath(ID)).toBe(`/shop/${ID}/checkout`);
  });

  it("redirects the old addresses permanently to the new ones", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({
      source: "/transaction/:transactionId",
      destination: "/shop/:transactionId",
      permanent: true,
    });
    expect(redirects).toContainEqual({
      source: "/checkout/:transactionId",
      destination: "/shop/:transactionId/checkout",
      permanent: true,
    });
  });
});
