// @vitest-environment jsdom
//
// CHR-1281 — the side panels' resize handles in app.js: drag, arrow keys, double-click, persistence and the clamp limits. jsdom has no layout, so the real positions are checked in a browser (see the PR).
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
const $ = (id) => document.getElementById(id);
const appVar = (name) => $("app").style.getPropertyValue(name);
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const pointer = (target, type, clientX) => target.dispatchEvent(new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true }));

/** Gives a card a fixed rect: jsdom has no layout. */
function placeCard(card, left, right) {
  card.getBoundingClientRect = () => ({ left, right, top: 0, bottom: 600, width: right - left, height: 600, x: left, y: 0 });
}

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

describe("the panel handles (CHR-1281)", () => {
  it("each handle is a focusable vertical separator; a fresh install keeps the default widths", async () => {
    await boot();
    for (const id of ["sidebar-screens-resize", "agent-bar-resize", "tool-panel-resize"]) {
      const handle = $(id);
      expect(handle.getAttribute("role"), id).toBe("separator");
      expect(handle.getAttribute("aria-orientation"), id).toBe("vertical");
      expect(handle.tabIndex, id).toBe(0);
    }
    expect($("sidebar-screens-resize").getAttribute("aria-valuenow")).toBe("256");
    expect($("agent-bar-resize").getAttribute("aria-valuenow")).toBe("248");
    expect([appVar("--size-nav-card"), appVar("--panel-right-w")]).toEqual(["", ""]);
  });

  it("dragging the left handle sets the width live, within 220..480, and saves it on release", async () => {
    await boot();
    placeCard($("sidebar-screens"), 16, 272);
    const handle = $("sidebar-screens-resize");
    pointer(handle, "pointerdown", 270); // grabbed 2px inside the edge
    pointer(window, "pointermove", 370);
    expect(appVar("--size-nav-card")).toBe("356px"); // the edge moved by the pointer's 100px, not by the grab offset
    expect(appVar("--panel-left-extra")).toBe("100px");
    pointer(window, "pointermove", 5000);
    expect(appVar("--size-nav-card")).toBe("480px");
    pointer(window, "pointermove", 0);
    expect(appVar("--size-nav-card")).toBe("220px");
    pointer(window, "pointermove", 316);
    pointer(window, "pointerup", 316);
    await flush();
    expect(settings.prefs["artisign.panel.left.width"]).toBe("302");
  });

  it("dragging the right handle to the left widens the whole column, within 248..560", async () => {
    await boot();
    placeCard($("agent-bar"), 1000, 1248);
    pointer($("agent-bar-resize"), "pointerdown", 1000);
    pointer(window, "pointermove", 900);
    expect(appVar("--panel-right-w")).toBe("348px");
    expect(appVar("--panel-right-extra")).toBe("100px");
    pointer(window, "pointermove", 0);
    expect(appVar("--panel-right-w")).toBe("560px");
    pointer(window, "pointermove", 1240);
    expect(appVar("--panel-right-w")).toBe("");
    pointer(window, "pointermove", 800);
    pointer(window, "pointerup", 800);
    await flush();
    expect(settings.prefs["artisign.panel.right.width"]).toBe("448");
    expect($("tool-panel-resize").getAttribute("aria-valuenow")).toBe("448");
  });

  it("arrow keys change the width by 16px in the direction the edge moves", async () => {
    await boot();
    key($("sidebar-screens-resize"), "ArrowRight");
    expect(appVar("--size-nav-card")).toBe("272px");
    key($("sidebar-screens-resize"), "ArrowLeft");
    key($("sidebar-screens-resize"), "ArrowLeft");
    expect(appVar("--size-nav-card")).toBe("240px");
    key($("agent-bar-resize"), "ArrowLeft"); // the right column's edge moves left: wider
    expect(appVar("--panel-right-w")).toBe("264px");
    key($("tool-panel-resize"), "ArrowRight");
    key($("tool-panel-resize"), "ArrowRight");
    expect(appVar("--panel-right-w")).toBe(""); // back at the default, clamped at the minimum
    await flush();
    expect(settings.prefs["artisign.panel.left.width"]).toBe("240");
  });

  it("a double-click resets the panel to its default and forgets the stored width", async () => {
    memoryStorage.set("artisign.panel.left.width", "400");
    await boot();
    expect(appVar("--size-nav-card")).toBe("400px");
    $("sidebar-screens-resize").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(appVar("--size-nav-card")).toBe("");
    expect(appVar("--panel-left-extra")).toBe("");
    await flush();
    expect(settings.prefs["artisign.panel.left.width"]).toBe("");
  });

  it("restores the stored widths after a reload, clamped to the limits; garbage falls back to the default", async () => {
    memoryStorage.set("artisign.panel.left.width", "9999");
    memoryStorage.set("artisign.panel.right.width", "wide");
    await boot();
    expect(appVar("--size-nav-card")).toBe("480px");
    expect(appVar("--panel-right-w")).toBe("");
  });

  it("folding the Screens card keeps its width", async () => {
    memoryStorage.set("artisign.panel.left.width", "320");
    await boot();
    $("sidebar-screens-collapse").click();
    expect($("sidebar-screens").dataset.collapsed).toBe("true");
    expect(appVar("--size-nav-card")).toBe("320px");
    $("sidebar-screens-collapse").click();
    expect(appVar("--size-nav-card")).toBe("320px");
  });
});
