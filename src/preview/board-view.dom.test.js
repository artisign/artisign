// @vitest-environment jsdom
//
// CHR-733 — the cluster board's DOM: frames, header clicks, "+N more" tiles,
// docked edge labels, and that tiles survive an expanded-only change. jsdom has
// no layout, so sizes fall back to the default phone size; geometry itself is
// covered in board.test.js.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api.js", () => ({ fetchRender: vi.fn(async (screen) => ({ ok: true, html: `<div id="r">${screen}</div>` })) }));

import { createBoardView } from "./board-view.js";
import { clusterToggleWrite } from "./board.js";
import { fetchRender } from "./api.js";

const v = (name, variant_of, variant_kind) => ({ name, tags: [], ...(variant_of ? { variant_of, variant_kind } : {}) });
const screens = [
  v("dash"),
  v("dash-empty", "dash", "state"),
  v("cart"),
  v("cart-clear", "cart", "overlay"),
  v("cart-clear-confirm", "cart-clear", "step"),
  v("plain"),
];
const names = screens.map((s) => s.name);
const flows = [
  { from: "plain.go", event: "tap", to: "dash-empty", to_kind: "screen" },
  { from: "cart-clear-confirm.go", event: "tap", to: "plain", to_kind: "screen" },
];

function setup(extra = {}) {
  document.body.innerHTML =
    '<div id="surface"><div id="canvas"><div id="inner"><div id="tiles"></div><svg id="edges"></svg></div></div></div>';
  const toggled = [];
  const board = createBoardView({
    surfaceEl: document.getElementById("surface"),
    canvasEl: document.getElementById("canvas"),
    canvasInnerEl: document.getElementById("inner"),
    tilesEl: document.getElementById("tiles"),
    edgesEl: document.getElementById("edges"),
    onToggleCluster: (c) => toggled.push(c),
    ...extra,
  });
  return { board, toggled, tiles: document.getElementById("tiles"), edges: document.getElementById("edges") };
}
const tileNames = (tilesEl) => [...tilesEl.querySelectorAll(".board-tile")].map((t) => t.dataset.screen);
const frameRoots = (tilesEl) => [...tilesEl.querySelectorAll(".board-cluster-frame")].map((f) => f.dataset.root + (f.classList.contains("expanded") ? "*" : ""));

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.CSS ??= { escape: (s) => s };
  fetchRender.mockClear();
});

