// @vitest-environment jsdom
//
// CHR-927 — the update notice (toast) and the update status in the settings menu's About group, wired in app.js.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { fakeSettings } from "./fake-settings.test-helper.js";
import { localDay } from "./update-notice.js";
import { makeNativePopover, installDialogStubs } from "./dialog-stub.test-helper.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  get length() { return memoryStorage.size; },
  key: (i) => [...memoryStorage.keys()][i] ?? null,
  clear: () => memoryStorage.clear(),
};

const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");

const DISMISSED = "artisign.updateNoticeDismissedOn";
const HOUR = 60 * 60 * 1000;

let settings;
let about; // the /api/about body; null = the request fails
let writeText;

function stubDaemon() {
  settings = fakeSettings();
  about = { version: "2.1.1", updateCheck: "on", latest: "2.2.0", updateAvailable: true };
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    const settingsRes = settings.handle(path, init);
    if (settingsRes) return settingsRes;
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/about") {
      if (!about) throw new Error("down");
      return json(about);
    }
    if (path === "/api/setup") return json({ command: "artisign setup", clients: [] });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: [] });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const toast = () => $("#update-toast");
// jsdom has no Popover API, so the fallback path is the default here: the toast is shown by `data-open`.
const shown = () => toast().hasAttribute("data-open");

async function boot() {
  await import("./app.js");
  await flush();
}

/** Fakes the clock and the hourly timer only; the real setTimeout keeps the awaits above working. */
function fakeClock(iso) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("localDay", () => {
  it("is the local calendar day, zero-padded", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDay(new Date(2026, 10, 30, 0, 0))).toBe("2026-11-30");
  });
});

describe("update toast", () => {
  it("shows for an available update, with the version and the copyable command", async () => {
    await boot();
    expect(shown()).toBe(true);
    expect($("#update-toast-title").textContent).toBe("artisign 2.2.0 is available");
    expect($("#update-toast-sub, .update-toast-sub").textContent).toBe("Run this in a terminal. It restarts artisign on the same port.");
    // The command sits in a compact code field; only its icon copies.
    expect($("#update-toast-command .code-field--compact .code-field-text").textContent).toBe("artisign update");
    const copy = $("#update-toast-command button");
    expect(copy.querySelector(".icon").textContent).toBe("content_copy");
    copy.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("artisign update");
    expect(copy.querySelector(".icon").textContent).toBe("check");
  });

  it("a clipboard that refuses shows an error mark and selects the command for a manual copy, then recovers", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await boot();
    const copy = $("#update-toast-command button");
    const glyph = copy.querySelector(".icon");
    copy.click();
    await flush();
    expect(glyph.textContent).toBe("error");
    expect(glyph.dataset.copyState).toBe("failed");
    expect(copy.dataset.tooltip).toMatch(/copy failed/i);
    expect(window.getSelection().toString()).toBe("artisign update");
    await new Promise((r) => setTimeout(r, 3100)); // the mark goes back by itself: the control is never stuck
    expect(glyph.textContent).toBe("content_copy");
    expect(copy.dataset.tooltip).toBe("Copy");
  });

  it("sits in the Notifications region as a manual popover, with a keyboard-reachable close button", async () => {
    await boot();
    const region = $("#toast-region");
    expect(region.tagName).toBe("SECTION");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Notifications");
    expect(toast().parentElement).toBe(region);
    expect(toast().getAttribute("popover")).toBe("manual"); // no light dismiss, never takes focus
    const close = $("#update-toast-close");
    expect(close.tagName).toBe("BUTTON");
    expect(close.getAttribute("aria-label")).toBe("Hide for today");
    expect(close.dataset.tooltip).toBe("Hide for today"); // the shared tooltip is a manual popover (top layer)
  });

  it("announces through one always-present polite status node, and only when the announced version changes", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    const live = $("#update-live");
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("artisign 2.2.0 is available");
    let mutations = 0;
    new MutationObserver((records) => (mutations += records.length)).observe(live, { childList: true, characterData: true, subtree: true });
    vi.advanceTimersByTime(HOUR); // the hourly re-read finds the same version
    await flush();
    $("#settings-trigger").click(); // so does opening the menu
    await flush();
    expect(mutations).toBe(0);
    about = { version: "2.1.1", updateCheck: "on", latest: "2.3.0", updateAvailable: true };
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(live.textContent).toBe("artisign 2.3.0 is available");
    expect(mutations).toBeGreaterThan(0);
  });

  it("closing it with the keyboard puts focus on the settings button, not on <body>", async () => {
    await boot();
    const close = $("#update-toast-close");
    close.focus();
    close.click();
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe($("#settings-trigger"));
  });

  it("stays hidden when nothing is available, the check is off, or about cannot be read", async () => {
    about = { version: "2.1.1", updateCheck: "on", latest: "2.1.1", updateAvailable: false };
    await boot();
    expect(shown()).toBe(false);
    vi.resetModules();
    document.body.innerHTML = bodyHtml;
    about = { version: "2.1.1", updateCheck: "off", updateAvailable: false };
    await boot();
    expect(shown()).toBe(false);
    vi.resetModules();
    document.body.innerHTML = bodyHtml;
    about = null;
    await boot();
    expect(shown()).toBe(false);
  });

  it("close hides it for today and stores the day in the daemon prefs", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    $("#update-toast-close").click();
    expect(shown()).toBe(false);
    await flush();
    expect(settings.prefs[DISMISSED]).toBe("2026-10-26|2.2.0");
  });

  it("stays hidden after a reload on the same day (the stored day wins), in any browser", async () => {
    fakeClock("2026-10-26T10:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26|2.2.0" }, migrated: true });
    await boot();
    expect(shown()).toBe(false);
  });

  it("shows again the next day", async () => {
    fakeClock("2026-10-27T08:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26|2.2.0" }, migrated: true });
    await boot();
    expect(shown()).toBe(true);
  });
});

