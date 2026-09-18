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
  clampZoom,
  computeFitAllZoom,
  computeBoardColumns,
  zoomSliderOffset,
  labelDisplayMode,
  computeZoomAroundCursor,
  computeWheelZoomFactor,
  stepZoomDown,
  stepZoomUp,
  MIN_BOARD_ZOOM,
  MAX_BOARD_ZOOM,
  DEFAULT_BOARD_ZOOM,
  DEFAULT_COLUMNS,
  BOARD_ZOOM_STEP,
  computeBoardVisibility,
  formatBoardStatusText,
  LOW_ZOOM_AFFORDANCE_THRESHOLD,
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

describe("clampZoom", () => {
  it("passes a value already inside the range through unchanged", () => {
    expect(clampZoom(80)).toBe(80);
  });

  it("clamps to the floor", () => {
    expect(clampZoom(1)).toBe(MIN_BOARD_ZOOM);
  });

  it("clamps to the ceiling", () => {
    expect(clampZoom(9999)).toBe(MAX_BOARD_ZOOM);
  });

  it("accepts custom bounds", () => {
    expect(clampZoom(5, 20, 50)).toBe(20);
    expect(clampZoom(500, 20, 50)).toBe(50);
  });
});

describe("computeFitAllZoom", () => {
  it("returns the default zoom for an empty screen list", () => {
    expect(computeFitAllZoom([], {}, 1000, 1000)).toBe(DEFAULT_BOARD_ZOOM);
  });

  it("returns the default zoom for a degenerate viewport", () => {
    expect(computeFitAllZoom(["a"], { a: { width: 100, height: 100 } }, 0, 1000)).toBe(DEFAULT_BOARD_ZOOM);
  });

  it("finds the exact zoom at which a single tile plus padding fills the viewport width", () => {
    // One tile, one column: contentWidth(scale) = 2*padding + width*scale = 20 + 100*scale.
    // At scale 1 (100%) that's 120 — pick a viewport exactly that size so the
    // ideal zoom is exactly 100%, not just clamped-to-fit.
    const zoom = computeFitAllZoom(["a"], { a: { width: 100, height: 50 } }, 120, 1000, { columns: 1, gapX: 0, gapY: 0, padding: 10 });
    expect(zoom).toBe(100);
  });

  it("clamps to the floor when even the smallest reasonable zoom overflows the viewport", () => {
    const sizes = { a: { width: 390, height: 844 }, b: { width: 390, height: 844 }, c: { width: 390, height: 844 }, d: { width: 390, height: 844 } };
    const zoom = computeFitAllZoom(["a", "b", "c", "d"], sizes, 50, 50, { columns: 1 });
    expect(zoom).toBe(MIN_BOARD_ZOOM);
  });

  it("clamps to the ceiling when the viewport has far more room than the content needs at 200%", () => {
    const zoom = computeFitAllZoom(["a"], { a: { width: 10, height: 10 } }, 5000, 5000, { columns: 1 });
    expect(zoom).toBe(MAX_BOARD_ZOOM);
  });

  it("a larger viewport never yields a smaller fit-all zoom", () => {
    const sizes = { a: { width: 200, height: 300 }, b: { width: 200, height: 300 }, c: { width: 200, height: 300 } };
    const small = computeFitAllZoom(["a", "b", "c"], sizes, 400, 400, { columns: 2 });
    const large = computeFitAllZoom(["a", "b", "c"], sizes, 800, 800, { columns: 2 });
    expect(large).toBeGreaterThanOrEqual(small);
  });

  it("never returns a zoom that overflows the viewport, even when the ideal scale rounds up to the next integer percent (CHR-623 review re-measurement bug: an ideal 7.56% used to round to 8%, which overflowed)", () => {
    // contentWidth(scale) = 200*scale (no gap/padding): an ideal scale of
    // exactly 0.0756 (7.56%) needs a 15.12px-wide viewport; Math.round
    // would report 8% (16px worth of content at scale 1, i.e. content
    // wider than the viewport) where Math.floor correctly reports 7%
    // (content narrower than or equal to the viewport).
    const zoom = computeFitAllZoom(["a"], { a: { width: 200, height: 10 } }, 15.12, 10000, { columns: 1, gapX: 0, gapY: 0, padding: 0 });
    expect(zoom).toBe(7);
    // Verify the claim directly: the resulting zoom, applied back, must not
    // exceed the viewport.
    const { contentWidth } = computeBoardLayout(["a"], { a: { width: 200, height: 10 } }, { scale: zoom / 100, columns: 1, gapX: 0, gapY: 0, padding: 0 });
    expect(contentWidth).toBeLessThanOrEqual(15.12);
  });

  it("scales gaps and padding together with tiles — CHR-623 review fix, board zoom is one whole-canvas CSS transform, not a per-tile scale with fixed-pixel gaps", () => {
    // Two tiles, one column, non-zero gap/padding: at scale s, contentWidth
    // = 2*10*s + 100*s = 120*s (gap/padding scale WITH the tiles, since the
    // real board zoom is a single transform over the whole base layout,
    // gaps included) — not 2*10 + 100*s = 20 + 100*s (gap/padding held at
    // their literal pixel value regardless of s, which an earlier,
    // incorrect version of this function assumed by varying
    // computeBoardLayout's own `scale` option, which only resizes tiles).
    // A viewport of exactly 240 width should therefore land on exactly
    // 200% under the CORRECT model (120*2=240) — the buggy model would
    // have needed a much larger tile scale to compensate for gaps that
    // never shrink, landing below 200%.
    const zoom = computeFitAllZoom(["a"], { a: { width: 100, height: 50 } }, 240, 10000, { columns: 1, gapX: 10, gapY: 10, padding: 10 });
    expect(zoom).toBe(200);
  });
});

