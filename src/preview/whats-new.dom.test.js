// @vitest-environment jsdom
//
// CHR-928 — What's New: shown once after an update (releases since the last seen version), recorded silently on a fresh install, reopened from the settings menu.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { fakeSettings } from "./fake-settings.test-helper.js";

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

const RELEASES = [
  { version: "2.2.0", date: "2026-11-02", body: "### Added\n\n- A settings menu. (CHR-926)\n- <img src=x onerror=alert(1)> stays text" },
  { version: "2.1.1", date: "2026-10-21", body: "### Fixed\n\n- `artisign update` restarts the daemon. (CHR-886)" },
  { version: "2.1.0", date: null, body: "One install path." },
];

let settings;
let whatsNewQueries;

function stubDaemon(initialPrefs) {
  settings = fakeSettings({ prefs: initialPrefs, migrated: true });
  whatsNewQueries = [];
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const [path, query = ""] = String(url).split("?");
    const settingsRes = settings.handle(path, init);
    if (settingsRes) return settingsRes;
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "<div style='width:390px;height:844px'></div>" });
    if (path === "/api/about") return json({ version: "2.2.0" });
    if (path === "/api/whats-new") {
      const since = new URLSearchParams(query).get("since");
      whatsNewQueries.push(since);
      const order = ["2.1.0", "2.1.1", "2.2.0"];
      return json({ version: "2.2.0", releases: since ? RELEASES.filter((r) => order.indexOf(r.version) > order.indexOf(since)) : RELEASES });
    }
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: [{ name: "home", tags: [] }] });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const dialogOpen = () => !$("#whats-new-scrim").hidden;

async function boot(prefs) {
  stubDaemon(prefs);
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  // A previous test's app.js keeps its document listeners; an Escape closes whatever dialog it left open so it cannot swallow this test's keys.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
});
afterEach(() => vi.unstubAllGlobals());

describe("What's New after an update", () => {
  it("shows the releases since the last seen version, newest first, and records the running one on close", async () => {
    await boot({ "artisign.whatsNewSeen": "2.1.0" });
    expect(dialogOpen()).toBe(true);
    expect(whatsNewQueries).toEqual(["2.1.0"]);
    expect($$(".whats-new-version").map((e) => e.textContent)).toEqual(["2.2.0", "2.1.1"]);
    expect($(".whats-new-date").textContent).toBe("2026-11-02");
    expect($$(".whats-new-body h5").map((e) => e.textContent)).toEqual(["Added", "Fixed"]);
    expect($("#whats-new-summary").textContent).toBe("Showing 2 releases · full history in CHANGELOG.md");
    expect(settings.prefs["artisign.whatsNewSeen"]).toBe("2.1.0");

    $("#whats-new-done").click();
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(settings.prefs["artisign.whatsNewSeen"]).toBe("2.2.0");
  });

  it("renders release bodies as text, never as HTML", async () => {
    await boot({ "artisign.whatsNewSeen": "2.1.1" });
    expect($("#whats-new-body img")).toBeNull();
    expect($("#whats-new-body").textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("Escape closes it and also records the version", async () => {
    await boot({ "artisign.whatsNewSeen": "2.1.1" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(settings.prefs["artisign.whatsNewSeen"]).toBe("2.2.0");
  });

  it("records the version silently on a fresh install", async () => {
    await boot({});
    expect(dialogOpen()).toBe(false);
    expect(whatsNewQueries).toEqual([]);
    expect(settings.prefs["artisign.whatsNewSeen"]).toBe("2.2.0");
  });

  it("shows nothing when the running version was already seen", async () => {
    await boot({ "artisign.whatsNewSeen": "2.2.0" });
    expect(dialogOpen()).toBe(false);
    expect(whatsNewQueries).toEqual([]);
  });
});

describe("What's New from the settings menu", () => {
  it("opens every released section and returns focus to the settings trigger on close", async () => {
    await boot({ "artisign.whatsNewSeen": "2.2.0" });
    $("#settings-trigger").click();
    await flush();
    const item = $("#settings-whats-new");
    expect($("#settings-about").hidden).toBe(false);
    item.click();
    await flush();
    expect(dialogOpen()).toBe(true);
    expect(whatsNewQueries).toEqual([null]);
    expect($$(".whats-new-version").map((e) => e.textContent)).toEqual(["2.2.0", "2.1.1", "2.1.0"]);
    expect($("#whats-new-summary").textContent).toBe("Showing 3 releases · full history in CHANGELOG.md");
    $("#whats-new-close").click();
    expect(dialogOpen()).toBe(false);
    expect(document.activeElement).toBe($("#settings-trigger"));
  });

  it("is reachable with the arrow keys once About is shown", async () => {
    await boot({ "artisign.whatsNewSeen": "2.2.0" });
    $("#settings-trigger").click();
    await flush();
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe($("#settings-whats-new"));
  });
});
