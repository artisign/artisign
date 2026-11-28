// CHR-1286 — the right column as a stack of docked cards: the Agent bar and the tool panel. A card is docked while it has no dragged position (no inline `left`); a dragged card is free and independent of the other.
//
// Both docked and both open: the column splits 40 % Agent bar / 60 % panel (CSS, keyed on `#app[data-stack="split"]`). The Agent bar folded: the panel starts below its head (`below`). Anything else (a free card, no panel, no Agent bar in this view): `none`, every card keeps its own place. This module only decides the mode; the geometry is CSS.

/** An expanded card is never shorter than this (its head plus about 120px of content). */
export const CARD_MIN_HEIGHT = 168;
/** The cards' bottom edge (CSS `bottom`). */
const BOTTOM_GAP = 18;

/** @typedef {"split" | "below" | "none"} StackMode */

/**
 * @param {{ agentDocked: boolean, agentShown: boolean, agentFolded: boolean, panelDocked: boolean, panelShown: boolean }} state
 * @returns {StackMode}
 */
export function stackMode({ agentDocked, agentShown, agentFolded, panelDocked, panelShown }) {
  if (!agentShown || !agentDocked || !panelShown || !panelDocked) return "none";
  return agentFolded ? "below" : "split";
}

/**
 * Keeps `#app[data-stack]` current and an expanded free Agent bar inside the window.
 * @param {{ appEl: HTMLElement, agentEl: HTMLElement, panelEl: HTMLElement }} args
 */
export function createRightColumn({ appEl, agentEl, panelEl }) {
  function sync() {
    const agentDocked = agentEl.style.left === "";
    const mode = stackMode({
      agentDocked,
      agentShown: appEl.dataset.shellView !== "design-system" && appEl.dataset.shellView !== "usecases",
      agentFolded: agentEl.dataset.collapsed === "true",
      panelDocked: panelEl.style.left === "",
      panelShown: !panelEl.hidden,
    });
    if (appEl.dataset.stack !== mode) appEl.dataset.stack = mode;
    // A free Agent bar that unfolds grows down to the window's bottom edge: its top keeps it at least CARD_MIN_HEIGHT tall.
    if (!agentDocked && agentEl.dataset.collapsed === "false") {
      const maxTop = window.innerHeight - BOTTOM_GAP - CARD_MIN_HEIGHT;
      const top = parseFloat(agentEl.style.top);
      if (Number.isFinite(top) && top > maxTop) agentEl.style.top = `${Math.max(0, maxTop)}px`;
    }
  }
  const observer = new MutationObserver(sync);
  observer.observe(agentEl, { attributes: true, attributeFilter: ["style", "data-collapsed"] });
  observer.observe(panelEl, { attributes: true, attributeFilter: ["style", "hidden"] });
  observer.observe(appEl, { attributes: true, attributeFilter: ["data-shell-view"] });
  window.addEventListener("resize", sync);
  sync();
  return { sync };
}