describe("dismissal is per version", () => {
  it("a newer release found the same day shows again", async () => {
    fakeClock("2026-10-26T10:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26|2.1.9" }, migrated: true });
    await boot();
    expect(shown()).toBe(true);
  });

  it("an old date-only value counts as not matching", async () => {
    fakeClock("2026-10-26T10:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26" }, migrated: true });
    await boot();
    expect(shown()).toBe(true);
  });

  it("a newer version found by the hourly read reappears after dismissing the older one", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    $("#update-toast-close").click();
    expect(shown()).toBe(false);
    about = { version: "2.1.1", updateCheck: "on", latest: "2.3.0", updateAvailable: true };
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(true);
  });
});

describe("dismissal made elsewhere", () => {
  it("another tab's dismissal hides the toast at the next hourly read", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    expect(shown()).toBe(true);
    settings.prefs[DISMISSED] = "2026-10-26|2.2.0"; // written by another tab or browser
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(false);
  });

  it("and it stays hidden when this tab reads again", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    settings.prefs[DISMISSED] = "2026-10-26|2.2.0";
    vi.advanceTimersByTime(HOUR);
    await flush();
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(false);
  });

  it("opening the settings menu reads it too", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    settings.prefs[DISMISSED] = "2026-10-26|2.2.0";
    $("#settings-trigger").click();
    await flush();
    expect(shown()).toBe(false);
  });

  it("this tab's own dismissal is not undone by a read that predates it", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    $("#update-toast-close").click();
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(false);
    expect(settings.prefs[DISMISSED]).toBe("2026-10-26|2.2.0");
  });
});

describe("hourly re-read", () => {
  it("shows a version the daemon found after boot", async () => {
    fakeClock("2026-10-26T10:00:00");
    about = { version: "2.1.1", updateCheck: "on", latest: "2.1.1", updateAvailable: false };
    await boot();
    expect(shown()).toBe(false);
    about = { version: "2.1.1", updateCheck: "on", latest: "2.3.0", updateAvailable: true };
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(true);
    expect($("#update-toast-title").textContent).toBe("artisign 2.3.0 is available");
  });

  it("brings a notice dismissed yesterday back after midnight", async () => {
    fakeClock("2026-10-26T23:30:00");
    await boot();
    $("#update-toast-close").click();
    expect(shown()).toBe(false);
    vi.setSystemTime(new Date("2026-10-27T00:10:00"));
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(true);
  });

  it("keeps a dismissed notice hidden at the next hourly read the same day", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    $("#update-toast-close").click();
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(false);
  });

  it("a failed read keeps what is shown", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    about = null;
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(shown()).toBe(true);
  });
});

