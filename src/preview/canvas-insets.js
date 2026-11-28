// CHR-1299 — what the floating cards cover of a full-window canvas. The canvases (Screens, Board) fill the window and never move for a card; these insets only feed what is asked of the free area: the fit scale and where "Fit" / "Fit all" put the content.

/**
 * @typedef {{ left: number, right: number, top: number, bottom: number }} Insets
 * @typedef {{ left: number, right: number }} CardRect horizontal extent of a visible card, in window pixels
 */

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
  return { left, right, top, bottom };
}
