// @vitest-environment jsdom
//
// CHR-738 — the compare wiring in app.js end to end: the real index.html
// body, the real modules, a stubbed daemon (fetch + EventSource).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));

const s = (name, variant_of, variant_kind = "state") => ({ name, tags: [], notes: "", ...(variant_of ? { variant_of, variant_kind } : {}) });
const SCREENS = [s("plain"), s("family"), s("a", "family"), s("a1", "a", "step"), s("b", "family")];

let calls;
let sources;
let screens;

/** Node's own experimental `localStorage` shadows jsdom's here, so give the app a plain in-memory one. */
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
  calls = [];
  sources = [];
  vi.stubGlobal(
    "EventSource",
    class {
      constructor() {
        sources.push(this);
      }
      close() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s }); // jsdom has none; the Board tab (restored in one test) builds tiles with it
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push(String(url));
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path === "/api/compare") {
      const others = new URL(String(url), "http://x").searchParams.get("others").split(",");
      return json({
        base: "family",
        members: others.map((screen) => ({
          screen,
          status: "ok",
          overlap: { shared: 5, base: 5, member: 5, ratio: 1 },
          added: ["x"],
          removed: [],
          changed: [],
          counts: { added: 1, removed: 0, changed: 0 },
        })),
      });
    }
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">${path}</div>` };
    throw new Error(`unstubbed ${init?.method ?? "GET"} ${url}`);
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const rowButton = (name) => $(`#screen-list li[data-screen="${name}"] button.screen-item`);
const seg = (mode) => document.querySelector(`.compare-seg-button[data-mode="${mode}"]`);
const chips = () => [...document.querySelectorAll("#compare-bar .compare-chip[data-screen]")].map((c) => c.dataset.screen);

