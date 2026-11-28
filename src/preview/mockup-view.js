// Mockup view: a horizontally scrolling column per variant, each rendered
// live in a sandboxed, measure-and-grow-to-fit iframe fetched via
// `fetchRenderFor` — see iframe-fit.js (shared with design-system.js's
// renderVariantCell).

import { createFittingIframe } from "./iframe-fit.js";
import { setMarkdown } from "./markdown.js";

/**
 * @param {HTMLElement} container
 * @param {{ name: string, title?: string, description?: string, variants: { id: string, title: string, description?: string }[] }} mockup
 * @param {{
 *   fetchRenderFor: (variantId: string) => Promise<{ ok: true, html: string } | { ok: false, message: string }>,
 *   onColumnMeasured?: () => void,
 *   onFrameLoad?: (variantId: string, iframe: HTMLIFrameElement) => void,
 * }} deps `onColumnMeasured` fires once per column, each time its iframe's
 *   FINAL size (width and height, via createFittingIframe's `onFitted`) is
 *   known — the caller (app.js) uses it to re-apply mockup zoom as columns
 *   arrive asynchronously. Must not fire any earlier: at `load`,
 *   before iframe-fit.js's own rAF has set the real height, every column
 *   still reports its CSS-default placeholder height. `onFrameLoad` fires
 *   on every load of a column's iframe (the comment layer attaches to the
 *   fresh document there).
 * @returns {{ variantId: string, letter: string, iframe: HTMLIFrameElement, countsEl: HTMLElement, columnEl: HTMLElement }[]} the columns, in order
 */
export function renderMockupView(container, mockup, { fetchRenderFor, onColumnMeasured, onFrameLoad }) {
  container.innerHTML = "";

  const header = document.createElement("div");
  // Visually hidden: the design shows only the columns on the canvas — the open mockup is named by the card's selected row and each column's label.
  header.className = "mockup-view-header visually-hidden";
  const title = document.createElement("h1");
  title.textContent = mockup.title ?? mockup.name;
  header.appendChild(title);
  if (mockup.description) {
    const description = document.createElement("div");
    description.className = "mockup-view-description md";
    setMarkdown(description, mockup.description);
    header.appendChild(description);
  }
  container.appendChild(header);

  if (mockup.variants.length === 0) {
    const empty = document.createElement("p");
    empty.className = "mockup-view-empty";
    empty.textContent = "No variants yet.";
    container.appendChild(empty);
    return [];
  }

  // The wrap is the zoom target's parent — see applyMockupZoom (mockup-zoom.js),
  // which resizes it to the scaled box so #mockup-view's scrollbars follow
  // the current zoom instead of the row's un-scaled layout size.
  const columnsWrap = document.createElement("div");
  columnsWrap.className = "mockup-columns-wrap";
  const columns = document.createElement("div");
  columns.className = "mockup-columns";
  const rendered = mockup.variants.map((variant, index) => {
    const column = renderColumn(variant, index, mockup.title ?? mockup.name, fetchRenderFor, onColumnMeasured, onFrameLoad);
    columns.appendChild(column.el);
    return column.handle;
  });
  columnsWrap.appendChild(columns);
  container.appendChild(columnsWrap);
  return rendered;
}

/**
 * Marks one column as the selected variant (the teal ring around its frame, `aria-current` on its group); `null` marks none.
 * @param {{ variantId: string, columnEl: HTMLElement }[]} columns
 * @param {string | null} variantId
 */
export function markSelectedColumn(columns, variantId) {
  for (const column of columns) {
    const on = column.variantId === variantId;
    column.columnEl.classList.toggle("is-selected", on);
    if (on) column.columnEl.setAttribute("aria-current", "true");
    else column.columnEl.removeAttribute("aria-current");
  }
}

