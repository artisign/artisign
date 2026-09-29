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
  v("family"),
  v("family-leave", "family", "overlay"),
  v("family-leave-confirm", "family-leave", "step"),
  v("plain"),
];
const names = screens.map((s) => s.name);
const flows = [
  { from: "plain.go", event: "tap", to: "dash-empty", to_kind: "screen" },
  { from: "family-leave-confirm.go", event: "tap", to: "plain", to_kind: "screen" },
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
  it("renders collapsed clusters as frames with the main tile, header text and thumbnails", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    expect(frameRoots(tiles)).toEqual(["dash", "family"]);
    expect(tileNames(tiles)).toEqual(["dash", "family", "plain"]);
    const header = tiles.querySelector('[data-root="family"] .board-cluster-header');
    expect(header.textContent).toContain("family");
    expect(header.textContent).toContain("2 in subtree · depth 3");
    expect(tiles.querySelectorAll('[data-root="family"] .board-cluster-thumb')).toHaveLength(2);
  });

  it("a header click reports the cluster; expand adds the main screen, collapse removes every member entry", async () => {
    const { board, tiles, toggled } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    tiles.querySelector('[data-root="family"] .board-cluster-header').click();
    expect(clusterToggleWrite(toggled[0], [])).toEqual({ op: "add", screens: ["family"] });

    await board.setScreens(names, flows, "p", { screens, expanded: ["family", "family-leave-confirm"], clusters: true });
    tiles.querySelector('[data-root="family"] .board-cluster-header').click();
    expect(clusterToggleWrite(toggled[1], ["family", "family-leave-confirm"])).toEqual({
      op: "remove",
      screens: ["family", "family-leave-confirm"],
    });
  });

  it("an expanded-only change adds the newly shown tiles and keeps every existing iframe (no reload)", async () => {
    const { board, tiles } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    const before = tiles.querySelector('.board-tile[data-screen="family"] iframe');
    fetchRender.mockClear();
    await board.setClusterState({ expanded: ["family"] });
    expect(frameRoots(tiles)).toEqual(["dash", "family*"]);
    expect(tileNames(tiles).sort()).toEqual(["dash", "family", "family-leave", "family-leave-confirm", "plain"]);
    expect(tiles.querySelector('.board-tile[data-screen="family"] iframe')).toBe(before);
    expect(fetchRender.mock.calls.map((c) => c[0]).sort()).toEqual(["family-leave", "family-leave-confirm"]);
    expect(document.getElementById("edges").querySelectorAll(".board-connector")).toHaveLength(2);

    await board.setClusterState({ expanded: [] });
    expect(frameRoots(tiles)).toEqual(["dash", "family"]);
    expect(tileNames(tiles).sort()).toEqual(["dash", "family", "plain"]);
    expect(document.getElementById("edges").querySelectorAll(".board-connector")).toHaveLength(0);
  });

  it("labels a docked edge end with the variant it really touches", async () => {
    const { board, edges } = setup();
    await board.setScreens(names, flows, "p", { screens, expanded: [], clusters: true });
    const labels = [...edges.querySelectorAll(".board-edge-label")].map((g) => [g.getAttribute("class"), g.textContent]);
    expect(labels).toEqual([
      ["board-edge-label target", "→ dash-empty"],
      ["board-edge-label source", "family-leave-confirm"],
    ]);
  });

  it("shows a '+N more' tile for a level above the cap", async () => {
    const many = [v("m"), ...Array.from({ length: 10 }, (_, i) => v(`m-${i}`, "m", "overlay"))];
    const { board, tiles } = setup();
    await board.setScreens(many.map((s) => s.name), [], "p", { screens: many, expanded: ["m"], clusters: true });
    const more = tiles.querySelector(".board-more-tile");
    expect(more.textContent).toBe("+2 more");
    expect(more.title).toBe("m-8\nm-9");
    expect(tileNames(tiles)).toHaveLength(9);
  });

  it("Clusters off is the flat board: no frames, every visible screen a tile in visible order, expanded ignored", async () => {
    const off = setup();
    await off.board.setScreens(names, flows, "p", { screens, expanded: ["family"], clusters: false });
    const offHtml = off.tiles.innerHTML.replace(/<div class="board-frames"><\/div>/, "");
    expect(off.tiles.querySelector(".board-cluster-frame")).toBeNull();
    expect(tileNames(off.tiles)).toEqual(names);
    expect(off.edges.querySelector(".board-connector, .board-edge-label")).toBeNull();

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
    await board.setScreens(["family-leave-confirm"], [], "p", { screens, expanded: ["family"], clusters: true });
    expect([...tiles.querySelectorAll(".board-tile.context")].map((t) => t.dataset.screen).sort()).toEqual(["family", "family-leave"]);
    expect(tiles.querySelector('.board-tile[data-screen="family-leave-confirm"]').classList.contains("context")).toBe(false);
  });
});
