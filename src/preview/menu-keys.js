// Keyboard helpers shared by the project menu, the variant popover, the project dialogs and the shortcut reference (CHR-920): arrow-key movement through a list of rows, a roving tab stop, and a Tab focus trap. Plain functions over DOM nodes, no state.

const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]';

/**
 * The elements inside `container` that Tab can reach, in DOM order: enabled, not hidden, not taken out of the tab order.
 *
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function tabbableWithin(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(
    (el) =>
      !el.disabled &&
      el.tabIndex >= 0 &&
      !el.closest("[hidden]") &&
      el.getAttribute("aria-hidden") !== "true" &&
      // Hidden by CSS (display: none, visibility: hidden); jsdom has no checkVisibility, hence the optional call.
      el.checkVisibility?.() !== false,
  );
}

/**
 * ArrowDown / ArrowUp move focus to the next / previous row, Home / End to the first / last. Enter and Space are left to the rows (they are buttons). Returns whether the key was handled (and default-prevented).
 *
 * @param {KeyboardEvent} evt
 * @param {HTMLElement[]} rows the actionable rows, in order
 * @param {{ wrap?: boolean, rowOf?: (target: EventTarget | null) => Element | null | undefined }} [options] wrap past the ends (menus do, plain lists do not); `rowOf` maps a focused control that is not itself a row (a checkbox beside it) to its row, so the arrows move to the neighbour
 * @returns {boolean}
 */
export function handleListArrowKeys(evt, rows, { wrap = true, rowOf } = {}) {
  if (evt.defaultPrevented || evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey || rows.length === 0) return false;
  const anchor = /** @type {Node} */ (rowOf?.(evt.target) ?? evt.target);
  const current = rows.findIndex((row) => row === anchor || row.contains(anchor));
  let next;
  if (evt.key === "ArrowDown") next = current === -1 ? 0 : current + 1;
  else if (evt.key === "ArrowUp") next = current === -1 ? rows.length - 1 : current - 1;
  else if (evt.key === "Home") next = 0;
  else if (evt.key === "End") next = rows.length - 1;
  else return false;
  if (wrap) next = (next + rows.length) % rows.length;
  else next = Math.min(rows.length - 1, Math.max(0, next));
  evt.preventDefault();
  rows[next].focus();
  return true;
}

/**
 * Roving tab stop: only `active` is in the tab order, the other rows are reached with the arrow keys.
 *
 * @param {HTMLElement[]} rows
 * @param {HTMLElement | undefined} active
 */
export function setRovingTabindex(rows, active) {
  for (const row of rows) row.tabIndex = row === active ? 0 : -1;
}

/**
 * Keeps Tab / Shift+Tab inside `container`: past the last control it wraps to the first and the other way round; with focus outside, Tab enters at the first. Returns whether it took over the key.
 *
 * @param {KeyboardEvent} evt
 * @param {HTMLElement} container
 * @returns {boolean}
 */
export function trapFocus(evt, container) {
  if (evt.key !== "Tab" || evt.defaultPrevented || evt.ctrlKey || evt.metaKey || evt.altKey) return false;
  const items = tabbableWithin(container);
  if (items.length === 0) {
    evt.preventDefault();
    container.focus();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = container.contains(active);
  if (evt.shiftKey && (!inside || active === first || active === container)) {
    evt.preventDefault();
    last.focus();
    return true;
  }
  if (!evt.shiftKey && (!inside || active === last)) {
    evt.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Before a rebuild: remembers which keyed element inside `container` has focus (`[attr]` names its key). The returned function, called after the rebuild, puts focus on the element with the same key, else on `fallback()`; it does nothing when focus was not on a keyed element, and returns the element that has focus again (or undefined).
 *
 * @param {HTMLElement} container
 * @param {string} attr data attribute carrying the key, e.g. "data-key"
 * @param {() => HTMLElement | undefined} fallback
 * @returns {() => HTMLElement | undefined}
 */
export function captureFocus(container, attr, fallback) {
  const active = document.activeElement;
  const key = active instanceof Element && container.contains(active) ? active.closest(`[${attr}]`)?.getAttribute(attr) : null;
  return () => {
    if (key == null) return undefined;
    const target = /** @type {HTMLElement | undefined} */ ([...container.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === key)) ?? fallback();
    target?.focus();
    return target;
  };
}

/**
 * The keyboard wiring of an ARIA menu, in one place: arrow keys / Home / End move between the rows, the focused row is the single tab stop, and a keyboard Tab that leaves the menu calls `onTabOut`. Only a real Tab counts: a pointer press or a programmatic focus move elsewhere must not trigger it (those are the outside-click close's business, and acting on them would rebuild the page under the click).
 *
 * @param {HTMLElement} container the menu element
 * @param {() => HTMLElement[]} getRows the actionable rows, read fresh on every key
 * @param {{ rowOf?: (target: EventTarget | null) => Element | null | undefined, onTabOut?: (to: Node) => void }} [options]
 */
export function wireMenu(container, getRows, { rowOf, onTabOut } = {}) {
  // True from a Tab keydown until the end of that task: the focus move the key causes happens inside it.
  let tabbing = false;
  container.addEventListener("keydown", (evt) => {
    if (evt.key === "Tab") {
      tabbing = true;
      setTimeout(() => {
        tabbing = false;
      }, 0);
    }
    handleListArrowKeys(evt, getRows(), { rowOf });
  });
  container.addEventListener("focusin", (evt) => {
    const rows = getRows();
    const anchor = rowOf?.(evt.target) ?? evt.target;
    const row = rows.find((r) => r === anchor);
    if (row) setRovingTabindex(rows, row);
  });
  container.addEventListener("focusout", (evt) => {
    const to = /** @type {Node | null} */ (evt.relatedTarget);
    if (tabbing && to && !container.contains(to)) onTabOut?.(to);
  });
}
