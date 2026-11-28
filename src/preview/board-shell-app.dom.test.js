// @vitest-environment jsdom
//
// CHR-1271 end to end through app.js: the Board in the Stitch chrome — the tool bar's Board tools in the design's words, the left card's status line and groups, the zoom pill, the agent's presentation notice, the writing ring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));
const SCREENS = [
  { name: "checkout", tags: ["checkout"], notes: "" },
  { name: "checkout-error", tags: [], notes: "", variant_of: "checkout", variant_kind: "state" },
  { name: "cart", tags: ["checkout"], notes: "" },
  { name: "home", tags: ["orders"], notes: "" },
  { name: "settings", tags: ["account"], notes: "" },
];
const TS = "2026-11-26T10:00:00.000Z";

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
let comments;
let writes;
let sources;

function stubDaemon() {
  boardState = { filter: null, pinned: [], expanded: [] };
  comments = { comments: [], threads: [] };
  writes = [];
  sources = [];
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const [path] = String(url).split("?");
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/tools/set_board_state") {
      writes.push(JSON.parse(init.body));
      return json({});
    }
    if (path === "/api/comments") return json(comments);
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json(boardState);
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root"><p id="btn-a">A</p></div>` };
    return json({});
  });
}

HTMLDialogElement.prototype.show ??= function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });
const label = (id) => document.getElementById(id).getAttribute("aria-label");
const key = (k, init = {}) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: init.code, bubbles: true, cancelable: true, ...init }));

