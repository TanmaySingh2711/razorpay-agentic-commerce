"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that counts up to its value the first time it scrolls into view.
 *
 * The server renders the real number, so without JavaScript - or with
 * reduced motion turned on - the figure is simply there. The animation only
 * ever runs from zero to that same number; it never shows a value the page
 * was not given.
 */
export function CountUp({
  value,
  durationMs = 1400,
}: {
  readonly value: number;
  readonly durationMs?: number;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    // Drop to zero before the figure is seen, so it counts up rather than
    // showing the number, blinking to zero and then counting.
    let frame = requestAnimationFrame(() => {
      setShown(0);
    });
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const started = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - started) / durationMs);
          // Ease out: fast at first, settling onto the real figure.
          const eased = 1 - Math.pow(1 - progress, 3);
          setShown(Math.round(value * eased));
          if (progress < 1) frame = requestAnimationFrame(tick);
        };
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, durationMs]);

  return (
    <span ref={ref} className="count-up">
      {/* The settled figure for assistive technology; the moving one is visual. */}
      <span className="visually-hidden">{value.toLocaleString("en-IN")}</span>
      <span aria-hidden="true">{shown.toLocaleString("en-IN")}</span>
    </span>
  );
}