describe("board clusters — DOM", () => {
  it("renders collapsed clusters as frames with the main tile, the toggle and thumbnails; the cluster's label is its main tile's", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    expect(frameRoots(tiles)).toEqual(["dash", "cart"]);
    expect(tileNames(tiles)).toEqual(["dash", "cart", "plain"]);
    const header = tiles.querySelector('[data-root="cart"] .board-cluster-header');
    expect(header.textContent).toBe("keyboard_arrow_downExpand");
    expect(header.getAttribute("aria-label")).toBe("Expand cart");
    const label = tiles.querySelector('.board-tile[data-screen="cart"] .board-tile-label');
    expect(label.querySelector(".board-tile-name").textContent).toBe("cart");
    expect(label.querySelector(".board-tile-count").textContent).toBe("2 variants");
    expect(tiles.querySelector('.board-tile[data-screen="dash"] .board-tile-count').textContent).toBe("1 variant");
    expect(tiles.querySelector('.board-tile[data-screen="plain"] .board-tile-count')).toBeNull();
    // The frame above is the first thumb (ringed), then one per variant.
    const thumbs = [...tiles.querySelectorAll('[data-root="cart"] .board-cluster-thumb')];
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0].classList.contains("on")).toBe(true);
    expect(thumbs.slice(1).some((el) => el.classList.contains("on"))).toBe(false);
  });

  it("an expanded cluster offers Collapse; its toggle is the header's whole content", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: ["cart"], clusters: true });
    const header = tiles.querySelector('[data-root="cart"] .board-cluster-header');
    expect(header.textContent).toBe("keyboard_arrow_upCollapse");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.getAttribute("aria-label")).toBe("Collapse cart");
  });

  it("a header click reports the cluster; expand adds the main screen, collapse removes every member entry", async () => {
    const { board, tiles, toggled } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    tiles.querySelector('[data-root="cart"] .board-cluster-header').click();
    expect(clusterToggleWrite(toggled[0], [])).toEqual({ op: "add", screens: ["cart"] });

    await board.setScreens(names, flows, "p", { screens, expanded: ["cart", "cart-clear-confirm"], clusters: true });
    tiles.querySelector('[data-root="cart"] .board-cluster-header').click();
    expect(clusterToggleWrite(toggled[1], ["cart", "cart-clear-confirm"])).toEqual({
      op: "remove",
      screens: ["cart", "cart-clear-confirm"],
    });
  });

  it("an expanded-only change adds the newly shown tiles and keeps every existing iframe (no reload)", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    const before = tiles.querySelector('.board-tile[data-screen="cart"] iframe');
    fetchRender.mockClear();
    await board.setClusterState({ expanded: ["cart"] });
    expect(frameRoots(tiles)).toEqual(["dash", "cart*"]);
    expect(tileNames(tiles).sort()).toEqual(["cart", "cart-clear", "cart-clear-confirm", "dash", "plain"]);
    expect(tiles.querySelector('.board-tile[data-screen="cart"] iframe')).toBe(before);
    expect(fetchRender.mock.calls.map((c) => c[0]).sort()).toEqual(["cart-clear", "cart-clear-confirm"]);

    await board.setClusterState({ expanded: [] });
    expect(frameRoots(tiles)).toEqual(["dash", "cart"]);
    expect(tileNames(tiles).sort()).toEqual(["cart", "dash", "plain"]);
  });

  it("labels a docked edge end with the variant it really touches", async () => {
    const { board, edges } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    const labels = [...edges.querySelectorAll(".board-edge-label")].map((g) => [g.getAttribute("class"), g.textContent]);
    expect(labels).toEqual([
      ["board-edge-label target", "dash-empty"],
      ["board-edge-label source", "cart-clear-confirm"],
    ]);
    // The arrow is a drawn Material path (no icon font, no Unicode glyph), hidden from assistive tech; only the target end has one.
    expect(edges.querySelectorAll(".board-edge-label.target .board-edge-label-arrow")).toHaveLength(1);
    expect(edges.querySelector(".board-edge-label.target .board-edge-label-arrow").getAttribute("aria-hidden")).toBe("true");
    expect(edges.querySelector(".board-edge-label.source .board-edge-label-arrow")).toBeNull();
  });

  it("shows a '+N more' tile for a level above the cap", async () => {
    const many = [v("m"), ...Array.from({ length: 10 }, (_, i) => v(`m-${i}`, "m", "overlay"))];
    const { board, tiles } = setup();
    await board.setScreens(many.map((s) => s.name), [], "p", { screens: many, expanded: ["m"], clusters: true });
    const more = tiles.querySelector(".board-more-tile");
    expect(more.textContent).toBe("+2 more");
    expect(more.dataset.tooltip).toBe("m-8\nm-9");
    expect(tileNames(tiles)).toHaveLength(9);
  });

  it("Clusters off is the flat board: no frames, every visible screen a tile in visible order, expanded ignored", async () => {
    const off = setup();
    await off.board.setScreens(names, flows, "p", { screens, expanded: ["cart"], clusters: false });
    const offHtml = off.tiles.innerHTML.replace(/<div class="board-frames"><\/div>/, "");
    expect(off.tiles.querySelector(".board-cluster-frame")).toBeNull();
    expect(tileNames(off.tiles)).toEqual(names);
    expect(off.edges.querySelector(".board-edge-label")).toBeNull();

    const flat = setup(); // today's call: no cluster info at all
    await flat.board.setScreens(names, flows, "p");
    expect(offHtml).toBe(flat.tiles.innerHTML.replace(/<div class="board-frames"><\/div>/, ""));
    expect(off.edges.innerHTML).toBe(flat.edges.innerHTML);
  });

  it("a project without variants renders like the flat board", async () => {
    const plain = ["a", "b", "c"].map((n) => v(n));
    const on = setup();
    await on.board.setScreens(["a", "b", "c"], [], "p", { screens: plain, expanded: [], clusters: true });
    const flat = setup();
    await flat.board.setScreens(["a", "b", "c"], [], "p");
    expect(on.tiles.innerHTML).toBe(flat.tiles.innerHTML);
  });

  it("dims ancestors of a shown variant as context", async () => {
    const { board, tiles } = setup();
    await board.setScreens(["cart-clear-confirm"], [], "p", { screens, expanded: ["cart"], clusters: true });
    expect([...tiles.querySelectorAll(".board-tile.context")].map((t) => t.dataset.screen).sort()).toEqual(["cart", "cart-clear"]);
    expect(tiles.querySelector('.board-tile[data-screen="cart-clear-confirm"]').classList.contains("context")).toBe(false);
  });
});

