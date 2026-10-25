import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The two "start the app" launchers: run_dashboard.bat (with its PowerShell
 * half) for Windows, and run_dashboard.sh for macOS and Linux.
 *
 * Neither is exercised by the suite end to end - each opens a browser and
 * waits for a key - so what can break them quietly is checked here: a shell
 * script that does not parse, Windows line endings in it (bash then fails on
 * every line), syntax the bash 3.2 that macOS ships cannot run, and the two
 * launchers drifting apart in what they prepare.
 */

const SH = "run_dashboard.sh";
const PS1 = "scripts/run-dashboard.ps1";

function hasBash(): boolean {
  return spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
}

describe("run_dashboard.sh", () => {
  const text = readFileSync(SH, "utf8");

  it("is a bash script with Unix line endings", () => {
    expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(text).not.toContain("\r");
  });

  it("parses", () => {
    // Bash is part of Git on Windows and of every CI runner. A machine
    // without it cannot run this script either, so there is nothing to check
    // there - but CI must always check.
    if (!hasBash()) {
      expect(process.env["CI"] ?? "").toBe("");
      return;
    }
    const result = spawnSync("bash", ["-n", SH], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("runs on the bash 3.2 macOS ships", () => {
    // 3.2 accepts only whole seconds for `read -t`, and has no mapfile or
    // associative arrays.
    expect(text).not.toMatch(/read[^\n]*-t\s*0?\.\d/);
    expect(text).not.toMatch(/\bmapfile\b|\breadarray\b|declare -A/);
  });
});

describe("the two launchers", () => {
  it("prepare the same pages in the background", () => {
    const shPages = /^WARM_PAGES="([^"]+)"/m.exec(readFileSync(SH, "utf8"))?.[1];
    const ps1 = readFileSync(PS1, "utf8");
    const noSuchPurchase = /^\$NoSuchPurchase = "([^"]+)"/m.exec(ps1)?.[1];
    const ps1Pages = /^\$WarmPages = @\(([^)]+)\)/m
      .exec(ps1)?.[1]
      ?.split(",")
      .map((page) => page.trim())
      .map((page) =>
        page === "$NoSuchPurchase" ? (noSuchPurchase ?? page) : page.replace(/"/g, ""),
      );

    expect(shPages?.split(" ")).toEqual(ps1Pages);
  });
});
