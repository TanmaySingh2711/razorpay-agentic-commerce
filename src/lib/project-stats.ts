import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * How much went into this repository, counted from the repository itself.
 *
 * The overview page shows these numbers, and every one of them is measured
 * here rather than typed into the page: a hand-written "1,400 tests" is a claim
 * that goes stale the day a test is added, while a count taken from the files
 * is true by construction. The page is prerendered, so this runs once, during
 * `next build`, against the checked-out source.
 *
 * Anything that cannot be measured is `null`, and the page leaves it out
 * rather than guessing. Git history is the usual case: a shallow clone (which
 * is what most build machines make) has a handful of commits, and reporting
 * that handful as the project's history would be wrong, so a shallow
 * repository reports no history at all.
 */

export interface DesignDocument {
  readonly file: string;
  readonly title: string;
  readonly words: number;
}

export interface GitHistory {
  readonly commits: number;
  /** ISO date (YYYY-MM-DD) of the first commit. */
  readonly firstCommit: string;
  /** ISO date (YYYY-MM-DD) of the most recent commit. */
  readonly lastCommit: string;
}

export interface ProjectStats {
  readonly sourceFiles: number;
  readonly sourceLines: number;
  readonly testFiles: number;
  readonly testCases: number;
  readonly testLines: number;
  readonly pages: number;
  readonly apiEndpoints: number;
  readonly migrations: number;
  readonly documents: readonly DesignDocument[];
  readonly documentWords: number;
  readonly git: GitHistory | null;
}

/** Generated code is not work anybody did by hand. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "generated", ".next", ".git"]);

function walk(directory: string, accept: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...walk(full, accept));
    } else if (accept(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Lines that hold something: blank lines are layout, not work. */
export function countLines(source: string): number {
  return source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * The test cases a file declares.
 *
 * Counts `it(`, `test(` and their `.each` / `.skipIf(...)` forms at the start
 * of a statement. A parameterised case counts once, as written, so this is the
 * number of cases somebody wrote - lower than the number the runner reports.
 */
export function countTestCases(source: string): number {
  return [
    ...source.matchAll(/^\s*(?:it|test)(?:\.each|\.skipIf\([^)]*\)|\.only)?\s*[(`]/gm),
  ].length;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

/**
 * The first Markdown heading, without its `#` marks or its "07 — " number
 * prefix (the file name already carries the number).
 */
export function documentTitle(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (heading === undefined) return fallback;
  return heading.replace(/^\d+\s*[—–-]\s*/, "");
}

const isSource = (name: string) => /\.(ts|tsx|css)$/.test(name);
const isTest = (name: string) => name.endsWith(".test.ts");

function readGitHistory(root: string): GitHistory | null {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  try {
    if (git("rev-parse", "--is-shallow-repository") !== "false") return null;
    const commits = Number(git("rev-list", "--count", "HEAD"));
    const dates = git("log", "--format=%cs", "HEAD").split("\n");
    const lastCommit = dates[0];
    const firstCommit = dates.at(-1);
    if (!Number.isInteger(commits) || commits <= 0) return null;
    if (lastCommit === undefined || firstCommit === undefined) return null;
    return { commits, firstCommit, lastCommit };
  } catch {
    // No git binary, or not a repository (a tarball build): nothing to report.
    return null;
  }
}

function measure(root: string): ProjectStats {
  const at = (...parts: string[]) => path.join(root, ...parts);
  const read = (file: string) => readFileSync(file, "utf8");

  const sources = walk(at("src"), isSource);
  const tests = walk(at("tests"), isTest);
  const testSources = tests.map(read);

  const documents = readdirSync(at("docs"))
    .filter((name) => /^\d.*\.md$/.test(name))
    .sort()
    .map((file) => {
      const text = read(at("docs", file));
      return { file, title: documentTitle(text, file), words: countWords(text) };
    });

  const migrations = readdirSync(at("prisma", "migrations")).filter((name) =>
    statSync(at("prisma", "migrations", name)).isDirectory(),
  ).length;

  return {
    sourceFiles: sources.length,
    sourceLines: sources.reduce((total, file) => total + countLines(read(file)), 0),
    testFiles: tests.length,
    testCases: testSources.reduce((total, text) => total + countTestCases(text), 0),
    testLines: testSources.reduce((total, text) => total + countLines(text), 0),
    pages: walk(at("src", "app"), (name) => name === "page.tsx").length,
    apiEndpoints: walk(at("src", "app", "api"), (name) => name === "route.ts").length,
    migrations,
    documents,
    documentWords: documents.reduce((total, doc) => total + doc.words, 0),
    git: readGitHistory(root),
  };
}

/**
 * Measures the repository at `root`, or returns `null` when its files are not
 * there - a server that only has the built output, for instance. The page
 * then shows no numbers instead of wrong ones.
 */
export function readProjectStats(root: string = process.cwd()): ProjectStats | null {
  try {
    return measure(root);
  } catch {
    return null;
  }
}