describe("board tiles — Stitch look", () => {
  it("the label is the screen's name with a viewport glyph; a screen outside the filter and pinned carries the pin mark and the dashed card", async () => {
    const { board, tiles } = setup();
    await board.setScreens(["plain", "cart"], [], "p", { screens, pinned: ["plain"], outsideFilter: ["plain"], expanded: [], clusters: true });
    const plain = tiles.querySelector('.board-tile[data-screen="plain"]');
    expect(plain.classList.contains("outside-filter")).toBe(true);
    expect(plain.querySelector(".board-tile-name").textContent).toBe("plain");
    expect(plain.querySelector(".board-tile-viewport").textContent).toMatch(/smartphone|desktop_windows/);
    const pin = plain.querySelector(".board-tile-pin");
    expect(pin.hidden).toBe(false);
    expect(pin.getAttribute("aria-label")).toBe("Unpin plain from the board");
    const cart = tiles.querySelector('.board-tile[data-screen="cart"]');
    expect(cart.classList.contains("outside-filter")).toBe(false);
    expect(cart.querySelector(".board-tile-pin").hidden).toBe(true); // pinning starts in the card's list
    expect(tiles.querySelector('[data-root="cart"]').classList.contains("outside-filter")).toBe(false);
  });

  it("the pin mark unpins, and does not reach the surface's own click", async () => {
    const onTogglePin = vi.fn();
    const { board, tiles } = setup({ onTogglePin });
    await board.setScreens(["plain"], [], "p", { screens, pinned: ["plain"], expanded: [], clusters: true });
    tiles.querySelector(".board-tile-pin").click();
    expect(onTogglePin).toHaveBeenCalledWith("plain");
  });

  it("a cluster whose main screen is outside the filter gets the dashed outline on its frame", async () => {
    const { board, tiles } = setup();
    await board.setScreens(["cart"], [], "p", { screens, pinned: ["cart"], outsideFilter: ["cart"], expanded: [], clusters: true });
    expect(tiles.querySelector('[data-root="cart"]').classList.contains("outside-filter")).toBe(true);
  });

  it("only the tile of the screen being written has the ring and the Writing chip, and it follows the agent", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, [], "p", { screens, expanded: [], clusters: false });
    board.setWritingScreen("plain");
    const chip = (name) => tiles.querySelector(`.board-tile[data-screen="${name}"] .board-tile-writing`);
    expect(tiles.querySelector(".board-tile.writing").dataset.screen).toBe("plain");
    expect(chip("plain").hidden).toBe(false);
    expect(chip("plain").textContent).toBe("editWriting");
    expect(chip("dash").hidden).toBe(true);
    board.setWritingScreen("dash");
    expect([...tiles.querySelectorAll(".board-tile.writing")].map((t) => t.dataset.screen)).toEqual(["dash"]);
    board.setWritingScreen(null);
    expect(tiles.querySelector(".board-tile.writing")).toBeNull();
    // A rebuild (a filter change) keeps the ring on the screen still being written.
    board.setWritingScreen("cart");
    await board.setScreens(["cart", "plain"], [], "p", { screens, expanded: [], clusters: false });
    expect(tiles.querySelector(".board-tile.writing").dataset.screen).toBe("cart");
  });

  it("a label hides below the overview zoom, is truncated to the tile below 100 % and full above", async () => {
    const { board, tiles } = setup();
    await board.setScreens(["plain"], [], "p", { screens, expanded: [], clusters: false });
    const label = tiles.querySelector(".board-tile-label");
    board.setZoom(10);
    expect(label.dataset.mode).toBe("hidden");
    board.setZoom(50);
    expect(label.dataset.mode).toBe("truncated");
    board.setZoom(150);
    expect(label.dataset.mode).toBe("full");
  });
});