describe("computeBoardColumns", () => {
  it("returns the default column count for an empty screen list", () => {
    expect(computeBoardColumns([], {}, 1000, 1000)).toBe(DEFAULT_COLUMNS);
  });

  it("returns the default column count for a degenerate viewport", () => {
    expect(computeBoardColumns(["a"], { a: { width: 100, height: 100 } }, 0, 1000)).toBe(DEFAULT_COLUMNS);
  });

  it("returns 1 for a single screen", () => {
    expect(computeBoardColumns(["a"], { a: { width: 390, height: 844 } }, 1356, 764)).toBe(1);
  });

  it("picks a wide grid for many uniform portrait tiles in a landscape viewport, close to the sqrt(n * viewport-aspect / tile-aspect) heuristic", () => {
    const screens = Array.from({ length: 186 }, (_, i) => `s${i}`);
    const sizes = Object.fromEntries(screens.map((s) => [s, { width: 390, height: 844 }]));
    const columns = computeBoardColumns(screens, sizes, 1356, 764, { gapX: 10, gapY: 10, padding: 10 });
    // sqrt(186 * (1356/764) / (390/844)) ≈ 26.9 — assert a neighborhood
    // rather than the exact value, since the true optimum is a discrete
    // search result, not this continuous approximation.
    expect(columns).toBeGreaterThan(15);
    expect(columns).toBeLessThan(40);
  });

  it("picks fewer columns for a tall, narrow viewport than for a wide one, same tiles", () => {
    const screens = Array.from({ length: 40 }, (_, i) => `s${i}`);
    const sizes = Object.fromEntries(screens.map((s) => [s, { width: 200, height: 200 }]));
    const tall = computeBoardColumns(screens, sizes, 300, 3000);
    const wide = computeBoardColumns(screens, sizes, 3000, 300);
    expect(tall).toBeLessThan(wide);
  });

  it("breaks a tie in favor of the smaller column count", () => {
    // Two identical square-ish tiles, no gap/padding, square viewport: 1
    // column (a 1x2 stack) and 2 columns (a 2x1 row) are exact mirror
    // images of each other and fit identically well.
    const sizes = { a: { width: 100, height: 100 }, b: { width: 100, height: 100 } };
    expect(computeBoardColumns(["a", "b"], sizes, 1000, 1000, { gapX: 0, gapY: 0, padding: 0 })).toBe(1);
  });

  it("does not throw or produce NaN for a project mixing very different tile sizes", () => {
    const sizes = { tiny: { width: 20, height: 20 }, huge: { width: 4000, height: 3000 }, normal: { width: 390, height: 844 } };
    const columns = computeBoardColumns(["tiny", "huge", "normal"], sizes, 1356, 764);
    expect(Number.isInteger(columns)).toBe(true);
    expect(columns).toBeGreaterThanOrEqual(1);
  });
});

