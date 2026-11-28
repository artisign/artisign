// CHR-1295, CHR-1296 — the pointer layer of the Board's Comment and Inspect tools. Every tile carries a `.board-tile-pick` overlay over its iframe (board-view.js); while a tool is active the overlays take the pointer, because a press inside a tile iframe never reaches this document. Overlays sit inside the tile, below its chrome, so the tile's own controls (pin mark, cluster toggles, labels) stay clickable. Each move and click on an overlay is mapped into the tile under it (tile-hit.js) and handed to the active tool; the tool owns the left button. The overlays are inside the scrolled canvas, so the wheel and native scrolling still reach the surface.

import { elementAtHit, tileAtPoint } from "./tile-hit.js";

/**
 * @param {{
 *   containerEl: HTMLElement,
 *   targetSelector: string,
 *   frames: () => import("./tile-hit.js").TileFrame[],
 *   onHover: (hit: import("./tile-hit.js").TileHit | null, el: Element | null) => void,
 *   onPick: (hit: import("./tile-hit.js").TileHit | null, el: Element | null) => void,
 * }} opts `containerEl`: the scrolled canvas that holds the overlays (it carries `data-pick` while a tool is active); `targetSelector`: what an overlay matches; `onHover`: the pointer moved to another element, left the tile or left the board (`null`); `onPick`: a click on an overlay
 */
export function createBoardPicker({ containerEl, targetSelector, frames, onHover, onPick }) {
  /** @type {{ x: number, y: number } | null} */
  let last = null;

  /** @param {number} x @param {number} y */
  function resolve(x, y) {
    const hit = tileAtPoint(frames(), x, y);
    return { hit, el: hit ? elementAtHit(hit) : null };
  }

  /** @param {Event} evt */
  const onOverlay = (evt) => evt.target instanceof Element && evt.target.closest(targetSelector) !== null;

  containerEl.addEventListener("pointermove", (evt) => {
    if (!onOverlay(evt)) {
      if (last) onHover(null, null);
      last = null;
      return;
    }
    last = { x: evt.clientX, y: evt.clientY };
    const { hit, el } = resolve(evt.clientX, evt.clientY);
    onHover(hit, el);
  });
  containerEl.addEventListener("pointerleave", () => {
    last = null;
    onHover(null, null);
  });
  containerEl.addEventListener("click", (evt) => {
    if (!onOverlay(evt)) return;
    evt.preventDefault();
    const { hit, el } = resolve(evt.clientX, evt.clientY);
    onPick(hit, el);
  });

  return {
    /** The overlays take the pointer only while a tool is active; otherwise the tiles stay clickable as before. @param {boolean} on */
    setActive(on) {
      containerEl.dataset.pick = String(on);
      if (!on) last = null;
    },
    /** Asks the tool again about the element under the last known pointer position — after a scroll or zoom moved the tiles under a resting pointer. */
    refresh() {
      if (!last || containerEl.dataset.pick !== "true") return;
      const { hit, el } = resolve(last.x, last.y);
      onHover(hit, el);
    },
  };
}