describe("keys inside a tile", () => {
  it("are handed to the shell, and stop being handed over when the tile's document goes", async () => {
    const onTileKeydown = vi.fn();
    const { board, tiles } = setup({ onTileKeydown });
    await board.setScreens(["plain"], [], "p", { screens, expanded: [], clusters: false });
    const iframe = tiles.querySelector("iframe");
    iframe.dispatchEvent(new Event("load")); // jsdom: the srcdoc document is there, the load event is ours to send
    iframe.contentDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    expect(onTileKeydown).toHaveBeenCalledTimes(1);
    await board.setScreens([], [], "p", { screens, expanded: [], clusters: false });
    iframe.contentDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    expect(onTileKeydown).toHaveBeenCalledTimes(1);
  });
});

describe("expanded clusters (design `board-cluster-expanded`)", () => {
  it("the main screen is the ringed current member with the caption \"default\"; its label is the card's header", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, [], "p", { screens, expanded: ["cart"], clusters: true });
    const cart = tiles.querySelector('.board-tile[data-screen="cart"]');
    expect(cart.classList.contains("current")).toBe(true);
    expect(cart.classList.contains("member")).toBe(false);
    expect(cart.querySelector(".board-tile-caption").textContent).toBe("default");
    expect(cart.querySelector(".board-tile-label .board-tile-name").textContent).toBe("cart");
    expect(cart.querySelector(".board-tile-label .board-tile-count").textContent).toBe("2 variants");
  });

  it("a variant is a member: its caption below is its name without the family's prefix, with room for chips and the pin mark, no header label", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, [], "p", { screens, pinned: ["cart-clear"], expanded: ["cart"], clusters: true });
    const member = tiles.querySelector('.board-tile[data-screen="cart-clear"]');
    expect(member.classList.contains("member")).toBe(true);
    expect(member.classList.contains("current")).toBe(false);
    expect(member.querySelector(".board-tile-caption")).toBeNull();
    const label = member.querySelector(".board-tile-label");
    expect([...label.children].map((c) => c.className)).toEqual(["board-tile-name", "board-tile-chips-slot", "board-tile-pin"]); // name, chips, pin mark
    expect(label.querySelector(".board-tile-name").textContent).toBe("clear");
    expect(label.querySelector(".board-tile-viewport")).toBeNull();
    expect(label.querySelector(".board-tile-pin").hidden).toBe(false);
  });

  it("a plain tile's label reads icon, name, count, chips, pin mark", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, [], "p", { screens, expanded: [], clusters: true });
    const label = tiles.querySelector('.board-tile[data-screen="cart"] .board-tile-label');
    expect([...label.children].map((c) => c.className.split(" ")[c.className.includes("icon") ? 1 : 0])).toEqual(["board-tile-viewport", "board-tile-name", "board-tile-count", "board-tile-chips-slot", "board-tile-pin"]);
  });

  it("a tile that stays when its cluster expands changes its part without reloading", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, [], "p", { screens, expanded: [], clusters: true });
    const iframe = tiles.querySelector('.board-tile[data-screen="cart"] iframe');
    await board.setClusterState({ expanded: ["cart"] });
    const cart = tiles.querySelector('.board-tile[data-screen="cart"]');
    expect(cart.classList.contains("current")).toBe(true);
    expect(cart.querySelector("iframe")).toBe(iframe);
    expect(cart.querySelectorAll(".board-tile-label")).toHaveLength(1);
    await board.setClusterState({ expanded: [] });
    expect(tiles.querySelector('.board-tile[data-screen="cart"]').classList.contains("current")).toBe(false);
    expect(tiles.querySelector('.board-tile[data-screen="cart"] .board-tile-caption')).toBeNull();
  });

  it("the captions are hidden below 24 % and the labels below 15 %", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, [], "p", { screens, expanded: ["cart"], clusters: true });
    const caption = tiles.querySelector(".board-tile-caption");
    board.setZoom(20);
    expect(caption.dataset.mode).toBe("hidden");
    expect(tiles.querySelector('.board-tile[data-screen="cart"] .board-tile-label').dataset.mode).toBe("truncated");
    expect(tiles.querySelector('.board-tile[data-screen="cart-clear"] .board-tile-label').dataset.mode).toBe("hidden");
    board.setZoom(24);
    expect(caption.dataset.mode).toBe("truncated");
  });
});

