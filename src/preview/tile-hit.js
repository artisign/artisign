// CHR-1295, CHR-1296 — the one hit-test of the Board's tools. A tile's document sits in a sandboxed iframe that is scaled twice (the tile's own fit, the board's zoom), and no listener goes into it: Comment and Inspect both catch the pointer in a parent-document layer over the board and ask this module which element of which tile it is over.
//
// The mapping uses the iframe's own on-screen rect, so it holds at every zoom and pan and does not depend on how the board is laid out or padded: a client point inside the rect maps to the tile document's CSS pixels by the ratio of the rect's width to the iframe's layout width.

/**
 * @typedef {{ left: number, top: number, width: number, height: number }} Rect
 * @typedef {{ screen: string, rect: () => Rect, layoutWidth: () => number, doc: () => Document | null }} TileFrame a tile as the hit-test sees it (board-view.js's tileFrames)
 * @typedef {{ screen: string, frame: TileFrame, doc: Document, x: number, y: number }} TileHit `x`, `y`: the point in the tile document's CSS pixels
 */

/**
 * On-screen pixels per tile-document pixel: the tile's scale times the board's zoom.
 * @param {TileFrame} frame
 * @returns {number}
 */
export function tileScale(frame) {
  const layout = frame.layoutWidth();
  return layout > 0 ? frame.rect().width / layout : 1;
}

/**
 * The tile under a client point, with the point mapped into the tile document. The last tile in the list wins where two overlap (later tiles paint above earlier ones). Null over empty board space and over a tile whose document is not there (yet).
 * @param {TileFrame[]} frames
 * @param {number} clientX
 * @param {number} clientY
 * @returns {TileHit | null}
 */
export function tileAtPoint(frames, clientX, clientY) {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    const r = frame.rect();
    if (clientX < r.left || clientX >= r.left + r.width || clientY < r.top || clientY >= r.top + r.height) continue;
    const doc = frame.doc();
    if (!doc) return null;
    const scale = tileScale(frame);
    return { screen: frame.screen, frame, doc, x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  }
  return null;
}

/**
 * The innermost element at a hit, as the tile document itself answers it.
 * @param {TileHit} hit
 * @returns {Element | null}
 */
export function elementAtHit(hit) {
  return hit.doc.elementFromPoint(hit.x, hit.y);
}

/**
 * An element of a tile's document as a box in client pixels (what a parent-document overlay positions against).
 * @param {TileFrame} frame
 * @param {Element} el
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
export function elementClientBox(frame, el) {
  const r = frame.rect();
  const scale = tileScale(frame);
  const e = el.getBoundingClientRect();
  return { left: r.left + e.left * scale, top: r.top + e.top * scale, right: r.left + e.right * scale, bottom: r.top + e.bottom * scale };
}
