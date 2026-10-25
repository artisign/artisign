// @vitest-environment jsdom
//
// CHR-913 review findings, end to end through app.js: the right panel's collapse label, the Add comment action right after a screen switch, and the Notes panel for a tag-only screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const SCREENS = [
  { name: "one", tags: [], notes: "" },
  { name: "two", tags: ["alpha", "beta"], notes: "" },
];

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
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">${path}</div>` };
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);

async function boot(lastScreen) {
  localStorage.setItem("artisign.last-screen:/p", lastScreen);
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

describe("right panel collapse button", () => {
  it("names the active tab in label and tooltip, also after collapse and expand", async () => {
    memoryStorage.set("artisign.inspector.collapsed", "false");
    await boot("one");
    const btn = $("#inspector-collapse");
    const names = () => [btn.getAttribute("aria-label"), btn.dataset.tooltip];
    expect(names()).toEqual(["Collapse Elements panel", "Collapse Elements panel"]);
    $("#panel-tab-activity").click();
    expect(names()).toEqual(["Collapse Activity panel", "Collapse Activity panel"]);
    btn.click();
    expect(names()).toEqual(["Expand Activity panel", "Expand Activity panel"]);
    btn.click();
    expect(names()).toEqual(["Collapse Activity panel", "Collapse Activity panel"]);
    $("#panel-tab-elements").click();
    expect(names()).toEqual(["Collapse Elements panel", "Collapse Elements panel"]);
  });
});

describe("Add comment", () => {
  it("keeps the screen-wide compose open when the new screen's own frame loads", async () => {
    await boot("one");
    const frame = $("#screen-frame");
    frame.dispatchEvent(new Event("load")); // screen "one" is shown
    $('#screen-list li[data-screen="two"] button.screen-item').click();
    await flush();
    // The frame still holds the previous document until "two" has loaded.
    $("#comment-add").click();
    expect($("#comment-compose").hidden).toBe(false);
    frame.dispatchEvent(new Event("load")); // now "two" has rendered
    expect($("#comment-compose").hidden).toBe(false);
    expect($("#comment-target-label").textContent).toBe("New comment on screen");
  });
});

describe("Notes panel", () => {
  it("shows the tag chips for a tagged screen with no notes, without an empty text band", async () => {
    await boot("two");
    expect($("#notes-panel").hidden).toBe(false);
    expect([...document.querySelectorAll("#notes-panel-chips .chrome-chip")].map((c) => c.textContent)).toEqual(["alpha", "beta"]);
    expect($("#notes-panel-text").hidden).toBe(true);
  });

  it("stays hidden for a screen with neither notes nor tags", async () => {
    await boot("one");
    expect($("#notes-panel").hidden).toBe(true);
  });
});
