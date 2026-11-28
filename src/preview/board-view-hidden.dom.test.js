// @vitest-environment jsdom
//
// CHR-1298 — the Board while its view is hidden (display: none): nothing is measured or laid out then, and when it shows again the tiles take their real sizes, the grid is laid out for the real surface and the pan comes back. jsdom has no layout, so the sizes a document "has" are stubbed per root element.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api.js", () => ({ fetchRender: vi.fn(async (screen) => ({ ok: true, html: `<div id="r">${screen}</div>` })) }));

import { createBoardView } from "./board-view.js";

const names = ["alpha", "beta"];
let observer;

function setup() {
  document.body.innerHTML =
    '<div id="view"><div id="surface"><div id="canvas"><div id="inner"><div id="tiles"></div><svg id="edges"></svg></div></div></div></div>';
  const board = createBoardView({
    surfaceEl: document.getElementById("surface"),
    canvasEl: document.getElementById("canvas"),
    canvasInnerEl: document.getElementById("inner"),
    tilesEl: document.getElementById("tiles"),
    edgesEl: document.getElementById("edges"),
  });
  board.mount();
  return { board, view: document.getElementById("view"), surface: document.getElementById("surface"), tiles: document.getElementById("tiles") };
}

/** Loads a tile's document the way the browser would: its root has a size only while the view shows. */
function loadTile(tiles, view, screen, size) {
  const iframe = tiles.querySelector(`.board-tile[data-screen="${screen}"] iframe`);
  iframe.contentDocument.body.innerHTML = '<div id="root"></div>';
  const root = iframe.contentDocument.body.firstElementChild;
  Object.defineProperty(root, "offsetWidth", { get: () => (view.hidden ? 0 : size.width) });
  Object.defineProperty(root, "offsetHeight", { get: () => (view.hidden ? 0 : size.height) });
  iframe.dispatchEvent(new Event("load"));
}
const tileBox = (tiles, screen) => {
  const el = tiles.querySelector(`.board-tile[data-screen="${screen}"]`);
  return [el.style.width, el.style.height];
};

beforeEach(() => {
  observer = null;
  globalThis.ResizeObserver = class {
    constructor(cb) { observer = cb; }
    observe() {}
    disconnect() {}
  };
  globalThis.CSS ??= { escape: (s) => s };
});

describe("Board view while hidden (CHR-1298)", () => {
  it("lays nothing out while hidden", async () => {
    const { board, view, tiles } = setup();
    await board.setScreens(names, [], "p");
    const before = tileBox(tiles, "alpha");
    view.hidden = true;
    board.relayout();
    observer?.();
    expect(tileBox(tiles, "alpha")).toEqual(before);
  });

  it("a tile document that loads while hidden is measured when the view shows, not read as 0 or the phone fallback", async () => {
    const { board, view, tiles } = setup();
    await board.setScreens(names, [], "p");
    view.hidden = true;
    loadTile(tiles, view, "alpha", { width: 1440, height: 900 });
    loadTile(tiles, view, "beta", { width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 120)); // past the coalescing timer: it must not lay out hidden either
    view.hidden = false;
    board.relayout();
    expect(tileBox(tiles, "alpha")).toEqual(["1440px", "900px"]);
    expect(tileBox(tiles, "beta")).toEqual(["1440px", "900px"]);
  });

  it("a tile that loads while visible keeps its size across a hidden spell", async () => {
    const { board, view, tiles } = setup();
    await board.setScreens(names, [], "p");
    loadTile(tiles, view, "alpha", { width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 120));
    view.hidden = true;
    observer?.();
    board.relayout();
    view.hidden = false;
    board.relayout();
    expect(tileBox(tiles, "alpha")).toEqual(["1440px", "900px"]);
  });

  it("keeps zoom and brings the pan back after the view was away", async () => {
    const { board, view, surface } = setup();
    await board.setScreens(names, [], "p");
    board.setZoom(50);
    surface.scrollLeft = 120;
    surface.scrollTop = 80;
    surface.dispatchEvent(new Event("scroll"));
    view.hidden = true;
    observer?.();
    surface.scrollLeft = 0; // the browser drops a hidden element's scroll position
    surface.scrollTop = 0;
    surface.dispatchEvent(new Event("scroll"));
    view.hidden = false;
    board.relayout();
    expect([surface.scrollLeft, surface.scrollTop]).toEqual([120, 80]);
    expect(document.getElementById("inner").style.transform).toBe("scale(0.5)");
  });

  it("Fit all does nothing while hidden", async () => {
    const { board, view } = setup();
    await board.setScreens(names, [], "p");
    board.setZoom(80);
    view.hidden = true;
    board.fitAll();
    expect(document.getElementById("inner").style.transform).toBe("scale(0.8)");
  });
});
