import type { Metadata } from "next";
import "./globals.css";
import "./ui.css";

export const metadata: Metadata = {
  title: "Razorpay Agentic Commerce",
  description:
    "Agent-transactable commerce with deterministic financial controls, human approval gates and a full audit trail.",
};

/**
 * `suppressHydrationWarning` is on the two elements browser extensions rewrite.
 *
 * Dark-mode and privacy extensions add attributes such as
 * `data-darkreader-mode` to `<html>` and `<body>` before React hydrates, so the
 * server's markup and the client's genuinely differ - through no fault of this
 * application. Without this, every user running one of those extensions sees a
 * hydration error that says nothing about our code.
 *
 * It is deliberately narrow. The flag applies only to the element it is on, not
 * to the tree beneath it, so a real mismatch inside the page still reports
 * normally. It is not a way to silence hydration problems generally.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
