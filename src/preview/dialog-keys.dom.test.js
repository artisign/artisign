// @vitest-environment jsdom
//
// CHR-920 / CHR-1272 — keyboard behaviour of the project dialogs (native modal <dialog>s): initial focus, focus return on every way out, the folder listbox's arrow keys and roving tab stop. The Tab trap itself is the browser's (showModal makes the rest of the page inert); only what this code adds is tested.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProjectDialogs } from "./project-dialogs.js";
import { installDialogStubs, pressEscape, clickScrim } from "./dialog-stub.test-helper.js";
import { mountProjectDialogs } from "./project-dialogs.test-helper.js";

const HOME = "/Users/example";

const settle = () => new Promise((r) => setTimeout(r, 0));
const keydown = (target, key, init = {}) => {
  const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(evt);
  return evt;
};

let openEl;
let initEl;
let opener;
let dialogs;
let entries;

beforeEach(() => {
  installDialogStubs();
  entries = [
    { name: "alpha", path: `${HOME}/alpha`, isArtisignProject: false },
    { name: "beta", path: `${HOME}/beta`, isArtisignProject: false },
    { name: "gamma", path: `${HOME}/gamma`, isArtisignProject: true },
  ];
  globalThis.fetch = vi.fn(async (url) => ({
    ok: true,
    json: async () => ({ path: new URL(url, "http://x").searchParams.get("path") ?? HOME, parent: null, entries, home: HOME }),
  }));
  document.body.innerHTML = '<button id="opener">open</button>';
  ({ openEl, initEl } = mountProjectDialogs());
  opener = document.getElementById("opener");
  dialogs = createProjectDialogs({ openDialogEl: openEl, initDialogEl: initEl }, { onOpen: async () => ({ ok: true }), onInit: async () => ({ ok: true }) });
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
  it("Open dialog: the first Places chip (autofocus); New project dialog: the name field (autofocus)", async () => {
    expect(openEl.querySelector("[autofocus]")).toBe(openEl.querySelector(".quick-chip"));
    expect(initEl.querySelector("[autofocus]")).toBe(initEl.querySelector(".text-field-input"));
    await openFromButton("open");
    expect(document.activeElement).toBe(openEl.querySelector(".quick-chip"));
    dialogs.hide();
    await openFromButton("init");
    expect(document.activeElement).toBe(initEl.querySelector(".text-field-input"));
  });
});

describe("focus restore", () => {
  it.each([
    ["Escape", () => pressEscape(openEl)],
    ["the close button", () => openEl.querySelector(".dialog-close").click()],
    ["Cancel", () => openEl.querySelector(".btn-cancel").click()],
    ["a click on the scrim", () => clickScrim(openEl)],
  ])("returns focus to the opener after %s", async (_name, close) => {
    await openFromButton("open");
    expect(document.activeElement).not.toBe(opener);
    close();
    expect(openEl.open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("copes with an opener that is gone", async () => {
    await openFromButton("open");
    opener.remove();
    expect(() => dialogs.hide()).not.toThrow();
    expect(openEl.open).toBe(false);
  });

  it("falls back to the given element when the opener is hidden by the time the dialog closes", async () => {
    const fallback = document.createElement("button");
    document.body.append(fallback);
    document.body.innerHTML = '<button id="opener">open</button>';
    document.body.append(fallback);
    ({ openEl, initEl } = mountProjectDialogs());
    dialogs = createProjectDialogs({ openDialogEl: openEl, initDialogEl: initEl, fallbackFocusEl: fallback }, { onOpen: async () => ({ ok: true }), onInit: async () => ({ ok: true }) });
    const holder = document.createElement("div");
    const emptyStateButton = document.createElement("button");
    holder.append(emptyStateButton);
    document.body.append(holder);
    emptyStateButton.focus();
    dialogs.showOpenDialog();
    await settle();
    holder.hidden = true; // the no-project state disappears once a project opened
    dialogs.hide();
    expect(document.activeElement).toBe(fallback);
  });
});

describe("folder listbox keys", () => {
  const rows = () => [...openEl.querySelectorAll(".dir-row")];

  it("↑/↓ move between options, Home/End jump, no wrap, Enter / Space act like a click", async () => {
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
    const enter = keydown(rows()[0], "Enter"); // enters the folder, like a click
    expect(enter.defaultPrevented).toBe(true);
    await settle();
    expect(globalThis.fetch).toHaveBeenLastCalledWith(expect.stringContaining(encodeURIComponent(`${HOME}/alpha`)));
  });

  it("Enter on a project folder (Open mode) selects it and Space does too", async () => {
    await openFromButton("open");
    rows()[2].focus();
    keydown(rows()[2], "Enter");
    expect(rows()[2].getAttribute("aria-selected")).toBe("true");
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(false);
    keydown(rows()[0], " ");
    await settle(); // Space on a plain folder enters it
    expect(globalThis.fetch).toHaveBeenLastCalledWith(expect.stringContaining(encodeURIComponent(`${HOME}/alpha`)));
  });

  it("one tab stop: the first option (or the selected one) has tabindex 0, the rest -1, and it follows the focus", async () => {
    await openFromButton("open");
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    rows()[1].focus();
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("skips inert options (project folders in the New project dialog)", async () => {
    await openFromButton("init");
    const initRows = [...initEl.querySelectorAll(".dir-row")];
    expect(initRows[2].getAttribute("aria-disabled")).toBe("true");
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

describe("folder navigation keeps keyboard focus in the dialog", () => {
  const rows = () => [...openEl.querySelectorAll(".dir-row")];

  it("Enter on a folder row, then the arrows still work in the rebuilt list", async () => {
    await openFromButton("open");
    rows()[0].focus();
    rows()[0].click();
    await settle();
    expect(document.activeElement).toBe(rows()[0]); // the list was rebuilt, focus is on its first row
    keydown(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("focus in the inline New folder field falls back to the first folder row when the list is rebuilt", async () => {
    await openFromButton("open");
    openEl.querySelector(".btn-new-folder").click();
    const input = openEl.querySelector(".new-folder-input");
    input.focus();
    entries = [{ name: "other", path: `${HOME}/other`, isArtisignProject: false }];
    openEl.querySelector('.quick-chip[data-quick="home"]').click(); // navigates without moving focus
    await settle();
    expect(document.activeElement).toBe(openEl.querySelector(".dir-row"));
  });

  it("an empty folder moves focus to the New folder button, not <body>", async () => {
    await openFromButton("open");
    const row = openEl.querySelector(".dir-row");
    row.focus();
    entries = [];
    row.click();
    await settle();
    expect(document.activeElement).toBe(openEl.querySelector(".btn-new-folder"));
    expect(openEl.querySelector(".dir-list").hasAttribute("tabindex")).toBe(false);
  });
});
