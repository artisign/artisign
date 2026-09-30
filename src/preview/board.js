// Board view geometry: pure, DOM-free layout/edge/scroll math consumed by
// board-view.js. Kept separate (and tested directly) because everything
// touching the DOM — tiles, iframes, the SVG edge layer — needs real
// layout that even jsdom doesn't compute.

import { filterScreens, buildScreenTree } from "./screens.js";

export const DEFAULT_COLUMNS = 4;
// The board's own 100%-zoom reference gap/padding (CHR-623). Tiles are laid
// out at native (unscaled) size, and the whole canvas — tiles, gaps and
// padding alike — is then zoomed as one unit by board-view.js's CSS
// transform (see BASE_GAP/BASE_PADDING's usage there), so these are chosen
// such that *0.8 reproduces the pre-CHR-623 fixed grid exactly: 80*0.8=64,
// 60*0.8=48, matching the old DEFAULT_GAP/DEFAULT_PADDING at the new default
// board zoom of 80% (see DEFAULT_BOARD_ZOOM) — "keep today's default look as
// the default" from a CSS-transform architecture where gaps scale with zoom
// instead of staying a fixed pixel amount (which used to swamp shrunk tiles
// at low zoom).
export const BASE_GAP = 80;
export const BASE_PADDING = 60;
const FALLBACK_SIZE = { width: 390, height: 844 };

// 5%, not the approved design's original 10% — CHR-623 review, decided from
// the 186-screen Lückenzeit measurement: real screens are taller than the
// design's 180px mock tiles, so a 10% floor still couldn't get everything
// on screen at Fit all for a large project. 5% does (see computeFitAllZoom/
// computeBoardColumns' call sites for the measured before/after).
export const MIN_BOARD_ZOOM = 5;
export const MAX_BOARD_ZOOM = 200;
// Reproduces the pre-CHR-623 fixed board layout pixel-for-pixel (native
// tile size * 0.8, 64px gap, 48px padding) — see BASE_GAP/BASE_PADDING.
export const DEFAULT_BOARD_ZOOM = 80;
// 5, not 10 (CHR-623 review): with MIN_BOARD_ZOOM=5, a 10-point step from
// the floor's neighboring multiples of 10 (15, 25, ...) would need an
// uneven final 5-point step to land exactly on the 5% floor. Every value
// 5, 10, 15, ..., 200 is a clean multiple of 5 (40 even steps end to end),
// so +/- always lands on a "round" number, at the floor/ceiling too.
export const BOARD_ZOOM_STEP = 5;

/**
 * A flow's `to` (like `data-flow-target`) is either a bare screen id or a
 * `"screen.nodeId"` ref — same convention as flows.js's targetScreen(),
 * duplicated here because that module only deals with one iframe document
 * at a time and has no reason to export it.
 * @param {string} ref
 * @returns {string}
 */
export function screenIdFromRef(ref) {
  const dot = ref.indexOf(".");
  return dot === -1 ? ref : ref.slice(0, dot);
}

/**
 * Grid-packs `screens` into rows of `columns` tiles, left to right, top to
 * bottom, in the given order. Each tile's size is its natural (unscaled)
 * screen size — from `sizes`, falling back to a default phone size for
 * screens not measured yet — times `scale`. Row height is the tallest tile
 * in that row; deterministic and independent of any previous layout.
 *
 * @param {string[]} screens
 * @param {Record<string, { width: number, height: number }>} sizes
 * @param {{ scale?: number, columns?: number, gapX?: number, gapY?: number, padding?: number }} [options]
 * @returns {{
 *   tiles: { screen: string, x: number, y: number, width: number, height: number, naturalWidth: number, naturalHeight: number }[],
 *   contentWidth: number,
 *   contentHeight: number,
 * }}
 */
export function computeBoardLayout(screens, sizes, options = {}) {
  const scale = options.scale ?? 1;
  const columns = options.columns ?? DEFAULT_COLUMNS;
  const gapX = options.gapX ?? BASE_GAP;
  const gapY = options.gapY ?? BASE_GAP;
  const padding = options.padding ?? BASE_PADDING;

  const tiles = [];
  let y = padding;
  let contentWidth = padding * 2;

  for (let i = 0; i < screens.length; i += columns) {
    const rowScreens = screens.slice(i, i + columns);
    let x = padding;
    let rowHeight = 0;
    for (const screen of rowScreens) {
      const natural = sizes[screen] ?? FALLBACK_SIZE;
      const width = natural.width * scale;
      const height = natural.height * scale;
      tiles.push({ screen, x, y, width, height, naturalWidth: natural.width, naturalHeight: natural.height });
      x += width + gapX;
      rowHeight = Math.max(rowHeight, height);
    }
    contentWidth = Math.max(contentWidth, x - gapX + padding);
    y += rowHeight + gapY;
  }

  const contentHeight = screens.length === 0 ? padding * 2 : y - gapY + padding;
  return { tiles, contentWidth, contentHeight };
}

/**
 * Finds a tile by screen id. Returns `undefined` if the screen isn't (or
 * isn't yet) on the board — e.g. a flow target that doesn't exist.
 * @param {{ screen: string }[]} tiles
 * @param {string} screen
 */
export function findTile(tiles, screen) {
  return tiles.find((tile) => tile.screen === screen);
}

/**
 * A point on the given side of a tile, in board coordinates.
 * @param {{ x: number, y: number, width: number, height: number }} tile
 * @param {"left" | "right" | "top" | "bottom" | "center"} [side]
 * @returns {{ x: number, y: number }}
 */
