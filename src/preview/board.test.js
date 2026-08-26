import { describe, it, expect } from "vitest";
import {
  screenIdFromRef,
  computeBoardLayout,
  findTile,
  edgeSides,
  elementSideAnchor,
  tileAnchor,
  bezierPath,
  computeCenterScroll,
  edgesFromNode,
} from "./board.js";

describe("screenIdFromRef", () => {
  it("returns the ref unchanged when it has no node part", () => {
    expect(screenIdFromRef("dashboard")).toBe("dashboard");
  });

  it("strips the node id after the first dot", () => {
    expect(screenIdFromRef("dashboard.btn-login")).toBe("dashboard");
  });
});

describe("computeBoardLayout", () => {
  it("packs screens left to right, wrapping at the column count", () => {
    const sizes = {
      a: { width: 100, height: 200 },
      b: { width: 100, height: 200 },
      c: { width: 100, height: 200 },
    };
    const { tiles } = computeBoardLayout(["a", "b", "c"], sizes, { scale: 1, columns: 2, gapX: 10, gapY: 10, padding: 5 });
    expect(tiles.map((t) => t.screen)).toEqual(["a", "b", "c"]);
    expect(tiles[0]).toMatchObject({ x: 5, y: 5, width: 100, height: 200 });
    expect(tiles[1]).toMatchObject({ x: 115, y: 5, width: 100, height: 200 }); // 5 + 100 + 10
    expect(tiles[2]).toMatchObject({ x: 5, y: 215 }); // new row: y = 5 + 200 + 10
  });

  it("uses the tallest tile in a row to place the next row, not a fixed height", () => {
    const sizes = {
      short: { width: 100, height: 100 },
      tall: { width: 100, height: 300 },
      next: { width: 100, height: 100 },
    };
    const { tiles } = computeBoardLayout(["short", "tall", "next"], sizes, { scale: 1, columns: 2, gapX: 0, gapY: 10, padding: 0 });
    expect(tiles[2].y).toBe(310); // tall row height (300) + gap (10)
  });

  it("scales natural sizes by the given scale factor", () => {
    const sizes = { a: { width: 200, height: 400 } };
    const { tiles } = computeBoardLayout(["a"], sizes, { scale: 0.5, columns: 4, padding: 0, gapX: 0, gapY: 0 });
    expect(tiles[0]).toMatchObject({ width: 100, height: 200, naturalWidth: 200, naturalHeight: 400 });
  });

  it("falls back to a default phone size for screens with no measured size yet", () => {
    const { tiles } = computeBoardLayout(["unmeasured"], {}, { scale: 1, padding: 0, gapX: 0, gapY: 0 });
    expect(tiles[0].width).toBe(390);
    expect(tiles[0].height).toBe(844);
  });

  it("returns zero tiles and a padding-only content size for an empty screen list", () => {
    const { tiles, contentWidth, contentHeight } = computeBoardLayout([], {}, { padding: 20 });
    expect(tiles).toEqual([]);
    expect(contentWidth).toBe(40);
    expect(contentHeight).toBe(40);
  });

  it("grows contentWidth/contentHeight to enclose every tile plus padding", () => {
    const sizes = { a: { width: 100, height: 100 }, b: { width: 100, height: 100 } };
    const { contentWidth, contentHeight } = computeBoardLayout(["a", "b"], sizes, {
      scale: 1,
      columns: 2,
      gapX: 10,
      gapY: 10,
      padding: 5,
    });
    expect(contentWidth).toBe(5 + 100 + 10 + 100 + 5); // two tiles + gap + padding both sides
    expect(contentHeight).toBe(5 + 100 + 5); // one row + padding both sides
  });
});

describe("findTile", () => {
  it("finds a tile by screen id", () => {
    const tiles = [{ screen: "a" }, { screen: "b" }];
    expect(findTile(tiles, "b")).toBe(tiles[1]);
  });

  it("returns undefined for a screen not on the board", () => {
    expect(findTile([{ screen: "a" }], "missing")).toBeUndefined();
  });
});

