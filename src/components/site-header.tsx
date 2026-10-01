import Link from "next/link";

/**
 * The slim bar every page opens with: who this is, where else there is to go,
 * and the one fact that must survive whatever the copy says.
 *
 * Three destinations, because the product has three audiences - the shopper
 * (Shop), the merchant (Insights) and the reviewer (How it's safe). The
 * current page is marked with `aria-current`, so the location is announced
 * rather than only coloured.
 *
 * `TEST MODE · NO REAL MONEY` is a fixed badge rather than prose, so no copy
 * edit can quietly remove it.
 */

export type SiteSection = "shop" | "merchant" | "about" | null;

const LINKS: readonly {
  readonly section: Exclude<SiteSection, null>;
  readonly href: string;
  readonly label: string;
}[] = [
  { section: "shop", href: "/", label: "Shop" },
  { section: "merchant", href: "/merchant", label: "Merchant insights" },
  { section: "about", href: "/about", label: "How it's safe" },
];

export function SiteHeader({
  current,
}: {
  readonly current: SiteSection;
}): React.JSX.Element {
  return (
    <header className="product-bar">
      <div className="product-bar-inner">
        <span className="brand">Razorpay Agentic Commerce</span>
        <nav aria-label="Main" className="site-nav">
          {LINKS.map((link) => (
            <Link
              key={link.section}
              href={link.href}
              className="nav-link"
              {...(link.section === current ? { "aria-current": "page" as const } : {})}
            >
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
