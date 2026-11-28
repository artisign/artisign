// @vitest-environment jsdom
//
// CHR-1297 through app.js: what the Board expands or collapses follows into the left card's tree, one way only. The group opens with its parents, scrolls into view and lights up; the tree never writes the Board's state.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));
const SCREENS = [
  { name: "checkout", tags: [], notes: "" },
  { name: "checkout-error", tags: [], notes: "", variant_of: "checkout", variant_kind: "state" },
  { name: "checkout-error-retry", tags: [], notes: "", variant_of: "checkout-error", variant_kind: "step" },
  { name: "cart", tags: [], notes: "" },
  { name: "cart-empty", tags: [], notes: "", variant_of: "cart", variant_kind: "state" },
  { name: "home", tags: [], notes: "" },
];
const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  get length() { return memoryStorage.size; },
  key: (i) => [...memoryStorage.keys()][i] ?? null,
  clear: () => memoryStorage.clear(),
};

let boardState;
let writes;
let sources;
let scrolled;

function stubDaemon() {
  boardState = { filter: null, pinned: [], expanded: [] };
  writes = [];
  sources = [];
  scrolled = [];
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = function (opts) { scrolled.push([this.dataset.screen, opts]); };
  vi.stubGlobal("fetch", async (url, init) => {
    const [path] = String(url).split("?");
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/tools/set_board_state") {
      writes.push(JSON.parse(init.body));
      return json({});
    }
    if (path === "/api/comments") return json({ comments: [], threads: [] });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json(boardState);
    if (path === "/api/mockups") return json({ mockups: [{ name: "ideas", title: "Ideas", tags: [], variants: [{ id: "a", title: "A" }, { id: "b", title: "B" }] }] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root"></div>` };
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify({ type: "board_state", filter: null, pinned: [], source: "human", ...event }) });
const rows = () => [...document.querySelectorAll("#screen-list .screen-item-row[data-screen]")].map((r) => r.dataset.screen);

async function boot(expanded = []) {
  boardState.expanded = expanded;
  localStorage.setItem("artisign.last-screen:/p", "home");
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

describe("Board -> tree sync (CHR-1297)", () => {
  it("expanding a group on the Board opens it in the tree, scrolls to it and lights it up", async () => {
    await boot();
    expect(rows()).toEqual(["checkout", "cart", "home"]);
    emit({ expanded: ["checkout"] });
    await flush();
    expect(rows()).toEqual(["checkout", "checkout-error", "cart", "home"]);
    expect(scrolled).toEqual([["checkout", { block: "nearest" }]]);
    expect($('#screen-list li[data-screen="checkout"]').classList.contains("tree-reveal")).toBe(true);
  });

  it("a nested group opens with its parents", async () => {
    await boot();
    emit({ expanded: ["checkout-error"] });
    await flush();
    expect(rows()).toEqual(["checkout", "checkout-error", "checkout-error-retry", "cart", "home"]);
    expect(scrolled.map(([name]) => name)).toEqual(["checkout-error"]);
  });

  it("collapsing on the Board closes the group in the tree, and Collapse all closes every one", async () => {
    await boot();
    emit({ expanded: ["checkout", "cart"] });
    await flush();
    expect(rows()).toEqual(["checkout", "checkout-error", "cart", "cart-empty", "home"]);
    emit({ expanded: ["cart"] });
    await flush();
    expect(rows()).toEqual(["checkout", "cart", "cart-empty", "home"]);
    emit({ expanded: [] });
    await flush();
    expect(rows()).toEqual(["checkout", "cart", "home"]);
  });

  it("the sync goes one way: toggling the tree writes nothing to the Board and leaves it alone", async () => {
    await boot();
    $('#screen-list li[data-screen="checkout"] .screen-item-toggle').click();
    await flush();
    expect(rows()).toContain("checkout-error");
    expect(writes).toEqual([]);
    expect(scrolled).toEqual([]);
  });

  it("the list a project loads with is the baseline: nothing opens, scrolls or lights up", async () => {
    await boot(["cart"]);
    expect(rows()).toEqual(["checkout", "cart", "home"]);
    expect(scrolled).toEqual([]);
  });

  it("a folded card takes the state at once and scrolls and lights up when it opens again", async () => {
    await boot();
    $("#sidebar-screens-collapse").click();
    emit({ expanded: ["cart"] });
    await flush();
    expect(scrolled).toEqual([]);
    expect(rows()).toEqual(["checkout", "cart", "cart-empty", "home"]);
    $("#sidebar-screens-collapse").click();
    expect(scrolled).toEqual([["cart", { block: "nearest" }]]);
    expect($('#screen-list li[data-screen="cart"]').classList.contains("tree-reveal")).toBe(true);
  });

  it("while the card shows Mockups the Screens tree still takes the state; the scroll waits for the Screens tab", async () => {
    await boot();
    $("#nav-tab-mockups").click();
    emit({ expanded: ["checkout"] });
    await flush();
    expect(scrolled).toEqual([]);
    $("#nav-tab-screens").click();
    expect(rows()).toEqual(["checkout", "checkout-error", "cart", "home"]);
    expect(scrolled).toEqual([["checkout", { block: "nearest" }]]);
  });
});
