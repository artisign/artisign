// @vitest-environment jsdom
//
// CHR-1264 end to end through app.js: the Board's read-only comment pins — one request for all screens, the toolbar toggles, a pin's preview and "Open in Screens", and the refresh on SSE events.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));
const SCREENS = [
  { name: "one", tags: [], notes: "" },
  { name: "two", tags: [], notes: "" },
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

let boardData;
let requests;
let sources;

function stubDaemon() {
  boardData = { comments: [], threads: [] };
  requests = [];
  sources = [];
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url) => {
    const [path, query] = String(url).split("?");
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/comments") {
      requests.push(query);
      const screen = new URLSearchParams(query).get("screen");
      return json(screen ? { comments: boardData.comments.filter((c) => c.screen === screen), threads: boardData.threads.filter((t) => t.screen === screen) } : boardData);
    }
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
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
const press = (el) => {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  el.click();
};
const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });

const seed = () => {
  boardData = {
    comments: [
      { id: "c1", screen: "one", node_id: "one.btn-a", text: "Make it primary", author: "human", parent_id: null, resolved: false, ts: TS },
      { id: "c2", screen: "two", node_id: "two.btn-a", text: "Check spacing", author: "agent", agent: "ux-agent", parent_id: null, resolved: false, ts: TS },
      { id: "c3", screen: "two", node_id: "two.btn-a", text: "Fixed earlier", author: "human", parent_id: null, resolved: true, ts: TS },
    ],
    threads: [
      { id: "c1", screen: "one", node_id: "one.btn-a", author: "human", status: "open", detached: false, reply_count: 0 },
      { id: "c2", screen: "two", node_id: "two.btn-a", author: "agent", agent: "ux-agent", status: "open", detached: false, reply_count: 0 },
      { id: "c3", screen: "two", node_id: "two.btn-a", author: "human", status: "resolved", detached: false, reply_count: 0 },
    ],
  };
};