export function tileAnchor(tile, side = "center") {
  switch (side) {
    case "left":
      return { x: tile.x, y: tile.y + tile.height / 2 };
    case "right":
      return { x: tile.x + tile.width, y: tile.y + tile.height / 2 };
    case "top":
      return { x: tile.x + tile.width / 2, y: tile.y };
    case "bottom":
      return { x: tile.x + tile.width / 2, y: tile.y + tile.height };
    default:
      return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  }
}

/**
 * Which side of the source tile an edge should leave from, and which side
 * of the target tile it should enter — chosen from the tiles' relative
 * position so an edge never has to double back across its own source tile
 * (e.g. leaving right while the target is to the left) or enter a target
 * from the side facing away from the source (which used to send edges to
 * the leftmost tile sweeping out past the board's left boundary).
 * @param {{ x: number, y: number, width: number, height: number }} fromTile
 * @param {{ x: number, y: number, width: number, height: number }} toTile
 * @returns {{ from: "left" | "right" | "top" | "bottom", to: "left" | "right" | "top" | "bottom" }}
 */
export function edgeSides(fromTile, toTile) {
  if (fromTile === toTile) return { from: "right", to: "top" }; // self-edge: loop out and back in from adjacent sides
  const dx = toTile.x + toTile.width / 2 - (fromTile.x + fromTile.width / 2);
  const dy = toTile.y + toTile.height / 2 - (fromTile.y + fromTile.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
  }
  return dy > 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A point on the source ELEMENT's own edge (not the tile's), in board
 * coordinates — so an edge visibly starts at the exact button/element it
 * comes from, which matters once a screen has more than one flow-source
 * element. The edge layer paints above the tiles, so the line segment
 * crossing from this point to the tile boundary stays visible on top of
 * the tile's content — that's intentional, not a bug to route around.
 * Clamped to the tile's own bounds so a partially offscreen element can't
 * anchor outside the tile it belongs to.
 * @param {{ x: number, y: number, width: number, height: number, naturalWidth: number, naturalHeight: number }} tile
 * @param {{ x: number, y: number, width: number, height: number }} elementRect
 * @param {"left" | "right" | "top" | "bottom"} side
 * @returns {{ x: number, y: number }}
 */
export function elementSideAnchor(tile, elementRect, side) {
  const scaleX = tile.naturalWidth > 0 ? tile.width / tile.naturalWidth : 1;
  const scaleY = tile.naturalHeight > 0 ? tile.height / tile.naturalHeight : 1;
  const centerX = tile.x + (elementRect.x + elementRect.width / 2) * scaleX;
  const centerY = tile.y + (elementRect.y + elementRect.height / 2) * scaleY;
  switch (side) {
    case "left":
      return { x: clamp(tile.x + elementRect.x * scaleX, tile.x, tile.x + tile.width), y: clamp(centerY, tile.y, tile.y + tile.height) };
    case "right":
      return {
        x: clamp(tile.x + (elementRect.x + elementRect.width) * scaleX, tile.x, tile.x + tile.width),
        y: clamp(centerY, tile.y, tile.y + tile.height),
      };
    case "top":
      return { x: clamp(centerX, tile.x, tile.x + tile.width), y: clamp(tile.y + elementRect.y * scaleY, tile.y, tile.y + tile.height) };
    default:
      return {
        x: clamp(centerX, tile.x, tile.x + tile.width),
        y: clamp(tile.y + (elementRect.y + elementRect.height) * scaleY, tile.y, tile.y + tile.height),
      };
  }
}

/** The control point pulled outward from `point` along `side`'s outward normal, by `pull`. */
function sideControlPoint(point, side, pull) {
  switch (side) {
    case "left":
      return { x: point.x - pull, y: point.y };
    case "right":
      return { x: point.x + pull, y: point.y };
    case "top":
      return { x: point.x, y: point.y - pull };
    default:
      return { x: point.x, y: point.y + pull };
  }
}

/**
 * An SVG cubic-bezier path `d` string from `from` to `to`, control points
 * pulled outward along each side's own outward normal (horizontal for
 * left/right, vertical for top/bottom) so the curve leaves/enters
 * perpendicular to the tile boundary instead of always bowing sideways —
 * which used to send edges into the wrong side of a target tile and out
 * past the board's edge. Defaults to the original left-to-right routing
 * for callers that don't care about sides.
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {"left" | "right" | "top" | "bottom"} [fromSide]
 * @param {"left" | "right" | "top" | "bottom"} [toSide]
 * @returns {string}
 */
export function bezierPath(from, to, fromSide = "right", toSide = "left") {
  const pull = Math.max(40, Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2);
  const c1 = sideControlPoint(from, fromSide, pull);
  const c2 = sideControlPoint(to, toSide, pull);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
}

/**
 * Scroll offset that centers `tile` inside a `viewportWidth`x`viewportHeight`
 * scroll container of `contentWidth`x`contentHeight`, clamped so it never
 * scrolls past the content edges.
 * @param {{ x: number, y: number, width: number, height: number }} tile
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {number} contentWidth
 * @param {number} contentHeight
 * @returns {{ left: number, top: number }}
 */
export function computeCenterScroll(tile, viewportWidth, viewportHeight, contentWidth, contentHeight) {
  const centerX = tile.x + tile.width / 2;
  const centerY = tile.y + tile.height / 2;
  const maxLeft = Math.max(0, contentWidth - viewportWidth);
  const maxTop = Math.max(0, contentHeight - viewportHeight);
  return {
    left: clamp(centerX - viewportWidth / 2, 0, maxLeft),
    top: clamp(centerY - viewportHeight / 2, 0, maxTop),
  };
}

