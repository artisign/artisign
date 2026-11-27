// CHR-1268 — the right column's one floating panel (design `float-card` in the right column): Inspect, Notes, Comments or — while comparing — Compare's Differences. One at a time; opening one replaces the other. Until the Agent bar (CHR-1269) lands the panel takes the whole column. The grip drags it (position remembered per viewer), the cross closes it.
//
// Compare's Differences is the panel of a mode, not of a tool: while comparing and no tool panel is open it shows by itself (and has no cross — Compare's own Single | Compare switch leaves it); a tool panel opened meanwhile takes its place, and closing that brings the Differences back.

import { makeCardDraggable } from "./float-card.js";

/** @typedef {"inspect" | "notes" | "comments" | "compare"} PanelId */

/** The panels, by id: their title and the section that holds their body. */
const PANELS = /** @type {const} */ ({
  inspect: { title: "Inspect" },
  notes: { title: "Notes" },
  comments: { title: "Comments" },
  compare: { title: "Differences" },
});

/**
 * @param {{
 *   panelEl: HTMLElement,
 *   titleEl: HTMLElement,
 *   contextEl: HTMLElement,
 *   closeEl: HTMLButtonElement,
 *   gripEl: HTMLElement,
 *   liveEl: HTMLElement,
 *   sections: Record<PanelId, HTMLElement>,
 *   storage: Storage,
 *   onChange: (shown: PanelId | null, opened: Exclude<PanelId, "compare"> | null) => void,
 *   onClose: (id: Exclude<PanelId, "compare">, returnFocus: boolean) => void,
 * }} args `onChange` runs after every change of what shows (`opened` is the tool panel the user asked for, null for none or for Compare's own); `onClose` runs when the user closes a tool panel (cross or Escape) — before `onChange` — so the owner can leave the tool's mode.
 */
export function createToolPanels({ panelEl, titleEl, contextEl, closeEl, gripEl, liveEl, sections, storage, onChange, onClose }) {
  /** @type {Exclude<PanelId, "compare"> | null} the tool panel the user opened */
  let opened = null;
  let comparing = false;
  /** @type {PanelId | null} */
  let shown = null;

  makeCardDraggable({ cardEl: panelEl, gripEl, storage, key: "artisign.tool-panel.position", label: "Panel", liveEl });

  function effective() {
    return opened ?? (comparing ? "compare" : null);
  }

  function reconcile() {
    const next = effective();
    if (next === shown) return;
    shown = next;
    panelEl.hidden = next === null;
    for (const [id, section] of Object.entries(sections)) section.hidden = id !== next;
    if (next !== null) {
      titleEl.textContent = PANELS[next].title;
      contextEl.textContent = "";
    }
    // Compare's Differences has no cross: leaving Compare is its own switch.
    closeEl.hidden = next === "compare";
    onChange(shown, opened);
  }

  function close(returnFocus = true) {
    if (opened === null) return false;
    const id = opened;
    opened = null;
    onClose(id, returnFocus);
    reconcile();
    return true;
  }

  closeEl.addEventListener("click", () => close(true));

  return {
    /** @param {Exclude<PanelId, "compare">} id */
    open(id) {
      if (opened === id) return;
      const previous = opened;
      opened = id;
      // The panel that makes room tells its owner (Inspect leaves inspect mode); focus stays where the user is.
      if (previous !== null) onClose(previous, false);
      reconcile();
    },
    /** Closes the tool panel the user opened; false when there was none. */
    close,
    /** @param {Exclude<PanelId, "compare">} id */
    toggle(id) {
      if (opened === id) close(false);
      else this.open(id);
    },
    /** @param {boolean} on whether Compare is on (its Differences show while no tool panel is open) */
    setComparing(on) {
      if (comparing === on) return;
      comparing = on;
      reconcile();
    },
    /** What the title line's right-hand side says (the shown scope: "home, default"). @param {string} text */
    setContext(text) {
      contextEl.textContent = text;
    },
    /** The tool panel the user opened, or null. */
    opened: () => opened,
    /** What is showing, or null. */
    shown: () => shown,
    contains: (node) => panelEl.contains(node),
  };
}
