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
 * Marks every flow-source element in the iframe document and wires clicks
 * to `onNavigate` when flow mode is on. Called after every iframe load
 * (fresh document each time) and on every flow-mode toggle.
 *
 * @param {Document} doc
 * @param {boolean} enabled
 * @param {(targetScreen: string) => void} onNavigate
 * @returns {() => void} cleanup, removes listeners and outlines
 */
export function applyFlowMode(doc, enabled, onNavigate) {
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

  return () => {
    doc.removeEventListener("click", handleClick, true);
    elements.forEach((el, i) => {
      const original = originalStyles[i];
      if (original === null) el.removeAttribute("style");
      else el.setAttribute("style", original);
    });
  };
}
