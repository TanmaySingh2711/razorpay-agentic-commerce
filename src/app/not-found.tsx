import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-header";

/**
 * What an unknown address shows: a purchase link from another database, a
 * mistyped page, an id that never existed. In the site's own frame, with the
 * header and a way on, instead of the framework's bare default.
 */
export default function NotFound() {
  return (
    <>
      <SiteHeader current={null} />
      <main className="full">
        <section className="page-intro" aria-labelledby="not-found-heading">
          <p className="eyebrow">Not found</p>
          <h1 id="not-found-heading">There is nothing at this address.</h1>
          <p className="lead">
            The page or purchase you were looking for does not exist here. A purchase link
            only works on the copy of the app that created it.
          </p>
          <div className="hero-actions">
            <Link href="/shop" className="primary">
              Go to the shop
            </Link>
            <Link href="/history" className="secondary">
              Your purchases
            </Link>
          </div>
        </section>
        <SiteFooter />
      </main>
    </>
  );
}
