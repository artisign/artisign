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
const toast = () => $("#update-toast");

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
    expect(toast().hidden).toBe(false);
    expect($("#update-toast-title").textContent).toBe("Artisign 2.2.0 is available");
    const chip = $("#update-toast-command button");
    expect(chip.textContent.replace("content_copy", "")).toBe("artisign update");
    chip.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("artisign update");
    expect(chip.querySelector(".icon").textContent).toBe("check");
  });

  it("is a polite live region, outside the layout flow, with a keyboard-reachable close button", async () => {
    await boot();
    const region = $("#update-notice");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.parentElement.id).toBe("main");
    const close = $("#update-toast-close");
    expect(close.tagName).toBe("BUTTON");
    expect(close.getAttribute("aria-label")).toBe("Hide for today");
    expect(close.dataset.tooltip).toBe("Hide for today");
  });

  it("stays hidden when nothing is available, the check is off, or about cannot be read", async () => {
    about = { version: "2.1.1", updateCheck: "on", latest: "2.1.1", updateAvailable: false };
    await boot();
    expect(toast().hidden).toBe(true);
    vi.resetModules();
    document.body.innerHTML = bodyHtml;
    about = { version: "2.1.1", updateCheck: "off", updateAvailable: false };
    await boot();
    expect(toast().hidden).toBe(true);
    vi.resetModules();
    document.body.innerHTML = bodyHtml;
    about = null;
    await boot();
    expect(toast().hidden).toBe(true);
  });

  it("close hides it for today and stores the day in the daemon prefs", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    $("#update-toast-close").click();
    expect(toast().hidden).toBe(true);
    await flush();
    expect(settings.prefs[DISMISSED]).toBe("2026-10-26|2.2.0");
  });

  it("stays hidden after a reload on the same day (the stored day wins), in any browser", async () => {
    fakeClock("2026-10-26T10:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26|2.2.0" }, migrated: true });
    await boot();
    expect(toast().hidden).toBe(true);
  });

  it("shows again the next day", async () => {
    fakeClock("2026-10-27T08:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26|2.2.0" }, migrated: true });
    await boot();
    expect(toast().hidden).toBe(false);
  });
});

describe("dismissal is per version", () => {
  it("a newer release found the same day shows again", async () => {
    fakeClock("2026-10-26T10:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26|2.1.9" }, migrated: true });
    await boot();
    expect(toast().hidden).toBe(false);
  });

  it("an old date-only value counts as not matching", async () => {
    fakeClock("2026-10-26T10:00:00");
    settings = fakeSettings({ prefs: { [DISMISSED]: "2026-10-26" }, migrated: true });
    await boot();
    expect(toast().hidden).toBe(false);
  });

  it("a newer version found by the hourly read reappears after dismissing the older one", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    $("#update-toast-close").click();
    expect(toast().hidden).toBe(true);
    about = { version: "2.1.1", updateCheck: "on", latest: "2.3.0", updateAvailable: true };
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(toast().hidden).toBe(false);
  });
});

describe("hourly re-read", () => {
  it("shows a version the daemon found after boot", async () => {
    fakeClock("2026-10-26T10:00:00");
    about = { version: "2.1.1", updateCheck: "on", latest: "2.1.1", updateAvailable: false };
    await boot();
    expect(toast().hidden).toBe(true);
    about = { version: "2.1.1", updateCheck: "on", latest: "2.3.0", updateAvailable: true };
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(toast().hidden).toBe(false);
    expect($("#update-toast-title").textContent).toBe("Artisign 2.3.0 is available");
  });

  it("brings a notice dismissed yesterday back after midnight", async () => {
    fakeClock("2026-10-26T23:30:00");
    await boot();
    $("#update-toast-close").click();
    expect(toast().hidden).toBe(true);
    vi.setSystemTime(new Date("2026-10-27T00:10:00"));
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(toast().hidden).toBe(false);
  });

  it("keeps a dismissed notice hidden at the next hourly read the same day", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    $("#update-toast-close").click();
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(toast().hidden).toBe(true);
  });

  it("a failed read keeps what is shown", async () => {
    fakeClock("2026-10-26T10:00:00");
    await boot();
    about = null;
    vi.advanceTimersByTime(HOUR);
    await flush();
    expect(toast().hidden).toBe(false);
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
    expect($("#settings-version").textContent).toBe("Artisign 2.1.1");
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
    $("#settings-mcp").focus();
    $("#settings-mcp").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(chip);
    chip.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("artisign update");
    expect($("#settings-mcp").closest("#settings-menu").hidden).toBe(false);
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
    expect($("#settings-version").textContent).toBe("Artisign 2.1.1");
    expect(status().hidden).toBe(true);
  });

  it("an older daemon without the update fields shows the version only", async () => {
    about = { version: "2.1.1" };
    await boot();
    await openMenu();
    expect(status().hidden).toBe(true);
    expect(toast().hidden).toBe(true);
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

describe("stacking", () => {
  it("dialogs and menus sit above the toast", () => {
    // The z-index of the first rule that starts with the selector.
    const z = (selector) => {
      const start = css.indexOf(`\n${selector} {`);
      return Number(/z-index: (\d+)/.exec(css.slice(start, css.indexOf("}", start)))?.[1]);
    };
    expect(z("#update-notice")).toBeLessThan(z(".chrome-scrim"));
    expect(z("#update-notice")).toBeLessThan(z("#settings-menu"));
  });
});
