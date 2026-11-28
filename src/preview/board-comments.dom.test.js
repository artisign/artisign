// @vitest-environment jsdom
//
// CHR-1264 — the board's read-only comment overlay: markers, groups, the dot, the preview and its closing rules. jsdom has no layout, so the geometry is a stub whose documents answer getBoundingClientRect.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBoardComments } from "./board-comments.js";

const TS = "2026-11-26T10:00:00.000Z";
const thread = (id, screen, node, extra = {}) => ({ id, screen, node_id: node ? `${screen}.${node}` : null, author: "human", status: "open", detached: false, reply_count: 0, ...extra });
const record = (id, screen, node, text, extra = {}) => ({ id, screen, node_id: node ? `${screen}.${node}` : null, text, author: "human", parent_id: null, resolved: false, ts: TS, ...extra });

/** Element rects by id, per screen, in the tile's natural coordinates. */
function docWith(rects) {
  return {
    getElementById: (id) => (rects[id] ? { getBoundingClientRect: () => ({ left: rects[id][0], top: rects[id][1], right: rects[id][2], bottom: rects[id][3] }) } : null),
  };
}

let layer;
let surface;
let calls;
let zoom;
let docs;

function setup(extra = {}) {
  document.body.innerHTML = '<div id="surface"><div id="canvas"><div id="layer"></div></div></div>';
  layer = document.getElementById("layer");
  surface = document.getElementById("surface");
  calls = { open: [], zoom: [], thread: [] };
  const board = createBoardComments({
    layerEl: layer,
    surfaceEl: surface,
    geometry: () => ({
      zoom,
      tiles: [
        { screen: "one", x: 0, y: 0, width: 200, height: 300, naturalWidth: 400 },
        { screen: "two", x: 300, y: 0, width: 200, height: 300, naturalWidth: 400 },
      ],
      docOf: (s) => docs[s] ?? null,
    }),
    onOpenInScreens: (screen, id) => calls.open.push([screen, id]),
    onOpenThread: (id) => calls.thread.push(id),
    onZoomToTile: (screen) => calls.zoom.push(screen),
    ...extra,
  });
  return board;
}

const pins = () => [...layer.querySelectorAll(".comment-pin")];
const chips = () => [...layer.querySelectorAll(".comment-count-chip")];
const preview = () => layer.querySelector(".board-comment-preview");
const press = (el) => {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  el.click();
};
const esc = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

beforeEach(() => {
  zoom = 100;
  docs = { one: docWith({ "btn-a": [100, 100, 200, 140], "btn-b": [20, 20, 120, 60] }), two: docWith({ hero: [0, 0, 400, 100] }) };
});