async function boot() {
  localStorage.setItem("artisign.last-screen:/p", "home");
  await import("./app.js");
  await flush();
}
async function openBoard() {
  await boot();
  $('.view-tab[data-view="board"]').click();
  await flush();
  for (const iframe of document.querySelectorAll(".board-tile-iframe")) {
    iframe.contentDocument.body.innerHTML = '<div id="root"><p id="btn-a">A</p></div>';
    iframe.dispatchEvent(new Event("load"));
  }
  await new Promise((r) => setTimeout(r, 120));
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
let documentListeners = [];
let windowListeners = [];
const nativeDocAdd = document.addEventListener.bind(document);
const nativeWinAdd = window.addEventListener.bind(window);
beforeEach(() => {
  documentListeners = [];
  windowListeners = [];
  document.addEventListener = (type, fn, opts) => {
    documentListeners.push([type, fn, opts]);
    nativeDocAdd(type, fn, opts);
  };
  window.addEventListener = (type, fn, opts) => {
    windowListeners.push([type, fn, opts]);
    nativeWinAdd(type, fn, opts);
  };
});
afterEach(() => {
  for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  document.addEventListener = nativeDocAdd;
  window.addEventListener = nativeWinAdd;
  vi.unstubAllGlobals();
});

describe("the Board's tool bar", () => {
  it("names every tool as the design does, and the bar for what it works on", async () => {
    comments = {
      comments: [{ id: "c1", screen: "home", node_id: "home.btn-a", text: "x", author: "human", parent_id: null, resolved: false, ts: TS }],
      threads: [{ id: "c1", screen: "home", node_id: "home.btn-a", author: "human", status: "open", detached: false, reply_count: 0 }],
    };
    await openBoard();
    expect($("#tool-bar").getAttribute("aria-label")).toBe("Board tools");
    expect(label("comment-mode-toggle")).toBe("Comment, read-only on the Board: comment in the Screens view");
    expect(label("inspect-mode-toggle")).toBe("Inspect, not available on the Board");
    expect(label("notes-tool-toggle")).toBe("Notes, not available on the Board");
    expect(label("comments-tool-toggle")).toBe("Comments on tiles, 1 open");
    expect(label("resolved-toggle")).toBe("Show resolved comments");
    expect(label("flow-mode-toggle")).toBe("Flow arrows");
    expect(document.getElementById("design-system-tool")).toBeNull(); // CHR-1284
    expect(label("board-clusters-toggle")).toBe("Clusters");
    expect(label("board-collapse-all-btn")).toBe("Collapse all clusters, all are collapsed");
    for (const id of ["comment-mode-toggle", "inspect-mode-toggle", "notes-tool-toggle", "board-collapse-all-btn"]) expect($(`#${id}`).getAttribute("aria-disabled")).toBe("true");
    for (const id of ["comments-tool-toggle", "resolved-toggle", "flow-mode-toggle", "board-clusters-toggle"]) expect($(`#${id}`).hasAttribute("aria-disabled")).toBe(false);
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    expect($("#board-clusters-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("the Flow tool answers to E on the Board and F elsewhere, in aria-keyshortcuts and its key too, on every view switch", async () => {
    await openBoard();
    const flow = $("#flow-mode-toggle");
    expect([flow.getAttribute("aria-keyshortcuts"), flow.dataset.shortcut]).toEqual(["E", "E"]);
    $('.view-tab[data-view="screens"]').click();
    expect([flow.getAttribute("aria-keyshortcuts"), flow.dataset.shortcut]).toEqual(["F", "F"]);
    $('.view-tab[data-view="board"]').click();
    expect(flow.getAttribute("aria-keyshortcuts")).toBe("E");
    $('.view-tab[data-view="design-system"]').click();
    expect(flow.getAttribute("aria-keyshortcuts")).toBe("F");
  });

  it("with nothing on the board, comments and collapse all say so; Show resolved stays a working switch (CHR-1292)", async () => {
    boardState = { filter: "xyzzy", pinned: [], expanded: [] };
    await openBoard();
    expect(label("comments-tool-toggle")).toBe("Comments on tiles, nothing on the board");
    expect(label("resolved-toggle")).toBe("Show resolved comments");
    expect($("#resolved-toggle").hasAttribute("aria-disabled")).toBe(false);
    expect(label("board-collapse-all-btn")).toBe("Collapse all clusters, nothing on the board");
    expect($("#comments-tool-toggle").getAttribute("aria-disabled")).toBe("true");
  });

  it("Clusters and Collapse all are hidden outside the Board (no gap, no stale state), and the tools are the Screens view's again (CHR-1283)", async () => {
    await openBoard();
    $('.view-tab[data-view="screens"]').click();
    for (const id of ["board-clusters-toggle", "board-collapse-all-btn"]) expect($(`#${id}`).hidden).toBe(true);
    expect($("#resolved-toggle").hidden).toBe(false);
    expect($("#tool-group-sep").hidden).toBe(false);
    // G and Shift+G do nothing in the Screens view, and the hidden Clusters tool keeps its state for the way back.
    const pressedBefore = $("#board-clusters-toggle").getAttribute("aria-pressed");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "G", code: "KeyG", shiftKey: true, bubbles: true, cancelable: true }));
    expect($("#board-clusters-toggle").getAttribute("aria-pressed")).toBe(pressedBefore);
    expect($("#tool-bar").getAttribute("aria-label")).toBe("Screen tools");
    expect(label("flow-mode-toggle")).toBe("Flow");
    expect(label("comment-mode-toggle")).toBe("Comment");
    expect($("#flow-mode-toggle").dataset.shortcutId).toBe("flow");
  });

  it("the Flow tool is the flow arrows on the Board (E), the flow mode elsewhere (F)", async () => {
    await openBoard();
    expect($("#flow-mode-toggle").dataset.shortcutId).toBe("board-edges");
    $("#flow-mode-toggle").click();
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    key("f");
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("false"); // F does nothing on the Board
    key("e");
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    // The flow mode armed in Screens is turned off when the Board takes over.
    $('.view-tab[data-view="screens"]').click();
    key("f");
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    $('.view-tab[data-view="board"]').click();
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("true"); // the arrows, which are on
    $('.view-tab[data-view="screens"]').click();
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("false"); // the mode did not survive the visit
  });

  it("the Comments panel of the Screens view does not stay open on the Board", async () => {
    await boot();
    $("#comments-tool-toggle").click();
    expect($("#tool-panel").hidden).toBe(false);
    $('.view-tab[data-view="board"]').click();
    await flush();
    expect($("#tool-panel").hidden).toBe(true);
  });

  it("Clusters toggles the shared preference, Collapse all clears the expanded state through the board API", async () => {
    boardState = { filter: null, pinned: [], expanded: ["checkout"] };
    await openBoard();
    expect(label("board-collapse-all-btn")).toBe("Collapse all clusters");
    $("#board-clusters-toggle").click();
    expect($("#board-clusters-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(label("board-collapse-all-btn")).toBe("Collapse all clusters, clusters are off");
    $("#board-clusters-toggle").click();
    $("#board-collapse-all-btn").click();
    expect(writes).toEqual([{ expanded: { op: "clear" } }]);
  });
});

describe("the left card on the Board", () => {
  const status = () => $("#screen-filter-hint").textContent;
  const sections = () => [...document.querySelectorAll("#screen-list .screen-section")].map((s) => `${s.querySelector(".screen-section-title").textContent} ${s.querySelector(".screen-section-count").textContent}`);

  it("says what is on the board, groups the list, and shows Clear pins while something is pinned", async () => {
    boardState = { filter: "checkout", pinned: ["home"], expanded: [] };
    await openBoard();
    expect(status()).toBe("3 on the board"); // checkout (with its variant), cart and the pinned home: clusters and screens, not variants
    expect(sections()).toEqual(["Matches 2", "Pinned 1"]);
    expect($("#board-clear-pins-btn").hidden).toBe(false);
    expect($("#board-clear-pins-btn").textContent).toBe("Clear pins");
    expect($('#screen-list [data-screen="home"] .screen-item-pin').getAttribute("aria-label")).toBe("Unpin home from the board");
    $("#board-clear-pins-btn").click();
    expect(writes).toEqual([{ pins: { op: "clear" } }]);
  });

  it("with no filter it reads All N on the board, and the list is Pinned / All screens", async () => {
    boardState = { filter: null, pinned: ["settings"], expanded: [] };
    await openBoard();
    expect(status()).toBe("All 4 on the board"); // checkout (with its variant), cart, home, settings
    expect(sections()).toEqual(["Pinned 1", "All screens 3"]);
  });

  it("is the Screens view's again elsewhere: the filter's match line, no Board groups, no Clear pins", async () => {
    boardState = { filter: "checkout", pinned: ["home"], expanded: [] };
    await openBoard();
    $('.view-tab[data-view="screens"]').click();
    expect(status()).toMatch(/match/);
    expect(sections()).toEqual([]);
    expect($("#board-clear-pins-btn").hidden).toBe(true);
  });

  it("nothing on the board: the status, the line under it, and the empty card with its Clear filter", async () => {
    boardState = { filter: "xyzzy", pinned: [], expanded: [] };
    await openBoard();
    expect(status()).toBe("Nothing on the board");
    expect($("#screen-list .nav-empty").textContent).toBe("No screen or tag matches “xyzzy”.");
    expect($("#board-empty-state").hidden).toBe(false);
    expect($("#board-empty-title").textContent).toBe("Nothing on the board");
    expect($("#board-empty-body").textContent).toBe("No screen matches “xyzzy” and nothing is pinned.\nClear the filter, or pin a screen from the list.");
    expect($("#board-empty-clear").hidden).toBe(false);
    $("#board-empty-clear").click();
    expect($("#screen-filter-input").value).toBe("");
  });
});

describe("the agent's presentation", () => {
  it("shows the notice as the design words it, counts the same screens as the card, and says so in the card", async () => {
    await openBoard();
    emit({ type: "board_state", filter: "checkout", pinned: [], expanded: [], source: "agent" });
    await flush();
    const banner = $("#board-presented-banner");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("The agent switched you to the Board to show 2 screens"); // checkout (with its variant) and cart
    expect($("#board-presented-text b").textContent).toBe("2 screens");
    expect($("#screen-filter-hint").textContent).toBe("2 shown by the agent");
    expect($("#agent-note-scope-text").textContent).toBe("On the Board, 2 screens"); // the Agent bar counts what the card counts
    $("#board-presented-dismiss").click();
    expect(banner.hidden).toBe(true);
    expect($("#screen-filter-hint").textContent).toBe("2 on the board");
  });

  it("does not rewrite the notice's words while they read the same (a live region speaks only for a real change)", async () => {
    await openBoard();
    emit({ type: "board_state", filter: "checkout", pinned: [], expanded: [], source: "agent" });
    await flush();
    const text = $("#board-presented-text");
    const before = text.firstChild;
    emit({ type: "board_state", filter: "checkout", pinned: [], expanded: [], source: "agent" });
    await flush();
    expect(text.firstChild).toBe(before);
  });
});

describe("the zoom pill on the Board", () => {
  it("shows with the Board's zoom, reads Fit all, and its slider and presets drive the Board", async () => {
    await openBoard();
    expect($("#canvas-controls").hidden).toBe(false);
    expect($("#zoom-fit-label").textContent).toBe("Fit all");
    expect($("#zoom-pop-hint").textContent).toBe("Drag, or Ctrl + scroll");
    expect($("#zoom-label").textContent).toBe("80%"); // the Board's own default
    $('#zoom-menu .zoom-preset[data-zoom="2"]').click();
    expect($("#zoom-label").textContent).toBe("200%");
    expect(memoryStorage.has("artisign.zoom")).toBe(false); // the screen canvas's zoom is not touched
    $("#zoom-in").click();
    expect($("#zoom-label").textContent).toBe("200%"); // already the largest
    $("#zoom-out").click();
    expect($("#zoom-label").textContent).toBe("195%");
    $('#zoom-menu .zoom-preset[data-zoom="fit"]').click();
    expect($("#zoom-fit").getAttribute("aria-pressed")).toBe("true");
    $('.view-tab[data-view="screens"]').click();
    expect($("#zoom-fit-label").textContent).toBe("Fit");
    expect($("#zoom-pop-hint").textContent).toBe("Drag the slider");
  });

  it("closes its menu when the view changes", async () => {
    await openBoard();
    $("#zoom-trigger").click();
    expect($("#zoom-menu").hasAttribute("data-open")).toBe(true);
    $('.view-tab[data-view="screens"]').click();
    expect($("#zoom-menu").hasAttribute("data-open")).toBe(false);
  });
});

describe("the screen the agent writes", () => {
  it("gets the ring and the Writing chip while the status says Writing, and loses them when the agent moves on", async () => {
    await openBoard();
    const tile = (name) => $(`.board-tile[data-screen="${name}"]`);
    emit({ type: "activity", tool: "write_html", kind: "write", ok: true, target: { kind: "screen", name: "home" }, nodes: [], at: Date.now() });
    await flush();
    expect(tile("home").classList.contains("writing")).toBe(true);
    expect(tile("home").querySelector(".board-tile-writing").hidden).toBe(false);
    emit({ type: "activity", tool: "get_screen", kind: "read", ok: true, target: { kind: "screen", name: "cart" }, nodes: [], at: Date.now() });
    await flush();
    expect(document.querySelector(".board-tile.writing")).toBeNull();
  });
});
