"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * What any page shows when rendering it fails on the server.
 *
 * Almost always the database not answering. The page keeps the site's look
 * and offers the two useful next steps - try again, or go back to the shop -
 * instead of a framework error screen. The error itself is logged where it
 * happened; production sends the browser only an opaque digest.
 */
export default function PageError({
  error,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="full">
      <section className="page-intro" aria-labelledby="error-heading">
        <h1 id="error-heading">This page could not be loaded.</h1>
        <p className="lead">
          The server could not finish it, usually because the database did not answer in
          time. Nothing was charged and nothing was lost.
        </p>
        <div className="hero-actions">
          <button type="button" className="primary" onClick={retry}>
            Try again
          </button>
          <Link href="/shop" className="secondary">
            Go to the shop
          </Link>
        </div>
      </section>
    </main>
  );
}
