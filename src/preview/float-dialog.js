// The floating modal dialogs (CHR-1272, design pattern `float-dialog`): a native <dialog> opened with `showModal()`, so the browser makes the page behind it inert, traps Tab, closes on Escape (`cancel`) and, with `closedby="any"`, on a click on the scrim (light dismiss). This module adds what the browser does not: focus goes back to the control that opened the dialog (or a fallback when that one is gone or hidden), and a click on the scrim still closes it where the browser has no `closedby` yet.

import { isShown } from "./menu-keys.js";

/**
 * @param {HTMLDialogElement} dialogEl
 * @param {{ fallbackFocusEl?: HTMLElement, onClosed?: () => void }} [options] `fallbackFocusEl`: where focus goes on close when the opener is gone or hidden; `onClosed` runs after every way of closing (button, Escape, scrim), once focus has moved back
 * @returns {{ show: () => boolean, hide: () => void, isOpen: () => boolean }} `show` answers whether it opened (false: it was open already)
 */
export function createModal(dialogEl, { fallbackFocusEl, onClosed } = {}) {
  /** @type {Element | null} */
  let returnFocusTo = null;

  const isOpen = () => dialogEl.open;

  function show() {
    if (isOpen()) return false;
    const active = document.activeElement;
    returnFocusTo = active && active !== document.body ? active : null;
    dialogEl.showModal();
    return true;
  }

  function hide() {
    if (isOpen()) dialogEl.close();
  }

  // Every way out ends in `close`: Escape (the browser's `cancel`), the buttons, the scrim.
  dialogEl.addEventListener("close", () => {
    const target = returnFocusTo instanceof HTMLElement && isShown(returnFocusTo) ? returnFocusTo : fallbackFocusEl;
    returnFocusTo = null;
    target?.focus();
    onClosed?.();
  });

  // Where `closedby` is known the browser light-dismisses by itself; elsewhere a press and a release both outside the dialog's box (on the scrim) close it. The pointer position is tested, not the event target: the <dialog> is also the target for its own padding and the gaps between its children, and a text-selection drag that ends on the scrim must not dismiss.
  if (!("closedBy" in dialogEl)) {
    const outside = (/** @type {PointerEvent} */ evt) => {
      const box = dialogEl.getBoundingClientRect();
      return evt.clientX < box.left || evt.clientX > box.right || evt.clientY < box.top || evt.clientY > box.bottom;
    };
    let pressedOutside = false;
    dialogEl.addEventListener("pointerdown", (evt) => {
      pressedOutside = outside(evt);
    });
    dialogEl.addEventListener("pointerup", (evt) => {
      if (pressedOutside && outside(evt)) hide();
      pressedOutside = false;
    });
  }

  return { show, hide, isOpen };
}