/**
 * Edges sourced from a specific node — the ones whose `from` is exactly
 * `"<screen>.<nodeId>"`. Used to highlight the edge(s) for a flow-source
 * element clicked while flow mode is off.
 * @param {{ from: string }[]} flows
 * @param {string} screen
 * @param {string} nodeId
 */
export function edgesFromNode(flows, screen, nodeId) {
  const from = `${screen}.${nodeId}`;
  return flows.filter((flow) => flow.from === from);
}

/** Clamps a board zoom percentage into [min, max] (CHR-623: 5–200 by default). */
export function clampZoom(value, min = MIN_BOARD_ZOOM, max = MAX_BOARD_ZOOM) {
  return clamp(value, min, max);
}

/**
 * The largest zoom FACTOR (UNCLAMPED — a raw multiplier, e.g. 1 = 100%, not
 * a percentage) at which the board's ENTIRE base layout — same
 * `screens`/`sizes`/layout `options`, tiles at their native (scale-1) size —
 * fits inside a `viewportWidth`x`viewportHeight` viewport.
 *
 * Board zoom (board-view.js's `applyZoomSizing`) is a single CSS
 * `transform: scale()` applied to the whole pre-computed base layout, so it
 * scales tiles AND the gaps/padding between them by the exact same factor —
 * unlike `computeBoardLayout`'s own `scale` option, which only resizes
 * tiles while `gapX`/`gapY`/`padding` stay literal, fixed pixels. So "the
 * ideal fit zoom" is NOT "the computeBoardLayout `scale` that fits" (an
 * earlier version of this function got that wrong — it under-zoomed, since
 * holding gaps fixed while shrinking tiles requires a smaller tile-scale
 * than shrinking everything together does, and it skewed
 * `computeBoardColumns` towards too few columns, since a layout's fixed-size
 * gaps were overweighted relative to how small they actually render at a
 * real, whole-canvas zoom). It's a single division: compute the base layout
 * ONCE at scale 1, then find the largest uniform multiplier of THAT fixed
 * box that still fits both axes.
 *
 * Returns 0 for an empty screen list, a degenerate (zero/negative)
 * viewport, or a degenerate (zero/negative) base layout — nothing to fit,
 * so no "ideal" scale exists; callers with a more specific fallback
 * (computeFitAllZoom's DEFAULT_BOARD_ZOOM, computeBoardColumns'
 * DEFAULT_COLUMNS) special-case that before calling this. Shared by
 * computeFitAllZoom (the zoom for the CURRENT column count) and
 * computeBoardColumns (which column count fits best, i.e. has the largest
 * ideal scale — CHR-623 review).
 *
 * @param {string[]} screens
 * @param {Record<string, { width: number, height: number }>} sizes
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {{ columns?: number, gapX?: number, gapY?: number, padding?: number }} [options]
 * @returns {number}
 */