describe("edgeSides", () => {
  it("routes right-to-left when the target is to the right", () => {
    const from = { x: 0, y: 0, width: 100, height: 100 };
    const to = { x: 300, y: 0, width: 100, height: 100 };
    expect(edgeSides(from, to)).toEqual({ from: "right", to: "left" });
  });

  it("routes left-to-right when the target is to the left — the leftmost-tile case", () => {
    const from = { x: 300, y: 0, width: 100, height: 100 };
    const to = { x: 0, y: 0, width: 100, height: 100 };
    expect(edgeSides(from, to)).toEqual({ from: "left", to: "right" });
  });

  it("routes bottom-to-top when the target is below and roughly aligned horizontally", () => {
    const from = { x: 0, y: 0, width: 100, height: 100 };
    const to = { x: 0, y: 300, width: 100, height: 100 };
    expect(edgeSides(from, to)).toEqual({ from: "bottom", to: "top" });
  });

  it("routes top-to-bottom when the target is above", () => {
    const from = { x: 0, y: 300, width: 100, height: 100 };
    const to = { x: 0, y: 0, width: 100, height: 100 };
    expect(edgeSides(from, to)).toEqual({ from: "top", to: "bottom" });
  });

  it("picks a sane pair of sides for a self-edge (same tile)", () => {
    const tile = { x: 0, y: 0, width: 100, height: 100 };
    expect(edgeSides(tile, tile)).toEqual({ from: "right", to: "top" });
  });
});

describe("elementSideAnchor", () => {
  const tile = { x: 50, y: 20, width: 200, height: 400, naturalWidth: 400, naturalHeight: 800 };
  // scale is 0.5 in both axes; element at (100,100) sized 40x20 in natural coords
  const elementRect = { x: 100, y: 100, width: 40, height: 20 };

  it("anchors to the element's own right edge (not the tile's), aligned with its vertical center", () => {
    // element right edge: (100+40)*0.5 = 70 -> plus tile.x (50) = 120; y: element center (100+10)*0.5=55 -> plus tile.y (20) = 75
    expect(elementSideAnchor(tile, elementRect, "right")).toEqual({ x: 120, y: 75 });
  });

  it("anchors to the element's own left edge, aligned with its vertical center", () => {
    // element left edge: 100*0.5 = 50 -> plus tile.x (50) = 100
    expect(elementSideAnchor(tile, elementRect, "left")).toEqual({ x: 100, y: 75 });
  });

  it("anchors to the element's own top edge, aligned with its horizontal center", () => {
    // element top edge: 100*0.5 = 50 -> plus tile.y (20) = 70; x: element center (100+20)*0.5=60 -> plus tile.x (50) = 110
    expect(elementSideAnchor(tile, elementRect, "top")).toEqual({ x: 110, y: 70 });
  });

  it("anchors to the element's own bottom edge, aligned with its horizontal center", () => {
    // element bottom edge: (100+20)*0.5 = 60 -> plus tile.y (20) = 80
    expect(elementSideAnchor(tile, elementRect, "bottom")).toEqual({ x: 110, y: 80 });
  });

  it("clamps the y anchor to the tile's bounds for an element extending above the tile's own top edge", () => {
    const overflowingRect = { x: 0, y: -20, width: 20, height: 20 }; // center above the tile's own top edge
    const anchor = elementSideAnchor(tile, overflowingRect, "right");
    expect(anchor.y).toBe(tile.y); // clamped to the tile's top, not pushed above it
  });

  it("clamps the x anchor to the tile's bounds for an element extending past the tile's own right edge", () => {
    const overflowingRect = { x: 390, y: 100, width: 40, height: 20 }; // right edge past the tile's natural width
    const anchor = elementSideAnchor(tile, overflowingRect, "right");
    expect(anchor.x).toBe(tile.x + tile.width); // clamped to the tile's right edge, not pushed past it
  });
});