describe("pins and chips", () => {
  it("draws one pin per open thread at the element's top-right corner, numbered per screen, with the right label", () => {
    const board = setup();
    board.setData({
      comments: [],
      threads: [thread("a", "one", "btn-a"), thread("b", "one", "btn-b", { author: "agent" }), thread("c", "two", "hero")],
    });
    const p = pins();
    expect(p.map((x) => x.textContent)).toEqual(["1", "2", "1"]);
    expect(p[0].getAttribute("aria-label")).toBe("Comment 1 on btn-a, open");
    expect(p[1].dataset.kind).toBe("agent");
    // Tile "one" is half scale (200/400): btn-a's right edge 200 -> 100, top 100 -> 50; pin box is centred on it.
    expect(p[0].style.left).toBe("88px");
    expect(p[0].style.top).toBe("38px");
  });

  it("shows no pin for resolved threads until Show resolved is on, and the resolved chip says they are hidden", () => {
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a", { status: "resolved" }), thread("b", "one", "btn-b", { status: "resolved" })] });
    expect(pins()).toHaveLength(0);
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual(["2 resolved comments, hidden"]);
    board.setShowResolved(true);
    expect(pins().map((x) => x.dataset.state)).toEqual(["resolved", "resolved"]);
    expect(chips()).toHaveLength(0);
  });

  it("keeps an open and a detached count chip apart, and a detached pin sits at the tile's top-left", () => {
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a"), thread("d", "one", "gone", { detached: true })] });
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual(["1 open comment", "1 detached comment"]);
    const detached = pins().find((x) => x.dataset.state === "detached");
    expect(detached.style.left).toBe("-12px");
    expect(detached.style.top).toBe("-12px");
    expect(detached.getAttribute("aria-label")).toBe("Comment 2, detached: its element is gone");
  });

  it("merges overlapping pins into a group whose click zooms to the tile and opens no preview", () => {
    docs.one = docWith({ "btn-a": [100, 100, 200, 140], "btn-b": [110, 104, 204, 140] });
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a"), thread("b", "one", "btn-b")] });
    expect(pins()).toHaveLength(1);
    const group = pins()[0];
    expect(group.textContent).toBe("2");
    expect(group.getAttribute("aria-label")).toBe("2 comments overlap here, zoom in to separate them");
    press(group);
    expect(calls.zoom).toEqual(["one"]);
    expect(preview().hidden).toBe(true);
  });

  it("puts a pin on its element's top-right corner, even where that is the tile's own corner (the tile has no pin button)", () => {
    docs.two = docWith({ hero: [0, 0, 400, 100] });
    const board = setup();
    board.setData({ comments: [], threads: [thread("c", "two", "hero")] });
    // Tile two spans x 300-500: the element's right edge is the tile's, and the pin is centred on it.
    expect(pins()[0].style.left).toBe(`${500 - 12}px`);
  });

  it("makes room for the chips in the label (name, count, chips, pin mark) and sets them where that room starts", () => {
    const reserved = [];
    const board = setup({
      geometry: () => ({
        zoom,
        tiles: [{ screen: "one", x: 0, y: 0, width: 200, height: 300, naturalWidth: 400 }],
        docOf: (s) => docs[s] ?? null,
        chipsAt: () => ({ left: 90, top: -26, height: 18 }),
        reserveChips: (screen, width) => reserved.push([screen, width]),
      }),
    });
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a")] });
    const row = layer.querySelector(".board-comment-chips");
    const layerLeft = layer.getBoundingClientRect().left;
    expect(reserved).toHaveLength(1);
    expect(reserved[0][0]).toBe("one");
    expect(reserved[0][1]).toBe(row.getBoundingClientRect().width + 8); // the room is the chips and a gap before the pin mark
    expect(row.style.left).toBe(`${90 - layerLeft}px`);
    expect(row.style.height).toBe("18px");
  });

  it("keeps chips out that would run into the next tile's label, and gives the label its room back", () => {
    const reserved = [];
    const board = setup({
      geometry: () => ({
        zoom,
        tiles: [{ screen: "one", x: 0, y: 0, width: 200, height: 300, naturalWidth: 400 }],
        docOf: (s) => docs[s] ?? null,
        chipsAt: () => ({ left: 900, top: -26, height: 18 }), // far past the tile's right edge (200) and half the gap beyond it
        reserveChips: (screen, width) => reserved.push(width),
      }),
    });
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a")] });
    expect(layer.querySelector(".board-comment-chips").hidden).toBe(true);
    expect(reserved.at(-1)).toBe(0);
    expect(pins()).toHaveLength(1); // the pin still says it
  });

  it("draws nothing while Comments is off, and again when it is back on", () => {
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a")] });
    board.setEnabled(false);
    expect(layer.hidden).toBe(true);
    board.setEnabled(true);
    expect(layer.hidden).toBe(false);
    expect(pins()).toHaveLength(1);
  });
});

