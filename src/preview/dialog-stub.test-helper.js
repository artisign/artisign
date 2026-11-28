// jsdom has no modal <dialog> and no Popover API: these stand-ins give the modules the surface a browser has, so the real code paths (showModal / close / the `close` event, showPopover / hidePopover / `toggle`) run in the tests. They model what the browser does around them as well: Escape is the `cancel` event and then a close, a click on the scrim is the browser's light dismiss where `closedby` is known.

/** Installs `showModal()` / `close()` on HTMLDialogElement (idempotent): open sets the `open` attribute, close removes it and fires `close`. */
export function installDialogStubs() {
  HTMLDialogElement.prototype.showModal = function showModal() {
    if (this.hasAttribute("open")) throw new DOMException("The dialog is already open.", "InvalidStateError");
    this.setAttribute("open", "");
    this.setAttribute("data-modal", "");
    // The browser focuses the dialog's `autofocus` control, else its first focusable one (the dialog itself when it asks for it).
    const target = this.matches("[autofocus]") ? this : (this.querySelector("[autofocus]") ?? this.querySelector("button, input, [tabindex]"));
    /** @type {HTMLElement | null} */ (target)?.focus();
  };
  HTMLDialogElement.prototype.close = function close() {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.removeAttribute("data-modal");
    this.dispatchEvent(new Event("close"));
  };
}

/**
 * Escape the way the browser handles it for a modal dialog: a cancelable `cancel` event, and the dialog closes unless something prevented it. The keydown goes out first (an Escape handler that prevents it keeps the browser from closing anything).
 *
 * @param {HTMLDialogElement} dialog
 * @returns {boolean} whether the dialog closed
 */
export function pressEscape(dialog) {
  const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  (document.activeElement ?? dialog).dispatchEvent(key);
  if (key.defaultPrevented) return false;
  const cancel = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  if (cancel.defaultPrevented) return false;
  dialog.close();
  return true;
}

/** A press and a release on the scrim: both outside the dialog's box. @param {HTMLDialogElement} dialog */
export function clickScrim(dialog) {
  for (const type of ["pointerdown", "pointerup"]) dialog.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: -10, clientY: -10 }));
  dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: -10, clientY: -10 }));
}

/**
 * Gives an element the Popover API's surface: `showPopover()` / `hidePopover()` toggle an open flag that `matches(":popover-open")` reads, and fire `toggle`. Like the browser, an `auto` popover closes when something else outside it is pressed (light dismiss) through `lightDismiss()`.
 *
 * @param {HTMLElement} el
 * @returns {{ isOpen: () => boolean, lightDismiss: () => void }}
 */
export function makeNativePopover(el) {
  const state = { open: false };
  el.showPopover = () => {
    if (state.open) throw new DOMException("already open", "InvalidStateError");
    state.open = true;
    el.dispatchEvent(new Event("toggle"));
  };
  el.hidePopover = () => {
    if (!state.open) throw new DOMException("not open", "InvalidStateError");
    state.open = false;
    el.dispatchEvent(new Event("toggle"));
  };
  const matches = el.matches.bind(el);
  el.matches = (selector) => (selector === ":popover-open" ? state.open : matches(selector));
  // The declared invoker: the browser toggles the popover on a click of an element whose `popovertarget` names it.
  document.addEventListener("click", (evt) => {
    if (!el.isConnected) return;
    const invoker = evt.target instanceof Element ? evt.target.closest("[popovertarget]") : null;
    if (!invoker || invoker.getAttribute("popovertarget") !== el.id) return;
    if (state.open) el.hidePopover();
    else el.showPopover();
  });
  return {
    isOpen: () => state.open,
    lightDismiss: () => {
      if (state.open) el.hidePopover();
    },
  };
}
