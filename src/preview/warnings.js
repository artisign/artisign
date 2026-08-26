// Render diagnostics: the render document baseline (see
// src/model/render-document.ts) already outlines marker elements inside the
// iframe in red — this module just makes that visible in the shell too, via
// a topbar badge, and lets a click cycle through the flagged elements so
// they're easy to find even when scrolled out of view or covered by other
// content. Nothing here reads/writes anything outside the iframe's already
// rendered DOM — no second render engine, per render determinism.

const DIAGNOSTIC_SELECTOR =
  "[data-unresolved-component],[data-invalid-component],[data-recursive-component],[data-empty-component],[data-unresolved-token],[data-unresolved-icon-font]";

const CYCLE_HIGHLIGHT_STYLE = "outline: 3px solid #e5484d; outline-offset: 2px;";
const CYCLE_HIGHLIGHT_DURATION_MS = 1200;

/**
 * All diagnostic-marker elements in the given iframe document, in document order.
 * @param {Document} doc
 * @returns {Element[]}
 */
export function findDiagnostics(doc) {
  return Array.from(doc.querySelectorAll(DIAGNOSTIC_SELECTOR));
}

/**
 * The index to cycle to next, wrapping around. Pure so the cycling math is
 * unit-testable without a DOM.
 * @param {number} current
 * @param {number} total
 * @returns {number}
 */
export function nextIndex(current, total) {
  if (total <= 0) return -1;
  return (current + 1) % total;
}

/**
 * Briefly re-highlights an already-outlined diagnostic element and scrolls
 * it into view, so repeated clicks visibly step through the flagged
 * elements one at a time.
 * @param {Element} el
 */
function flash(el) {
  el.scrollIntoView({ block: "center" });
  const original = el.getAttribute("style");
  el.setAttribute("style", original ? `${original}; ${CYCLE_HIGHLIGHT_STYLE}` : CYCLE_HIGHLIGHT_STYLE);
  setTimeout(() => {
    if (original === null) el.removeAttribute("style");
    else el.setAttribute("style", original);
  }, CYCLE_HIGHLIGHT_DURATION_MS);
}

/**
 * Updates the warning badge for the current iframe document and wires
 * clicking it to cycle through the flagged elements. Called after every
 * iframe load (fresh document each time), same as flow/comment mode.
 *
 * @param {HTMLElement} badgeEl
 * @param {Document | null} doc
 * @returns {{ count: number, cleanup: () => void }} the diagnostic count (so
 *   callers can factor it into other visibility decisions, e.g. hiding the
 *   badge outside the screens view even when count > 0) and a cleanup that
 *   removes the click listener
 */
export function updateWarningBadge(badgeEl, doc) {
  const elements = doc ? findDiagnostics(doc) : [];
  badgeEl.textContent = `⚠ ${elements.length}`;
  badgeEl.hidden = elements.length === 0;

  let current = -1;
  function handleClick() {
    if (elements.length === 0) return;
    current = nextIndex(current, elements.length);
    flash(elements[current]);
  }
  badgeEl.addEventListener("click", handleClick);

  return { count: elements.length, cleanup: () => badgeEl.removeEventListener("click", handleClick) };
}
