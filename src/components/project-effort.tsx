import { CountUp } from "@/components/count-up";
import type { ProjectStats } from "@/lib/project-stats";

/**
 * "The work behind it": what went into this project, as measured figures.
 *
 * Every number comes from `readProjectStats`, which counts the repository
 * while the page is being built - nothing here is typed in by hand that could
 * be measured instead, and anything that cannot be measured is left out.
 */

const REPOSITORY = "https://github.com/TanmaySingh2711/razorpay-agentic-commerce";

const STACK = [
  "Next.js 16",
  "React 19",
  "TypeScript (strict)",
  "PostgreSQL 17",
  "Prisma 7",
  "Google Gemini",
  "Razorpay Test Mode",
  "Zod",
  "Vitest",
  "GitHub Actions",
] as const;

const CI_CHECKS = [
  "Lint (eslint + prettier)",
  "Type check (tsc)",
  "Tests on Ubuntu",
  "Tests on macOS",
  "Tests on Windows",
  "One-click setup on Ubuntu",
  "One-click setup on macOS",
  "One-click setup on Windows",
] as const;

/** Whole days from the first commit to the last, counting both. */
function daysBetween(first: string, last: string): number {
  const ms = Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Stat({
  value,
  label,
  note,
}: {
  readonly value: number;
  readonly label: string;
  readonly note: string;
}): React.JSX.Element {
  return (
    <li className="effort-stat">
      <span className="effort-value">
        <CountUp value={value} />
      </span>
      <span className="effort-label">{label}</span>
      <span className="effort-note">{note}</span>
    </li>
  );
}

export function ProjectEffort({
  stats,
}: {
  readonly stats: ProjectStats;
}): React.JSX.Element {
  const { git } = stats;
  return (
    <section id="work" className="chart-section" aria-labelledby="effort-heading">
      <h2 id="effort-heading" className="section-title">
        The work behind it
      </h2>
      <p className="section-lead">
        Every number here is counted from the code when the site is built, not written by
        hand. If a test is added tomorrow, the next build says so.
      </p>

      <ul className="effort-grid">
        <Stat
          value={stats.sourceLines}
          label="Lines of application code"
          note={`${String(stats.sourceFiles)} files, blank lines not counted`}
        />
        <Stat
          value={stats.testCases}
          label="Test cases written"
          note={`${String(stats.testFiles)} test files: unit tests, and tests against a real PostgreSQL`}
        />
        <Stat
          value={stats.testLines}
          label="Lines of tests"
          note={`${String(Math.round((stats.testLines / Math.max(1, stats.sourceLines)) * 100))} lines of test for every 100 lines of code`}
        />
        <Stat
          value={stats.documents.length}
          label="Design documents"
          note={`${stats.documentWords.toLocaleString("en-IN")} words explaining each decision`}
        />
        <Stat
          value={stats.migrations}
          label="Database migrations"
          note="Every schema change kept as reviewable history"
        />
        <Stat
          value={stats.apiEndpoints}
          label="API endpoints"
          note={`and ${String(stats.pages)} pages`}
        />
        {git === null ? null : (
          <>
            <Stat
              value={git.commits}
              label="Commits"
              note={`${formatDay(git.firstCommit)} to ${formatDay(git.lastCommit)}`}
            />
            <Stat
              value={daysBetween(git.firstCommit, git.lastCommit)}
              label="Days of work"
              note="From the first commit to the latest"
            />
          </>
        )}
      </ul>

      <div className="effort-columns">
        <div>
          <h3 className="mini-title">Checked on every push</h3>
          <ul className="check-list">
            {CI_CHECKS.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          <h3 className="mini-title">Built with</h3>
          <ul className="tag-list">
            {STACK.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mini-title">Every decision, written down</h3>
          <ol className="doc-index">
            {stats.documents.map((doc) => (
              <li key={doc.file}>
                <a href={`${REPOSITORY}/blob/main/docs/${doc.file}`}>{doc.title}</a>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
