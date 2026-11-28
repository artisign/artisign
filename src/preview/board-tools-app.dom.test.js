// @vitest-environment jsdom
//
// CHR-1295, CHR-1296 end to end through app.js: Comment and Inspect on the Board. jsdom has no layout, so each tile's iframe is given a rect, a layout width and an elementFromPoint; the pointer layer then maps a click into the tile exactly as in a browser.
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
let posts;
let nodeRequests;
let boardWrites;
let sources;

function stubDaemon() {
  boardData = { comments: [], threads: [] };
  posts = [];
  nodeRequests = [];
  boardWrites = [];
  sources = [];
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const [path, query] = String(url).split("?");
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/comments" && init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return json({});
    }
    if (path === "/api/comments") {
      const screen = new URLSearchParams(query).get("screen");
      return json(screen ? { comments: boardData.comments.filter((c) => c.screen === screen), threads: boardData.threads.filter((t) => t.screen === screen) } : boardData);
    }
    if (path === "/api/tools/set_board_state") {
      boardWrites.push(JSON.parse(init.body));
      return json({});
    }
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/tools/get_screen") {
      const { screen } = JSON.parse(init.body);
      nodeRequests.push(screen);
      return json({ nodes: [{ id: "root", tag: "div", parent_id: null }, { id: "btn-a", tag: "button", parent_id: "root", refs: { component_ref: "btn", variant: "primary" } }] });
    }
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root"><button id="btn-a">A</button></div>` };
    return json({});
  });
}

Element.prototype.scrollIntoView ??= function () {};
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
const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, bubbles: true, cancelable: true }));
const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

/** Tile one is drawn at (100, 50), tile two at (500, 50); both 200 px wide for a 400 px document (the board at some zoom). The button sits at document (100, 100)-(200, 140); anything else under the pointer is the root. */
const TILE_AT = { one: 100, two: 500 };

async function openBoard() {
  localStorage.setItem("artisign.last-screen:/p", "one");
  await import("./app.js");
  await flush();
  $('.view-tab[data-view="board"]').click();
  await flush();
  for (const iframe of document.querySelectorAll(".board-tile-iframe")) {
    const screen = iframe.title.replace(" (board)", "");
    const doc = iframe.contentDocument;
    doc.body.innerHTML = '<div id="root"><button id="btn-a">A</button></div>';
    const button = doc.getElementById("btn-a");
    button.getBoundingClientRect = () => ({ left: 100, top: 100, right: 200, bottom: 140, width: 100, height: 40 });
    // The pointer is over the button inside this box of the tile (document px), else over the root.
    doc.elementFromPoint = (x, y) => (x >= 100 && x < 200 && y >= 100 && y < 140 ? button : doc.getElementById("root"));
    iframe.getBoundingClientRect = () => ({ left: TILE_AT[screen], top: 50, width: 200, height: 400, right: TILE_AT[screen] + 200, bottom: 450 });
    Object.defineProperty(iframe, "offsetWidth", { configurable: true, get: () => 400 });
    iframe.dispatchEvent(new Event("load"));
  }
  await new Promise((r) => setTimeout(r, 120));
  nodeRequests.length = 0; // the Screens view's own boot request is not the Board's
}

const seed = () => {
  boardData = {
    comments: [{ id: "c1", screen: "one", node_id: "one.btn-a", text: "Make it primary", author: "human", parent_id: null, resolved: false, ts: TS }],
    threads: [{ id: "c1", screen: "one", node_id: "one.btn-a", author: "human", status: "open", detached: false, reply_count: 0 }],
  };
};

/** A pointer move or click at a client point: on the pick overlay of the tile drawn there, else on the surface (empty board space). */
const onLayer = (type, x, y) => {
  const tile = Object.entries(TILE_AT).find(([, left]) => x >= left && x < left + 200 && y >= 50 && y < 450)?.[0];
  const target = tile ? document.querySelector(`.board-tile[data-screen="${tile}"] .board-tile-pick`) : $("#board-surface");
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
};
/** The client point of a document point in tile `screen`. */
const clientOf = (screen, x, y) => [TILE_AT[screen] + x * 0.5, 50 + y * 0.5];

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

