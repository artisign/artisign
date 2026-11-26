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
  calls = { open: [], zoom: [] };
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

  it("keeps a marker off the tile's top-right corner, where the pin button sits", () => {
    docs.two = docWith({ hero: [0, 0, 400, 100] });
    const board = setup();
    board.setData({ comments: [], threads: [thread("c", "two", "hero")] });
    // Tile two spans x 300-500 (right 500): the pin's centre is at most right - 28.
    expect(pins()[0].style.left).toBe(`${500 - 28 - 12}px`);
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

describe("the preview", () => {
  const data = () => ({
    comments: [record("a", "one", "btn-a", "Make it primary"), record("r", "one", "btn-a", "Done", { parent_id: "a", author: "agent", agent: "ux-agent" })],
    threads: [thread("a", "one", "btn-a", { reply_count: 1 }), thread("b", "one", "btn-b")],
  });

  it("does nothing on hover and opens on a click with the messages, the status and Open in Screens", () => {
    const board = setup();
    board.setData(data());
    pins()[0].dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    pins()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(preview().hidden).toBe(true);
    press(pins()[0]);
    expect(preview().hidden).toBe(false);
    expect(preview().querySelector("b").textContent).toBe("#1");
    expect([...preview().querySelectorAll(".comment-message-body")].map((n) => n.textContent)).toEqual(["Make it primary", "Done"]);
    expect(preview().querySelector(".board-comment-preview-meta").textContent).toBe("2 messages · open");
    expect(pins()[0].getAttribute("aria-expanded")).toBe("true");
    const open = [...preview().querySelectorAll("button")].find((b) => b.textContent === "Open in Screens");
    open.click();
    expect(calls.open).toEqual([["one", "a"]]);
    expect(preview().hidden).toBe(true);
  });

  it("closes on Esc and returns the focus to the pin, and on an outside press without moving focus", () => {
    const board = setup();
    board.setData(data());
    const first = pins()[0];
    press(first);
    esc();
    expect(preview().hidden).toBe(true);
    expect(document.activeElement).toBe(first);
    press(first);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(preview().hidden).toBe(true);
  });

  it("switches to another pin in one press: the pointerdown on a marker does not close it first (no swallowed click)", () => {
    const board = setup();
    board.setData(data());
    const [one, two] = pins();
    press(one);
    const kept = pins();
    press(two);
    expect(pins()).toEqual(kept); // opening and closing never rebuild the markers
    expect(preview().querySelector("b").textContent).toBe("#2");
    expect(one.getAttribute("aria-expanded")).toBe("false");
    expect(two.getAttribute("aria-expanded")).toBe("true");
  });

  it("a second click on the open pin closes it", () => {
    const board = setup();
    board.setData(data());
    press(pins()[0]);
    press(pins()[0]);
    expect(preview().hidden).toBe(true);
  });

  it("shows the detached notice and badge for a detached thread, and the resolved badge for a resolved one", () => {
    const board = setup();
    board.setShowResolved(true);
    board.setData({
      comments: [record("d", "one", "gone", "Gone?"), record("x", "one", "btn-a", "Fine", { resolved: true })],
      threads: [thread("d", "one", "gone", { detached: true }), thread("x", "one", "btn-a", { status: "resolved" })],
    });
    press(pins().find((p) => p.dataset.state === "detached"));
    expect(preview().textContent).toContain("This element is no longer on the screen. Open the screen to move the thread to another element.");
    expect(preview().querySelector(".comment-badge--detached").textContent).toBe("Detached");
    press(pins().find((p) => p.dataset.state === "resolved"));
    expect(preview().querySelector(".comment-badge--resolved").textContent).toBe("Resolved");
    expect(preview().querySelector(".board-comment-preview-meta").textContent).toBe("1 message · resolved");
  });

  it("closes when a refresh drops the thread, and stays open (same markers rebuilt) when it is still there", () => {
    const board = setup();
    board.setData(data());
    press(pins()[0]);
    board.setData(data());
    expect(preview().hidden).toBe(false);
    board.setData({ comments: [], threads: [thread("b", "one", "btn-b")] });
    expect(preview().hidden).toBe(true);
  });

  it("Esc after a rebuild (tile load, refetch, zoom) still returns the focus to the new marker, chips included", () => {
    const board = setup();
    board.setData(data());
    press(pins()[0]);
    board.layout();
    const fresh = pins()[0];
    expect(fresh.getAttribute("aria-expanded")).toBe("true");
    esc();
    expect(document.activeElement).toBe(fresh);
    press(chips()[0]);
    board.layout();
    expect(chips()[0].getAttribute("aria-expanded")).toBe("true");
    esc();
    expect(document.activeElement).toBe(chips()[0]);
  });

  describe("an outside press inside a tile", () => {
    const realActive = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement");
    afterEach(() => {
      delete document.activeElement;
      if (realActive) Object.defineProperty(Document.prototype, "activeElement", realActive);
    });

    it("closes the preview when the focus moves into an iframe (no listener inside the tile)", () => {
      const board = setup();
      board.setData(data());
      const frame = document.createElement("iframe");
      document.body.append(frame);
      press(pins()[0]);
      Object.defineProperty(document, "activeElement", { configurable: true, get: () => frame });
      window.dispatchEvent(new Event("blur"));
      expect(preview().hidden).toBe(true);
    });

    it("ignores a window blur that does not land in an iframe", () => {
      const board = setup();
      board.setData(data());
      press(pins()[0]);
      window.dispatchEvent(new Event("blur"));
      expect(preview().hidden).toBe(false);
    });
  });

  it("leaves Esc alone while the board is not shown, and close() drops the preview", () => {
    const board = setup();
    board.setData(data());
    press(pins()[0]);
    surface.hidden = true;
    const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    board.close();
    expect(preview().hidden).toBe(true);
  });

  it("a count chip opens its first thread of that kind", () => {
    const board = setup();
    board.setData(data());
    press(chips()[0]);
    expect(preview().querySelector("b").textContent).toBe("#1");
  });
});

describe("below 60 % zoom", () => {
  it("shows one dot per tile with the number of its threads, and no pins or chips", () => {
    zoom = 42;
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a"), thread("b", "one", "btn-b"), thread("c", "two", "hero")] });
    const dots = [...layer.querySelectorAll(".board-comment-dot")];
    expect(dots.map((d) => d.textContent)).toEqual(["2", "1"]);
    expect(pins()).toHaveLength(0);
    expect(chips()).toHaveLength(0);
  });

  it("opens the screen's thread list on a click; a row opens that thread in Screens", () => {
    zoom = 42;
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

  it("closes a pin's preview when the zoom drops below 60 %, and the list when it comes back", () => {
    const board = setup();
    board.setData({ comments: [record("a", "one", "btn-a", "x")], threads: [thread("a", "one", "btn-a")] });
    press(pins()[0]);
    zoom = 40;
    board.layout();
    expect(preview().hidden).toBe(true);
    press(layer.querySelector(".board-comment-dot"));
    expect(preview().hidden).toBe(false);
    zoom = 100;
    board.layout();
    expect(preview().hidden).toBe(true);
  });
});

describe("summary", () => {
  it("counts open threads (detached included) and detached ones of the shown screens only", () => {
    const board = setup();
    board.setData({ comments: [], threads: [thread("a", "one", "btn-a"), thread("d", "one", "gone", { detached: true }), thread("x", "one", "btn-b", { status: "resolved" }), thread("c", "two", "hero")] });
    expect(board.summary(["one"])).toEqual({ open: 2, detached: 1 });
    expect(board.summary(["one", "two"])).toEqual({ open: 3, detached: 1 });
    expect(board.threadScreens()).toEqual(new Set(["one", "two"]));
  });
});
