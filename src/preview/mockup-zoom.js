// Mockup view zoom: scales the whole comparison row (`.mockup-columns`) as
// one unit via a CSS transform — not per-column scaling — same approach as
// the screen canvas's `applyCanvas` (see canvas.js), reusing its `fitScale`.

import { fitScale } from "./canvas.js";

/**
 * Scales `columnsEl` to fit within `paneEl` ("fit") or to a fixed zoom
 * level, and resizes `columnsEl`'s parent (the zoom wrapper) to the scaled
 * box — a CSS `transform` never changes an element's own layout size, so
 * without this the wrapper (and `paneEl`'s scrollbars) would still reflect
 * the un-scaled row.
 *
 * Column widths settle asynchronously as each variant's iframe loads (see
 * `onColumnMeasured` in mockup-view.js) — callers re-invoke this after each
 * one so "fit" keeps converging on the final row size.
 *
 * @param {{ paneEl: HTMLElement, columnsEl: HTMLElement, zoom: "fit" | number }} args
 */
export function applyMockupZoom({ paneEl, columnsEl, zoom }) {
  const wrapperEl = columnsEl.parentElement;
  if (!wrapperEl) return;

  // clientWidth/clientHeight include paneEl's OWN padding (#mockup-view has
  // padding: $spacing-2xl) — subtract it, or "fit" overestimates the room
  // available to the wrapper by 2x the padding on each axis and the scaled
  // row spills past the padding edge.
  const paneStyle = getComputedStyle(paneEl);
  const availW = paneEl.clientWidth - (parseFloat(paneStyle.paddingLeft) || 0) - (parseFloat(paneStyle.paddingRight) || 0);
  const availH = paneEl.clientHeight - (parseFloat(paneStyle.paddingTop) || 0) - (parseFloat(paneStyle.paddingBottom) || 0);

  // The row's height depends on the zoom (the column headers counter-scale, see layoutHeads) and "fit" depends on the row's height, so settle by iterating: apply the candidate scale, measure the row it produces, derive the next scale. It converges in one or two steps; a fixed zoom needs none.
  let scale = zoom === "fit" ? 1 : zoom;
  let width;
  let height;
  for (let step = 0; step < 4; step += 1) {
    layoutHeads(columnsEl, scale);
    width = columnsEl.scrollWidth;
    height = columnsEl.scrollHeight;
    const next = zoom === "fit" ? fitScale(availW, availH, width, height) : zoom;
    const settled = Math.abs(next - scale) < 0.001;
    scale = next;
    if (settled) break;
  }

  columnsEl.style.transform = `scale(${scale})`;
  columnsEl.style.transformOrigin = "top left";
  wrapperEl.style.width = `${width * scale}px`;
  wrapperEl.style.height = `${height * scale}px`;
}

/**
 * Publishes `--zoom` on the row and pushes each frame down by what its counter-scaled header lacks. The headers (index, title, description) are chrome text, not the user's variant: they counter-scale to native size (style.css: width x --zoom, scale(1 / --zoom)). The counter-scaled box still occupies its unscaled layout height, which after the row's own scale is `h * scale` — short of the `h` it paints — so the row needs `h / scale - h` more, in its own (pre-scale) units.
 *
 * @param {HTMLElement} columnsEl
 * @param {number} scale
 */
function layoutHeads(columnsEl, scale) {
  columnsEl.style.setProperty("--zoom", String(scale));
  for (const head of columnsEl.querySelectorAll(".mockup-column-head")) {
    const h = head.offsetHeight; // laid out at width x --zoom, so it already reflects the new wrapping
    head.style.marginBottom = `${h / scale - h}px`;
  }
}
