// CHR-1295, CHR-1296 — the pointer layer of the Board's Comment and Inspect tools. While a tool is active it lies over the board (inside the scrolled canvas, so the wheel and native scrolling still reach the surface) and takes the pointer, because a press inside a tile iframe never reaches this document. Each move and click is mapped into the tile under it (tile-hit.js) and handed to the active tool; the tool owns the left button.

import { elementAtHit, tileAtPoint } from "./tile-hit.js";

/**
 * @param {{
 *   layerEl: HTMLElement,
 *   frames: () => import("./tile-hit.js").TileFrame[],
 *   onHover: (hit: import("./tile-hit.js").TileHit | null, el: Element | null) => void,
 *   onPick: (hit: import("./tile-hit.js").TileHit | null, el: Element | null) => void,
 * }} opts `onHover`: the pointer moved to another element, left the tile or left the board (`null`); `onPick`: a click — `null` on empty board space
 */
export function createBoardPicker({ layerEl, frames, onHover, onPick }) {
  /** @type {{ x: number, y: number } | null} */
  let last = null;

  /** @param {number} x @param {number} y */
  function resolve(x, y) {
    const hit = tileAtPoint(frames(), x, y);
    return { hit, el: hit ? elementAtHit(hit) : null };
  }

  layerEl.addEventListener("pointermove", (evt) => {
    last = { x: evt.clientX, y: evt.clientY };
    const { hit, el } = resolve(evt.clientX, evt.clientY);
    onHover(hit, el);
  });
  layerEl.addEventListener("pointerleave", () => {
    last = null;
    onHover(null, null);
  });
  layerEl.addEventListener("click", (evt) => {
    evt.preventDefault();
    const { hit, el } = resolve(evt.clientX, evt.clientY);
    onPick(hit, el);
  });

  return {
    /** The layer takes the pointer only while a tool is active; otherwise the tiles stay clickable as before. @param {boolean} on */
    setActive(on) {
      layerEl.dataset.active = String(on);
      if (!on) last = null;
    },
    /** Asks the tool again about the element under the last known pointer position — after a scroll or zoom moved the tiles under a resting pointer. */
    refresh() {
      if (!last || layerEl.dataset.active !== "true") return;
      const { hit, el } = resolve(last.x, last.y);
      onHover(hit, el);
    },
  };
}
