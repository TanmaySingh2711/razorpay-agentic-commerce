"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect } from "react";

/**
 * Brings each page back to where it was left when the browser goes back or
 * forward to it.
 *
 * Every page's scroll position is remembered per address, for this tab, as
 * the page is scrolled. Moving with Back or Forward then returns to that
 * position; following a link (the header, a button, a card) still opens the
 * page at the top, which is what a link means.
 *
 * Content that arrives after the first paint - the history list, read from
 * the server - can make a page taller a moment later, so the position is
 * re-applied for a short while until the page is tall enough, and given up as
 * soon as the person scrolls themselves.
 */

const STORAGE_KEY = "rac:scroll-positions:v1";
const RESTORE_WINDOW_MS = 1_500;

function readPositions(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function writePosition(address: string, y: number): void {
  try {
    const positions = readPositions();
    positions[address] = Math.round(y);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Storage unavailable: pages simply open at the top, as they would anyway.
  }
}

const currentAddress = (): string => window.location.pathname + window.location.search;

/** Set by Back/Forward, consumed by the next page that renders. */
let pendingRestore: string | null = null;

export function ScrollMemory(): null {
  const pathname = usePathname();

  useEffect(() => {
    // The browser's own restoration races the router's rendering; this
    // component does the job deterministically instead.
    window.history.scrollRestoration = "manual";

    let frame = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        writePosition(currentAddress(), window.scrollY);
      });
    };
    const onPopState = (): void => {
      pendingRestore = currentAddress();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPopState);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useLayoutEffect(() => {
    const address = currentAddress();
    if (pendingRestore !== address) {
      // A link was followed: open the page at its very top. The router's own
      // scroll aims past the sticky header to the first element below it, which
      // leaves the page a header's height down; a link to a #section is left
      // alone, because there the browser is meant to scroll.
      if (window.location.hash === "") {
        const frame = requestAnimationFrame(() => {
          window.scrollTo(0, 0);
        });
        return () => {
          cancelAnimationFrame(frame);
        };
      }
      return;
    }
    pendingRestore = null;
    const target = readPositions()[address] ?? 0;

    const started = performance.now();
    let frame = 0;
    let cancelled = false;
    const stop = (): void => {
      cancelled = true;
    };
    // A person scrolling takes over immediately.
    window.addEventListener("wheel", stop, { passive: true, once: true });
    window.addEventListener("touchstart", stop, { passive: true, once: true });
    window.addEventListener("keydown", stop, { once: true });

    const apply = (): void => {
      if (cancelled) return;
      window.scrollTo(0, target);
      const reached = Math.abs(window.scrollY - target) < 2;
      if (!reached && performance.now() - started < RESTORE_WINDOW_MS) {
        frame = requestAnimationFrame(apply);
      }
    };
    apply();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [pathname]);

  return null;
}
