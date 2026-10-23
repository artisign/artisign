// @vitest-environment jsdom
//
// CHR-911 — the menus, dialogs and empty states carry Material Symbols, not emoji or Unicode glyph icons, and their interactive rows are real buttons (Tab-reachable, so the focus ring applies). The dynamically rendered rows are covered in project-picker-app.dom.test.js and project-dialogs.dom.test.js; this pins the static markup.
import { describe, it, expect } from "vitest";
import html from "./index.html?raw";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";

// Emoji, dingbats (check marks), the fullwidth plus, and the small triangles the old chrome used as icons.
const GLYPH_ICON = /[\u{1F300}-\u{1FAFF}☀-➿＋▸▾]/u;

const doc = new DOMParser().parseFromString(html, "text/html");

// vitest's css pipeline does not hand back raw stylesheet text, so read the file (tests run from the package root).
const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");

describe("floating surfaces and empty states in index.html", () => {
  const surfaces = ["#project-menu", "#no-project-state", "#open-project-dialog", "#init-project-dialog", "#empty-guide"];

  for (const selector of surfaces) {
    it(`${selector} has no glyph icons`, () => {
      const el = doc.querySelector(selector);
      expect(el).not.toBeNull();
      expect(el.textContent).not.toMatch(GLYPH_ICON);
    });
  }

  it("uses Material Symbols for the menu actions, the empty state and the quick chips", () => {
    const icons = (selector) => [...doc.querySelectorAll(`${selector} .icon`)].map((i) => i.textContent);
    expect(icons("#project-menu")).toEqual(["folder_open", "add"]);
    expect(icons("#no-project-state")).toEqual(["folder_open"]);
    expect(icons("#open-project-dialog .quick-access")).toEqual(["home", "folder_special", "desktop_windows"]);
  });

  it("has an icon close button and no '+' prefix on New folder", () => {
    for (const dialog of doc.querySelectorAll(".project-dialog")) {
      const close = dialog.querySelector(".dialog-close");
      expect(close.getAttribute("aria-label")).toBe("Close");
      expect(close.dataset.tooltip).toBe("Close");
      expect(close.classList.contains("chrome-icon-btn--sm")).toBe(true);
      expect(close.querySelector(".icon").textContent).toBe("close");
      expect(dialog.querySelector(".btn-new-folder").textContent.trim()).toBe("create_new_folderNew folder");
    }
  });

  it("the close button gets the shared keyboard focus ring", () => {
    expect(css).toMatch(/\.chrome-icon-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--chrome-focus-ring\)/);
  });
});