describe("About status in the settings menu", () => {
  const openMenu = async () => {
    $("#settings-trigger").click();
    await flush();
  };
  const status = () => $("#settings-update-status");

  it("up to date: check icon and the words", async () => {
    about = { version: "2.1.1", updateCheck: "on", latest: "2.1.1", updateAvailable: false };
    await boot();
    await openMenu();
    expect($("#settings-version").textContent).toBe("artisign 2.1.1");
    expect(status().hidden).toBe(false);
    expect($("#settings-update-icon").textContent).toBe("check_circle");
    expect($("#settings-update-text").textContent).toBe("Up to date");
    expect($("#settings-update-cmd").hidden).toBe(true);
  });

  it("update available: the version, and the command with a copy chip that is a row of the menu", async () => {
    await boot();
    await openMenu();
    expect($("#settings-update-icon").textContent).toBe("upgrade");
    expect($("#settings-update-text").textContent).toBe("Version 2.2.0 available");
    expect($("#settings-update-cmd").hidden).toBe(false);
    const chip = $("#settings-update-cmd button");
    expect(chip.getAttribute("role")).toBe("menuitem");
    expect($("#settings-update-cmd .code-field--compact")).not.toBeNull();
    $("#settings-mcp").focus();
    $("#settings-mcp").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(chip);
    chip.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("artisign update");
    expect($("#settings-menu").hasAttribute("data-open")).toBe(true); // copying never closes the menu
  });

  it("arrow order and the single tab stop include both the copy chip and What's New", async () => {
    await boot();
    await openMenu();
    const down = () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    $("#settings-mcp").focus();
    down();
    expect(document.activeElement).toBe($("#settings-update-cmd button"));
    down();
    expect(document.activeElement).toBe($("#settings-whats-new"));
    expect($$("#settings-menu button").filter((b) => b.tabIndex === 0)).toEqual([$("#settings-whats-new")]);
    down(); // wraps to the theme control
    expect(document.activeElement.dataset.themePref).toBeDefined();
  });

  it("the menu keeps showing the update after the toast was dismissed", async () => {
    await boot();
    $("#update-toast-close").click();
    await openMenu();
    expect($("#settings-update-text").textContent).toBe("Version 2.2.0 available");
  });

  it("update check off", async () => {
    about = { version: "2.1.1", updateCheck: "off", updateAvailable: false };
    await boot();
    await openMenu();
    expect($("#settings-update-icon").textContent).toBe("block");
    expect($("#settings-update-text").textContent).toBe("Update check off");
    expect($("#settings-update-cmd").hidden).toBe(true);
  });

  it("check on but nothing known yet: no status line", async () => {
    about = { version: "2.1.1", updateCheck: "on", updateAvailable: false };
    await boot();
    await openMenu();
    expect($("#settings-version").textContent).toBe("artisign 2.1.1");
    expect(status().hidden).toBe(true);
  });

  it("an older daemon without the update fields shows the version only", async () => {
    about = { version: "2.1.1" };
    await boot();
    await openMenu();
    expect(status().hidden).toBe(true);
    expect(shown()).toBe(false);
  });

  it("the status follows a later read when the menu is opened again", async () => {
    about = { version: "2.1.1", updateCheck: "on", latest: "2.1.1", updateAvailable: false };
    await boot();
    await openMenu();
    expect($("#settings-update-text").textContent).toBe("Up to date");
    $("#settings-trigger").click();
    about = { version: "2.1.1", updateCheck: "on", latest: "2.4.0", updateAvailable: true };
    await openMenu();
    expect($("#settings-update-text").textContent).toBe("Version 2.4.0 available");
  });
});

describe("with a modal dialog open", () => {
  const dialog = () => $("#whats-new-dialog");

  it("does not show over the dialog, and shows once the dialog has closed", async () => {
    installDialogStubs();
    about = { version: "2.1.1", updateCheck: "on", latest: "2.2.0", updateAvailable: false };
    await boot();
    dialog().showModal();
    about = { version: "2.1.1", updateCheck: "on", latest: "2.2.0", updateAvailable: true };
    $("#settings-trigger").click(); // a re-read finds the update while the dialog is up
    await flush();
    expect(shown()).toBe(false);
    expect($("#update-live").textContent).toBe("artisign 2.2.0 is available"); // announced, though not drawn yet
    dialog().close();
    expect(shown()).toBe(true);
  });

  it("a dismissed or withdrawn notice does not appear when the dialog closes", async () => {
    installDialogStubs();
    await boot();
    expect(shown()).toBe(true);
    $("#update-toast-close").click();
    dialog().showModal();
    dialog().close();
    expect(shown()).toBe(false);
  });
});

describe("native popover path", () => {
  /** The toast with the Popover API's surface: shown by showPopover(), never by a data attribute. */
  function nativeToast() {
    const popover = makeNativePopover($("#update-toast"));
    const calls = [];
    const show = toast().showPopover;
    const hide = toast().hidePopover;
    toast().showPopover = () => (calls.push("show"), show());
    toast().hidePopover = () => (calls.push("hide"), hide());
    return { popover, calls };
  }

  it("is shown with showPopover() once, not again on a re-read that finds the same, and hidden with hidePopover() on close", async () => {
    fakeClock("2026-10-26T10:00:00");
    document.body.innerHTML = bodyHtml;
    const { popover, calls } = nativeToast();
    await boot();
    expect(popover.isOpen()).toBe(true);
    expect(shown()).toBe(false); // no fallback attribute on the native path
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(calls).toEqual(["show"]);
    $("#update-toast-close").click();
    expect(popover.isOpen()).toBe(false);
    expect(calls).toEqual(["show", "hide"]);
  });
});

describe("stacking and place", () => {
  /** The declarations of the first rule that starts with the selector. */
  const rule = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    return css.slice(start, css.indexOf("}", start));
  };

  it("sits under the settings button where the design puts it (right 16, top 66, 360 wide) and above everything while shown", () => {
    const toastRule = rule(".update-toast");
    expect(toastRule).toMatch(/position: fixed/);
    expect(toastRule).toMatch(/right: var\(--space-xl\)/);
    expect(toastRule).toMatch(/top: 66px/);
    expect(toastRule).toMatch(/width: 360px/);
  });

  it("steps aside while the settings menu opens in the same spot", () => {
    expect(css).toMatch(/body:has\(#settings-menu:is\(:popover-open, \[data-open\]\)\) \.update-toast\s*\{\s*visibility: hidden/);
  });
});
