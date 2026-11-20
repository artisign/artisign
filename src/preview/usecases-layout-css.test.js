// Layout guards for the Use Cases sidebar and the example tables. jsdom has no layout engine, so these pin the CSS rules that
// keep the "+" inside the sidebar and the Field/Type cells whole; the real widths are checked in a browser (see CHR-1151 PR).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";

// vitest's css pipeline does not hand back raw stylesheet text, so read the file (tests run from the package root).
const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");

/** The declaration block of the one rule with exactly this selector. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `rule ${selector}`).not.toBeNull();
  return match[1];
}

describe("Use Cases sidebar sub-tab row", () => {
  it("keeps the add button at its full size, never squeezed out of the row", () => {
    expect(rule(".uc-subnav .chrome-icon-btn")).toMatch(/flex:\s*none/);
  });

  it("lets the four tabs give way with tight padding instead of pushing the button out", () => {
    const tab = rule(".uc-subtab");
    expect(tab).toMatch(/padding:\s*0 var\(--space-xs\)/);
    expect(tab).toMatch(/min-width:\s*0/);
    expect(tab).toMatch(/white-space:\s*nowrap/);
    expect(rule(".uc-subnav")).toMatch(/gap:\s*0/);
  });
});

describe("example tables", () => {
  it("keep Field and Type words whole and let only the last (Example) column break anywhere", () => {
    expect(rule(".uc-table td")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".uc-table td:not(:last-child)")).toMatch(/overflow-wrap:\s*normal/);
  });
});