async function openBoard() {
  localStorage.setItem("artisign.last-screen:/p", "one");
  await import("./app.js");
  await flush();
  $('.view-tab[data-view="board"]').click();
  await flush();
  // The tile documents load from srcdoc; give them an element to measure.
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
const nativeAddEventListener = document.addEventListener.bind(document);
beforeEach(() => {
  documentListeners = [];
  document.addEventListener = (type, fn, opts) => {
    documentListeners.push([type, fn, opts]);
    nativeAddEventListener(type, fn, opts);
  };
});
afterEach(() => {
  for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
  document.addEventListener = nativeAddEventListener;
  vi.unstubAllGlobals();
});

const boardPins = () => [...document.querySelectorAll("#board-comment-layer .comment-pin")];
const boardRequests = () => requests.filter((q) => q.includes("scope=screens"));

describe("Board comments in the app", () => {
  it("fetches every screen's threads with one request and draws their pins and chips", async () => {
    seed();
    await openBoard();
    expect(boardRequests()).toHaveLength(1);
    expect(boardPins().map((p) => p.getAttribute("aria-label"))).toEqual(["Comment 1 on btn-a, open", "Comment 1 on btn-a, open"]);
    expect([...document.querySelectorAll("#board-comment-layer .comment-count-chip")].map((c) => c.getAttribute("aria-label"))).toEqual(["1 open comment", "1 open comment"]);
    expect($("#comments-tool-toggle").getAttribute("aria-label")).toBe("Comments, 2 open");
  });

  it("has no comment listener or marker inside a tile document", async () => {
    seed();
    await openBoard();
    for (const iframe of document.querySelectorAll(".board-tile-iframe")) {
      expect(iframe.contentDocument.querySelector(".comment-pin, .comment-count-chip, .board-comment-dot")).toBeNull();
    }
  });

  it("the Comments tool opens the panel; the pins have their own switch in it; Show resolved adds resolved pins and keeps its state", async () => {
    seed();
    await openBoard();
    const comments = $("#comments-tool-toggle");
    const resolved = $("#resolved-toggle");
    expect(comments.getAttribute("aria-pressed")).toBe("false");
    comments.click();
    expect(comments.getAttribute("aria-pressed")).toBe("true");
    expect($("#tool-panel").hidden).toBe(false);
    const pins = $("#comments-pins-toggle");
    expect(pins.checked).toBe(true);
    expect(resolved.hidden).toBe(false);
    expect(resolved.getAttribute("aria-label")).toBe("Show resolved comments");
    resolved.click();
    expect(resolved.getAttribute("aria-pressed")).toBe("true");
    expect(boardPins().some((p) => p.dataset.state === "resolved")).toBe(true);
    pins.click();
    expect(pins.checked).toBe(false);
    expect($("#board-comment-layer").hidden).toBe(true);
    // CHR-1292: a switch on its own — it stays usable with the pins off and keeps its state.
    expect(resolved.hasAttribute("aria-disabled")).toBe(false);
    expect(resolved.getAttribute("aria-pressed")).toBe("true");
    pins.click();
    expect($("#board-comment-layer").hidden).toBe(false);
  });

  it("the panel lists the Board's threads with their screens, numbered as their pins; a row brings the tile into view and opens the thread", async () => {
    seed();
    await openBoard();
    $("#comments-tool-toggle").click();
    const rows = () => [...document.querySelectorAll("#comments-list .comment-row")];
    expect(rows().map((r) => r.querySelector(".comment-row-variant").textContent)).toEqual(["one", "two"]);
    expect(rows().map((r) => r.querySelector(".comment-row-num").textContent)).toEqual(["1", "1"]); // numbered per screen, like the pins
    expect($("#comments-count-open").textContent).toBe("2");
    expect($("#comments-count-resolved").textContent).toBe("1");
    rows()[1].click();
    const popover = $("#board-comment-canvas-layer .comment-popover");
    expect(popover.hasAttribute("open")).toBe(true);
    expect(popover.textContent).toContain("Check spacing");
    expect(rows()[1].classList.contains("is-active")).toBe(true);
    // The Resolved tab lists the resolved ones and shows their pins, with the panel open.
    $("#comments-tab-resolved").click();
    expect(rows().map((r) => r.querySelector(".comment-row-variant").textContent)).toEqual(["two"]);
    expect(boardPins().some((p) => p.dataset.state === "resolved")).toBe(true);
  });

  it("the open count is a badge on the Comments tool while the pins are off", async () => {
    seed();
    await openBoard();
    const badge = $("#comment-count-badge");
    expect(badge.hidden).toBe(true); // the pins say it
    $("#comments-tool-toggle").click();
    $("#comments-pins-toggle").click();
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("2");
    expect($("#comments-tool-toggle").getAttribute("aria-label")).toBe("Comments, 2 open");
    $("#comments-pins-toggle").click();
    expect(badge.hidden).toBe(true);
  });

  it("turning the pins off closes an open thread popover", async () => {
    seed();
    await openBoard();
    $("#comments-tool-toggle").click();
    press(boardPins()[0]);
    expect($("#board-comment-canvas-layer .comment-popover").hasAttribute("open")).toBe(true);
    $("#comments-pins-toggle").click();
    expect($("#board-comment-canvas-layer .comment-popover").hasAttribute("open")).toBe(false);
  });

  it("Show resolved is on or off whatever the data: pressed state, tooltip with state and count, a hint at 0 (CHR-1292)", async () => {
    seed();
    boardData.comments = boardData.comments.filter((c) => c.id !== "c3");
    boardData.threads = boardData.threads.filter((t) => t.id !== "c3");
    await openBoard();
    const resolved = $("#resolved-toggle");
    expect(resolved.getAttribute("aria-pressed")).toBe("false");
    expect(resolved.title).toBe("Show resolved comments (0) (Shift+M)"); // jsdom has no interest invokers: the title carries the tooltip text
    resolved.click();
    expect(resolved.getAttribute("aria-pressed")).toBe("true"); // active = showResolved, not "has resolved comments"
    expect(resolved.title).toBe("Hide resolved comments (0) (Shift+M)");
    expect($("#tool-toast").hidden).toBe(false);
    expect($("#tool-toast").textContent).toBe("No resolved comments on the board");
    resolved.click();
    expect(resolved.getAttribute("aria-pressed")).toBe("false");
  });

  it("Show resolved counts the resolved threads of the shown tiles in its tooltip", async () => {
    seed();
    await openBoard();
    expect($("#resolved-toggle").title).toBe("Show resolved comments (1) (Shift+M)");
    $("#resolved-toggle").click();
    expect($("#resolved-toggle").title).toBe("Hide resolved comments (1) (Shift+M)");
    expect($("#tool-toast").hidden).toBe(true); // something to show: no hint
  });

  it("M and Shift+M reach the same tools from the keyboard, and Show resolved is the same switch in the Screens view", async () => {
    seed();
    await openBoard();
    const key = (k, init = {}) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, bubbles: true, cancelable: true, ...init }));
    key("M", { shiftKey: true });
    expect($("#resolved-toggle").getAttribute("aria-pressed")).toBe("true");
    key("m");
    expect($("#comments-tool-toggle").getAttribute("aria-pressed")).toBe("true");
    key("m");
    expect($("#comments-tool-toggle").getAttribute("aria-pressed")).toBe("false");
    $('.view-tab[data-view="screens"]').click();
    expect($("#resolved-toggle").hidden).toBe(false);
    expect($("#resolved-toggle").getAttribute("aria-pressed")).toBe("true"); // the state stays across views
    key("M", { shiftKey: true });
    expect($("#resolved-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("closes a pin's thread popover when the board is left, so Esc in Screens is not swallowed", async () => {
    seed();
    await openBoard();
    press(boardPins()[0]);
    expect($("#board-comment-canvas-layer .comment-popover").hasAttribute("open")).toBe(true);
    $('.view-tab[data-view="screens"]').click();
    expect($("#board-comment-canvas-layer .comment-popover").hasAttribute("open")).toBe(false);
  });

  it("a pin opens the thread in the comment canvas's popover; Open in Screens (More actions) shows that screen with the thread open", async () => {
    seed();
    await openBoard();
    const secondTilePin = boardPins()[1];
    press(secondTilePin);
    const popover = $("#board-comment-canvas-layer .comment-popover");
    expect(popover.hasAttribute("open")).toBe(true);
    expect(popover.textContent).toContain("Check spacing");
    expect(popover.textContent).toContain("ux-agent");
    expect(secondTilePin.getAttribute("aria-expanded")).toBe("true"); // the pin shows as the open one
    // Reply, resolve and the menu are the Screens popover's own.
    expect(popover.querySelector('textarea[aria-label="Reply"]')).not.toBeNull();
    expect(popover.querySelector('button[aria-label="Resolve"]')).not.toBeNull();
    popover.querySelector('button[aria-label="More actions"]').click();
    const items = [...popover.querySelectorAll(".comment-popover-menu button")];
    expect(items.some((b) => b.textContent.endsWith("Open in Screens"))).toBe(true);
    expect(items.some((b) => b.textContent.includes("Re-anchor"))).toBe(false); // done in the Screens view
    items.find((b) => b.textContent.endsWith("Open in Screens")).click();
    await flush();
    expect($('.view-tab[data-view="screens"]').getAttribute("aria-pressed")).toBe("true");
    expect($('.view-tab[data-view="board"]').getAttribute("aria-pressed")).toBe("false");
    // The Screens canvas shows screen "two" with its own thread popover open.
    const screensPopover = $("#comment-layer .comment-popover");
    expect(screensPopover.hasAttribute("open")).toBe(true);
    expect(screensPopover.textContent).toContain("Check spacing");
  });

  it("an SSE comments event refetches with one more request; a screen event refetches only for a screen with threads", async () => {
    seed();
    await openBoard();
    expect(boardRequests()).toHaveLength(1);
    boardData = { ...boardData, threads: boardData.threads.slice(0, 1) };
    emit({ type: "change", kind: "comments", name: "comments" });
    await flush();
    expect(boardRequests()).toHaveLength(2);
    expect(boardPins()).toHaveLength(1);
    emit({ type: "change", kind: "screen", name: "one" });
    await flush();
    expect(boardRequests()).toHaveLength(3);
    emit({ type: "change", kind: "screen", name: "two" });
    await flush();
    expect(boardRequests()).toHaveLength(3); // "two" has no threads left in the answer above
  });
});
