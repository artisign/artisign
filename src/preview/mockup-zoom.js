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
  wrapperEl.style.width = `${width * scale}px`;
  wrapperEl.style.height = `${height * scale}px`;
}
