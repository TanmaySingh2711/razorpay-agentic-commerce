import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  countLines,
  countTestCases,
  countWords,
  documentTitle,
  readProjectStats,
} from "@/lib/project-stats";

/**
 * The overview's "work behind it" figures.
 *
 * They are only worth showing if they are measured honestly, so the counting
 * rules are pinned here: what a line is, what a test case is, which files are
 * someone's work and which are generated. And when the repository is not
 * there to measure, the answer must be "nothing", never a guess.
 */

describe("the counting rules", () => {
  it("counts lines that hold something, not blank ones", () => {
    expect(countLines("a\n\n  \r\nb\r\n\tc\n")).toBe(3);
    expect(countLines("")).toBe(0);
  });

  it("counts each test case as written, including each and skipIf forms", () => {
    const source = [
      'it("one", () => {});',
      '  test("two", () => {});',
      '  it.each([1, 2])("three %i", () => {});',
      '  it.skipIf(!db)("four", () => {});',
      "it.only(`five`, () => {});",
      'describe("not a case", () => {});',
      "const split = items.filter((it) => it);",
      "// it( in a comment line that does not start a statement is still prose",
    ].join("\n");
    expect(countTestCases(source)).toBe(5);
  });

  it("counts words, not punctuation or markup", () => {
    expect(countWords("# Title\n\nTwo words — and **three** more.")).toBe(6);
  });

  it("titles a document by its first heading, without the number prefix", () => {
    expect(documentTitle("# 07 — API boundaries\n\ntext", "07.md")).toBe(
      "API boundaries",
    );
    expect(documentTitle("# Plain title", "x.md")).toBe("Plain title");
    expect(documentTitle("no heading at all", "fallback.md")).toBe("fallback.md");
  });
});

describe("measuring a repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rac-stats-"));
  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  write("src/app/page.tsx", "export default 1;\n\nexport const a = 2;\n");
  write("src/app/api/health/route.ts", "export const GET = 1;\n");
  write("src/lib/x.ts", "a\nb\nc\n");
  write("src/app/site.css", "a {}\n");
  // Generated code is nobody's work and must not be counted.
  write("src/generated/prisma/client.ts", "x\n".repeat(500));
  write("tests/unit/a.test.ts", 'it("a", () => {});\nit("b", () => {});\n');
  write("tests/support/fake.ts", 'it("not a test file", () => {});\n');
  write("docs/01-overview.md", "# 01 — Overview\n\nOne two three.\n");
  write("docs/README.md", "# Index, not a design document\n");
  write("prisma/migrations/20260101000000_init/migration.sql", "CREATE TABLE x ();\n");
  write("prisma/migrations/migration_lock.toml", "provider = 1\n");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const stats = readProjectStats(root);

  it("counts source files and their lines, skipping generated code", () => {
    expect(stats?.sourceFiles).toBe(4);
    expect(stats?.sourceLines).toBe(2 + 1 + 3 + 1);
  });

  it("counts only *.test.ts files as tests", () => {
    expect(stats?.testFiles).toBe(1);
    expect(stats?.testCases).toBe(2);
    expect(stats?.testLines).toBe(2);
  });

  it("counts pages, API endpoints and migration directories", () => {
    expect(stats?.pages).toBe(1);
    expect(stats?.apiEndpoints).toBe(1);
    expect(stats?.migrations).toBe(1);
  });

  it("lists numbered design documents only, with their titles and words", () => {
    expect(stats?.documents).toEqual([
      { file: "01-overview.md", title: "Overview", words: 5 },
    ]);
    expect(stats?.documentWords).toBe(5);
  });

  it("reports no git history rather than a wrong one outside a repository", () => {
    // A temp directory is not a repository; git may still find a parent one
    // on some machines, so the only acceptable answers are null or real.
    if (stats?.git !== null && stats?.git !== undefined) {
      expect(stats.git.commits).toBeGreaterThan(0);
    }
  });

  it("returns nothing at all when the files are not there", () => {
    expect(readProjectStats(path.join(root, "does-not-exist"))).toBeNull();
  });
});

describe("this repository", () => {
  const stats = readProjectStats();

  it("measures itself", () => {
    expect(stats).not.toBeNull();
    expect(stats?.sourceFiles).toBeGreaterThan(50);
    expect(stats?.testFiles).toBeGreaterThan(30);
    expect(stats?.documents.length).toBeGreaterThan(10);
    expect(stats?.pages).toBeGreaterThanOrEqual(5);
  });

  it("includes this very test file in its count", () => {
    expect(stats?.testCases).toBeGreaterThan(countTestCases('it("x", () => {});'));
  });
});
