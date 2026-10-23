// Shared tooltip (CHR-910): one floating element for every `[data-tooltip]` trigger, shown on hover and keyboard focus. The trigger keeps its own accessible name (`aria-label`); the tooltip is `aria-hidden` so it never double-announces. `data-shortcut` fills the optional key slot (the shortcut ticket, CHR-916, supplies the values).

const GAP = 4;
const EDGE = 8;

/**
 * Centred below the trigger; flipped above when it would leave the viewport at the bottom, clamped horizontally. Pure so it can be unit-tested without layout.
 *
 * @param {{ left: number, right: number, top: number, bottom: number }} anchor
 * @param {{ width: number, height: number }} tip
 * @param {{ width: number, height: number }} viewport
 * @returns {{ left: number, top: number }}
 */
export function placeTooltip(anchor, tip, viewport) {
  const centre = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(EDGE, viewport.width - tip.width - EDGE);
  const left = Math.min(Math.max(centre - tip.width / 2, EDGE), maxLeft);
  const below = anchor.bottom + GAP;
  const top = below + tip.height + EDGE > viewport.height ? Math.max(EDGE, anchor.top - GAP - tip.height) : below;
  return { left, top };
}

let disposePrevious = null;

/**
 * Wires the shared tooltip to `doc`. Idempotent: a second call tears down the previous wiring first, so listeners never stack and there is only ever one #chrome-tooltip. Returns a disposer.
 *
 * @param {Document} doc
 * @returns {() => void}
 */
export function initTooltips(doc) {
  disposePrevious?.();
  const tip = doc.createElement("div");
  tip.id = "chrome-tooltip";
  tip.setAttribute("aria-hidden", "true");
  tip.hidden = true;
  const labelEl = doc.createElement("span");
  const keyEl = doc.createElement("span");
  keyEl.className = "chrome-tooltip-key";
  tip.append(labelEl, keyEl);
  doc.body.append(tip);

  /** @type {HTMLElement | null} */
  let current = null;
  // After Escape the trigger stays dismissed until the pointer leaves it or focus moves on.
  /** @type {Element | null} */
  let dismissed = null;

  function show(target) {
    current = target;
    labelEl.textContent = target.dataset.tooltip ?? "";
    const shortcut = target.dataset.shortcut ?? "";
    keyEl.textContent = shortcut;
    keyEl.hidden = shortcut === "";
    tip.hidden = false;
    const view = doc.defaultView;
    const pos = placeTooltip(
      target.getBoundingClientRect(),
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: view.innerWidth, height: view.innerHeight },
    );
    tip.style.left = `${pos.left}px`;
    tip.style.top = `${pos.top}px`;
  }

  function hide() {
    current = null;
    tip.hidden = true;
  }

  // The trigger was removed or hidden (view switch, panel collapse) while its tooltip was up.
  function hideIfStale() {
    if (current && (!current.isConnected || current.closest("[hidden]"))) hide();
  }

  const triggerOf = (event) => (event.target instanceof Element ? event.target.closest("[data-tooltip]") : null);

  const onOver = (event) => {
    hideIfStale();
    const target = triggerOf(event);
    if (target && target !== current && target !== dismissed) show(target);
  };
  const onOut = (event) => {
    const target = triggerOf(event);
    // Leaving to a child of the same trigger is not leaving.
    if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
    if (target === dismissed) dismissed = null;
    if (target === current) hide();
  };
  const onFocusIn = (event) => {
    const target = triggerOf(event);
    if (target !== dismissed) dismissed = null;
    if (target) show(target);
  };
  const onFocusOut = (event) => {
    // Only the current trigger losing focus hides; blur elsewhere must not close a hover-opened tooltip.
    const target = triggerOf(event);
    if (target && target === current) hide();
    if (target === dismissed) dismissed = null;
  };
  const onKeydown = (event) => {
    hideIfStale();
    if (event.key === "Escape" && current) {
      dismissed = current;
      hide();
    }
  };
  // A click can change the trigger's own tooltip text (e.g. the theme toggle) while it is still shown.
  const onClick = (event) => {
    const target = triggerOf(event);
    if (target && target === current) show(target);
  };

  doc.addEventListener("mouseover", onOver);
  doc.addEventListener("mouseout", onOut);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  doc.addEventListener("keydown", onKeydown);
  doc.addEventListener("click", onClick);
  // A scrolled or resized page moves the trigger out from under a fixed tooltip.
  doc.addEventListener("scroll", hide, true);
  doc.defaultView.addEventListener("resize", hide);

  const dispose = () => {
    doc.removeEventListener("mouseover", onOver);
    doc.removeEventListener("mouseout", onOut);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
    doc.removeEventListener("keydown", onKeydown);
    doc.removeEventListener("click", onClick);
    doc.removeEventListener("scroll", hide, true);
    doc.defaultView.removeEventListener("resize", hide);
    tip.remove();
    if (disposePrevious === dispose) disposePrevious = null;
  };
  disposePrevious = dispose;
  return dispose;
}
