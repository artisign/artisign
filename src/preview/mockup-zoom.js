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

  const width = columnsEl.scrollWidth;
  const height = columnsEl.scrollHeight;
  // clientWidth/clientHeight include paneEl's OWN padding (#mockup-view has
  // padding: $spacing-2xl) — subtract it, or "fit" overestimates the room
  // available to the wrapper by 2x the padding on each axis and the scaled
  // row spills past the padding edge.
  const paneStyle = getComputedStyle(paneEl);
  const availW = paneEl.clientWidth - (parseFloat(paneStyle.paddingLeft) || 0) - (parseFloat(paneStyle.paddingRight) || 0);
  const availH = paneEl.clientHeight - (parseFloat(paneStyle.paddingTop) || 0) - (parseFloat(paneStyle.paddingBottom) || 0);
  const scale = zoom === "fit" ? fitScale(availW, availH, width, height) : zoom;

  columnsEl.style.transform = `scale(${scale})`;
  columnsEl.style.transformOrigin = "top left";
  columnsEl.style.setProperty("--zoom", String(scale));

  // The column headers (index, title, description) are chrome text, not the user's variant: they counter-scale to native size (style.css: width x --zoom, scale(1 / --zoom)). The counter-scaled box still occupies its unscaled layout height, which after the row's own scale is `h * scale` — short of the `h` it paints — so the frame below is pushed down by the difference, in the row's own (pre-scale) units.
  let heads = 0;
  for (const head of columnsEl.querySelectorAll(".mockup-column-head")) {
    const h = head.offsetHeight;
    head.style.marginBottom = `${h / scale - h}px`;
    heads += 1;
  }
  const scaledHeight = heads > 0 ? columnsEl.scrollHeight : height; // margins changed the row's height

  wrapperEl.style.width = `${width * scale}px`;
  wrapperEl.style.height = `${scaledHeight * scale}px`;
}
