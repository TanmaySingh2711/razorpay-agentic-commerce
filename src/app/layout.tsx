import type { Metadata } from "next";
// Self-hosted from npm: the font files are bundled with the app, so no build
// or page load reaches a font CDN. Archivo is loaded with its width axis for
// the condensed headings.
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import "./ui.css";
import "./site.css";
import { ScrollMemory } from "@/components/scroll-memory";

export const metadata: Metadata = {
  title: "Razorpay Agentic Commerce",
  description:
    "An AI assistant picks a product from a sentence; the server decides everything about the money. Razorpay Test Mode.",
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
      <body suppressHydrationWarning>
        <ScrollMemory />
        {children}
      </body>
    </html>
  );
}
