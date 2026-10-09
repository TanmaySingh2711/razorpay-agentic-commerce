import { PurchaseHistory } from "@/components/purchase-history";
import { SiteFooter, SiteHeader } from "@/components/site-header";

/**
 * History: the purchases this browser has opened.
 *
 * The list itself is a client component: it lives in browser storage, because
 * there is no login and the server cannot tell one visitor from another (see
 * `src/lib/purchase-history.ts`). This page is the frame around it.
 */
export const metadata = {
  title: "History | Razorpay Agentic Commerce",
  description:
    "The purchases you have opened in this browser, with their current status.",
};

export default function HistoryPage() {
  return (
    <>
      <SiteHeader current="history" />
      <main className="full">
        <header className="page-intro">
          <p className="eyebrow">History</p>
          <h1>Everything you started, and where it stands now.</h1>
          <p className="lead">
            Each purchase you open is saved in this browser. The status, product and price
            come fresh from the server every time you look, so they always match the
            purchase page.
          </p>
        </header>

        <PurchaseHistory />

        <p className="hint history-note">
          There is no login, so this list lives only in this browser. Clearing it forgets
          the list here; it never deletes a purchase or its records on the server.
        </p>

        <SiteFooter />
      </main>
    </>
  );
}
