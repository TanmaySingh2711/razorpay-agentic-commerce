import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Invariants of the stylesheet, asserted the way the rest of this repository
 * asserts things: deterministically, with no browser.
 *
 * ## The bug this exists to stop happening again
 *
 * The "Find" button once looked dead in dark mode. Nothing was broken in the
 * markup and nothing was broken in the component - the hover state was written
 * as a swap from `var(--accent)` to `var(--rzp-blue)`, which is a real colour
 * change in light mode and *no change at all* in dark mode, because dark mode
 * defines `--accent: var(--rzp-blue)`. The two tokens are different names for
 * the same colour in exactly one theme, and the state that depended on them
 * differing silently disappeared there.
 *
 * That class of defect is invisible to typecheck, invisible to lint, and
 * invisible to anyone testing in the theme where it happens to work. It is
 * visible to arithmetic, which is what this file does: it resolves the token
 * graph per theme and refuses any interactive state whose "changed" value is
 * the same colour as the value it replaced.
 *
 * The rule that follows from it, and which the styles now obey: build a state
 * change *relative* to the current token (`color-mix` against it), never by
 * swapping in a second token that might be its alias.
 */

const GLOBALS = readFileSync("src/app/globals.css", "utf8");
const UI = readFileSync("src/app/ui.css", "utf8");

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--name: value;` pairs inside one slice of CSS. */
function tokenMap(slice: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of stripComments(slice).matchAll(
    /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g,
  )) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    map.set(name, value.trim());
  }
  return map;
}

const darkStart = GLOBALS.indexOf("@media (prefers-color-scheme: dark)");
const LIGHT = tokenMap(GLOBALS.slice(0, darkStart));
// Dark mode redefines a subset; anything it does not name keeps its light value.
const DARK = new Map([...LIGHT, ...tokenMap(GLOBALS.slice(darkStart))]);

/** Follows `var(--a)` chains to the literal underneath. */
function resolve(theme: Map<string, string>, value: string, depth = 0): string {
  if (depth > 8) return value;
  const alias = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value.trim());
  const name = alias?.[1];
  if (name === undefined) return value.trim();
  const next = theme.get(name);
  return next === undefined ? value.trim() : resolve(theme, next, depth + 1);
}

/**
 * Every declaration that applies to a selector, cascaded.
 *
 * A control's look is assembled from more than one rule - the shared
 * `.primary, .secondary` block sets the geometry, the specific block sets the
 * colours - so reading only the first matching rule would report a resting
 * colour of "undefined" for a button that plainly has one. Later declarations
 * overwrite earlier ones, which is the cascade for rules of equal specificity.
 */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The selector may sit anywhere in a comma-separated list: at the start
  // (followed by a comma), in the middle, or last (followed by the brace).
  const rules = new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`, "gm");
  const merged = new Map<string, string>();
  for (const rule of stripComments(css).matchAll(rules)) {
    const body = rule[1];
    if (body === undefined) continue;
    for (const [property, value] of tokenDecls(body)) merged.set(property, value);
  }
  return merged;
}

function tokenDecls(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of body.split(";")) {
    const [prop, ...rest] = line.split(":");
    if (prop === undefined || rest.length === 0) continue;
    map.set(prop.trim(), rest.join(":").trim());
  }
  return map;
}

/** Every custom property the stylesheets actually consume. */
function referencedTokens(): Set<string> {
  const referenced = new Set<string>();
  for (const css of [GLOBALS, UI]) {
    for (const match of stripComments(css).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const name = match[1];
      if (name !== undefined) referenced.add(name);
    }
  }
  return referenced;
}

describe("the token graph", () => {
  it("defines every custom property the stylesheets reference", () => {
    const referenced = referencedTokens();
    const missing = [...referenced].filter((name) => !LIGHT.has(name) && !DARK.has(name));
    expect(missing).toEqual([]);
  });

  it("references every custom property it defines", () => {
    const referenced = referencedTokens();
    // A token nothing consumes is dead weight that later reads as a supported
    // choice. Delete it, or use it.
    const dead = [...LIGHT.keys()].filter((name) => !referenced.has(name));
    expect(dead).toEqual([]);
  });

  it("gives dark mode no token that light mode never defined", () => {
    const orphans = [...tokenMap(GLOBALS.slice(darkStart)).keys()].filter(
      (name) => !LIGHT.has(name),
    );
    expect(orphans).toEqual([]);
  });
});

describe("interactive states stay visible in both themes", () => {
  /**
   * The heart of it. For each control, the resting declaration and the state
   * declaration are resolved in light and in dark; a state that lands on the
   * identical literal is a state that does not exist for that theme's users.
   */
  const CASES = [
    { control: ":where(button, a).primary", state: "hover", property: "background" },
    { control: ":where(button, a).primary", state: "active", property: "background" },
    { control: ":where(button, a).secondary", state: "hover", property: "color" },
    { control: ":where(button, a).secondary", state: "hover", property: "border-color" },
  ] as const;

  for (const { control, state, property } of CASES) {
    it(`changes ${property} on ${state} for ${control} in light and dark`, () => {
      const resting = declarationsOf(UI, control).get(property);
      const changed = declarationsOf(UI, `${control}:${state}:not(:disabled)`).get(
        property,
      );

      expect(resting, `${control} must declare a resting ${property}`).toBeDefined();
      expect(changed, `${control}:${state} must declare ${property}`).toBeDefined();

      for (const [themeName, theme] of [
        ["light", LIGHT],
        ["dark", DARK],
      ] as const) {
        const before = resolve(theme, resting as string);
        const after = resolve(theme, changed as string);
        expect(
          after,
          `${control}:${state} leaves ${property} unchanged in ${themeName} mode — ` +
            `both resolve to ${before}. Build the state relative to the token ` +
            `(color-mix) instead of swapping in another token.`,
        ).not.toBe(before);
      }
    });
  }

  it("builds the primary button's states relative to its own accent", () => {
    // Pins the fix itself, not just its effect: a relative blend cannot become
    // an accidental alias of the resting colour in some future theme.
    for (const state of ["hover", "active"] as const) {
      const changed = declarationsOf(
        UI,
        `:where(button, a).primary:${state}:not(:disabled)`,
      ).get("background");
      expect(changed).toMatch(/color-mix\(in srgb,\s*var\(--accent\)/);
    }
  });
});

describe("every control can be operated without a mouse or a guess", () => {
  it("gives buttons, links and disclosure controls a visible focus ring", () => {
    const focus =
      /button:focus-visible,\s*a:focus-visible,\s*summary:focus-visible\s*\{([^}]*)\}/.exec(
        stripComments(UI),
      );
    expect(focus, "a shared :focus-visible rule must exist").not.toBeNull();
    const declarations = tokenDecls(focus?.[1] ?? "");
    expect(declarations.get("outline")).toBeDefined();
    // `outline: none` with nothing replacing it is the accessibility failure
    // this assertion exists to prevent.
    expect(declarations.get("outline")).not.toBe("none");
  });

  it("marks a disabled button as disabled rather than merely inert", () => {
    const disabled = declarationsOf(UI, "button:disabled");
    expect(disabled.get("opacity")).toBeDefined();
    expect(Number(disabled.get("opacity"))).toBeLessThan(1);
    expect(disabled.get("cursor")).toBeDefined();
  });
});