describe("zoomSliderOffset", () => {
  it("sits at the track's start for the minimum zoom", () => {
    expect(zoomSliderOffset(MIN_BOARD_ZOOM)).toBe(0);
  });

  it("sits at the track's end for the maximum zoom", () => {
    expect(zoomSliderOffset(MAX_BOARD_ZOOM)).toBe(140);
  });

  it("maps 100% to the documented ~49% position along a 140px track", () => {
    // (100 - 5) / (200 - 5) * 140 = 68.20...
    expect(zoomSliderOffset(100)).toBeCloseTo(68.21, 1);
  });

  it("clamps an out-of-range zoom before mapping it", () => {
    expect(zoomSliderOffset(9999)).toBe(140);
    expect(zoomSliderOffset(-50)).toBe(0);
  });
});

describe("labelDisplayMode", () => {
  it("hides the label below 60%", () => {
    expect(labelDisplayMode(59)).toBe("hidden");
    expect(labelDisplayMode(MIN_BOARD_ZOOM)).toBe("hidden");
  });

  it("truncates the label between 60% and 100%", () => {
    expect(labelDisplayMode(60)).toBe("truncated");
    expect(labelDisplayMode(99)).toBe("truncated");
  });

  it("shows the full label at 100% and above", () => {
    expect(labelDisplayMode(100)).toBe("full");
    expect(labelDisplayMode(MAX_BOARD_ZOOM)).toBe("full");
  });
});

describe("computeZoomAroundCursor", () => {
  it("keeps the scroll offset unchanged when the zoom doesn't change", () => {
    const args = {
      cursorX: 50,
      cursorY: 60,
      scrollLeft: 100,
      scrollTop: 100,
      oldZoomPercent: 100,
      newZoomPercent: 100,
      contentWidth: 2000,
      contentHeight: 2000,
      viewportWidth: 500,
      viewportHeight: 500,
    };
    expect(computeZoomAroundCursor(args)).toEqual({ left: 100, top: 100 });
  });

  it("keeps the same content point under a cursor at the viewport's origin when zooming in", () => {
    // Cursor at the surface's own top-left (0,0): the content point there is
    // exactly (scrollLeft, scrollTop) / oldScale, so the new scroll must put
    // that same content point back at (0,0).
    const args = {
      cursorX: 0,
      cursorY: 0,
      scrollLeft: 200,
      scrollTop: 100,
      oldZoomPercent: 100,
      newZoomPercent: 200,
      contentWidth: 2000,
      contentHeight: 2000,
      viewportWidth: 500,
      viewportHeight: 500,
    };
    // content point = (200/1, 100/1) = (200, 100); at newScale 2 -> (400, 200)
    expect(computeZoomAroundCursor(args)).toEqual({ left: 400, top: 200 });
  });

  it("clamps the result so it never scrolls past the (zoomed) content's edges", () => {
    const args = {
      cursorX: 0,
      cursorY: 0,
      scrollLeft: 0,
      scrollTop: 0,
      oldZoomPercent: 10,
      newZoomPercent: 200,
      contentWidth: 100,
      contentHeight: 100,
      viewportWidth: 500,
      viewportHeight: 500,
    };
    expect(computeZoomAroundCursor(args)).toEqual({ left: 0, top: 0 });
  });

  it("keeps the exact same content point under a NON-ORIGIN cursor when zooming in (CHR-623 review — every prior test used cursor (0,0) or an unchanged zoom, where the formula collapses and a sign error on the cursor term would still pass)", () => {
    const args = {
      cursorX: 250,
      cursorY: 120,
      scrollLeft: 300,
      scrollTop: 150,
      oldZoomPercent: 80,
      newZoomPercent: 120,
      contentWidth: 2000,
      contentHeight: 2000,
      viewportWidth: 800,
      viewportHeight: 800,
    };
    const result = computeZoomAroundCursor(args);
    // content point at 80%: ((300+250)/0.8, (150+120)/0.8) = (687.5, 337.5);
    // at 120%: 687.5*1.2 - 250 = 575, 337.5*1.2 - 120 = 285.
    expect(result).toEqual({ left: 575, top: 285 });
    // The invariant itself, not just this one worked example: the content
    // point under the cursor is identical before and after.
    const contentBefore = { x: (args.scrollLeft + args.cursorX) / 0.8, y: (args.scrollTop + args.cursorY) / 0.8 };
    const contentAfter = { x: (result.left + args.cursorX) / 1.2, y: (result.top + args.cursorY) / 1.2 };
    expect(contentAfter.x).toBeCloseTo(contentBefore.x, 6);
    expect(contentAfter.y).toBeCloseTo(contentBefore.y, 6);
  });

  it("clamps to 0 with a NON-ORIGIN cursor too, when the zoomed content is smaller than the viewport", () => {
    const args = {
      cursorX: 40,
      cursorY: 20,
      scrollLeft: 0,
      scrollTop: 0,
      oldZoomPercent: 100,
      newZoomPercent: 50,
      contentWidth: 100,
      contentHeight: 100,
      viewportWidth: 500,
      viewportHeight: 500,
    };
    expect(computeZoomAroundCursor(args)).toEqual({ left: 0, top: 0 });
  });
});