async function boot(lastScreen = "a") {
  localStorage.setItem("artisign.last-screen:/p", lastScreen);
  localStorage.setItem("artisign.sidebarExpanded:/p", JSON.stringify(["family", "a"]));
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  screens = SCREENS;
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("compare mode in the screen view", () => {
  it("Single | Compare toggles the view; the main screen is the locked reference, the open variant preselected", async () => {
    await boot("a");
    expect($("#compare-view").hidden).toBe(true);
    seg("compare").click();
    await flush();
    expect($("#compare-view").hidden).toBe(false);
    expect($("#screens-stage").hidden).toBe(true);
    expect(chips()).toEqual(["family", "a"]);
    expect($("#compare-bar .compare-chip-reference").textContent).toContain("reference");
    expect(seg("compare").textContent).toBe("Compare · 2");
    expect(calls.some((u) => u.startsWith("/api/compare?base=family&others=a&"))).toBe(true);
    // the compare panel replaces the Elements/Activity panel
    expect($("#compare-panel").hidden).toBe(false);
    expect($("#panel-tabs").hidden).toBe(true);
    expect($("#panel-body-elements").hidden).toBe(true);
    expect($("#compare-panel .compare-summary h3").textContent).toBe("vs. reference family");
  });

  it("Single goes back to the screen that was open before compare", async () => {
    await boot("a1");
    seg("compare").click();
    await flush();
    rowButton("b").click(); // in-family navigation keeps compare on
    await flush();
    expect($("#compare-view").hidden).toBe(false);
    seg("single").click();
    await flush();
    expect($("#compare-view").hidden).toBe(true);
    expect($("#screens-stage").hidden).toBe(false);
    expect(rowButton("a1").getAttribute("aria-current")).toBe("true");
    expect($("#panel-tabs").hidden).toBe(false);
  });

  it("navigating to a screen outside the family ends compare", async () => {
    await boot("a");
    seg("compare").click();
    await flush();
    rowButton("plain").click();
    await flush();
    expect($("#compare-view").hidden).toBe(true);
    expect(rowButton("plain").getAttribute("aria-current")).toBe("true");
  });
});

describe("picking members", () => {
  it("shows sidebar checkboxes only in compare and only on the family, ticked for the selection", async () => {
    await boot("a");
    expect(document.querySelectorAll(".screen-item-compare")).toHaveLength(0);
    seg("compare").click();
    await flush();
    const box = (name) => $(`#screen-list li[data-screen="${name}"] .screen-item-compare`);
    expect(box("plain")).toBeNull();
    expect([box("family").checked, box("family").disabled]).toEqual([true, true]);
    expect(box("a").checked).toBe(true);
    expect(box("b").checked).toBe(false);
  });

  it("the sidebar checkbox, the popover checkbox and the chip row edit one selection", async () => {
    await boot("a");
    seg("compare").click();
    await flush();
    $('#screen-list li[data-screen="b"] .screen-item-compare').click();
    await flush();
    expect(chips()).toEqual(["family", "a", "b"]);
    expect($(`#screen-list li[data-screen="b"] .screen-item-compare`).checked).toBe(true);

    // "+ add" opens the breadcrumb popover of the open screen, whose boxes mirror the same selection
    $("#compare-bar .compare-chip-add").click();
    const popBox = (name) => document.querySelector(`.variant-pop-check[data-screen="${name}"]`);
    expect(popBox("b").checked).toBe(true);
    popBox("a1").click();
    await flush();
    expect(chips()).toEqual(["family", "a", "b", "a1"]);
    // cap: three members, the reference is not counted
    expect($(`#screen-list li[data-screen="b"] .screen-item-compare`).disabled).toBe(false);

    // removing a chip unticks the sidebar box
    $('#compare-bar .compare-chip[data-screen="b"] .compare-chip-remove').click();
    await flush();
    expect(chips()).toEqual(["family", "a", "a1"]);
    expect($(`#screen-list li[data-screen="b"] .screen-item-compare`).checked).toBe(false);
  });
});

describe("other modes", () => {
  it("comment and inspect are disabled with a tooltip while comparing, and back afterwards", async () => {
    await boot("a");
    const inspectTitle = $("#inspect-mode-toggle").title;
    seg("compare").click();
    await flush();
    for (const id of ["comment-mode-toggle", "inspect-mode-toggle"]) {
      expect($(`#${id}`).disabled).toBe(true);
      expect($(`#${id}`).title).toBe("Not available while comparing variants");
    }
    seg("single").click();
    await flush();
    expect($("#comment-mode-toggle").disabled).toBe(false);
    expect($("#inspect-mode-toggle").disabled).toBe(false);
    expect($("#inspect-mode-toggle").title).toBe(inspectTitle);
  });

  it("turning flow mode on leaves compare first", async () => {
    await boot("a");
    seg("compare").click();
    await flush();
    $("#flow-mode-toggle").click();
    await flush();
    expect($("#compare-view").hidden).toBe(true);
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("an active comment mode is switched off when compare starts", async () => {
    await boot("a");
    $("#comment-mode-toggle").click();
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    seg("compare").click();
    await flush();
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("staying current", () => {
  const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });

  it("a screen-changed event of a compared screen refetches the diff and re-renders its column", async () => {
    await boot("a");
    seg("compare").click();
    await flush();
    calls.length = 0;
    emit({ type: "change", kind: "screen", name: "a" });
    await flush();
    expect(calls.some((u) => u.startsWith("/api/compare?"))).toBe(true);
    expect(calls.some((u) => u.startsWith("/api/render/a?"))).toBe(true);
    calls.length = 0;
    emit({ type: "change", kind: "screen", name: "plain" });
    await flush();
    expect(calls.some((u) => u.startsWith("/api/compare?"))).toBe(false);
  });

  it("a deleted member drops out of the chip row, a deleted reference ends compare", async () => {
    await boot("a");
    seg("compare").click();
    await flush();
    $('#screen-list li[data-screen="b"] .screen-item-compare').click();
    await flush();
    screens = SCREENS.filter((x) => x.name !== "b");
    emit({ type: "change", kind: "screen", name: "b" });
    await flush();
    expect(chips()).toEqual(["family", "a"]);
    screens = SCREENS.filter((x) => x.name !== "family");
    emit({ type: "change", kind: "screen", name: "family" });
    await flush();
    expect($("#compare-view").hidden).toBe(true);
  });
});

describe("compare restored behind another tab", () => {
  it("renders the columns only once the Screens tab is showing", async () => {
    memoryStorage.set("artisign.compare", "true");
    memoryStorage.set("artisign.view", "board");
    await boot("a");
    expect($("#compare-view").hidden).toBe(true);
    const rendered = () => [...document.querySelectorAll("#compare-columns iframe")].filter((f) => f.srcdoc !== "").length;
    expect(rendered()).toBe(0); // the Board tab renders its own tiles; only the compare columns are held back
    document.querySelector('.view-tab[data-view="screens"]').click();
    await flush();
    expect($("#compare-view").hidden).toBe(false);
    expect(rendered()).toBe(2);
  });
});

describe("per-browser state", () => {
  it("restores compare mode, the selection and the zoom after a reload", async () => {
    await boot("a");
    seg("compare").click();
    await flush();
    $('#screen-list li[data-screen="b"] .screen-item-compare').click();
    $('#compare-bar .compare-zoom-button[data-zoom="1"]').click();
    await flush();

    vi.resetModules();
    document.body.innerHTML = bodyHtml;
    stubDaemon();
    await import("./app.js");
    await flush();
    expect($("#compare-view").hidden).toBe(false);
    expect(chips()).toEqual(["family", "a", "b"]);
    expect($('#compare-bar .compare-zoom-button[aria-pressed="true"]').dataset.zoom).toBe("1");
  });
});
