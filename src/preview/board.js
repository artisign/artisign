// Board view geometry: pure, DOM-free layout/edge/scroll math consumed by
// board-view.js. Kept separate (and tested directly) because everything
// touching the DOM — tiles, iframes, the SVG edge layer — needs real
// layout that even jsdom doesn't compute.

export const DEFAULT_TILE_SCALE = 0.8;
export const DEFAULT_COLUMNS = 4;
export const DEFAULT_GAP = 64;
export const DEFAULT_PADDING = 48;
const FALLBACK_SIZE = { width: 390, height: 844 };

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
  const scale = options.scale ?? DEFAULT_TILE_SCALE;
  const columns = options.columns ?? DEFAULT_COLUMNS;
  const gapX = options.gapX ?? DEFAULT_GAP;
  const gapY = options.gapY ?? DEFAULT_GAP;
  const padding = options.padding ?? DEFAULT_PADDING;

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