const popover = () => $("#board-comment-canvas-layer .comment-popover");
const typeAndSend = async (text) => {
  const input = popover().querySelector("textarea");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await flush();
};

describe("Comment on the Board (CHR-1295)", () => {
  it("is an enabled tool: C turns the mode on with its banner, the pointer layer takes the pointer, Esc leaves", async () => {
    await openBoard();
    expect($("#comment-mode-toggle").hasAttribute("aria-disabled")).toBe(false);
    expect($("#board-canvas").dataset.pick).toBe("false");
    key("c");
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    expect($("#board-comment-banner").hidden).toBe(false);
    expect($("#board-comment-banner").textContent).toContain("Comment mode: click an element to start a thread");
    expect($("#board-canvas").dataset.pick).toBe("true");
    esc();
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#board-comment-banner").hidden).toBe(true);
    expect($("#board-canvas").dataset.pick).toBe("false");
  });

  it("hovering an element outlines it with its name; a click opens the composer, and Enter posts the thread on that screen and element", async () => {
    await openBoard();
    key("c");
    const [x, y] = clientOf("two", 150, 120); // over the button of tile two
    onLayer("pointermove", x, y);
    const outline = $("#board-comment-canvas-layer .comment-hover-outline");
    expect(outline.hidden).toBe(false);
    expect(outline.dataset.label).toBe("two · btn-a");
    onLayer("click", x, y);
    expect(popover().hasAttribute("open")).toBe(true);
    expect(popover().querySelector("b").textContent).toBe("New thread");
    expect(popover().querySelector("code").textContent).toBe("btn-a");
    await typeAndSend("Spacing is off");
    expect(posts).toEqual([{ screen: "two", node_id: "btn-a", text: "Spacing is off" }]);
    expect(popover().hasAttribute("open")).toBe(false);
  });

  it("a click on the screen's root starts a thread on the whole screen", async () => {
    await openBoard();
    key("c");
    const [x, y] = clientOf("one", 20, 20);
    onLayer("click", x, y);
    await typeAndSend("Whole screen");
    expect(posts).toEqual([{ screen: "one", node_id: null, text: "Whole screen" }]);
  });

  it("clicking empty board space does nothing", async () => {
    await openBoard();
    key("c");
    onLayer("click", 380, 100); // between the tiles
    expect(popover().hasAttribute("open")).toBe(false);
    expect(posts).toEqual([]);
  });

  it("a pin opens the full thread: a reply and a resolve post to the same thread the Screens view has", async () => {
    seed();
    await openBoard();
    press($("#board-comment-layer .comment-pin"));
    expect(popover().hasAttribute("open")).toBe(true);
    await typeAndSend("On it");
    expect(posts.at(-1)).toEqual({ parent_id: "c1", text: "On it" });
    press($("#board-comment-layer .comment-pin"));
    popover().querySelector('button[aria-label="Resolve"]').click();
    await flush();
    expect(posts.at(-1)).toEqual({ parent_id: "c1", text: "", resolved: true });
  });

  it("below 30 % writing is off: the banner says to zoom in, a click starts nothing, and an open thread has no composer or resolve", async () => {
    seed();
    memoryStorage.set("artisign.boardZoom", "20");
    await openBoard();
    key("c");
    expect($("#board-comment-banner").textContent).toContain("Zoom in to comment");
    const [x, y] = clientOf("two", 150, 120);
    onLayer("click", x, y);
    expect(popover().hasAttribute("open")).toBe(false);
    press($("#board-comment-layer .comment-pin"));
    expect(popover().hasAttribute("open")).toBe(true);
    expect(popover().querySelector("form").hidden).toBe(true);
    expect(popover().querySelector(".comment-popover-locked").textContent).toBe("Zoom in to comment");
    expect(popover().querySelector('button[aria-label="Resolve"]')).toBeNull();
    expect(popover().querySelector('button[aria-label="More actions"]')).not.toBeNull(); // Open in Screens stays
    expect(posts).toEqual([]);
  });

  it("the Screens view's comment mode does not come along when the board is left, and the board's does not leak back", async () => {
    await openBoard();
    key("c");
    $('.view-tab[data-view="screens"]').click();
    expect($("#board-canvas").dataset.pick).toBe("false");
    expect($("#comment-banner").hidden).toBe(false); // the mode is still on, now on the Screens canvas
    $('.view-tab[data-view="board"]').click();
    expect($("#board-canvas").dataset.pick).toBe("true");
    expect($("#comment-banner").hidden).toBe(true);
  });
});

