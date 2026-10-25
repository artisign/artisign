// @vitest-environment jsdom
//
// CHR-920 — keyboard behaviour of the project dialogs: initial focus, the Tab trap, focus restore on every way out, arrow keys in the folder list.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProjectDialogs } from "./project-dialogs.js";

const HOME = "/Users/example";

function sectionHtml(withName) {
  return `
    <button class="dialog-close"></button>
    <button class="quick-chip" data-quick="home"></button>
    <button class="quick-chip" data-quick="workspace"></button>
    <div class="breadcrumbs"></div>
    <button class="btn-new-folder"></button>
    <div class="dir-list"></div>
    <span class="selection-path"></span>
    <p class="dialog-error"></p>
    ${withName ? '<input class="field-name-input" />' : ""}
    <button class="btn-cancel"></button>
    <button class="btn-confirm" disabled></button>`;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const keydown = (target, key, init = {}) => {
  const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(evt);
  return evt;
};

let scrimEl;
let openEl;
let initEl;
let opener;
let dialogs;
let entries;

beforeEach(() => {
  entries = [
    { name: "alpha", path: `${HOME}/alpha`, isArtisignProject: false },
    { name: "beta", path: `${HOME}/beta`, isArtisignProject: false },
    { name: "gamma", path: `${HOME}/gamma`, isArtisignProject: true },
  ];
  globalThis.fetch = vi.fn(async (url) => ({
    ok: true,
    json: async () => ({ path: new URL(url, "http://x").searchParams.get("path") ?? HOME, parent: null, entries, home: HOME }),
  }));
  document.body.innerHTML = '<button id="opener">open</button><div id="scrim" hidden><section id="o" hidden></section><section id="i" hidden></section></div>';
  scrimEl = document.getElementById("scrim");
  openEl = document.getElementById("o");
  initEl = document.getElementById("i");
  openEl.innerHTML = sectionHtml(false);
  initEl.innerHTML = sectionHtml(true);
  opener = document.getElementById("opener");
  dialogs = createProjectDialogs({ scrimEl, openSectionEl: openEl, initSectionEl: initEl }, { onOpen: async () => ({ ok: true }), onInit: async () => ({ ok: true }) });
});
afterEach(() => {
  delete globalThis.fetch;
});

async function openFromButton(which = "open") {
  opener.focus();
  if (which === "open") dialogs.showOpenDialog();
  else dialogs.showInitDialog();
  await settle();
}

describe("initial focus", () => {
  it("Open dialog: the first quick chip; New project dialog: the name field", async () => {
    await openFromButton("open");
    expect(document.activeElement).toBe(openEl.querySelector(".quick-chip"));
    dialogs.hide();
    await openFromButton("init");
    expect(document.activeElement).toBe(initEl.querySelector(".field-name-input"));
  });
});

describe("focus trap", () => {
  it("Tab past the last control wraps to the first, Shift+Tab before the first wraps to the last", async () => {
    await openFromButton("open");
    const tabbable = [...openEl.querySelectorAll("button:not([disabled]), input")];
    const first = tabbable[0];
    const last = tabbable[tabbable.length - 1];
    expect(first).toBe(openEl.querySelector(".dialog-close"));
    last.focus();
    expect(keydown(last, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(keydown(first, "Shift", {}).defaultPrevented).toBe(false);
    expect(keydown(first, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("leaves Tab alone between the ends and pulls focus in from outside", async () => {
    await openFromButton("open");
    const chip = openEl.querySelector(".quick-chip");
    chip.focus();
    expect(keydown(chip, "Tab").defaultPrevented).toBe(false);
    opener.focus();
    keydown(scrimEl, "Tab");
    expect(openEl.contains(document.activeElement)).toBe(true);
  });

  it("traps inside the visible dialog only", async () => {
    await openFromButton("init");
    const last = [...initEl.querySelectorAll("button:not([disabled]), input")].pop();
    last.focus();
    keydown(last, "Tab");
    expect(document.activeElement).toBe(initEl.querySelector(".dialog-close"));
  });
});

describe("focus restore", () => {
  it.each([
    ["Escape", () => keydown(document.body, "Escape")],
    ["the close button", () => openEl.querySelector(".dialog-close").click()],
    ["Cancel", () => openEl.querySelector(".btn-cancel").click()],
    ["a click on the scrim", () => scrimEl.dispatchEvent(new MouseEvent("click", { bubbles: true }))],
  ])("returns focus to the opener after %s", async (_name, close) => {
    await openFromButton("open");
    expect(document.activeElement).not.toBe(opener);
    close();
    expect(scrimEl.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("copes with an opener that is gone", async () => {
    await openFromButton("open");
    opener.remove();
    expect(() => dialogs.hide()).not.toThrow();
    expect(scrimEl.hidden).toBe(true);
  });
});

describe("folder list arrow keys", () => {
  const rows = () => [...openEl.querySelectorAll(".dir-row")];

  it("↑/↓ move between rows, Home/End jump, no wrap, Enter still navigates", async () => {
    await openFromButton("open");
    expect(rows().length).toBe(3);
    rows()[0].focus();
    keydown(rows()[0], "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    keydown(rows()[1], "End");
    expect(document.activeElement).toBe(rows()[2]);
    keydown(rows()[2], "ArrowDown");
    expect(document.activeElement).toBe(rows()[2]);
    keydown(rows()[2], "Home");
    expect(document.activeElement).toBe(rows()[0]);
    keydown(rows()[0], "ArrowUp");
    expect(document.activeElement).toBe(rows()[0]);
    rows()[0].click(); // what Enter does on a button
    await settle();
    expect(globalThis.fetch).toHaveBeenLastCalledWith(expect.stringContaining(encodeURIComponent(`${HOME}/alpha`)));
  });

  it("skips disabled rows (project folders in the New project dialog)", async () => {
    await openFromButton("init");
    const initRows = [...initEl.querySelectorAll(".dir-row")];
    expect(initRows[2].disabled).toBe(true);
    initRows[1].focus();
    keydown(initRows[1], "ArrowDown");
    expect(document.activeElement).toBe(initRows[1]);
  });

  it("leaves arrow keys in the inline New folder field alone", async () => {
    await openFromButton("open");
    openEl.querySelector(".btn-new-folder").click();
    const input = openEl.querySelector(".new-folder-input");
    input.focus();
    const evt = keydown(input, "ArrowDown");
    expect(evt.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});
