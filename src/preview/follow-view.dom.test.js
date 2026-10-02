// @vitest-environment jsdom
//
// CHR-779 — follow mode switches to the target's view and catches targets the
// same write creates. The real index.html body and modules, a stubbed daemon
// (fetch + EventSource); activity/change events are pushed down the SSE stub.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));

const s = (name) => ({ name, tags: [], notes: "" });
let sources;
let screens;
let mockups;

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
  sources = [];
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (v) => v });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", async (url) => {
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens });
    if (path === "/api/mockups") return json({ mockups });
    if (path === "/api/design-system") {
      return json({ component_definitions: [{ name: "btn", variants: [{ name: "default", rendered_html: "<button></button>" }] }] });
    }
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">${path}</div>` };
    if (path.startsWith("/api/mockups/")) return json({ name: "m", variants: [] });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });
const activity = (tool, kind, target) => emit({ type: "activity", tool, kind, target, nodes: [], ok: true, at: Date.now() });
const screenActivity = (name, tool = "get_screen", kind = "read") => activity(tool, kind, { kind: "screen", name });
const componentWrite = (name) => activity("write_html", "write", { kind: "component", name });
const tab = (view) => $(`.view-tab[data-view="${view}"]`);
const pressed = () => [...document.querySelectorAll(".view-tab")].find((t) => t.getAttribute("aria-pressed") === "true").dataset.view;
const rowButton = (name) => $(`#screen-list li[data-screen="${name}"] button.screen-item`);
const followState = () => $("#follow-toggle").dataset.state;

async function boot() {
  localStorage.setItem("artisign.last-screen:/p", "a");
  localStorage.setItem("artisign.followEnabled", "true");
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  screens = [s("a"), s("b")];
  mockups = [];
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("follow switches to the target's view", () => {
  it("a screen target switches from the Design System view to Screens and selects it, without pausing follow", async () => {
    await boot();
    expect(followState()).toBe("following");
    tab("design-system").click(); // human navigation pauses follow...
    await flush();
    $("#follow-toggle-resume").click(); // ...Resume re-arms it
    expect(followState()).toBe("following");
    expect(pressed()).toBe("design-system");
    screenActivity("b");
    await flush();
    expect(pressed()).toBe("screens");
    expect($("#design-system-view").hidden).toBe(true);
    expect(rowButton("b").getAttribute("aria-current")).toBe("true");
    expect(followState()).toBe("following");
  });

  it("switches away from the Board too", async () => {
    await boot();
    tab("board").click();
    await flush();
    $("#follow-toggle-resume").click();
    screenActivity("b");
    await flush();
    expect(pressed()).toBe("screens");
    expect($("#board-view").hidden).toBe(true);
  });

  it("a component write goes to Design System, the next screen write back to Screens", async () => {
    await boot();
    componentWrite("btn");
    await flush();
    expect(pressed()).toBe("design-system");
    expect($("#design-system-view").hidden).toBe(false);
    await wait(350); // past the 300 ms coalescing window
    screenActivity("b", "write_html", "write");
    await flush();
    expect(pressed()).toBe("screens");
    expect(rowButton("b").getAttribute("aria-current")).toBe("true");
    expect(followState()).toBe("following");
  });

  it("a mockup target switches to the Screens view's mockup", async () => {
    mockups = [{ name: "m", variants: [], tags: [] }];
    await boot();
    tab("design-system").click();
    await flush();
    $("#follow-toggle-resume").click();
    activity("get_mockup", "read", { kind: "mockup", name: "m" });
    await flush();
    expect(pressed()).toBe("screens");
    expect($("#mockup-view").hidden).toBe(false);
  });

  it("paused follow does not switch the view", async () => {
    await boot();
    tab("design-system").click(); // pauses
    await flush();
    expect(followState()).toBe("paused");
    screenActivity("b");
    await flush();
    expect(pressed()).toBe("design-system");
  });
});

describe("follow catches a target the same write creates", () => {
  it("an activity that beats its change event navigates once the change lists the screen", async () => {
    await boot();
    screens = [s("a"), s("b"), s("fresh")];
    screenActivity("fresh", "write_html", "write"); // lists are still stale here
    await flush();
    expect(rowButton("fresh")).toBeNull();
    expect(rowButton("a").getAttribute("aria-current")).toBe("true");
    emit({ type: "change", kind: "screen", name: "fresh" });
    await flush();
    expect(rowButton("fresh").getAttribute("aria-current")).toBe("true");
  });

  it("a held target that never shows up is dropped after the grace period", async () => {
    await boot();
    screenActivity("ghost", "write_html", "write");
    await wait(1100);
    screens = [s("a"), s("b"), s("ghost")];
    emit({ type: "change", kind: "screen", name: "ghost" });
    await flush();
    expect(rowButton("a").getAttribute("aria-current")).toBe("true");
    expect(rowButton("ghost").getAttribute("aria-current")).not.toBe("true");
  });

  it("a human pause while the event is held keeps it from navigating", async () => {
    await boot();
    screenActivity("fresh", "write_html", "write");
    tab("design-system").click(); // human navigation pauses
    await flush();
    screens = [s("a"), s("b"), s("fresh")];
    emit({ type: "change", kind: "screen", name: "fresh" });
    await flush();
    expect(pressed()).toBe("design-system");
  });
});

describe("design-system cue", () => {
  it("scrolls to and marks the card after the view has rendered, and again after the change re-render", async () => {
    await boot();
    componentWrite("btn");
    await flush();
    const card = () => $('.ds-component[data-component-name="btn"]');
    expect(card().classList.contains("activity-cue-write")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    Element.prototype.scrollIntoView.mockClear();
    emit({ type: "change", kind: "component", name: "btn" }); // the write's own re-render replaces the card
    await flush();
    expect(card().classList.contains("activity-cue-write")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
