"use client";

import Link from "next/link";

/**
 * The bar every page opens with: what this is, the pages there are, and the
 * one fact that must survive whatever the copy says.
 *
 * The current page is marked with `aria-current`, so the location is announced
 * rather than only coloured.
 *
 * A link in this bar always lands at the top of its page. Pressing the link
 * for the page already open scrolls it back to the top instead of reloading
 * it. (Going back with the browser returns to where you were - see
 * `scroll-memory.tsx`.)
 *
 * `TEST MODE, NO REAL MONEY` is a fixed badge rather than prose, so no copy
 * edit can quietly remove it.
 */

export type SiteSection = "overview" | "shop" | "how" | "history" | "merchant" | null;

const LINKS: readonly {
  readonly section: Exclude<SiteSection, null>;
  readonly href: string;
  readonly label: string;
}[] = [
  { section: "overview", href: "/", label: "Overview" },
  { section: "shop", href: "/shop", label: "Shop" },
  { section: "how", href: "/how-it-works", label: "How it works" },
  { section: "history", href: "/history", label: "History" },
  { section: "merchant", href: "/merchant", label: "Merchant" },
];

/** On the page already open, a header link means "take me to the top". */
function scrollToTopIfHere(
  event: React.MouseEvent<HTMLAnchorElement>,
  href: string,
): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  if (window.location.pathname !== href) return;
  event.preventDefault();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * The mark: a shopping bag with a tick, for a purchase the server has checked.
 * Drawn inline so it is crisp at any size and needs no image request.
 *
 * Its colours come from CSS classes (`.mark-*` in site.css), not from `fill`
 * and `stroke` attributes. Colour-changing browser extensions rewrite those
 * attributes before React hydrates, which turned this logo into a hydration
 * error on every page; there is nothing for them to rewrite now.
 */
export function BrandMark({ size = 30 }: { readonly size?: number }): React.JSX.Element {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="mark-tile" width="32" height="32" rx="8" />
      <path className="mark-handle" d="M12.25 12.5V11a3.75 3.75 0 0 1 7.5 0v1.5" />
      <path
        className="mark-bag"
        d="M8.6 12.5h14.8a1 1 0 0 1 1 .92l.95 11.1a1.8 1.8 0 0 1-1.8 1.98H8.45a1.8 1.8 0 0 1-1.8-1.98l.95-11.1a1 1 0 0 1 1-.92z"
      />
      <path className="mark-tick" d="M12.4 19.3l2.5 2.5 4.8-5" />
    </svg>
  );
}

export function SiteHeader({
  current,
}: {
  readonly current: SiteSection;
}): React.JSX.Element {
  return (
    <header className="product-bar">
      <div className="product-bar-inner">
        <Link
          href="/"
          className="brand"
          aria-label="Razorpay Agentic Commerce, overview"
          onClick={(event) => {
            scrollToTopIfHere(event, "/");
          }}
        >
          <BrandMark />
          <span className="brand-name">
            Razorpay <span>Agentic Commerce</span>
          </span>
        </Link>
        <nav aria-label="Main" className="site-nav">
          {LINKS.map((link) => (
            <Link
              key={link.section}
              href={link.href}
              className="nav-link"
              onClick={(event) => {
                scrollToTopIfHere(event, link.href);
              }}
              {...(link.section === current ? { "aria-current": "page" as const } : {})}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <span className="badge test-mode">
          <span className="dot" aria-hidden="true" />
          Test Mode, no real money
        </span>
      </div>
    </header>
  );
}

/** The closing line every page ends on. */
export function SiteFooter(): React.JSX.Element {
  return (
    <footer className="site-footer">
      <span>Razorpay Agentic Commerce</span>
      <span>Razorpay Test Mode. No real money moves.</span>
    </footer>
  );
}
