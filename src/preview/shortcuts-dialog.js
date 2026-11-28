// The keyboard shortcut reference (CHR-916, screen `chrome-c-shell-shortcuts`, CHR-1272): a native modal <dialog> with the groups in a three-column grid, label left, `kbd` keys right. Built from the same SHORTCUTS mapping the keys are bound from. Escape, a click on the scrim, the close button and "?" close it.

import { SHORTCUTS } from "./shortcuts.js";
import { createModal } from "./float-dialog.js";

/** Group order as drawn: three columns, read row by row. */
const GROUPS = ["Tools", "Zoom", "Views", "Agent", "Board", "Fold cards", "Project", "General"];

/** Two mapping entries the design shows as one row. */
const MERGED = { "zoom-in": { label: "Zoom in, out", also: "zoom-out" } };

/** @param {import("./shortcuts.js").ShortcutDef} def @param {boolean} mac @returns {string[]} one string per key cap: "⇧" / "Shift" and the key */
function keyCaps(def, mac) {
  return def.shift ? [mac ? "⇧" : "Shift", def.display] : [def.display];
}

/**
 * @param {{ dialogEl: HTMLDialogElement, gridEl: HTMLElement, closeEl: HTMLElement, mac: boolean, fallbackFocusEl?: HTMLElement }} els `fallbackFocusEl`: where focus goes on close when the opener is gone or hidden
 * @returns {{ show: () => void, hide: () => void, isOpen: () => boolean }}
 */
export function createShortcutsDialog({ dialogEl, gridEl, closeEl, mac, fallbackFocusEl }) {
  const modal = createModal(dialogEl, { fallbackFocusEl });
  const skipped = new Set(Object.values(MERGED).map((m) => m.also));

  for (const group of GROUPS) {
    const defs = SHORTCUTS.filter((d) => d.group === group && !skipped.has(d.id));
    if (defs.length === 0) continue;
    const section = document.createElement("section");
    section.className = "shortcuts-group";
    const title = document.createElement("h3");
    title.className = "shortcuts-group-title";
    title.textContent = group;
    const list = document.createElement("dl");
    list.className = "shortcuts-list";
    for (const def of defs) {
      const merged = MERGED[def.id];
      const caps = merged ? [...keyCaps(def, mac), ...keyCaps(SHORTCUTS.find((d) => d.id === merged.also) ?? def, mac)] : keyCaps(def, mac);
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const label = document.createElement("dt");
      label.textContent = merged?.label ?? def.label;
      const keys = document.createElement("dd");
      keys.className = "shortcut-keys";
      for (const cap of caps) {
        const kbd = document.createElement("kbd");
        kbd.className = "kbd-key";
        kbd.textContent = cap;
        keys.append(kbd);
      }
      row.append(label, keys);
      list.append(row);
    }
    section.append(title, list);
    gridEl.append(section);
  }

  closeEl.addEventListener("click", () => modal.hide());
  // "?" closes the dialog it opened. The key is consumed here: the global shortcut handler (registered later) must not read it as "open the list" again. On the document, not the dialog: focus can be on <body> after a click on the dialog's plain surface.
  document.addEventListener("keydown", (evt) => {
    if (!modal.isOpen() || evt.key !== "?" || evt.ctrlKey || evt.metaKey || evt.altKey) return;
    evt.preventDefault();
    evt.stopImmediatePropagation();
    modal.hide();
  });

  return {
    show() {
      // Focus goes to the dialog itself, not to its close button (the first focusable one, where the browser would put it).
      if (modal.show()) dialogEl.focus();
    },
    hide: modal.hide,
    isOpen: modal.isOpen,
  };
}
