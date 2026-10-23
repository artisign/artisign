// @vitest-environment jsdom
//
// CHR-911 — the menus, dialogs and empty states carry Material Symbols, not emoji or Unicode glyph icons, and their interactive rows are real buttons (Tab-reachable, so the focus ring applies). The dynamically rendered rows are covered in project-picker-app.dom.test.js and project-dialogs.dom.test.js; this pins the static markup.
import { describe, it, expect } from "vitest";
import html from "./index.html?raw";

// Emoji, dingbats (check marks), the fullwidth plus, and the small triangles the old chrome used as icons.
const GLYPH_ICON = /[\u{1F300}-\u{1FAFF}☀-➿＋▸▾]/u;

const doc = new DOMParser().parseFromString(html, "text/html");

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

  it("has no dialog close button and no '+' prefix on New folder", () => {
    for (const dialog of doc.querySelectorAll(".project-dialog")) {
      expect(dialog.querySelector("[aria-label*='lose']")).toBeNull();
      expect(dialog.querySelector(".btn-new-folder").textContent.trim()).toBe("create_new_folderNew folder");
    }
  });
});
