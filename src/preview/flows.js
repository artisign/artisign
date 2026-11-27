// Flow mode: `data-flow-target`/`data-flow-trigger` on the rendered HTML are
// the flow edge itself (per render.ts, these survive rendering unchanged so
// the preview never needs a second source of truth for them). A target
// value containing "." is a node ref ("screen.nodeId"); we only support
// screen-level navigation in v1, so we jump to its screen part.

const FLOW_OUTLINE_STYLE = "outline: 2px solid #2a3edb; outline-offset: 1px; cursor: pointer;";

/** @param {string} flowTarget @returns {string} the screen id to navigate to */
function targetScreen(flowTarget) {
  const dot = flowTarget.indexOf(".");
  return dot === -1 ? flowTarget : flowTarget.slice(0, dot);
}

/**
 * Places the flow hover overlay (design `flow-hint`, hover state) over `el`: the outline with a tint, and the chip naming the target screen under its bottom-right corner. The overlay sits in the zoomed #screen-holder, in the iframe's own (unscaled) coordinates, so the chip counter-scales to a constant on-screen size (style.css).
 * @param {HTMLElement} overlayEl
 * @param {Element | null} el the hovered flow-source element, null to hide the overlay
 * @param {string} target the screen it leads to
 */
export function updateFlowOverlay(overlayEl, el, target) {
  if (!el) {
    overlayEl.hidden = true;
    return;
  }
  const rect = el.getBoundingClientRect();
  overlayEl.style.left = `${Math.round(rect.left)}px`;
  overlayEl.style.top = `${Math.round(rect.top)}px`;
  overlayEl.style.width = `${Math.round(rect.width)}px`;
  overlayEl.style.height = `${Math.round(rect.height)}px`;
  const targetEl = overlayEl.querySelector("#flow-overlay-target");
  if (targetEl) targetEl.textContent = target;
  overlayEl.hidden = false;
}

/**
 * Marks every flow-source element in the iframe document and wires clicks
 * to `onNavigate` when flow mode is on. Called after every iframe load
 * (fresh document each time) and on every flow-mode toggle.
 *
 * @param {Document} doc
 * @param {boolean} enabled
 * @param {(targetScreen: string) => void} onNavigate
 * @param {{ onHover?: (el: Element | null, targetScreen: string) => void }} [opts] `onHover` follows the pointer: the flow-source element under it and where it leads, or null when the pointer leaves it
 * @returns {() => void} cleanup, removes listeners and outlines
 */
export function applyFlowMode(doc, enabled, onNavigate, { onHover } = {}) {
  const elements = Array.from(doc.querySelectorAll("[data-flow-target]"));
  if (!enabled) return () => {};

  /** @param {Event} evt */
  function handleClick(evt) {
    const el = /** @type {HTMLElement} */ (evt.target).closest("[data-flow-target]");
    if (!el) return;
    const trigger = el.getAttribute("data-flow-trigger") ?? "tap";
    if (trigger !== "tap") return;
    evt.preventDefault();
    onNavigate(targetScreen(el.getAttribute("data-flow-target")));
  }

  // Capture each element's original style text so cleanup can restore it
  // exactly, instead of string-replacing the outline back out (which left
  // a stray "; " behind on every toggle).
  const originalStyles = elements.map((el) => el.getAttribute("style"));
  for (const el of elements) {
    const original = el.getAttribute("style");
    el.setAttribute("style", original ? `${original}; ${FLOW_OUTLINE_STYLE}` : FLOW_OUTLINE_STYLE);
  }
  doc.addEventListener("click", handleClick, true);

  /** The tap-triggered flow source an event's target sits in, if any (the click only follows those). */
  const sourceOf = (evt) => {
    const el = /** @type {HTMLElement} */ (evt.target)?.closest?.("[data-flow-target]") ?? null;
    return el && (el.getAttribute("data-flow-trigger") ?? "tap") === "tap" ? el : null;
  };
  const handleOver = (evt) => {
    const el = sourceOf(evt);
    if (el) onHover?.(el, targetScreen(el.getAttribute("data-flow-target")));
  };
  const handleOut = (evt) => {
    const el = sourceOf(evt);
    // Moving into a child of the same element is not leaving it.
    if (el && !(evt.relatedTarget instanceof Node && el.contains(evt.relatedTarget))) onHover?.(null, "");
  };
  if (onHover) {
    doc.addEventListener("pointerover", handleOver, true);
    doc.addEventListener("pointerout", handleOut, true);
  }

  return () => {
    doc.removeEventListener("click", handleClick, true);
    doc.removeEventListener("pointerover", handleOver, true);
    doc.removeEventListener("pointerout", handleOut, true);
    onHover?.(null, "");
    elements.forEach((el, i) => {
      const original = originalStyles[i];
      if (original === null) el.removeAttribute("style");
      else el.setAttribute("style", original);
    });
  };
}