describe("computeWheelZoomFactor", () => {
  it("makes one Chrome/Safari mouse-wheel notch (deltaY 100, deltaMode 0) exactly ÷1.2 zooming out", () => {
    expect(computeWheelZoomFactor(100, 0, 800)).toBeCloseTo(1 / 1.2, 10);
  });

  it("makes one notch in the other direction exactly ×1.2 zooming in", () => {
    expect(computeWheelZoomFactor(-100, 0, 800)).toBeCloseTo(1.2, 10);
  });

  it("is the identity (factor 1) for a zero delta", () => {
    expect(computeWheelZoomFactor(0, 0, 800)).toBe(1);
  });

  it("normalizes deltaMode 1 (line — Firefox's physical-wheel convention) via a 16px line height", () => {
    // 3 lines * 16px = 48px -> exp(-48 * ln(1.2)/100)
    expect(computeWheelZoomFactor(3, 1, 800)).toBeCloseTo(Math.exp((-48 * Math.log(1.2)) / 100), 10);
  });

  it("normalizes deltaMode 2 (page) via the given viewport height", () => {
    // 1 page * 800px viewport -> exp(-800 * ln(1.2)/100) = 1.2^-8
    expect(computeWheelZoomFactor(1, 2, 800)).toBeCloseTo(Math.pow(1.2, -8), 10);
  });

  it("gives a trackpad-pinch-sized delta (a few px, deltaMode 0) a proportionally small, smooth factor", () => {
    const factor = computeWheelZoomFactor(4, 0, 800);
    expect(factor).toBeLessThan(1); // still zooms out
    expect(factor).toBeGreaterThan(1 / 1.2); // but far more gently than a full notch
  });
});

describe("stepZoomDown", () => {
  it("snaps DOWN to the nearest grid point below an off-grid value — the review's own example", () => {
    expect(stepZoomDown(7, BOARD_ZOOM_STEP)).toBe(5);
  });

  it("snaps down from a fractional (wheel-driven) value", () => {
    expect(stepZoomDown(83.2, BOARD_ZOOM_STEP)).toBe(80);
  });

  it("steps one full grid unit further down from a value already exactly on the grid", () => {
    expect(stepZoomDown(80, BOARD_ZOOM_STEP)).toBe(75);
  });

  it("clamps at the floor and does not go below it", () => {
    expect(stepZoomDown(5, BOARD_ZOOM_STEP)).toBe(MIN_BOARD_ZOOM);
    expect(stepZoomDown(7, BOARD_ZOOM_STEP, 6)).toBe(6); // custom floor above the natural grid point
  });
});

describe("stepZoomUp", () => {
  it("snaps UP to the nearest grid point above an off-grid value — the review's own example", () => {
    expect(stepZoomUp(7, BOARD_ZOOM_STEP)).toBe(10);
  });

  it("snaps up from a fractional (wheel-driven) value — the review's own example", () => {
    expect(stepZoomUp(83.2, BOARD_ZOOM_STEP)).toBe(85);
  });

  it("steps one full grid unit further up from a value already exactly on the grid", () => {
    expect(stepZoomUp(80, BOARD_ZOOM_STEP)).toBe(85);
  });

  it("clamps at the ceiling and does not go above it", () => {
    expect(stepZoomUp(200, BOARD_ZOOM_STEP)).toBe(MAX_BOARD_ZOOM);
    expect(stepZoomUp(198, BOARD_ZOOM_STEP, 199)).toBe(199); // custom ceiling below the natural grid point
  });
});