function idealFitScale(screens, sizes, viewportWidth, viewportHeight, options = {}) {
  if (screens.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return 0;
  const { contentWidth, contentHeight } = computeLayout(screens, sizes, { ...options, scale: 1 });
  if (contentWidth <= 0 || contentHeight <= 0) return 0;
  return Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
}

/**
 * The largest board zoom (as a percentage, clamped to [min, max]) at which
 * every tile fits inside a `viewportWidth`x`viewportHeight` viewport, for
 * the grid `options` (in particular its `columns`) already describes — see
 * `idealFitScale`. Empty screens or a degenerate viewport return
 * DEFAULT_BOARD_ZOOM — there's nothing to fit, so there's no ideal value.
 *
 * @param {string[]} screens
 * @param {Record<string, { width: number, height: number }>} sizes
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {{ columns?: number, gapX?: number, gapY?: number, padding?: number }} [options]
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
export function computeFitAllZoom(screens, sizes, viewportWidth, viewportHeight, options = {}, min = MIN_BOARD_ZOOM, max = MAX_BOARD_ZOOM) {
  if (screens.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return DEFAULT_BOARD_ZOOM;
  const scale = idealFitScale(screens, sizes, viewportWidth, viewportHeight, options);
  // Math.floor, not Math.round: this is a promise that "every tile is
  // inside the viewport" (the acceptance criterion, and how the toolbar's
  // "Fit all" quick-jump button decides it's active — it must exactly
  // reproduce whatever zoom actually got applied). Rounding to the NEAREST
  // integer percent can round up past the true fitting boundary — a
  // genuine off-by-rounding bug caught while re-measuring after CHR-623's
  // review lowered the floor to 5%: an ideal scale of 7.56% rounded up to
  // 8%, which overflowed the viewport by a few px and needed a scrollbar.
  return clampZoom(Math.floor(scale * 100), min, max);
}

/**
 * The column count (>= 1) whose grid — same `screens`/`sizes`/gap/padding
 * `options`, native (scale-1) tile size — has the LARGEST `idealFitScale`
 * for a `viewportWidth`x`viewportHeight` viewport: the grid shape that puts
 * the most pixels of actual content on screen at Fit all, rather than a
 * fixed column count that's tall and skinny (or short and wide) regardless
 * of how many screens there are or what shape the viewport is (CHR-623
 * review — Christian's own requirement behind the zoom-slider redesign:
 * "board-view-zoomed-out" shows 186 tiles as a 17x11 grid filling the
 * viewport at Fit all, not a 4-wide, 47-row column).
 *
 * A full scan of every candidate from 1 to `screens.length` (more columns
 * than tiles can't pack any differently than exactly `screens.length`
 * columns already does — one row) rather than a directed search: the
 * fit-per-column-count curve isn't guaranteed unimodal once tile sizes
 * differ (a real project mixes phone/tablet/desktop screens), so a
 * bisection or golden-section search could settle on a local optimum. Ties
 * keep the SMALLER column count (fewer, taller columns over many, short
 * ones) — the scan runs ascending and only replaces the best on a STRICT
 * improvement, so the first column count to reach the best score wins.
 * O(n) in screen count (n candidates, each an O(n) `idealFitScale` — a
 * single `computeBoardLayout` call, no search of its own since CHR-623's
 * review fix) — measured well under 5ms for a 186-screen project, see
 * board-view.js's call site comment for where this runs (screen-list/
 * resize/project-switch, never during a zoom drag).
 *
 * @param {string[]} screens
 * @param {Record<string, { width: number, height: number }>} sizes
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {{ gapX?: number, gapY?: number, padding?: number }} [options]
 * @returns {number}
 */
export function computeBoardColumns(screens, sizes, viewportWidth, viewportHeight, options = {}) {
  if (screens.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return DEFAULT_COLUMNS;

  let bestColumns = 1;
  let bestScale = -Infinity;
  for (let columns = 1; columns <= screens.length; columns++) {
    const scale = idealFitScale(screens, sizes, viewportWidth, viewportHeight, { ...options, columns });
    if (scale > bestScale) {
      bestScale = scale;
      bestColumns = columns;
    }
  }
  return bestColumns;
}

/**
 * Pixel offset of the zoom-slider thumb along its track — the linear
 * mapping from the `$zoom-slider` design-system component (5%–200% ->
 * 0–`trackWidth`px).
 * @param {number} zoomPercent
 * @param {number} [trackWidth]
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
export function zoomSliderOffset(zoomPercent, trackWidth = 140, min = MIN_BOARD_ZOOM, max = MAX_BOARD_ZOOM) {
  const clamped = clampZoom(zoomPercent, min, max);
  return ((clamped - min) / (max - min)) * trackWidth;
}

// Solved so that one mouse wheel "notch" (100 raw px — Chrome/Safari/Edge's
// deltaMode-0 convention for a physical wheel click) changes zoom by
// exactly ×1.2 (zooming in) or ÷1.2 (zooming out): exp(-100 * k) = 1/1.2.
const WHEEL_ZOOM_K = Math.log(1.2) / 100;

/**
 * The multiplicative zoom factor for a `wheel` event's raw `deltaY` and
 * `deltaMode` (CHR-623 review — the old handler was additive and ignored
 * `deltaMode`, so it was ~2x too fast on Chrome, ~30x too fast on Firefox's
 * line-mode wheel deltas, and wrong at the low end of the range: an
 * additive `zoom - 5` from 7% hits the 5% floor while `zoom + 5` reaches
 * 12%, a lopsided step size purely because 7 happens to sit near the
 * floor).
 *
 * First normalizes `deltaY` to the same "pixel" units regardless of
 * `deltaMode` (0 = pixel, already there; 1 = line, browsers report this for
 * a physical mouse wheel notch on Firefox — approximated at 16px/line, a
 * common browser default line-height; 2 = page — one `viewportHeight`),
 * then converts that pixel delta to a multiplicative factor via
 * `exp(-px * k)`, `k` chosen so one 100px (deltaMode-0) notch is exactly
 * ×1.2 / ÷1.2 — smooth and scale-invariant, unlike an additive delta (which
 * has no sensible "percent per pixel" that's both usable at 5% and at
 * 200%). A trackpad pinch (deltaMode 0, deltaY typically 2-10 per event)
 * gets proportionally smaller per-event steps, accumulating smoothly across
 * the many events a real pinch gesture fires.
 *
 * Positive `deltaY` (wheel down / pinch out on most platforms) zooms OUT
 * (factor < 1); negative zooms in (factor > 1) — same direction convention
 * the old additive handler used (`zoom - deltaY * sensitivity`).
 *
 * @param {number} deltaY
 * @param {number} deltaMode 0 (pixel), 1 (line), or 2 (page) — `WheelEvent.deltaMode`
 * @param {number} viewportHeight only used for deltaMode 2 (page)
 * @returns {number} multiplicative factor — apply as `zoom * factor`, then clampZoom
 */
export function computeWheelZoomFactor(deltaY, deltaMode, viewportHeight) {
  const LINE_HEIGHT_PX = 16;
  const px = deltaMode === 1 ? deltaY * LINE_HEIGHT_PX : deltaMode === 2 ? deltaY * viewportHeight : deltaY;
  return Math.exp(-px * WHEEL_ZOOM_K);
}

/**
 * The next board zoom below `zoom` that's a multiple of `step` (CHR-623
 * review — the `−` button must land ON the 5-grid, even from a fractional
 * or off-grid value a wheel/pinch gesture left behind, not just subtract
 * `step` from whatever `zoom` currently is: from 7 with step 5, `zoom -
 * step` would give 2 — off-grid and needlessly close to the floor — where
 * this gives 5, the nearest grid point below). Snaps down to the nearest
 * multiple of `step`; if `zoom` is ALREADY exactly on the grid, steps one
 * further down (otherwise the button would do nothing from an on-grid
 * value). Clamped to `min`.
 * @param {number} zoom
 * @param {number} [step]
 * @param {number} [min]
 * @returns {number}
 */
export function stepZoomDown(zoom, step = BOARD_ZOOM_STEP, min = MIN_BOARD_ZOOM) {
  const snapped = Math.floor(zoom / step) * step;
  const next = snapped < zoom ? snapped : snapped - step;
  return Math.max(min, next);
}

/**
 * The next board zoom above `zoom` that's a multiple of `step` — see
 * `stepZoomDown`, the mirror image (snaps UP to the nearest grid point
 * above `zoom`, stepping one further if already exactly on the grid).
 * Clamped to `max`.
 * @param {number} zoom
 * @param {number} [step]
 * @param {number} [max]
 * @returns {number}
 */
export function stepZoomUp(zoom, step = BOARD_ZOOM_STEP, max = MAX_BOARD_ZOOM) {
  const snapped = Math.ceil(zoom / step) * step;
  const next = snapped > zoom ? snapped : snapped + step;
  return Math.min(max, next);
}

// The "low zoom" legibility threshold from the `chr-621` design-system tag
// notes — shared by two unrelated-looking rules that are actually the same
// rule: below this, a tile's name label is illegible at the canvas's own
// scale (labelDisplayMode), AND the UNPINNED pin affordance is pure visual
// noise that drowns the handful of pinned markers a human is scanning for
// at an overview zoom (CHR-624 — see board-view.js's applyZoomDependentTileState).
export const LOW_ZOOM_AFFORDANCE_THRESHOLD = 60;

/**
 * Below this board zoom, a tile's name label is illegible at the canvas's
 * own scale and isn't rendered at all; below 100% but at/above this, it's
 * rendered truncated (ellipsis) to the tile's own width; at 100% and above,
 * the full name always shows. See the `chr-621` design-system tag notes'
 * "Label degradation by zoom" section.
 * @param {number} zoomPercent
 * @returns {"hidden" | "truncated" | "full"}
 */
export function labelDisplayMode(zoomPercent) {
  if (zoomPercent < LOW_ZOOM_AFFORDANCE_THRESHOLD) return "hidden";
  if (zoomPercent < 100) return "truncated";
  return "full";
}

/**
 * The scroll offset that keeps the same content point under the cursor
 * across a zoom change — the "zoom around cursor" behavior for Ctrl/Cmd +
 * wheel and trackpad pinch. Exact (not an approximation) because the board
 * canvas is a single uniform CSS `scale()` transform from its own origin
 * (0,0) — see board-view.js's `applyZoomSizing` — so content coordinates and
 * screen coordinates relate by one multiplicative factor, unlike the tile
 * grid's per-row layout math.
 *
 * @param {{
 *   cursorX: number, cursorY: number,
 *   scrollLeft: number, scrollTop: number,
 *   oldZoomPercent: number, newZoomPercent: number,
 *   contentWidth: number, contentHeight: number,
 *   viewportWidth: number, viewportHeight: number,
 * }} args `cursorX`/`cursorY` are relative to the scroll viewport's own
 *   top-left (e.g. from `surfaceEl.getBoundingClientRect()`); `contentWidth`/
 *   `contentHeight` are the UNSCALED (100%-zoom) board content size.
 * @returns {{ left: number, top: number }}
 */
export function computeZoomAroundCursor({
  cursorX,
  cursorY,
  scrollLeft,
  scrollTop,
  oldZoomPercent,
  newZoomPercent,
  contentWidth,
  contentHeight,
  viewportWidth,
  viewportHeight,
}) {
  const oldScale = oldZoomPercent / 100;
  const newScale = newZoomPercent / 100;
  const contentX = (scrollLeft + cursorX) / oldScale;
  const contentY = (scrollTop + cursorY) / oldScale;
  const maxLeft = Math.max(0, contentWidth * newScale - viewportWidth);
  const maxTop = Math.max(0, contentHeight * newScale - viewportHeight);
  return {
    left: clamp(contentX * newScale - cursorX, 0, maxLeft),
    top: clamp(contentY * newScale - cursorY, 0, maxTop),
  };
}

// --- CHR-733: variant clusters ------------------------------------------
//
// Layout items are either a plain screen (a string, or `{ type: "tile" }`)
// or a `{ type: "cluster" }` from buildBoardModel. A board of only plain
// screens is laid out by computeBoardLayout exactly as before; anything with
// a cluster goes through computeClusterLayout. `computeLayout` picks, so
// Fit all / column search work on either without knowing which.

/** Expanded clusters draw their tiles at this fraction of native size (the approved `c-clusters` design shrinks them ~60% so a subtree fits)... */
export const CLUSTER_TILE_SCALE = 0.6;
/** ...or smaller, when the fullest depth level of a cluster would otherwise stack taller than this many board px (a level with 8 tiles is ~4000px at 0.6). */
export const MAX_LEVEL_HEIGHT = 1800;
const MIN_CLUSTER_TILE_SCALE = 0.2;
/** Tiles per depth level of an expanded cluster before the rest fold into a "+N more" tile. */
export const MAX_TILES_PER_DEPTH = 8;
const FRAME_PAD = 24;
const FRAME_HEADER = 40;
const FRAME_MIN_WIDTH = 220;
const THUMB_ROW = 36;
const DEPTH_GAP = 56;
const TILE_GAP = 28;
const MORE_HEIGHT = 56;
const MAX_THUMBS = 8;

function allNodes(node) {
  return [node, ...node.children.flatMap(allNodes)];
}

/**
 * Turns the visible screen set into the board's layout items.
 *
 * Visibility stays per screen (`visibleNames`, from computeBoardVisibility):
 * a cluster exists as soon as ANY of its members is shown; members that are
 * not shown are left out, and the ancestors of shown members are kept as
 * `context` (dimmed) so a shown variant is never orphaned. A main screen
 * without variants stays a plain tile. A cluster is expanded when ANY member
 * of its subtree is named in `expandedNames` — the daemon stores the names as
 * given (a main screen or any variant), so an entry naming a variant expands
 * that variant's cluster.
 *
 * `clusters: false` returns the flat board: `visibleNames` as plain tiles in
 * the given order, `expandedNames` ignored.
 *
 * @param {{ name: string, tags?: string[], variant_of?: string, variant_kind?: string }[]} screens every screen of the project
 * @param {string[]} visibleNames
 * @param {string[]} [expandedNames]
 * @param {{ clusters?: boolean }} [options]
 * @returns {{ items: object[], tileNames: string[], contextNames: Set<string>, clusters: object[] }}
 */
export function buildBoardModel(screens, visibleNames, expandedNames = [], { clusters = true } = {}) {
  if (!clusters) {
    return { items: visibleNames.map((screen) => ({ type: "tile", screen })), tileNames: [...visibleNames], contextNames: new Set(), clusters: [] };
  }
  const tree = buildScreenTree(screens);
  const visible = new Set(visibleNames);
  const expandedSet = new Set(expandedNames);
  const items = [];
  const tileNames = [];
  const contextNames = new Set();
  const clusterItems = [];

  for (const root of tree.roots) {
    const all = allNodes(root);
    const shown = all.filter((n) => visible.has(n.name));
    if (shown.length === 0) continue;
    if (root.children.length === 0) {
      items.push({ type: "tile", screen: root.name });
      tileNames.push(root.name);
      continue;
    }
    const shownSet = new Set(shown);
    const displayedSet = new Set();
    for (const n of shown) for (let p = n; p; p = p.parent) displayedSet.add(p);
    const displayed = all.filter((n) => displayedSet.has(n));
    const members = displayed.map((n) => ({
      screen: n.name,
      parent: n.parent?.name ?? null,
      depth: n.depth,
      kind: n.screen.variant_kind ?? null,
      context: !shownSet.has(n),
    }));
    for (const m of members) if (m.context) contextNames.add(m.screen);
    const expanded = all.some((n) => expandedSet.has(n.name));
    const cluster = {
      type: "cluster",
      root: root.name,
      size: root.total,
      depth: 1 + Math.max(...all.map((n) => n.depth)),
      expanded,
      memberNames: all.map((n) => n.name),
      members,
      levels: [],
    };
    if (expanded) {
      const byDepth = new Map();
      for (const m of members) byDepth.set(m.depth, [...(byDepth.get(m.depth) ?? []), m]);
      for (const [depth, list] of [...byDepth].sort((a, b) => a[0] - b[0])) {
        // Context ancestors are always tiles (they parent shown members) and
        // don't count toward the cap; only shown members can fold into "+N more".
        let shownSoFar = 0;
        const tiles = [];
        const hidden = [];
        for (const m of list) {
          if (m.context || shownSoFar++ < MAX_TILES_PER_DEPTH) tiles.push(m);
          else hidden.push(m);
        }
        cluster.levels.push({ depth, tiles, hidden });
      }
      for (const level of cluster.levels) for (const m of level.tiles) tileNames.push(m.screen);
    } else {
      tileNames.push(root.name);
    }
    items.push(cluster);
    clusterItems.push(cluster);
  }
  return { items, tileNames, contextNames, clusters: clusterItems };
}

/**
 * The `set_board_state` `expanded` patch for a header click (CHR-733 CTO
 * decision): an expanded cluster collapses by removing EVERY member
 * currently listed in `expandedNames` (the daemon stores them un-normalised,
 * so more than one can be there); a collapsed one expands by adding its main
 * screen.
 * @param {{ root: string, expanded: boolean, memberNames: string[] }} cluster
 * @param {string[]} expandedNames
 * @returns {{ op: "add" | "remove", screens: string[] }}
 */
export function clusterToggleWrite(cluster, expandedNames) {
  if (!cluster.expanded) return { op: "add", screens: [cluster.root] };
  const listed = new Set(expandedNames);
  return { op: "remove", screens: cluster.memberNames.filter((name) => listed.has(name)) };
}

function screenSize(sizes, screen) {
  return sizes[screen] ?? FALLBACK_SIZE;
}

function layoutTile(screen, x, y, sizes, scale) {
  const natural = screenSize(sizes, screen);
  return { screen, x, y, width: natural.width * scale, height: natural.height * scale, naturalWidth: natural.width, naturalHeight: natural.height };
}

function collapsedBlock(cluster, sizes) {
  const main = screenSize(sizes, cluster.root);
  const width = Math.max(FRAME_MIN_WIDTH, main.width + FRAME_PAD * 2);
  const others = cluster.members.filter((m) => m.parent !== null);
  const height = FRAME_HEADER + main.height + (others.length > 0 ? 12 + THUMB_ROW : 0) + FRAME_PAD;
  return {
    width,
    height,
    emit(x, y, out) {
      out.frames.push({
        root: cluster.root,
        expanded: false,
        size: cluster.size,
        depth: cluster.depth,
        x,
        y,
        width,
        height,
        headerHeight: FRAME_HEADER,
        members: cluster.members.map((m) => m.screen),
        thumbs: others.slice(0, MAX_THUMBS).map((m) => ({ screen: m.screen, kind: m.kind, deeper: m.depth >= 2 })),
        moreThumbs: Math.max(0, others.length - MAX_THUMBS),
      });
      out.tiles.push(layoutTile(cluster.root, x + (width - main.width) / 2, y + FRAME_HEADER, sizes, 1));
    },
  };
}

/** The tile scale of one expanded cluster: CLUSTER_TILE_SCALE, shrunk so its fullest level stays within MAX_LEVEL_HEIGHT. */
export function clusterTileScale(cluster, sizes) {
  let tallest = 0;
  for (const level of cluster.levels) {
    const total = level.tiles.reduce((sum, m) => sum + screenSize(sizes, m.screen).height, 0);
    tallest = Math.max(tallest, total + (level.hidden.length > 0 ? MORE_HEIGHT : 0) + TILE_GAP * level.tiles.length);
  }
  if (tallest <= 0) return CLUSTER_TILE_SCALE;
  return Math.max(MIN_CLUSTER_TILE_SCALE, Math.min(CLUSTER_TILE_SCALE, MAX_LEVEL_HEIGHT / tallest));
}

function expandedBlock(cluster, sizes) {
  const scale = clusterTileScale(cluster, sizes);
  const columns = cluster.levels.map((level) => {
    const entries = level.tiles.map((m) => ({ member: m, size: screenSize(sizes, m.screen) }));
    const tileWidth = Math.max(...entries.map((e) => e.size.width * scale));
    const moreWidth = level.hidden.length > 0 ? 140 : 0;
    const width = Math.max(tileWidth, moreWidth);
    const heights = entries.map((e) => e.size.height * scale);
    if (level.hidden.length > 0) heights.push(MORE_HEIGHT);
    const height = heights.reduce((sum, h) => sum + h, 0) + TILE_GAP * Math.max(0, heights.length - 1);
    return { level, entries, width, height };
  });
  const innerWidth = columns.reduce((sum, c) => sum + c.width, 0) + DEPTH_GAP * Math.max(0, columns.length - 1);
  const innerHeight = Math.max(...columns.map((c) => c.height));
  const width = Math.max(FRAME_MIN_WIDTH, innerWidth + FRAME_PAD * 2);
  const height = FRAME_HEADER + FRAME_PAD + innerHeight + FRAME_PAD;
  return {
    width,
    height,
    emit(x, y, out) {
      out.frames.push({
        root: cluster.root,
        expanded: true,
        size: cluster.size,
        depth: cluster.depth,
        x,
        y,
        width,
        height,
        headerHeight: FRAME_HEADER,
        members: cluster.members.map((m) => m.screen),
        thumbs: [],
        moreThumbs: 0,
      });
      let cx = x + FRAME_PAD + (width - FRAME_PAD * 2 - innerWidth) / 2;
      const placed = new Map();
      for (const col of columns) {
        let cy = y + FRAME_HEADER + FRAME_PAD + (innerHeight - col.height) / 2;
        for (const { member, size } of col.entries) {
          const tile = layoutTile(member.screen, cx + (col.width - size.width * scale) / 2, cy, sizes, scale);
          out.tiles.push(tile);
          placed.set(member.screen, tile);
          cy += tile.height + TILE_GAP;
        }
        if (col.level.hidden.length > 0) {
          out.mores.push({
            id: `${cluster.root}:${col.level.depth}`,
            root: cluster.root,
            depth: col.level.depth,
            names: col.level.hidden.map((m) => m.screen),
            x: cx + (col.width - 140) / 2,
            y: cy,
            width: 140,
            height: MORE_HEIGHT,
          });
        }
        cx += col.width + DEPTH_GAP;
      }
      const foldedParents = new Set();
      for (const member of cluster.members) {
        const child = placed.get(member.screen);
        const parent = member.parent ? placed.get(member.parent) : null;
        if (child && parent) out.connectors.push({ from: parent.screen, to: child.screen });
      }
      // Children folded into a "+N more" tile keep their parent's connector,
      // drawn once per parent to that tile.
      for (const col of columns) {
        const more = out.mores.find((m) => m.id === `${cluster.root}:${col.level.depth}`);
        for (const member of col.level.hidden) {
          const key = `${member.parent}>${more.id}`;
          if (!member.parent || !placed.has(member.parent) || foldedParents.has(key)) continue;
          foldedParents.add(key);
          out.connectors.push({ from: member.parent, to: more.id, more: true });
        }
      }
    },
  };
}

/**
 * Cluster-aware sibling of computeBoardLayout: plain tiles and cluster
 * frames are packed into rows of `columns` items exactly like the flat grid
 * (row height = tallest item). A collapsed cluster is a frame around its main
 * tile at native size plus a thumbnail strip; an expanded one lays its
 * subtree out left-to-right by depth at CLUSTER_TILE_SCALE with at most
 * MAX_TILES_PER_DEPTH tiles per level (the rest become one "+N more" tile).
 *
 * @param {(string | { type: "tile", screen: string } | object)[]} items
 * @param {Record<string, { width: number, height: number }>} sizes
 * @param {{ columns?: number, gapX?: number, gapY?: number, padding?: number }} [options]
 * @returns {{
 *   tiles: ReturnType<typeof computeBoardLayout>["tiles"],
 *   frames: object[], mores: object[], connectors: { from: string, to: string, more?: boolean }[],
 *   contentWidth: number, contentHeight: number,
 * }}
 */
export function computeClusterLayout(items, sizes, options = {}) {
  const columns = options.columns ?? DEFAULT_COLUMNS;
  const gapX = options.gapX ?? BASE_GAP;
  const gapY = options.gapY ?? BASE_GAP;
  const padding = options.padding ?? BASE_PADDING;
  const out = { tiles: [], frames: [], mores: [], connectors: [], contentWidth: padding * 2, contentHeight: padding * 2 };

  const blocks = items.map((item) => {
    if (typeof item === "string" || item.type === "tile") {
      const screen = typeof item === "string" ? item : item.screen;
      const natural = screenSize(sizes, screen);
      return { width: natural.width, height: natural.height, emit: (x, y, o) => o.tiles.push(layoutTile(screen, x, y, sizes, 1)) };
    }
    return item.expanded ? expandedBlock(item, sizes) : collapsedBlock(item, sizes);
  });

  let y = padding;
  for (let i = 0; i < blocks.length; i += columns) {
    let x = padding;
    let rowHeight = 0;
    for (const block of blocks.slice(i, i + columns)) {
      block.emit(x, y, out);
      x += block.width + gapX;
      rowHeight = Math.max(rowHeight, block.height);
    }
    out.contentWidth = Math.max(out.contentWidth, x - gapX + padding);
    y += rowHeight + gapY;
  }
  out.contentHeight = blocks.length === 0 ? padding * 2 : y - gapY + padding;
  return out;
}

/** Picks the flat grid for a board of only plain tiles (byte-for-byte today's layout) and the cluster layout otherwise. */
export function computeLayout(items, sizes, options) {
  const isPlain = (item) => typeof item === "string" || item.type === "tile";
  if (items.every(isPlain)) return computeBoardLayout(items.map((i) => (typeof i === "string" ? i : i.screen)), sizes, options);
  return computeClusterLayout(items, sizes, options);
}

/**
 * Where an edge ending at `screen` lands on a cluster board: its own tile;
 * else the "+N more" tile its (capped) depth level folded into; else the
 * frame of its collapsed cluster. `null` when the screen isn't on the board.
 * @returns {{ kind: "tile" | "more" | "frame", rect: object, screen: string, id: string } | null}
 */
export function resolveEdgeEnd(layout, screen) {
  const tile = findTile(layout.tiles, screen);
  if (tile) return { kind: "tile", rect: tile, screen, id: screen };
  const more = layout.mores?.find((m) => m.names.includes(screen));
  if (more) return { kind: "more", rect: more, screen, id: more.id };
  const frame = layout.frames?.find((f) => !f.expanded && f.members.includes(screen));
  if (frame) return { kind: "frame", rect: frame, screen, id: frame.root };
  return null;
}

/**
 * Both ends of a flow edge on a cluster board plus the sides it leaves/enters
 * by; a docked end (`more` / `frame`) is labelled with the screen it really
 * touches by the caller. `null` when an end isn't on the board, or when the
 * edge stays inside one cluster and touches a docked end (both ends live in
 * the same frame / "+N more" tile, so there is nothing to draw).
 */
export function resolveFlowEdge(layout, flow) {
  const fromScreen = screenIdFromRef(flow.from);
  const toScreen = screenIdFromRef(flow.to);
  const from = resolveEdgeEnd(layout, fromScreen);
  const to = resolveEdgeEnd(layout, toScreen);
  if (!from || !to) return null;
  if (from.kind !== "tile" || to.kind !== "tile") {
    // Nothing to draw when both ends dock on the same rect, or the edge stays
    // inside one collapsed frame. Inside an expanded cluster, an edge from a
    // tile to its own "+N more" tile is two different rects and is drawn.
    if (from.rect === to.rect) return null;
    const frameOf = (screen) => layout.frames?.find((f) => f.members.includes(screen));
    const fromFrame = frameOf(fromScreen);
    if (fromFrame && !fromFrame.expanded && fromFrame === frameOf(toScreen)) return null;
  }
  return { from, to, sides: edgeSides(from.rect, to.rect) };
}

/**
 * The Board's visible tile set (CHR-624/ADR-005) — filter matches UNION
 * pinned screens, in the project's own screen order (not filter-match order
 * or pin order) — plus enough classification for the toolbar status text
 * and the per-tile "pinned but outside the filter" treatment
 * (`$board-tile` `outside-filter` variant: dashed border + badge). One
 * function computing all of it together, rather than three separate passes
 * over `screens`, so the tile list and the status text it's displayed next
 * to can never disagree about what's actually shown.
 *
 * `pinned` is trusted no further than the screens that actually exist: a
 * pinned name with no matching screen (the daemon didn't catch a delete —
 * ADR-005 prunes on `delete_entity`, but a screen can also vanish without
 * it, e.g. a branch switch or a hand-deleted file) is silently dropped from
 * every result here rather than rendered as a ghost tile or counted in
 * `pinnedCount`.
 *
 * @param {{ name: string, tags: string[] }[]} screens
 * @param {string} filter
 * @param {string[]} pinned
 * @returns {{
 *   visibleNames: string[],
 *   outsideFilterNames: string[],
 *   pinnedNames: string[],
 *   matchCount: number,
 *   pinnedCount: number,
 *   shownCount: number,
 * }}
 */
export function computeBoardVisibility(screens, filter, pinned) {
  const matches = filterScreens(screens, filter);
  const matchNames = new Set(matches.map((s) => s.name));
  const pinnedNames = pinned.filter((name) => screens.some((s) => s.name === name));
  const pinnedSet = new Set(pinnedNames);
  const visible = screens.filter((s) => matchNames.has(s.name) || pinnedSet.has(s.name));
  return {
    visibleNames: visible.map((s) => s.name),
    outsideFilterNames: visible.filter((s) => pinnedSet.has(s.name) && !matchNames.has(s.name)).map((s) => s.name),
    pinnedNames,
    matchCount: matches.length,
    pinnedCount: pinnedSet.size,
    shownCount: visible.length,
  };
}

/**
 * The `$board-toolbar` `status` slot's text — "N shown — M matches ·
 * K pinned", exactly as the approved `board-view` design screen shows it.
 * Takes `computeBoardVisibility`'s own return shape so the two can never
 * drift apart.
 * @param {{ shownCount: number, matchCount: number, pinnedCount: number }} visibility
 * @returns {string}
 */
export function formatBoardStatusText({ shownCount, matchCount, pinnedCount }) {
  return `${shownCount} shown — ${matchCount} matches · ${pinnedCount} pinned`;
}