describe("the tools beside the Board's own controls", () => {
  it("keep a tile's controls clickable: the pick overlay sits inside the tile's frame, below its label and pin mark", async () => {
    await openBoard();
    key("c");
    const tile = document.querySelector('.board-tile[data-screen="one"]');
    expect(tile.querySelector(".board-tile-frame > .board-tile-pick")).not.toBeNull();
    expect(tile.querySelector(".board-tile-pick").contains(tile.querySelector(".board-tile-pin"))).toBe(false);
    expect(tile.querySelector(".board-tile-frame").contains(tile.querySelector(".board-tile-label"))).toBe(false);
    // The pin mark still works and starts no thread.
    const pin = tile.querySelector(".board-tile-pin");
    pin.hidden = false;
    pin.click();
    await flush();
    expect(boardWrites).toHaveLength(1);
    expect(popover().hasAttribute("open")).toBe(false);
    // The same in inspect mode: a click on the control selects nothing.
    key("i");
    pin.click();
    await flush();
    expect(nodeRequests).toEqual([]);
  });
});

describe("the views' comment canvases", () => {
  it("entering the Board closes the Screens popover, so the first Esc there closes the Board's own", async () => {
    seed();
    await openBoard();
    $('.view-tab[data-view="screens"]').click();
    await flush();
    key("c");
    // Open a thread in the Screens canvas (the pin of screen "one" is on the open screen).
    const screensPin = document.querySelector("#comment-layer .comment-pin");
    if (screensPin) screensPin.click();
    $('.view-tab[data-view="board"]').click();
    await flush();
    expect(document.querySelector("#comment-layer .comment-popover").hasAttribute("open")).toBe(false);
    press($("#board-comment-layer .comment-pin"));
    expect(popover().hasAttribute("open")).toBe(true);
    esc();
    expect(popover().hasAttribute("open")).toBe(false);
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true"); // the mode stays until the next Esc
  });

  it("with comment mode on, below 30 % the hover outline stays away", async () => {
    memoryStorage.set("artisign.boardZoom", "20");
    await openBoard();
    key("c");
    const [x, y] = clientOf("two", 150, 120);
    onLayer("pointermove", x, y);
    expect($("#board-comment-canvas-layer .comment-hover-outline").hidden).toBe(true);
  });
});

describe("pan input with a tool active (CHR-1290)", () => {
  const press1 = (target, type, x, y, init = {}) => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, ...init }));
  const drag = (button, from, to) => {
    const overlay = document.querySelector('.board-tile[data-screen="one"] .board-tile-pick');
    press1(overlay, "pointerdown", from[0], from[1], { button, buttons: 1 << (button === 1 ? 2 : 0) });
    press1(document, "pointermove", from[0], from[1], { buttons: 1 });
    press1(document, "pointermove", to[0], to[1], { buttons: 1 });
    press1(document, "pointerup", to[0], to[1]);
  };
  const scrollOf = () => [$("#board-surface").scrollLeft, $("#board-surface").scrollTop];

  for (const [name, mode] of [["Comment", "c"], ["Inspect", "i"]]) {
    it(`${name}: a left drag does not pan the Board, a middle drag and Space + drag do`, async () => {
      await openBoard();
      $("#board-surface").scrollLeft = 200;
      $("#board-surface").scrollTop = 200;
      key(mode);
      drag(0, [150, 100], [110, 60]);
      expect(scrollOf()).toEqual([200, 200]);
      drag(1, [150, 100], [110, 60]);
      expect(scrollOf()).toEqual([240, 240]);
      $("#board-surface").dispatchEvent(new Event("pointerenter"));
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
      drag(0, [150, 100], [130, 80]);
      document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true }));
      expect(scrollOf()).toEqual([260, 260]);
    });
  }
});

