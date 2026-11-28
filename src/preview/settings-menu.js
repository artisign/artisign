// The settings menu (CHR-926): app settings (theme, four per-browser toggles), MCP setup and About, behind the gear at the right end of the topbar. CHR-1272: a floating popover (design `float-popover`), native `popover="auto"` where the browser has the API (top layer, light dismiss, Escape, focus back to the trigger) and a plain toggled box with the same outside-click and Escape behaviour where it does not — like the zoom pill's. An ARIA menu (CHR-920) over static markup in index.html; this module only wires it. The state itself lives in app.js — the menu reads it through `getTheme` / `toggles[id].get` and changes it through the same setters the existing controls use, so both always agree.

import { fetchSetup } from "./api.js";
import { createCodeField } from "./clipboard.js";
import { setRovingTabindex, wireMenu } from "./menu-keys.js";

/**
 * @param {{
 *   controlsEl: HTMLElement,
 *   triggerEl: HTMLButtonElement,
 *   menuEl: HTMLElement,
 *   getTheme: () => string,
 *   setTheme: (pref: string) => void,
 *   toggles: Record<string, { get: () => boolean, set: (on: boolean) => void }>,
 *   onOpenMcp: () => void,
 *   onOpen?: () => void,
 *   onOpenWhatsNew: () => void,
 * }} options `toggles` is keyed by the `data-setting` of the rows; `onOpenMcp` runs after the menu closed and focus is back on the trigger; `onOpen` runs on every open (app.js re-reads /api/about there and calls `renderAbout`)
 * @returns {{ open: () => void, close: () => void, isOpen: () => boolean, sync: () => void, renderAbout: (about: { version: string, updateCheck: "on" | "off", latest?: string, updateAvailable: boolean } | null) => void }}
 */
export function createSettingsMenu({ controlsEl, triggerEl, menuEl, getTheme, setTheme, toggles, onOpenMcp, onOpen, onOpenWhatsNew }) {
  const segButtons = /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll(".settings-seg-button")]);
  const toggleRows = /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll(".settings-toggle-row")]);
  const mcpItem = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-mcp"));
  const mcpSub = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-mcp-sub"));
  const aboutEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-about"));
  const versionEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-version"));
  const updateStatusEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-update-status"));
  const updateIconEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-update-icon"));
  const updateTextEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-update-text"));
  const updateCmdEl = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-update-cmd"));
  const whatsNewItem = /** @type {HTMLElement} */ (menuEl.querySelector("#settings-whats-new"));

  let setupToken = 0;

  const native = typeof menuEl.showPopover === "function";
  const isOpen = () => (native ? menuEl.matches(":popover-open") : menuEl.hasAttribute("data-open"));

  /** The theme control is one row for the arrow keys: the segment that has focus, else the checked one. */
  const segRow = () => segButtons.find((b) => b === document.activeElement) ?? segButtons.find((b) => b.getAttribute("aria-checked") === "true") ?? segButtons[0];
  /** The copy chip of the "update available" state is a row of its own while it shows. */
  const updateCopyRows = () => /** @type {HTMLElement[]} */ (updateCmdEl.hidden ? [] : [...updateCmdEl.querySelectorAll("button")]);
  // What's New sits in the About group, shown once the version is known.
  const rows = () => [segRow(), ...toggleRows, mcpItem, ...updateCopyRows(), ...(aboutEl.hidden ? [] : [whatsNewItem])];

  function sync() {
    const theme = getTheme();
    for (const b of segButtons) b.setAttribute("aria-checked", String(b.dataset.themePref === theme));
    for (const row of toggleRows) row.setAttribute("aria-checked", String(toggles[row.dataset.setting ?? ""].get()));
  }

  /**
   * About Artisign: the version, and beside it the update state — up to date, a newer version with the command to copy, or the check switched off. An enabled check that has not found out yet (offline) shows nothing.
   */
  function renderAbout(about) {
    if (!about) return;
    versionEl.textContent = `artisign ${about.version}`;
    aboutEl.hidden = false;
    /** @type {{ state: string, icon: string, text: string } | null} */
    let status = null;
    if (about.updateCheck === "off") status = { state: "off", icon: "block", text: "Update check off" };
    else if (about.updateAvailable && about.latest) status = { state: "available", icon: "upgrade", text: `Version ${about.latest} available` };
    else if (about.latest) status = { state: "current", icon: "check_circle", text: "Up to date" };
    updateStatusEl.hidden = status === null;
    if (status) {
      updateStatusEl.dataset.state = status.state;
      updateIconEl.textContent = status.icon;
      updateTextEl.textContent = status.text;
    }
    const showCmd = status?.state === "available";
    if (showCmd && updateCmdEl.hidden) {
      const field = createCodeField("artisign update", { variant: "compact" });
      const copy = /** @type {HTMLElement} */ (field.querySelector("button"));
      copy.setAttribute("role", "menuitem");
      copy.tabIndex = -1; // a row of the menu: reached with the arrows
      updateCmdEl.replaceChildren(field);
    }
    updateCmdEl.hidden = !showCmd;
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

  /** Runs whenever the menu has just opened (either path): the rows are synced, focus goes to the theme control. */
  function onOpened() {
    triggerEl.setAttribute("aria-expanded", "true");
    sync();
    const start = segRow();
    setRovingTabindex(rows(), start);
    for (const b of segButtons) if (b !== start) b.tabIndex = -1;
    start.focus();
    onOpen?.();
    void loadSetupSummary();
  }

  /** Whatever closed it: nothing of this read stays for the next open. */
  function onClosed() {
    triggerEl.setAttribute("aria-expanded", "false");
    setupToken++;
    mcpSub.hidden = true;
  }

  function open() {
    if (isOpen()) return;
    if (native) menuEl.showPopover();
    else {
      menuEl.setAttribute("data-open", "");
      onOpened();
    }
  }

  function close() {
    if (!isOpen()) return;
    if (native) menuEl.hidePopover();
    else menuEl.removeAttribute("data-open");
    onClosed();
  }

  // Native: the trigger is the popover's declared invoker (`popovertarget` in index.html), so the browser toggles it and light dismiss leaves the invoker alone — a second click closes instead of reopening. Only the fallback toggles by hand. The `toggle` event keeps aria-expanded right and starts the open work, whichever way the browser opened or closed it.
  menuEl.addEventListener("toggle", () => {
    if (isOpen()) onOpened();
    else onClosed();
  });

  wireMenu(menuEl, rows, {
    onTabOut: () => {
      if (isOpen()) close();
    },
  });

  if (!native) {
    triggerEl.addEventListener("click", () => (isOpen() ? close() : open()));
    // Capture on pointerdown, like the zoom menu: other triggers stop click propagation.
    document.addEventListener(
      "pointerdown",
      (evt) => {
        if (isOpen() && !controlsEl.contains(/** @type {Node} */ (evt.target))) close();
      },
      true,
    );
  }
  // Capture + stopImmediatePropagation: this Escape only closes the menu (inspect mode's Escape must not also fire). It also answers an Escape the screen frame handed over, which the browser's own close handling never sees.
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

  return { open, close, isOpen, sync, renderAbout };
}
