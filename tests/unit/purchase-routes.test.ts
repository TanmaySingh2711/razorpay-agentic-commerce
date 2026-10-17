import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { purchasePath } from "@/lib/routes";

/**
 * A purchase lives inside the shop, and the old addresses still find it.
 *
 * Purchase links have been shared, bookmarked and kept in browser history
 * under /transaction/:id, /checkout/:id and /shop/:id/checkout. Paying again
 * now happens on the purchase page itself, so every one of them lands there.
 */

const ID = "01a068ee-b304-7756-83d6-3e709f3c1c37";

describe("purchase addresses", () => {
  it("puts a purchase under /shop", () => {
    expect(purchasePath(ID)).toBe(`/shop/${ID}`);
  });

  it("redirects every older address permanently to the purchase page", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    for (const source of [
      "/transaction/:transactionId",
      "/checkout/:transactionId",
      "/shop/:transactionId/checkout",
    ]) {
      expect(redirects).toContainEqual({
        source,
        destination: "/shop/:transactionId",
        permanent: true,
      });
    }
  });
});
