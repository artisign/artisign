// @vitest-environment jsdom
//
// CHR-888 / CHR-1267 — the left floating card in app.js: expanded by default, its fold state and position are per-viewer prefs. (The Context and Elements panels it replaced are gone.)
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

let settings;

function stubDaemon() {
  settings = fakeSettings();
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    const settingsRes = settings.handle(path, init);
    if (settingsRes) return settingsRes;
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: [] });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const state = (id) => document.getElementById(id).dataset.collapsed;
const expanded = (id) => document.getElementById(id).getAttribute("aria-expanded");

async function boot() {
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("left card (CHR-1267)", () => {
  it("fresh install: the card is expanded, and the Context and Elements panels no longer exist", async () => {
    await boot();
    expect(state("sidebar-screens")).toBe("false");
    expect(expanded("sidebar-screens-collapse")).toBe("true");
    expect(document.getElementById("app").dataset.cardFolded).toBe("false");
    expect(document.getElementById("sidebar-context")).toBeNull();
    expect(document.getElementById("inspector")).toBeNull();
  });

  it("the fold control swaps its icon, label and tooltip with the state, persists, and tells the shell", async () => {
    await boot();
    const btn = document.getElementById("sidebar-screens-collapse");
    const iconOf = () => btn.querySelector(".side-panel-collapse-icon").textContent;
    expect([iconOf(), btn.getAttribute("aria-label"), btn.dataset.tooltip]).toEqual(["expand_less", "Collapse Screens panel", "Collapse Screens panel"]);
    btn.click();
    expect([iconOf(), btn.getAttribute("aria-label"), btn.dataset.tooltip, state("sidebar-screens")]).toEqual(["expand_more", "Expand Screens panel", "Expand Screens panel", "true"]);
    expect(document.getElementById("app").dataset.cardFolded).toBe("true");
    await flush();
    expect(settings.prefs["artisign.sidebar-screens.collapsed"]).toBe("true");
    btn.click();
    expect(state("sidebar-screens")).toBe("false");
  });

  it("a stored fold state wins", async () => {
    memoryStorage.set("artisign.sidebar-screens.collapsed", "true");
    await boot();
    expect(state("sidebar-screens")).toBe("true");
    expect(document.getElementById("app").dataset.cardFolded).toBe("true");
  });

  it("restores the position the grip left it at, for this viewer", async () => {
    memoryStorage.set("artisign.sidebar-screens.position", "120,90");
    await boot();
    const card = document.getElementById("sidebar-screens");
    expect([card.style.left, card.style.top]).toEqual(["120px", "90px"]);
  });

  it("with no screen open the screen tools are greyed out, stay focusable and do nothing", async () => {
    await boot();
    for (const id of ["comment-mode-toggle", "inspect-mode-toggle", "notes-tool-toggle", "comments-tool-toggle", "flow-mode-toggle"]) {
      const tool = document.getElementById(id);
      expect(tool.getAttribute("aria-disabled"), id).toBe("true");
      expect(tool.disabled, id).toBe(false); // focusable
      expect(tool.dataset.toolReason, id).toBe("No screen is open");
      tool.click();
      expect(tool.getAttribute("aria-pressed"), id).toBe("false");
    }
    expect(document.getElementById("design-system-tool")).toBeNull(); // CHR-1284
  });
});
