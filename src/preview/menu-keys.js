// Keyboard helpers shared by the project menu, the variant popover, the project dialogs and the shortcut reference (CHR-920): arrow-key movement through a list of rows, a roving tab stop, and a Tab focus trap. Plain functions over DOM nodes, no state.

const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]';

/**
 * Whether an element is really on screen: in the document, not inside a [hidden] container, not hidden by CSS (jsdom has no checkVisibility, hence the optional call).
 *
 * @param {HTMLElement} el
 * @returns {boolean}
 */
export function isShown(el) {
  return el.isConnected && !el.closest("[hidden]") && el.checkVisibility?.() !== false;
}

/**
 * The elements inside `container` that Tab can reach, in DOM order: enabled, not hidden, not taken out of the tab order.
 *
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function tabbableWithin(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.disabled && el.tabIndex >= 0 && el.getAttribute("aria-hidden") !== "true" && isShown(el),
  );
}

/**
 * ArrowDown / ArrowUp move focus to the next / previous row, Home / End to the first / last. Enter and Space are left to the rows (they are buttons). Returns whether the key was handled (and default-prevented).
 *
 * @param {KeyboardEvent} evt
 * @param {HTMLElement[]} rows the actionable rows, in order
 * @param {{ wrap?: boolean }} [options] wrap past the ends (menus do, plain lists do not)
 * @returns {boolean}
 */
export function handleListArrowKeys(evt, rows, { wrap = true } = {}) {
  if (evt.defaultPrevented || evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey || rows.length === 0) return false;
  const current = rows.findIndex((row) => row === evt.target || row.contains(/** @type {Node} */ (evt.target)));
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
 * The keyboard wiring of an ARIA menu, in one place: arrow keys / Home / End move between the rows, the focused row is the single tab stop, and a keyboard Tab that takes focus out of the menu calls `onTabOut` with where focus went. Only a Tab counts, and it is checked once its focus move has happened (a task later): a pointer press or a programmatic focus move elsewhere is not a tab-out, and acting on those would rebuild the page under a click.
 *
 * @param {HTMLElement} container the menu element
 * @param {() => HTMLElement[]} getRows the rows (every control the arrows visit), read fresh on every key
 * @param {{ onTabOut?: (to: Element | null) => void }} [options]
 */
export function wireMenu(container, getRows, { onTabOut } = {}) {
  container.addEventListener("keydown", (evt) => {
    if (evt.key === "Tab") {
      setTimeout(() => {
        if (!container.contains(document.activeElement)) onTabOut?.(document.activeElement);
      }, 0);
    }
    handleListArrowKeys(evt, getRows());
  });
  container.addEventListener("focusin", (evt) => {
    const rows = getRows();
    const row = rows.find((r) => r === evt.target);
    if (row) setRovingTabindex(rows, row);
  });
}