describe("tileAnchor", () => {
  const tile = { x: 10, y: 20, width: 100, height: 50 };

  it("returns the center by default", () => {
    expect(tileAnchor(tile)).toEqual({ x: 60, y: 45 });
  });

  it("returns the left edge midpoint", () => {
    expect(tileAnchor(tile, "left")).toEqual({ x: 10, y: 45 });
  });

  it("returns the right edge midpoint", () => {
    expect(tileAnchor(tile, "right")).toEqual({ x: 110, y: 45 });
  });
});

describe("bezierPath", () => {
  it("produces an SVG cubic-bezier path string starting and ending at the given points", () => {
    const d = bezierPath({ x: 0, y: 0 }, { x: 100, y: 50 });
    expect(d.startsWith("M 0 0 C")).toBe(true);
    expect(d.endsWith("100 50")).toBe(true);
  });

  it("pulls control points outward along each side's own normal instead of always bowing horizontally", () => {
    // from leaves downward (bottom), to enters downward too (top) — both
    // control points should move vertically, not horizontally.
    const d = bezierPath({ x: 0, y: 0 }, { x: 10, y: 100 }, "bottom", "top");
    const [, , , c1x, c1y, c2x, c2y] = d.match(/M ([\d.-]+) ([\d.-]+) C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/).map(Number);
    expect(c1x).toBe(0); // no horizontal pull for a vertical ("bottom") exit
    expect(c1y).toBeGreaterThan(0);
    expect(c2x).toBe(10); // no horizontal pull for a vertical ("top") entry
    expect(c2y).toBeLessThan(100);
  });

  it("never produces a leftward-bulging path for a right-to-left edge — the leftmost-tile regression", () => {
    // A tile to the right of a leftmost target: edgeSides would say
    // {from:"left", to:"right"} is wrong here — this exercises the actual
    // {from:"right", to:"left"}-style curve for a target that sits further
    // left, and checks the control points stay between the two endpoints,
    // never sweeping past `to.x` to the left.
    const from = { x: 500, y: 100 };
    const to = { x: 0, y: 100 };
    const d = bezierPath(from, to, "left", "right");
    const [, , , c1x, , c2x] = d.match(/M ([\d.-]+) ([\d.-]+) C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/).map(Number);
    expect(c1x).toBeLessThan(from.x);
    expect(c2x).toBeGreaterThan(to.x);
    expect(c2x).toBeGreaterThanOrEqual(0); // never sweeps past x=0 for a target anchored at the board's left edge
  });
});

describe("computeCenterScroll", () => {
  it("centers a tile that fits well within the content bounds", () => {
    const tile = { x: 400, y: 400, width: 100, height: 100 };
    const offset = computeCenterScroll(tile, 200, 200, 1000, 1000);
    // tile center = (450, 450); viewport half = (100, 100) -> left/top = 350
    expect(offset).toEqual({ left: 350, top: 350 });
  });

  it("clamps so it never scrolls past the content's edges", () => {
    const tile = { x: 0, y: 0, width: 50, height: 50 };
    const offset = computeCenterScroll(tile, 500, 500, 400, 400);
    expect(offset).toEqual({ left: 0, top: 0 });
  });
});

describe("edgesFromNode", () => {
  it("returns only flows whose from matches the given screen and node id exactly", () => {
    const flows = [
      { from: "login.btn-submit", to: "dashboard" },
      { from: "login.btn-cancel", to: "home" },
      { from: "dashboard.btn-submit", to: "settings" },
    ];
    expect(edgesFromNode(flows, "login", "btn-submit")).toEqual([{ from: "login.btn-submit", to: "dashboard" }]);
  });

  it("returns an empty array when no flow originates from that node", () => {
    expect(edgesFromNode([{ from: "login.btn-submit", to: "dashboard" }], "login", "btn-other")).toEqual([]);
  });
});
