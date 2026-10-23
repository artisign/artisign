// @vitest-environment jsdom
//
// CHR-888 — first-run collapse defaults of the three side panels in app.js:
// Screens expanded, Context and Elements collapsed; a stored pref always wins.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
};

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url) => {
    const path = String(url).split("?")[0];
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

describe("side panel defaults", () => {
  it("fresh install: Screens expanded, Context and Elements collapsed", async () => {
    await boot();
    expect([state("sidebar-screens"), state("sidebar-context"), state("inspector")]).toEqual(["false", "true", "true"]);
    expect([expanded("sidebar-screens-collapse"), expanded("sidebar-context-collapse"), expanded("inspector-collapse")]).toEqual(["true", "false", "false"]);
  });

  it("stored prefs win over the defaults", async () => {
    memoryStorage.set("artisign.sidebar-context.collapsed", "false");
    memoryStorage.set("artisign.inspector.collapsed", "false");
    memoryStorage.set("artisign.sidebar-screens.collapsed", "true");
    await boot();
    expect([state("sidebar-screens"), state("sidebar-context"), state("inspector")]).toEqual(["true", "false", "false"]);
  });

  it("expanding a default-collapsed panel persists", async () => {
    await boot();
    document.getElementById("inspector-collapse").click();
    expect(state("inspector")).toBe("false");
    expect(memoryStorage.get("artisign.inspector.collapsed")).toBe("false");
  });

  it("comment mode opens Context, inspect mode opens Elements", async () => {
    await boot();
    const comment = document.getElementById("comment-mode-toggle");
    const inspect = document.getElementById("inspect-mode-toggle");
    comment.disabled = false;
    inspect.disabled = false;
    comment.click();
    expect([state("sidebar-context"), state("inspector")]).toEqual(["false", "true"]);
    inspect.click();
    expect(state("inspector")).toBe("false");
    expect(memoryStorage.get("artisign.inspector.collapsed")).toBe("false");
  });
});