describe("Inspect on the Board (CHR-1296)", () => {
  it("is an enabled tool: I turns the mode on and opens the Inspect panel", async () => {
    await openBoard();
    expect($("#inspect-mode-toggle").hasAttribute("aria-disabled")).toBe(false);
    key("i");
    expect($("#inspect-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    expect($("#inspect-panel").hidden).toBe(false);
    expect($("#board-canvas").dataset.pick).toBe("true");
  });

  it("hovering outlines the element with its name; a click lists that tile's screen in the panel and selects the element", async () => {
    await openBoard();
    key("i");
    const [x, y] = clientOf("two", 150, 120);
    onLayer("pointermove", x, y);
    const hover = $("#board-inspect-hover");
    expect(hover.hidden).toBe(false);
    expect(hover.dataset.label).toBe("btn-a");
    onLayer("click", x, y);
    await flush();
    expect(nodeRequests).toEqual(["two"]);
    expect([...document.querySelectorAll("#inspector-list .node-row-id")].map((n) => n.textContent)).toEqual(["root", "btn-a"]);
    expect($("#inspector-list .is-selected .node-row-id").textContent).toBe("btn-a");
    expect($("#inspector-summary").textContent).toContain("btn-a");
    expect($("#inspector-summary").textContent).toContain("Screen two");
    const selection = $("#board-inspect-selection");
    expect(selection.hidden).toBe(false);
    expect(selection.dataset.label).toBe("$btn · primary"); // the component's name, as in Screens
    // A second tile reloads the panel with its own screen.
    const [x2, y2] = clientOf("one", 150, 120);
    onLayer("click", x2, y2);
    await flush();
    expect(nodeRequests).toEqual(["two", "one"]);
    expect($("#inspector-summary").textContent).toContain("Screen one");
  });

  it("clicking empty board space, or the screen itself, clears the selection; Esc clears it first and the next one leaves the mode", async () => {
    await openBoard();
    key("i");
    const [x, y] = clientOf("one", 150, 120);
    onLayer("click", x, y);
    await flush();
    expect($("#board-inspect-selection").hidden).toBe(false);
    onLayer("click", 380, 100);
    expect($("#board-inspect-selection").hidden).toBe(true);
    expect($("#inspector-list .is-selected")).toBeNull();
    onLayer("click", x, y);
    await flush();
    const [rx, ry] = clientOf("one", 20, 20);
    onLayer("click", rx, ry);
    expect($("#board-inspect-selection").hidden).toBe(true);
    onLayer("click", x, y);
    await flush();
    esc();
    expect($("#board-inspect-selection").hidden).toBe(true);
    expect($("#inspect-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    esc();
    expect($("#inspect-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#board-canvas").dataset.pick).toBe("false");
  });

  it("below 30 % it says to zoom in and selects nothing", async () => {
    memoryStorage.set("artisign.boardZoom", "20");
    await openBoard();
    key("i");
    expect($("#board-inspect-hint").hidden).toBe(false);
    expect($("#board-inspect-hint").textContent).toBe("Zoom in to inspect");
    const [x, y] = clientOf("one", 150, 120);
    onLayer("pointermove", x, y);
    expect($("#board-inspect-hover").hidden).toBe(true);
    onLayer("click", x, y);
    await flush();
    expect(nodeRequests).toEqual([]);
  });

  it("the selection is not carried to the Screens view, which lists its own open screen again", async () => {
    await openBoard();
    key("i");
    const [x, y] = clientOf("two", 150, 120);
    onLayer("click", x, y);
    await flush();
    $('.view-tab[data-view="screens"]').click();
    await flush();
    expect($("#board-inspect-selection").hidden).toBe(true);
    expect($("#inspector-summary").hidden).toBe(true);
    expect(nodeRequests.at(-1)).toBe("one"); // the Screens view's open screen
  });
});
