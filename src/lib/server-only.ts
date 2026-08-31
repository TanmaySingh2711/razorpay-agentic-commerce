/**
 * A hard runtime boundary for modules that must never reach the browser.
 *
 * Some modules in this project are dangerous in a client bundle for reasons
 * that differ in kind:
 *
 *  - the persistence client carries database credentials;
 *  - the transaction creation and transition services are *authority*. Code
 *    that can call them can bring a financial record into existence or move it
 *    through the lifecycle, and anything shipped to a browser is, by
 *    definition, code an attacker can call.
 *
 * Next.js will usually catch a bad import at build time, but "usually" is the
 * wrong guarantee for a payment path. This guard converts the mistake into an
 * immediate, unmissable throw at module evaluation - before any exported
 * function can be reached - rather than a subtly working client bundle.
 *
 * It is a module-scope assertion by design: it runs on import, not on call,
 * so the failure surfaces at the boundary that was crossed.
 */
export function assertServerOnly(moduleId: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `${moduleId} was evaluated in a browser bundle. This module is server-only; ` +
        "reach it from a route handler, server action or server component instead.",
    );
  }
}
