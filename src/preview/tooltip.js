// Shared tooltip (CHR-910, CHR-1285): one floating element for every `[data-tooltip]` trigger — the only tooltip in the shell chrome, no native `title`. Timing follows the Radix / Figma model: it opens after the pointer rests on a trigger for OPEN_DELAY, opens at once when moving between triggers (while one shows, and for SKIP_DELAY after the last one closed), at once on `:focus-visible`, and closes immediately on pointer leave, click and Escape. While shown it is linked to its trigger with `aria-describedby`; the trigger keeps its own accessible name (`aria-label`). `data-shortcut` fills the optional key slot; `data-tooltip-side` ("end" | "top") keeps the tooltip off the trigger's neighbours (tool bar).

const GAP = 4;
const SIDE_GAP = 8;
const EDGE = 8;
export const OPEN_DELAY = 400;
export const SKIP_DELAY = 300;

/**
 * Centred below the trigger by default; flipped above when it would leave the viewport at the bottom, clamped horizontally. `side` "top" prefers above, "end" puts it right of the trigger (flipped to the left at the viewport edge), vertically centred. Pure so it can be unit-tested without layout.
 *
 * @param {{ left: number, right: number, top: number, bottom: number }} anchor
 * @param {{ width: number, height: number }} tip
 * @param {{ width: number, height: number }} viewport
 * @param {"bottom" | "top" | "end"} [side]
 * @returns {{ left: number, top: number }}
 */