/** A column's letter: A, B, C … — the number once the alphabet runs out. @param {number} index */
export function variantLetter(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * The count chips in a column header: open, detached, and resolved (only
 * while Show resolved is on). Each is a button that opens the first thread of
 * its kind; the one holding the open thread is aria-expanded.
 * @param {HTMLElement} countsEl
 * @param {{ open: number, detached: number, resolved: number }} counts
 * @param {{ showResolved: boolean, activeKind: "open" | "detached" | "resolved" | null, onOpen: (kind: "open" | "detached" | "resolved") => void }} opts
 */
export function renderColumnChips(countsEl, counts, { showResolved, activeKind, onOpen }) {
  countsEl.replaceChildren();
  const specs = [
    ["open", counts.open, "chat_bubble", "open comment"],
    ["detached", counts.detached, "warning", "detached comment"],
    ...(showResolved ? [["resolved", counts.resolved, "check", "resolved comment"]] : []),
  ];
  for (const [kind, count, glyph, noun] of specs) {
    if (!count) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "comment-count-chip";
    chip.dataset.kind = kind;
    chip.setAttribute("aria-label", `${count} ${noun}${count === 1 ? "" : "s"}`);
    chip.setAttribute("aria-expanded", String(activeKind === kind));
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = glyph;
    chip.append(icon, String(count));
    chip.addEventListener("click", () => onOpen(/** @type {"open" | "detached" | "resolved"} */ (kind)));
    countsEl.appendChild(chip);
  }
}

/**
 * @param {{ id: string, title: string, description?: string }} variant
 * @param {number} index array position — array order is column order, per
 *   ADR-003 — rendered as the 1-based "Variant N" label.
 * @param {string} mockupTitle the column group's accessible name is "<mockup title>: <variant title>"
 * @param {(variantId: string) => Promise<{ ok: true, html: string } | { ok: false, message: string }>} fetchRenderFor
 * @param {(() => void) | undefined} onColumnMeasured
 * @param {((variantId: string, iframe: HTMLIFrameElement) => void) | undefined} onFrameLoad
 */
function renderColumn(variant, index, mockupTitle, fetchRenderFor, onColumnMeasured, onFrameLoad) {
  const column = document.createElement("div");
  column.className = "mockup-column";
  column.setAttribute("role", "group");
  column.setAttribute("aria-label", `${mockupTitle}: ${variant.title || variant.id}`);

  // The header is chrome text, kept at native size under the row's zoom (see applyMockupZoom / .mockup-column-head).
  const head = document.createElement("div");
  head.className = "mockup-column-head";
  column.appendChild(head);

  // The mockup-column-header: letter badge, title, count chips; the description below.
  const row = document.createElement("div");
  row.className = "mockup-column-row";
  head.appendChild(row);

  const letter = variantLetter(index);
  const indexEl = document.createElement("span");
  indexEl.className = "mockup-column-index variant-badge";
  indexEl.textContent = letter;
  indexEl.title = `Variant ${index + 1}`;
  row.appendChild(indexEl);

  const title = document.createElement("div");
  title.className = "mockup-column-title";
  title.textContent = variant.title;
  row.appendChild(title);

  const countsEl = document.createElement("div");
  countsEl.className = "mockup-column-counts";
  row.appendChild(countsEl);

  if (variant.description) {
    const description = document.createElement("div");
    description.className = "mockup-column-description md";
    setMarkdown(description, variant.description);
    description.title = variant.description;
    head.appendChild(description);
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
    // The column just changed width, which re-wraps its header: the fit pass that already ran (it fires first) measured the row at the old width.
    onColumnMeasured?.();
  });
  iframe.addEventListener("load", () => onFrameLoad?.(variant.id, iframe));
  column.appendChild(iframe);

  fetchRenderFor(variant.id).then((result) => {
    if (result.ok) {
      iframe.srcdoc = result.html;
    } else {
      errorEl.textContent = result.message;
      errorEl.hidden = false;
    }
  });

  return { el: column, handle: { variantId: variant.id, letter, iframe, countsEl, columnEl: column } };
}
