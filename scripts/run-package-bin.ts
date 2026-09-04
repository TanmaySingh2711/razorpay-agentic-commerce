import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

/**
 * Runs a dependency's CLI without going through a shell.
 *
 * ## Why this exists
 *
 * Every database script used to spawn `npx <tool> <args>` with
 * `shell: process.platform === "win32"`, because Windows cannot execute
 * `npx.cmd` without one. Node 24 emits `DEP0190` for exactly that combination,
 * and the warning is not cosmetic: with `shell: true` the argument array is
 * concatenated into a command string rather than passed as separate arguments,
 * so any argument containing shell metacharacters is interpreted rather than
 * quoted. Today every caller passes literal strings, but "the arguments happen
 * to be safe right now" is the kind of invariant this project prefers to
 * remove rather than document.
 *
 * Resolving the tool's JavaScript entry point and handing it to the Node
 * binary already running this script removes the shell from the picture
 * entirely. There is nothing left to escape, the `win32` branch disappears,
 * and each command also starts fractionally sooner because npx no longer has
 * to resolve the package first.
 *
 * ## Why `createRequire` rather than a hard-coded path
 *
 * `node_modules/<pkg>/...` is only correct when the dependency is installed
 * beside this script. Node's own resolver finds it wherever npm actually put
 * it, which keeps this working under hoisting and in a workspace.
 */

const requireFrom = createRequire(import.meta.url);

/**
 * Absolute path to the JavaScript file a package's `bin` entry points at.
 *
 * Throws rather than guessing: a package with no usable `bin` is a broken
 * install, and continuing would spawn Node against a path that does not exist.
 */
export function resolvePackageBin(packageName: string): string {
  const manifestPath = requireFrom.resolve(`${packageName}/package.json`);
  const manifest: unknown = requireFrom(`${packageName}/package.json`);

  if (typeof manifest !== "object" || manifest === null || !("bin" in manifest)) {
    throw new Error(`Package "${packageName}" declares no bin entry.`);
  }

  const { bin } = manifest as { bin: unknown };
  // `bin` is either a single path or a map of command name to path. When it is
  // a map, the entry named after the package is the one npx would have run.
  const entry =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? (bin as Record<string, unknown>)[packageName]
        : undefined;

  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(
      `Package "${packageName}" declares no bin entry named "${packageName}".`,
    );
  }

  return resolve(dirname(manifestPath), entry);
}

/**
 * Spawns a dependency's CLI and waits for it, inheriting stdio so the tool's
 * own output reaches the terminal unchanged.
 *
 * `env` is passed through as given; callers use it to pin the database
 * connection the child is allowed to see.
 */
export function runPackageBin(
  packageName: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv },
): void {
  execFileSync(process.execPath, [resolvePackageBin(packageName), ...args], {
    stdio: "inherit",
    env: options.env,
  });
}