export function placeTooltip(anchor, tip, viewport, side = "bottom") {
  if (side === "end") {
    const maxTop = Math.max(EDGE, viewport.height - tip.height - EDGE);
    const top = Math.min(Math.max((anchor.top + anchor.bottom) / 2 - tip.height / 2, EDGE), maxTop);
    const right = anchor.right + SIDE_GAP;
    const left = right + tip.width + EDGE > viewport.width ? Math.max(EDGE, anchor.left - SIDE_GAP - tip.width) : right;
    return { left, top };
  }
  const centre = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(EDGE, viewport.width - tip.width - EDGE);
  const left = Math.min(Math.max(centre - tip.width / 2, EDGE), maxLeft);
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - tip.height;
  if (side === "top") return { left, top: above >= EDGE ? above : below };
  const top = below + tip.height + EDGE > viewport.height ? Math.max(EDGE, above) : below;
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
  tip.setAttribute("role", "tooltip");
  // A manual popover lives in the top layer, so it also shows above open modal dialogs.
  tip.setAttribute("popover", "manual");
  tip.hidden = true;
  const labelEl = doc.createElement("span");
  const keyEl = doc.createElement("span");
  keyEl.className = "chrome-tooltip-key";
  keyEl.setAttribute("aria-hidden", "true"); // the description reads "Comment", not "Comment C"
  tip.append(labelEl, keyEl);
  doc.body.append(tip);

  /** @type {HTMLElement | null} */
  let current = null;
  // The trigger whose open delay is running.
  /** @type {HTMLElement | null} */
  let pending = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  // Until this time moving to another trigger shows its tooltip at once.
  let skipUntil = 0;
  // After Escape or a click the trigger stays dismissed until the pointer leaves it or focus moves on.
  /** @type {Element | null} */
  let dismissed = null;
  // The trigger's own aria-describedby while the tooltip is linked into it.
  /** @type {string | null} */
  let describedBefore = null;
  let inTopLayer = false;
  // Fallback for :focus-visible where the engine does not know it: the last input was the keyboard.
  let keyboard = false;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  }

  function unlink() {
    if (!current) return;
    if (describedBefore === null) current.removeAttribute("aria-describedby");
    else current.setAttribute("aria-describedby", describedBefore);
  }

  function show(target) {
    clearTimer();
    const switching = current !== target;
    if (current && current !== target) unlink();
    if (current !== target) {
      describedBefore = target.getAttribute("aria-describedby");
      target.setAttribute("aria-describedby", describedBefore ? `${describedBefore} ${tip.id}` : tip.id);
    }
    current = target;
    labelEl.textContent = target.dataset.tooltip ?? "";
    const shortcut = target.dataset.shortcut ?? "";
    keyEl.textContent = shortcut;
    keyEl.hidden = shortcut === "";
    tip.hidden = false;
    if (tip.showPopover) {
      // Re-shown when it switches trigger: the top layer is ordered by when an element entered it, so a modal opened in between would cover the tooltip.
      if (inTopLayer && switching) tip.hidePopover();
      if (!inTopLayer || switching) tip.showPopover();
      inTopLayer = true;
    }
    // Measured at the origin: a position left over from the previous tooltip (clamped at the right edge) would squeeze the new one.
    tip.style.left = "0px";
    tip.style.top = "0px";
    const view = doc.defaultView;
    const side = target.closest("[data-tooltip-side]")?.getAttribute("data-tooltip-side");
    const pos = placeTooltip(
      target.getBoundingClientRect(),
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: view.innerWidth, height: view.innerHeight },
      side === "end" || side === "top" ? side : "bottom",
    );
    tip.style.left = `${pos.left}px`;
    tip.style.top = `${pos.top}px`;
  }

  function hide() {
    clearTimer();
    if (!current) return;
    unlink();
    current = null;
    skipUntil = Date.now() + SKIP_DELAY;
    tip.hidden = true;
    if (inTopLayer) {
      tip.hidePopover();
      inTopLayer = false;
    }
  }

  /** Shows `target` at once when a tooltip is up or just closed (or `immediate`), else after the open delay. */
  function open(target, immediate = false) {
    if (target === current || target === pending) return;
    clearTimer();
    if (immediate || current || Date.now() < skipUntil) {
      show(target);
      return;
    }
    pending = target;
    timer = setTimeout(() => {
      timer = null;
      pending = null;
      if (target.isConnected && !target.closest("[hidden]")) show(target);
    }, OPEN_DELAY);
  }

  // The trigger was removed or hidden (view switch, panel collapse) while its tooltip was up.
  function hideIfStale() {
    if (current && (!current.isConnected || current.closest("[hidden]"))) hide();
  }

  // An empty `data-tooltip` (a title that is cleared again) is no trigger.
  const TRIGGER = '[data-tooltip]:not([data-tooltip=""])';
  const triggerOf = (event) => (event.target instanceof Element ? event.target.closest(TRIGGER) : null);

  const focusVisible = (target) => {
    try {
      return target.matches(":focus-visible");
    } catch {
      return keyboard;
    }
  };

  const onOver = (event) => {
    hideIfStale();
    const target = triggerOf(event);
    if (!target) return;
    if (target !== dismissed) open(target);
  };
  const onOut = (event) => {
    const target = triggerOf(event);
    // Leaving to a child of the same trigger is not leaving.
    if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
    if (target === dismissed) dismissed = null;
    if (target === current) hide();
    else if (target === pending) clearTimer();
  };
  const onFocusIn = (event) => {
    const target = triggerOf(event);
    if (target !== dismissed) dismissed = null;
    if (target && target !== dismissed && focusVisible(target)) open(target, true);
  };
  const onFocusOut = (event) => {
    // Only the current trigger losing focus hides; blur elsewhere must not close a hover-opened tooltip.
    const target = triggerOf(event);
    if (target && target === current) hide();
    if (target === dismissed) dismissed = null;
  };
  const onKeydown = (event) => {
    keyboard = true;
    hideIfStale();
    if (event.key === "Escape" && (current || pending)) {
      dismissed = current ?? pending;
      hide();
      // Not consumed on purpose: a clicked toggle keeps focus, and "click Flow, press Esc" must still leave the mode in one Escape.
    }
  };
  const onPointerDown = () => {
    keyboard = false;
  };
  // A click closes the tooltip; it stays closed until the pointer leaves the trigger.
  const onClick = (event) => {
    const target = triggerOf(event);
    if (!target) return;
    dismissed = target;
    if (target === current || target === pending) hide();
  };

  // Disabled controls get no (or unreliable, browser-dependent) mouse events, so a disabled trigger — whose reason is the whole point of its tooltip — is hit-tested by position instead.
  const onMove = (event) => {
    hideIfStale();
    if (triggerOf(event)) return;
    // Occlusion-aware: whatever is topmost under the pointer, not a rect scan.
    const hit = doc.elementFromPoint?.(event.clientX, event.clientY)?.closest(TRIGGER);
    if (hit?.disabled && hit !== current && hit !== dismissed) open(hit);
    else if (!hit?.disabled && (current?.disabled || pending?.disabled)) {
      dismissed = null;
      hide();
    }
  };

  doc.addEventListener("mouseover", onOver);
  doc.addEventListener("mousemove", onMove);
  doc.addEventListener("mouseout", onOut);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  doc.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("click", onClick);
  // A scrolled or resized page moves the trigger out from under a fixed tooltip.
  doc.addEventListener("scroll", hide, true);
  doc.defaultView.addEventListener("resize", hide);

  const dispose = () => {
    hide();
    doc.removeEventListener("mouseover", onOver);
    doc.removeEventListener("mousemove", onMove);
    doc.removeEventListener("mouseout", onOut);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
    doc.removeEventListener("keydown", onKeydown, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("click", onClick);
    doc.removeEventListener("scroll", hide, true);
    doc.defaultView.removeEventListener("resize", hide);
    tip.remove();
    if (disposePrevious === dispose) disposePrevious = null;
  };
  disposePrevious = dispose;
  return dispose;
}