describe("computeBoardVisibility", () => {
  const screens = [
    { name: "open-project-dialog", tags: ["dialog"] },
    { name: "init-project-dialog", tags: ["dialog"] },
    { name: "no-project-empty-state", tags: ["empty-state", "dialog"] },
    { name: "app-shell", tags: ["shell"] },
  ];

  it("shows every screen for an empty filter and no pins", () => {
    const v = computeBoardVisibility(screens, "", []);
    expect(v.visibleNames).toEqual(screens.map((s) => s.name));
    expect(v).toMatchObject({ outsideFilterNames: [], pinnedNames: [], matchCount: 4, pinnedCount: 0, shownCount: 4 });
  });

  it("matches filter matches ∪ pinned, preserving the project's own screen order — the board-view design screen's own numbers", () => {
    // "dialog" matches the first 3; app-shell is pinned but doesn't match.
    const v = computeBoardVisibility(screens, "dialog", ["open-project-dialog", "app-shell"]);
    expect(v.visibleNames).toEqual(["open-project-dialog", "init-project-dialog", "no-project-empty-state", "app-shell"]);
    expect(v.matchCount).toBe(3);
    expect(v.pinnedCount).toBe(2);
    expect(v.shownCount).toBe(4);
  });

  it("classifies a pinned screen that doesn't match the filter as outsideFilterNames, and one that does match as neither", () => {
    const v = computeBoardVisibility(screens, "dialog", ["open-project-dialog", "app-shell"]);
    expect(v.outsideFilterNames).toEqual(["app-shell"]);
  });

  it("does not double-count a screen that both matches and is pinned", () => {
    const v = computeBoardVisibility(screens, "dialog", ["open-project-dialog"]);
    expect(v.visibleNames).toEqual(["open-project-dialog", "init-project-dialog", "no-project-empty-state"]);
    expect(v.shownCount).toBe(3);
  });

  it("drops a pinned name with no matching screen — silently, from every field", () => {
    const v = computeBoardVisibility(screens, "", ["ghost-screen"]);
    expect(v.visibleNames).toEqual(screens.map((s) => s.name));
    expect(v.pinnedNames).toEqual([]);
    expect(v.pinnedCount).toBe(0);
    expect(v.outsideFilterNames).toEqual([]);
  });

  it("shows nothing for a filter that matches no screen and no pins", () => {
    const v = computeBoardVisibility(screens, "nope", []);
    expect(v).toMatchObject({ visibleNames: [], matchCount: 0, pinnedCount: 0, shownCount: 0 });
  });

  it("never removes a pin when the filter changes — pinned screens stay pinned regardless of the current filter text", () => {
    const withFilter = computeBoardVisibility(screens, "dialog", ["app-shell"]);
    const withoutFilter = computeBoardVisibility(screens, "", ["app-shell"]);
    expect(withFilter.pinnedNames).toEqual(["app-shell"]);
    expect(withoutFilter.pinnedNames).toEqual(["app-shell"]);
  });
});

describe("formatBoardStatusText", () => {
  it("matches the approved design's exact phrasing", () => {
    expect(formatBoardStatusText({ shownCount: 4, matchCount: 3, pinnedCount: 2 })).toBe("4 shown — 3 matches · 2 pinned");
  });

  it("formats a zero-everything empty state", () => {
    expect(formatBoardStatusText({ shownCount: 0, matchCount: 0, pinnedCount: 0 })).toBe("0 shown — 0 matches · 0 pinned");
  });
});

describe("LOW_ZOOM_AFFORDANCE_THRESHOLD", () => {
  it("is the same threshold labelDisplayMode uses to hide the label", () => {
    expect(labelDisplayMode(LOW_ZOOM_AFFORDANCE_THRESHOLD)).not.toBe("hidden");
    expect(labelDisplayMode(LOW_ZOOM_AFFORDANCE_THRESHOLD - 1)).toBe("hidden");
  });
});
