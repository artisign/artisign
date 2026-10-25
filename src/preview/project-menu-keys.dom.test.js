// @vitest-environment jsdom
//
// CHR-920 review: the project menu keeps keyboard focus across a re-render while it is open (an SSE project event rebuilds the rows).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { createProjectUI } from "./projects.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));
const $ = (id) => document.getElementById(id);

let ui;
let documentListeners = [];
const nativeAddEventListener = document.addEventListener.bind(document);

beforeEach(() => {
  document.body.innerHTML = bodyHtml;
  documentListeners = [];
  document.addEventListener = (type, fn, opts) => {
    documentListeners.push([type, fn, opts]);
    nativeAddEventListener(type, fn, opts);
  };
  ui = createProjectUI(
    {
      triggerEl: $("project-picker-trigger"),
      nameEl: $("project-picker-name"),
      menuEl: $("project-menu"),
      openLabelEl: $("menu-label-open"),
      openListEl: $("menu-open-list"),
      dividerEl: $("menu-divider-1"),
      recentLabelEl: $("menu-label-recent"),
      recentListEl: $("menu-recent-list"),
      actionOpenEl: $("menu-action-open"),
      actionInitEl: $("menu-action-init"),
      noProjectEl: $("no-project-state"),
      bodyEl: $("body"),
      topbarEl: $("topbar"),
      emptyRecentListEl: $("empty-recent-list"),
      emptyBtnOpenEl: $("empty-btn-open"),
      emptyBtnInitEl: $("empty-btn-init"),
    },
    { onSwitch() {}, onOpenRecent() {}, onOpenDialog() {}, onInitDialog() {} },
  );
});
afterEach(() => {
  for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
  document.addEventListener = nativeAddEventListener;
});

const state = (open, recent = []) => ({ active: open[0], open: open.map((root) => ({ root, name: root.slice(1) })), recent });
const rows = () => [...document.querySelectorAll("#project-menu button.chrome-menu-item")];

describe("re-render while the menu is open", () => {
  it("keeps focus on the same project row and re-applies the roving tab stop", () => {
    ui.render(state(["/a", "/b", "/c"]));
    $("project-picker-trigger").click();
    rows()[2].focus();
    ui.render(state(["/a", "/b", "/c"], ["/r"])); // e.g. a lifecycle event added a recent entry
    expect(document.activeElement.dataset.key).toBe("/c");
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([document.activeElement]);
  });

  it("falls back to the first row when the focused project is gone", () => {
    ui.render(state(["/a", "/b", "/c"]));
    $("project-picker-trigger").click();
    rows()[2].focus();
    ui.render(state(["/a", "/b"]));
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0].tabIndex).toBe(0);
  });

  it("leaves focus alone when it is not in the project rows (an action row, or the menu is closed)", () => {
    ui.render(state(["/a", "/b"]));
    $("project-picker-trigger").click();
    $("menu-action-open").focus();
    ui.render(state(["/a", "/b", "/c"]));
    expect(document.activeElement).toBe($("menu-action-open"));
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([$("menu-action-open")]); // the roving stop stays on the focused action row
    $("project-picker-trigger").click(); // close
    const outside = $("flow-mode-toggle");
    outside.focus();
    ui.render(state(["/a"]));
    expect(document.activeElement).toBe(outside);
  });
});