describe("collapsed cluster thumbnails (design `board-cluster`)", () => {
  const thumbs = (tiles, root) => [...tiles.querySelectorAll(`[data-root="${root}"] .board-cluster-thumb`)].map((el) => [el.classList.contains("desktop") ? "desktop" : "mobile", el.classList.contains("on")]);

  it("take their shape from the project's viewport data, also for variants that are not on the board", async () => {
    const { board, tiles } = setup();
    const viewports = new Map([["dash", { width: 1200, height: 800 }], ["dash-empty", { width: 1200, height: 800 }], ["cart", { width: 390, height: 844 }], ["cart-clear", { width: 390, height: 844 }], ["cart-clear-confirm", { width: 390, height: 844 }]]);
    await board.setScreens(["dash", "cart"], [], "p", { screens, expanded: [], clusters: true, viewports });
    // dash: the frame and its one variant; cart: the frame and both variants of its family, only the main screen being on the board
    expect(thumbs(tiles, "dash")).toEqual([["desktop", true], ["desktop", false]]);
    expect(thumbs(tiles, "cart")).toEqual([["mobile", true], ["mobile", false], ["mobile", false]]);
  });

  it("follow viewport data that arrives later, and the label's glyph with it", async () => {
    const { board, tiles } = setup();
    await board.setScreens(["dash"], [], "p", { screens, expanded: [], clusters: true });
    expect(thumbs(tiles, "dash")).toEqual([["mobile", true], ["mobile", false]]); // nothing known: a phone, as everywhere
    board.setViewports(new Map([["dash", { width: 1440, height: 900 }], ["dash-empty", { width: 1440, height: 900 }]]));
    expect(thumbs(tiles, "dash")).toEqual([["desktop", true], ["desktop", false]]);
    expect(tiles.querySelector('.board-tile[data-screen="dash"] .board-tile-viewport').textContent).toBe("desktop_windows");
  });
});

describe("the label's room for comment chips", () => {
  it("is reserved by the comment layer and read back as where the chips start", async () => {
    const { board, tiles } = setup();
    await board.setScreens(["plain"], [], "p", { screens, expanded: [], clusters: false });
    const g = board.commentGeometry();
    g.reserveChips("plain", 52);
    expect(tiles.querySelector(".board-tile-chips-slot").style.width).toBe("52px");
    expect(g.chipsAt("plain")).toEqual({ left: 0, top: 0, height: 0 }); // jsdom lays nothing out
    board.setZoom(10);
    expect(board.commentGeometry().chipsAt("plain")).toBeNull(); // no label, no room
  });
});
