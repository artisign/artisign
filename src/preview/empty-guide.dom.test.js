// @vitest-environment jsdom
//
// CHR-890 — the how-to-start guide on the bare canvas (no frame):
// shown while the project has no screens, names the active project, and
// switches with the screen list live.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

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

let screens;
let sources;
let projects;

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  sources = [];
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url) => {
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json(projects);
    if (path === "/api/screens") return json({ screens });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">x</div>` };
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  screens = [];
  projects = { active: "/p", open: [{ root: "/p", name: "delete-me" }, { root: "/q", name: "other" }], recent: [] };
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("empty-project guide", () => {
  it("shows the guide with the project name and keeps the iframe hidden; the old column is gone", async () => {
    await import("./app.js");
    await flush();
    expect($("#empty-state")).toBeNull();
    expect($("#empty-guide").hidden).toBe(false);
    expect($("#screen-frame").hidden).toBe(true);
    expect($("#canvas").contains($("#empty-guide"))).toBe(true);
    expect($("#screen-holder").contains($("#empty-guide"))).toBe(false); // not zoomed with the frame
    expect($("#screen-holder").hidden).toBe(true);
    expect($("#empty-guide-prompt").textContent).toBe("Design a login screen in my Artisign project delete-me");
  });

  it("switches live: first screen hides the guide, deleting the last brings it back", async () => {
    await import("./app.js");
    await flush();
    screens = [{ name: "one", tags: [], notes: "" }];
    emit({ type: "change", kind: "screen", name: "one" });
    await flush();
    expect($("#empty-guide").hidden).toBe(true);
    expect($("#screen-frame").hidden).toBe(false);
    expect($("#screen-holder").hidden).toBe(false);
    expect($("#screen-list li[data-screen=\"one\"] button.screen-item").getAttribute("aria-current")).toBe("true"); // the new screen is selected and rendered
    screens = [];
    emit({ type: "change", kind: "screen", name: "one" });
    await flush();
    expect($("#empty-guide").hidden).toBe(false);
    expect($("#screen-frame").hidden).toBe(true);
  });

  it("a first screen written while disconnected is selected on reconnect", async () => {
    await import("./app.js");
    await flush();
    sources.at(-1).onopen(); // first connect
    screens = [{ name: "one", tags: [], notes: "" }];
    sources.at(-1).onopen(); // reconnect after a drop → resync
    await flush();
    expect($("#empty-guide").hidden).toBe(true);
    expect($("#screen-list li[data-screen=\"one\"] button.screen-item").getAttribute("aria-current")).toBe("true");
  });

  it("is not shown for a project that has screens", async () => {
    screens = [{ name: "one", tags: [], notes: "" }];
    await import("./app.js");
    await flush();
    expect($("#empty-guide").hidden).toBe(true);
  });

  it("Copy writes the prompt to the clipboard and flips its label", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await import("./app.js");
    await flush();
    $("#empty-guide-copy").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("Design a login screen in my Artisign project delete-me");
    expect($("#empty-guide-copy").textContent).toBe("Copied");
  });
});
