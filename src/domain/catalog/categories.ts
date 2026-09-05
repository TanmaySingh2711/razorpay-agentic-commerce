/**
 * The merchant's own category vocabulary, and how a shopper's words reach it.
 *
 * Category is matched by equality — `assessCandidate` refuses anything whose
 * `category` is not the one the shopper asked for — so the exact string matters
 * in a way no other free-text field does. "mouse" finds ten products and "mice"
 * finds none, and the difference is invisible to whoever typed it.
 *
 * That was harmless while the catalog sold one kind of thing. With keyboards,
 * mice and headphones side by side it is the difference between a working demo
 * and a shopper being told, truthfully but uselessly, that nothing matches.
 *
 * ## What this is not
 *
 * It is not a search, and it does not widen anything. Canonicalisation maps a
 * word onto a category the merchant genuinely has, or leaves it alone. An
 * unknown category stays unknown and matches nothing, which is the correct
 * outcome: a shopper asking for a webcam in a shop that sells none must be told
 * so, not handed a keyboard. Nothing here can turn "mouse" into "keyboard", and
 * nothing here relaxes a filter — the hard check still runs, unchanged, on
 * whatever this returns.
 */

/** Every category this merchant actually sells. The catalog's own spelling. */
export const MERCHANT_CATEGORIES = [
  "mechanical-keyboard",
  "mouse",
  "headphones",
] as const;

export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

/**
 * The words a person uses, mapped to the word the catalog uses.
 *
 * Deliberately conservative. Only terms that genuinely name the same kind of
 * product appear here: "headset" is a headphone, but "earbuds" is a different
 * product this merchant does not sell, so it is absent and will correctly match
 * nothing rather than being quietly rounded to the nearest thing in stock.
 */
const SYNONYMS: Readonly<Record<string, MerchantCategory>> = {
  // Keyboards
  keyboard: "mechanical-keyboard",
  keyboards: "mechanical-keyboard",
  "mechanical keyboard": "mechanical-keyboard",
  "mechanical keyboards": "mechanical-keyboard",
  "gaming keyboard": "mechanical-keyboard",
  "computer keyboard": "mechanical-keyboard",
  // Mice
  mouse: "mouse",
  mice: "mouse",
  "computer mouse": "mouse",
  "gaming mouse": "mouse",
  "wireless mouse": "mouse",
  "ergonomic mouse": "mouse",
  // Headphones
  headphone: "headphones",
  headphones: "headphones",
  headset: "headphones",
  headsets: "headphones",
  "gaming headset": "headphones",
  "gaming headphones": "headphones",
  "wireless headphones": "headphones",
  "over ear headphones": "headphones",
};

/**
 * Reduces a stated category to a comparable key.
 *
 * Hyphens and underscores become spaces so "gaming-mouse", "gaming_mouse" and
 * "Gaming Mouse" are one term rather than three, and repeated whitespace
 * collapses so a stray double space cannot miss.
 */
function normalise(raw: string): string {
  return raw.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The catalog category a stated one refers to, or the stated one unchanged.
 *
 * `null` in, `null` out: a shopper who named no category is not given one. That
 * matters — inventing a category here would narrow a search the shopper left
 * deliberately open.
 */
export function canonicalCategory(stated: string | null): string | null {
  if (stated === null) return null;
  const key = normalise(stated);
  if (key.length === 0) return null;

  const known = SYNONYMS[key];
  if (known !== undefined) return known;

  // Already the catalog's own spelling, just cased or hyphenated differently.
  const exact = MERCHANT_CATEGORIES.find((category) => normalise(category) === key);
  if (exact !== undefined) return exact;

  // Unknown to this merchant. Returned as given so the hard filter refuses it
  // honestly, rather than being mapped to whatever happens to be in stock.
  return stated;
}
