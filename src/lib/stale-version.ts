/**
 * Recovery for a tab that stayed open across a redeploy.
 *
 * Every deployment renames its JavaScript files, so such a tab asks for files
 * that no longer exist and the page fails to load. Reloading fetches the new
 * version, and nothing about the purchase depends on the old one. The error
 * page (`src/app/error.tsx`) does that by itself, at most once a minute, so a
 * fault that a reload does not cure can never become a reload loop.
 */

const RELOADED_AT_KEY = "rac:reloaded-for-new-version";
const MIN_RELOAD_GAP_MS = 60_000;

/** True for the failure a redeploy causes: a script chunk that could not be fetched. */
export function isStaleVersionError(error: Pick<Error, "name" | "message">): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /loading (css )?chunk|failed to fetch dynamically imported module/i.test(
      error.message,
    )
  );
}

/**
 * Whether to reload now, recording the reload if so.
 *
 * `false` when the last automatic reload was under a minute ago, or when
 * storage is unavailable - in both cases the error page is shown instead.
 */
export function claimStaleVersionReload(
  getStorage: () => Pick<Storage, "getItem" | "setItem">,
  now: number,
): boolean {
  try {
    // Behind a function: merely reading `sessionStorage` throws where it is blocked.
    const storage = getStorage();
    const last = Number(storage.getItem(RELOADED_AT_KEY) ?? "0");
    if (Number.isFinite(last) && now - last < MIN_RELOAD_GAP_MS) return false;
    storage.setItem(RELOADED_AT_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
