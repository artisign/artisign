// The settings menu (CHR-926): app settings (theme, five per-browser toggles), MCP setup and About, behind the gear at the right end of the topbar. An ARIA menu like the zoom menu (CHR-920) over static markup in index.html; this module only wires it. The state itself lives in app.js — the menu reads it through `getTheme` / `toggles[id].get` and changes it through the same setters the existing controls use, so both always agree.

import { fetchAbout, fetchSetup } from "./api.js";
import { setRovingTabindex, wireMenu } from "./menu-keys.js";

/**
 * @param {{
 *   controlsEl: HTMLElement,
 *   triggerEl: HTMLElement,
 *   menuEl: HTMLElement,
 *   getTheme: () => string,
 *   setTheme: (pref: string) => void,
 *   toggles: Record<string, { get: () => boolean, set: (on: boolean) => void }>,
 *   onOpenMcp: () => void,
 *   onOpenWhatsNew: () => void,
 * }} options `toggles` is keyed by the `data-setting` of the rows; `onOpenMcp` runs after the menu closed and focus is back on the trigger
 * @returns {{ open: () => void, close: () => void, isOpen: () => boolean, sync: () => void }}
 */
export function createSettingsMenu({ controlsEl, triggerEl, menuEl, getTheme, setTheme, toggles, onOpenMcp, onOpenWhatsNew }) {
  const segButtons = /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll(".settings-seg-button")]);
  const toggleRows = /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll(".settings-toggle-row")]);
  const mcpItem = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-mcp"));
  const mcpSub = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-mcp-sub"));
  const aboutEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-about"));
  const versionEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-version"));
  const whatsNewItem = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-whats-new"));

  let aboutLoaded = false;
  let setupToken = 0;

  const isOpen = () => !menuEl.hidden;

  /** The theme control is one row for the arrow keys: the segment that has focus, else the checked one. */
  const segRow = () => segButtons.find((b) => b === document.activeElement) ?? segButtons.find((b) => b.getAttribute("aria-checked") === "true") ?? segButtons[0];
  // What's New sits in the About group, shown once the version is known.
  const rows = () => [segRow(), ...toggleRows, mcpItem, ...(aboutEl.hidden ? [] : [whatsNewItem])];

  function sync() {
    const theme = getTheme();
    for (const b of segButtons) b.setAttribute("aria-checked", String(b.dataset.themePref === theme));
    for (const row of toggleRows) row.setAttribute("aria-checked", String(toggles[row.dataset.setting ?? ""].get()));
  }

  async function loadAbout() {
    if (aboutLoaded) return;
    const about = await fetchAbout();
    if (!about) return;
    aboutLoaded = true;
    versionEl.textContent = `Artisign ${about.version}`;
    aboutEl.hidden = false;
  }

  /** "N of M connected" under Connect AI tools; left off while loading and when the status cannot be read. */
  async function loadSetupSummary() {
    const token = ++setupToken;
    mcpSub.hidden = true;
    const setup = await fetchSetup();
    if (!setup || token !== setupToken || !isOpen()) return;
    mcpSub.textContent = `${setup.clients.filter((c) => c.connected).length} of ${setup.clients.length} connected`;
    mcpSub.hidden = false;
  }

  function open() {
    menuEl.hidden = false;
    triggerEl.setAttribute("aria-expanded", "true");
    sync();
    const start = segRow();
    setRovingTabindex(rows(), start);
    for (const b of segButtons) if (b !== start) b.tabIndex = -1;
    start.focus();
    void loadAbout();
    void loadSetupSummary();
  }

  function close() {
    menuEl.hidden = true;
    triggerEl.setAttribute("aria-expanded", "false");
  }

  wireMenu(menuEl, rows, {
    onTabOut: () => {
      if (isOpen()) close();
    },
  });

  triggerEl.addEventListener("click", () => (isOpen() ? close() : open()));
  // Capture on pointerdown, like the zoom menu: other triggers stop click propagation.
  document.addEventListener(
    "pointerdown",
    (evt) => {
      if (isOpen() && !controlsEl.contains(/** @type {Node} */ (evt.target))) close();
    },
    true,
  );
  // Capture + stopImmediatePropagation: this Escape only closes the menu (inspect mode's Escape must not also fire).
  document.addEventListener(
    "keydown",
    (evt) => {
      if (evt.key === "Escape" && isOpen()) {
        evt.stopImmediatePropagation();
        close();
        triggerEl.focus();
      }
    },
    true,
  );

  // One tab stop for the theme control, wherever focus is inside it (wireMenu's focusin only sees the row it picked for the arrows); none left on it once focus moves to another row.
  menuEl.addEventListener("focusin", (evt) => {
    const onSegment = segButtons.includes(/** @type {HTMLElement} */ (evt.target));
    for (const b of segButtons) b.tabIndex = onSegment && b === evt.target ? 0 : -1;
  });

  // Theme segments: Left / Right move between the three (Up / Down leave the control), Enter / Space pick.
  for (const button of segButtons) {
    button.addEventListener("click", () => {
      setTheme(button.dataset.themePref ?? "system");
      sync();
    });
    button.addEventListener("keydown", (evt) => {
      if (evt.key !== "ArrowLeft" && evt.key !== "ArrowRight") return;
      const next = segButtons[segButtons.indexOf(button) + (evt.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      evt.preventDefault();
      next.focus();
    });
  }

  // A toggle never closes the menu.
  for (const row of toggleRows) {
    row.addEventListener("click", () => {
      const toggle = toggles[row.dataset.setting ?? ""];
      toggle.set(!toggle.get());
      sync();
    });
  }

  mcpItem.addEventListener("click", () => {
    close();
    triggerEl.focus();
    onOpenMcp();
  });

  whatsNewItem.addEventListener("click", () => {
    close();
    triggerEl.focus();
    onOpenWhatsNew();
  });

  return { open, close, isOpen, sync };
}
