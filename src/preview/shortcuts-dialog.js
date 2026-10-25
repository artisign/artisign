// The keyboard shortcut reference (CHR-916, screen `chrome-c-shell-shortcuts`): three columns of grouped rows, label left, key chip right. Built from the same SHORTCUTS mapping the keys are bound from. Escape, a click on the scrim, the close button and "?" close it.

import { SHORTCUTS, formatShortcut } from "./shortcuts.js";
import { trapFocus } from "./menu-keys.js";

/** Group order per column, as drawn. */
const COLUMNS = [["Modes", "Views"], ["Zoom", "Board"], ["Panels", "Project", "General"]];

/** Same keys as the Screens zoom presets; the Board applies them as Fit all / 100%, so the reference lists each key once. */
const SHARED_WITH_ZOOM = new Set(["board-fit-all", "board-100"]);

/**
 * @param {{ scrimEl: HTMLElement, columnsEl: HTMLElement, closeEl: HTMLElement, mac: boolean }} els
 * @returns {{ show: () => void, hide: () => void, isOpen: () => boolean }}
 */
export function createShortcutsDialog({ scrimEl, columnsEl, closeEl, mac }) {
  const dialogEl = /** @type {HTMLElement} */ (scrimEl.querySelector("#shortcuts-dialog"));
  /** @type {Element | null} */
  let returnFocusTo = null;

  for (const groups of COLUMNS) {
    const column = document.createElement("div");
    column.className = "shortcuts-column";
    for (const group of groups) {
      const section = document.createElement("div");
      section.className = "shortcuts-group";
      const title = document.createElement("div");
      title.className = "shortcuts-group-title";
      title.textContent = group;
      section.appendChild(title);
      for (const def of SHORTCUTS.filter((d) => d.group === group && !SHARED_WITH_ZOOM.has(d.id))) {
        const row = document.createElement("div");
        row.className = "shortcuts-row";
        const label = document.createElement("span");
        label.textContent = def.label;
        const key = document.createElement("span");
        key.className = "chrome-chip chrome-chip--ref";
        key.textContent = formatShortcut(def, mac);
        row.append(label, key);
        section.appendChild(row);
      }
      column.appendChild(section);
    }
    columnsEl.appendChild(column);
  }

  function isOpen() {
    return !scrimEl.hidden;
  }

  function show() {
    if (isOpen()) return;
    returnFocusTo = document.activeElement;
    scrimEl.hidden = false;
    // Focus the dialog itself, not its close button: that would pop the button's tooltip. Tab is trapped inside (below).
    dialogEl.focus();
  }

  function hide() {
    if (!isOpen()) return;
    scrimEl.hidden = true;
    if (returnFocusTo instanceof HTMLElement) returnFocusTo.focus();
    returnFocusTo = null;
  }

  closeEl.addEventListener("click", hide);
  // On the document, not the scrim: with focus on <body> Tab must still enter the dialog.
  document.addEventListener("keydown", (evt) => {
    if (isOpen()) trapFocus(evt, dialogEl);
  });
  scrimEl.addEventListener("click", (evt) => {
    if (evt.target === scrimEl) hide();
  });
  document.addEventListener("keydown", (evt) => {
    if (!isOpen()) return;
    if (evt.key === "Escape" || (evt.key === "?" && !evt.ctrlKey && !evt.metaKey && !evt.altKey)) {
      evt.preventDefault();
      // This key only closes the dialog: the global shortcut handler (registered later) must not see it as "open the list" again.
      evt.stopImmediatePropagation();
      hide();
    }
  });

  return { show, hide, isOpen };
}
