import Link from "next/link";

/**
 * The bar every page opens with: what this is, the pages there are, and the
 * one fact that must survive whatever the copy says.
 *
 * The pages are numbered in the order they are meant to be read - what this
 * is, try it, how it works, what you bought - with the merchant's view last,
 * because it is a different audience. The current page is marked with
 * `aria-current`, so the location is announced rather than only coloured.
 *
 * `TEST MODE · NO REAL MONEY` is a fixed badge rather than prose, so no copy
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

export function SiteHeader({
  current,
}: {
  readonly current: SiteSection;
}): React.JSX.Element {
  return (
    <header className="product-bar">
      <div className="product-bar-inner">
        <Link href="/" className="brand" aria-label="Razorpay Agentic Commerce, overview">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">
            Razorpay <span>Agentic Commerce</span>
          </span>
        </Link>
        <nav aria-label="Main" className="site-nav">
          {LINKS.map((link, index) => (
            <Link
              key={link.section}
              href={link.href}
              className="nav-link"
              {...(link.section === current ? { "aria-current": "page" as const } : {})}
            >
              <span className="nav-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              {link.label}
            </Link>
          ))}
        </nav>
        <span className="badge test-mode">
          <span className="dot" aria-hidden="true" />
          Test Mode · No real money
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
      <span>Razorpay Test Mode — no real money moves.</span>
    </footer>
  );
}