describe("opening a thread", () => {
  const data = () => ({
    comments: [record("a", "one", "btn-a", "Make it primary"), record("r", "one", "btn-a", "Done", { parent_id: "a", author: "agent", agent: "ux-agent" })],
    threads: [thread("a", "one", "btn-a", { reply_count: 1 }), thread("b", "one", "btn-b")],
  });

  it("does nothing on hover; a click on a pin hands the thread to the comment canvas and opens no preview of its own", () => {
    const board = setup();
    board.setData(data());
    pins()[0].dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    pins()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(calls.thread).toEqual([]);
    press(pins()[0]);
    expect(calls.thread).toEqual(["a"]);
    expect(preview().hidden).toBe(true);
  });

  it("a count chip opens its first thread of that kind", () => {
    const board = setup();
    board.setData(data());
    press(chips()[0]);
    expect(calls.thread).toEqual(["a"]);
  });

  it("marks the open thread's marker as active, and again after every rebuild", () => {
    const board = setup();
    board.setData(data());
    board.setActiveThread("b");
    expect(pins().map((x) => x.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(pins()[1].dataset.active).toBe("true");
    board.layout();
    expect(pins()[1].dataset.active).toBe("true");
    board.setActiveThread(null);
    expect(pins().map((x) => x.dataset.active)).toEqual([undefined, undefined]);
  });

  it("gives a thread's marker back for the focus, and its screen", () => {
    const board = setup();
    board.setData(data());
    expect(board.markerOf("b")).toBe(pins()[1]);
    expect(board.screenOf("b")).toBe("one");
    expect(board.screenOf("nope")).toBeNull();
  });

  it("groups and the zoom to a tile are unchanged: a group opens no thread", () => {
    docs.one = docWith({ "btn-a": [100, 100, 200, 140], "btn-b": [110, 104, 204, 140] });
    const board = setup();
    board.setData(data());
    press(pins()[0]);
    expect(calls.thread).toEqual([]);
    expect(calls.zoom).toEqual(["one"]);
  });
});

describe("below 15 % zoom", () => {
  it("shows one dot per tile with the number of its threads, and no pins or chips", () => {
    zoom = 10;
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a"), thread("b", "one", "btn-b"), thread("c", "two", "hero")] });
    const dots = [...layer.querySelectorAll(".board-comment-dot")];
    expect(dots.map((d) => d.textContent)).toEqual(["2", "1"]);
    expect(pins()).toHaveLength(0);
    expect(chips()).toHaveLength(0);
  });

  it("opens the screen's thread list on a click; a row opens that thread in Screens", () => {
    zoom = 10;
    const board = setup();
    board.setData({
      comments: [record("a", "one", "btn-a", "Primary?"), record("b", "one", "btn-b", "Label", { author: "agent", agent: "ux-agent" })],
      threads: [thread("a", "one", "btn-a"), thread("b", "one", "btn-b", { author: "agent" })],
    });
    const dot = layer.querySelector(".board-comment-dot");
    press(dot);
    expect(preview().getAttribute("aria-label")).toBe("Comments of this screen, read only");
    expect(preview().querySelector(".board-comment-preview-title").textContent).toBe("one");
    expect(preview().querySelector(".board-comment-preview-count").textContent).toBe("2 open");
    const rows = [...preview().querySelectorAll(".board-comment-row")];
    expect(rows.map((r) => r.querySelector(".board-comment-row-text").textContent)).toEqual(["You: Primary?", "ux-agent: Label"]);
    rows[1].click();
    expect(calls.open).toEqual([["one", "b"]]);
  });

  it("closes the list when the pins come back with the zoom", () => {
    zoom = 10;
    const board = setup();
    board.setData({ comments: [record("a", "one", "btn-a", "x")], threads: [thread("a", "one", "btn-a")] });
    press(layer.querySelector(".board-comment-dot"));
    expect(preview().hidden).toBe(false);
    zoom = 100;
    board.layout();
    expect(preview().hidden).toBe(true);
  });

  it("closes the list on Esc and returns the focus to the dot; an outside press closes it without moving the focus", () => {
    zoom = 10;
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a")] });
    const dot = layer.querySelector(".board-comment-dot");
    press(dot);
    esc();
    expect(preview().hidden).toBe(true);
    expect(document.activeElement).toBe(dot);
    press(dot);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(preview().hidden).toBe(true);
    press(dot);
    board.close();
    expect(preview().hidden).toBe(true);
  });
});

describe("the list's closing rules", () => {
  const realActive = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement");
  afterEach(() => {
    delete document.activeElement;
    if (realActive) Object.defineProperty(Document.prototype, "activeElement", realActive);
  });
  const open = () => {
    zoom = 10;
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a")] });
    press(layer.querySelector(".board-comment-dot"));
    return board;
  };

  it("closes when the focus moves into an iframe (no listener inside the tile), and ignores a blur that lands elsewhere", () => {
    open();
    window.dispatchEvent(new Event("blur"));
    expect(preview().hidden).toBe(false);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => frame });
    window.dispatchEvent(new Event("blur"));
    expect(preview().hidden).toBe(true);
  });

  it("leaves Esc alone while the board is not shown, and to an open modal dialog", () => {
    open();
    surface.hidden = true;
    const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    surface.hidden = false;
    const dialog = document.body.appendChild(document.createElement("dialog"));
    dialog.className = "float-dialog";
    dialog.setAttribute("open", "");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(preview().hidden).toBe(false);
    dialog.removeAttribute("open");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(preview().hidden).toBe(true);
    dialog.remove();
  });
});

describe("summary", () => {
  it("counts open threads (detached included) and detached ones of the shown screens only", () => {
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a"), thread("d", "one", "gone", { detached: true }), thread("x", "one", "btn-b", { status: "resolved" }), thread("c", "two", "hero")] });
    expect(board.summary(["one"])).toEqual({ open: 2, detached: 1, resolved: 1 });
    expect(board.summary(["one", "two"])).toEqual({ open: 3, detached: 1, resolved: 1 });
    expect(board.threadScreens()).toEqual(new Set(["one", "two"]));
  });
});
