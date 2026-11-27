// CHR-1267 — the shell's new chrome tokens are the design system's, by value and by role name (the design project `design/design-system/tokens.json` is the source; style.css mirrors it as custom properties for light and dark).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";

const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");
const tokens = JSON.parse(readFileSync(resolve(cwd(), "design/design-system/tokens.json"), "utf8"));

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(selector) {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `rule ${selector}`).toBeGreaterThan(-1);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const map = new Map();
  for (const match of body.matchAll(/^\s*(--[\w-]+):\s*(.+?);\s*$/gm)) map.set(match[1], match[2]);
  return map;
}
const norm = (value) => value.replaceAll(/\s+/g, " ").trim().toLowerCase();

const CHROME = ["workspace", "workspace-dot", "float", "shadow-card", "shadow-frame", "shadow-raised", "hint", "hint-text", "agent", "agent-subtle", "cluster"];

describe.each([
  ["light", ":root", "chrome-light"],
  ["dark", ':root[data-theme="dark"]', "chrome-dark"],
])("chrome tokens, %s", (_name, selector, group) => {
  const vars = declarations(selector);
  it.each(CHROME)("--chrome-%s mirrors %s.<role> by value", (role) => {
    expect(tokens[group][role], `${group}.${role} in the design system`).toBeDefined();
    expect(norm(vars.get(`--chrome-${role}`) ?? ""), `--chrome-${role}`).toBe(norm(tokens[group][role]));
  });
});

describe("themeless chrome scales", () => {
  const vars = declarations(":root");
  it.each(["card", "item", "frame", "inset"])("--radius-%s mirrors radius.%s", (role) => {
    expect(vars.get(`--radius-${role}`)).toBe(tokens.radius[role]);
  });
  it.each(["tool", "toolbar", "float-control", "field-lg", "tag", "nav-card", "agent-bar", "dot-grid"])("--size-%s mirrors size.%s", (role) => {
    expect(vars.get(`--size-${role}`)).toBe(tokens.size[role]);
  });
});
