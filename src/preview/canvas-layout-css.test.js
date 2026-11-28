// CHR-1299 / CHR-1280 — layout guards for the full-window canvases. jsdom has no layout engine, so these pin the CSS rules the one layout model rests on; the real positions are checked in a browser (see the PR).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";

const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");

/** The declaration block of the one rule with exactly this selector. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `rule ${selector}`).not.toBeNull();
  return match[1];
}

describe("canvases fill the window; the cards float over them", () => {
  it("the Screens and Board canvases cover the whole window", () => {
    expect(rule("#screens-view")).toMatch(/inset:\s*0/);
    expect(rule("#board-view")).toMatch(/inset:\s*0/);
  });

  it("no card state feeds a canvas: the left reserve the canvases use is a constant", () => {
    expect(rule("#board-surface")).toMatch(/var\(--canvas-pad-left\)/);
    expect(rule("#board-surface")).not.toMatch(/--reserve-left/);
    expect(css).toMatch(/--canvas-pad-left:\s*356px/);
  });

  it("the zoom pill is anchored to the window, not to the canvas between the cards", () => {
    const pill = rule("#zoom-pill-wrap");
    expect(pill).toMatch(/left:\s*0/);
    expect(pill).toMatch(/right:\s*0/);
    expect(pill).not.toMatch(/--reserve/);
    expect(rule("#zoom-menu")).not.toMatch(/--reserve/);
  });

  it("the variant breadcrumb is centred on a point app.js sets, never on a card's edge", () => {
    const bar = rule("#variant-bar");
    expect(bar).toMatch(/left:\s*var\(--bar-center/);
    expect(bar).toMatch(/translateX\(-50%\)/);
    expect(bar).not.toMatch(/--reserve|--frame-left/);
  });
});
