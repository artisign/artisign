// CHR-1299 — what the floating cards cover of a full-window canvas. The canvases (Screens, Board) fill the window and never move for a card; these insets only feed what is asked of the free area: the fit scale and where "Fit" / "Fit all" put the content.

/** The narrowest free width a fit may be handed, in window pixels. */
const MIN_FREE_WIDTH = 200;

/**
 * @typedef {{ left: number, right: number, top: number, bottom: number }} Insets
 * @typedef {{ left: number, right: number }} CardRect horizontal extent of a visible card, in window pixels
 */

/**
 * The centre for a bar of `barWidth` over a target centre, kept inside `[freeLeft, freeRight]`; a bar wider than the free span is centred in it.
 * @param {number} center
 * @param {number} barWidth
 * @param {number} freeLeft
 * @param {number} freeRight
 * @returns {number}
 */
export function clampBarCenter(center, barWidth, freeLeft, freeRight) {
  const half = Math.min(barWidth, Math.max(0, freeRight - freeLeft)) / 2;
  return Math.min(Math.max(center, freeLeft + half), freeRight - half);
}

/**
 * The space the cards take from each window edge. A card on the left half pushes the left inset to its right edge, one on the right half the right inset to its left edge; `gap` is the breathing room kept between a card and the content. `top` and `bottom` are the fixed bands of the top groups and the zoom pill.
 * @param {number} viewportWidth
 * @param {CardRect[]} cards
 * @param {{ top: number, bottom: number, gap: number }} bands
 * @returns {Insets}
 */
export function computeCanvasInsets(viewportWidth, cards, { top, bottom, gap }) {
  let left = 0;
  let right = 0;
  for (const card of cards) {
    if ((card.left + card.right) / 2 < viewportWidth / 2) left = Math.max(left, card.right + gap);
    else right = Math.max(right, viewportWidth - card.left + gap);
  }
  // Two cards dragged toward the centre must not swallow the free area: keep a usable width by scaling both insets down together.
  const minFree = Math.min(MIN_FREE_WIDTH, viewportWidth / 4);
  const room = viewportWidth - minFree;
  if (left + right > room) {
    const k = Math.max(0, room) / (left + right);
    left *= k;
    right *= k;
  }
  return { left, right, top, bottom };
}
