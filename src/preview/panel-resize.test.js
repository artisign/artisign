import { describe, it, expect } from "vitest";
import { cwd } from "node:process";
import { clampPanelWidth, parsePanelWidth, LEFT_PANEL, RIGHT_PANEL } from "./panel-resize.js";

describe("clampPanelWidth", () => {
  it("keeps a width inside its limits and rounds it", () => {
    expect(clampPanelWidth(100, 220, 480)).toBe(220);
    expect(clampPanelWidth(900, 220, 480)).toBe(480);
    expect(clampPanelWidth(300.4, 220, 480)).toBe(300);
  });

  it("a cap below the minimum never pushes the width under the minimum", () => {
    expect(clampPanelWidth(400, 220, 100)).toBe(220);
  });
});

describe("parsePanelWidth", () => {
  it("reads a stored number and ignores anything else", () => {
    expect(parsePanelWidth("312")).toBe(312);
    for (const raw of [null, "", " ", "abc", "-5", "0", "NaN"]) expect(parsePanelWidth(raw), String(raw)).toBeNull();
  });
});

describe("the default widths are the stylesheet's", () => {
  it("LEFT_PANEL and RIGHT_PANEL default to --size-nav-card and --size-agent-bar", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");
    expect(css).toMatch(new RegExp(`--size-nav-card:\\s*${LEFT_PANEL.defaultWidth}px`));
    expect(css).toMatch(new RegExp(`--size-agent-bar:\\s*${RIGHT_PANEL.defaultWidth}px`));
    expect(RIGHT_PANEL.min).toBeLessThanOrEqual(RIGHT_PANEL.defaultWidth);
    expect(LEFT_PANEL.min).toBeLessThanOrEqual(LEFT_PANEL.defaultWidth);
  });
});

describe("a resize never reaches the canvases", () => {
  it("the Screens and Board pads and the breadcrumb's centring do not read the panel width variables", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");
    const block = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/[#.]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    for (const selector of ["#screens-view", "#board-surface", "#compare-view"]) {
      expect(block(selector), selector).not.toMatch(/--panel-|--size-nav-card|--size-agent-bar/);
    }
    expect(css).toMatch(/--reserve-right:\s*calc\(var\(--size-agent-bar\)/); // stays the constant the canvases use
  });
});
