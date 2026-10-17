import { SiteHeader, type SiteSection } from "@/components/site-header";

/**
 * What a page that reads the database shows while it does.
 *
 * Used by the `loading.tsx` files. Next.js prefetches this the moment a link
 * to the page is on screen, so a click changes the page at once instead of
 * leaving the old one up while the server works. The header and any wording
 * known in advance are real, so only the figures shimmer in.
 */
export function PageLoading({
  current,
  eyebrow,
  title,
  lead,
  tiles = 0,
  cards = 3,
}: {
  readonly current: SiteSection;
  readonly eyebrow: string;
  /** `null` when the heading depends on the data, as on a purchase. */
  readonly title: string | null;
  readonly lead?: string;
  readonly tiles?: number;
  readonly cards?: number;
}): React.JSX.Element {
  return (
    <>
      <SiteHeader current={current} />
      <main className="wide" aria-busy="true">
        <header className="page-head">
          <p className="eyebrow">{eyebrow}</p>
          {title === null ? (
            <div className="skeleton-block skeleton-title" aria-hidden="true" />
          ) : (
            <h1>{title}</h1>
          )}
          {lead === undefined ? (
            <div className="skeleton-block skeleton-line" aria-hidden="true" />
          ) : (
            <p className="lead">{lead}</p>
          )}
        </header>
        <p className="visually-hidden" role="status">
          Loading
        </p>
        {tiles > 0 ? (
          <div className="stat-row" aria-hidden="true">
            {Array.from({ length: tiles }, (_, index) => (
              <div key={index} className="skeleton-block skeleton-tile" />
            ))}
          </div>
        ) : null}
        {Array.from({ length: cards }, (_, index) => (
          <div key={index} className="skeleton-block skeleton-card" aria-hidden="true" />
        ))}
      </main>
    </>
  );
}
