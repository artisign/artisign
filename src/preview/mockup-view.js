// Mockup view: a horizontally scrolling column per variant, each rendered
// live in a sandboxed, measure-and-grow-to-fit iframe fetched via
// `fetchRenderFor` — see iframe-fit.js (shared with design-system.js's
// renderVariantCell).

import { createFittingIframe } from "./iframe-fit.js";

/**
 * @param {HTMLElement} container
 * @param {{ name: string, title?: string, description?: string, variants: { id: string, title: string, description?: string }[] }} mockup
 * @param {{
 *   fetchRenderFor: (variantId: string) => Promise<{ ok: true, html: string } | { ok: false, message: string }>,
 *   onColumnMeasured?: () => void,
 * }} deps `onColumnMeasured` fires once per column, each time its iframe's
 *   FINAL size (width and height, via createFittingIframe's `onFitted`) is
 *   known — the caller (app.js) uses it to re-apply mockup zoom as columns
 *   arrive asynchronously. Must not fire any earlier: at `load`,
 *   before iframe-fit.js's own rAF has set the real height, every column
 *   still reports its CSS-default placeholder height.
 */
export function renderMockupView(container, mockup, { fetchRenderFor, onColumnMeasured }) {
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "mockup-view-header";
  const title = document.createElement("h1");
  title.textContent = mockup.title ?? mockup.name;
  header.appendChild(title);
  if (mockup.description) {
    const description = document.createElement("p");
    description.className = "mockup-view-description";
    description.textContent = mockup.description;
    header.appendChild(description);
  }
  container.appendChild(header);

  if (mockup.variants.length === 0) {
    const empty = document.createElement("p");
    empty.className = "mockup-view-empty";
    empty.textContent = "No variants yet.";
    container.appendChild(empty);
    return;
  }

  // The wrap is the zoom target's parent — see applyMockupZoom (mockup-zoom.js),
  // which resizes it to the scaled box so #mockup-view's scrollbars follow
  // the current zoom instead of the row's un-scaled layout size.
  const columnsWrap = document.createElement("div");
  columnsWrap.className = "mockup-columns-wrap";
  const columns = document.createElement("div");
  columns.className = "mockup-columns";
  mockup.variants.forEach((variant, index) =>
    columns.appendChild(renderColumn(variant, index, fetchRenderFor, onColumnMeasured)),
  );
  columnsWrap.appendChild(columns);
  container.appendChild(columnsWrap);
}

/**
 * @param {{ id: string, title: string, description?: string }} variant
 * @param {number} index array position — array order is column order, per
 *   ADR-003 — rendered as the 1-based "Variant N" label.
 * @param {(variantId: string) => Promise<{ ok: true, html: string } | { ok: false, message: string }>} fetchRenderFor
 * @param {(() => void) | undefined} onColumnMeasured
 */
function renderColumn(variant, index, fetchRenderFor, onColumnMeasured) {
  const column = document.createElement("div");
  column.className = "mockup-column";

  const indexEl = document.createElement("div");
  indexEl.className = "mockup-column-index";
  indexEl.textContent = `Variant ${index + 1}`;
  column.appendChild(indexEl);

  const title = document.createElement("div");
  title.className = "mockup-column-title";
  title.textContent = variant.title;
  column.appendChild(title);

  if (variant.description) {
    const description = document.createElement("div");
    description.className = "mockup-column-description";
    description.textContent = variant.description;
    column.appendChild(description);
  }

  const errorEl = document.createElement("p");
  errorEl.className = "mockup-column-error";
  errorEl.hidden = true;
  column.appendChild(errorEl);

  // onFitted fires once BOTH dimensions are final (see iframe-fit.js) —
  // only then is columnsEl.scrollHeight in applyMockupZoom trustworthy.
  const iframe = createFittingIframe(() => onColumnMeasured?.());
  iframe.className = "mockup-column-frame";
  // createFittingIframe()'s own `load` listener (attached first, so it's
  // already run by the time this one fires) grows the IFRAME to the
  // rendered variant's natural width. Pin the COLUMN to that same width
  // (plus its own padding/border) so a long title/description can't
  // stretch the column past the variant it's describing — they
  // wrap inside it instead (see .mockup-column-title/-description's
  // overflow-wrap). .mockup-column's own min-width is the floor if the
  // variant itself renders narrower than that.
  iframe.addEventListener("load", () => {
    const frameWidth = parseFloat(iframe.style.width);
    if (!Number.isFinite(frameWidth)) return;
    const columnStyle = getComputedStyle(column);
    const extra =
      parseFloat(columnStyle.paddingLeft) +
      parseFloat(columnStyle.paddingRight) +
      parseFloat(columnStyle.borderLeftWidth) +
      parseFloat(columnStyle.borderRightWidth);
    column.style.width = `${Math.ceil(frameWidth + extra)}px`;
  });
  column.appendChild(iframe);

  fetchRenderFor(variant.id).then((result) => {
    if (result.ok) {
      iframe.srcdoc = result.html;
    } else {
      errorEl.textContent = result.message;
      errorEl.hidden = false;
    }
  });

  return column;
}
