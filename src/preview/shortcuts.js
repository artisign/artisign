// Keyboard shortcuts (CHR-916): the one mapping (artisign-ui decision `chr905-shortcuts`), the key matcher with its guards, and the display strings. Tooltips, menu hints and the reference dialog all read SHORTCUTS, and app.js binds from the same ids, so displayed and bound keys cannot drift.
//
// Browser-safe by construction: plain single keys, plus Shift for the zoom presets and Collapse all. Nothing matches with Ctrl or Cmd held, in a text field, during IME composition, or while a menu / dialog is open (except that overlay's own keys).
//
// Non-US layouts (CHR-916 review, CTO decision): the character keys `[ \ ] / ? + -` are matched by the character the key PRODUCES (`event.key`), and Shift or Option / AltGr may be held when the layout needs them to produce it (German Mac `[` is Option+5, Windows AltGr+8 reports ctrl+alt with AltGraph set, German `/` is Shift+7). Ctrl or Cmd alone is never accepted; a lone Alt counts as Option on macOS only, elsewhere it is the browser's. Letters and digits keep the strict rule: no Alt at all (Shift only where the mapping lists it).

/**
 * @typedef {{
 *   id: string,
 *   group: string,
 *   label: string,
 *   key?: string,          // KeyboardEvent.key to match (letters case-insensitive unless `shift`)
 *   code?: string,         // KeyboardEvent.code to match instead (Shift+digit: the produced key depends on the layout)
 *   alt?: string[],        // further `key` values bound to the same action ("=" for "+")
 *   shift?: boolean,       // Shift must be held (default: must not be held, unless `char`)
 *   char?: boolean,        // a character key: matched by `event.key`, with Shift / Option / AltGr allowed as the layout needs
 *   display: string,       // the key as shown, without the Shift prefix
 *   aria?: string,         // the key as aria-keyshortcuts names it, when it differs from `display`
 *   target?: string,       // the view a Views entry opens
 *   zoom?: "fit" | number, // the zoom level a Zoom preset sets
 *   view?: "board" | "screens", // only while the Board / any other view is active
 *   overlay?: "project-menu" | "zoom-menu", // only while that menu is open (and then only these keys)
 *   unbound?: boolean,     // listed in the reference only; its key is handled by the control itself
 * }} ShortcutDef
 */

export const SHORTCUT_GROUPS = ["Modes", "Views", "Zoom", "Board", "Panels", "Project", "General"];

/** @type {ShortcutDef[]} */
export const SHORTCUTS = [
  { id: "flow", group: "Modes", label: "Flow mode", key: "f", display: "F" },
  { id: "comment", group: "Modes", label: "Comment mode", key: "c", display: "C" },
  { id: "inspect", group: "Modes", label: "Inspect mode", key: "i", display: "I" },
  { id: "status-bar", group: "Modes", label: "Status bar", key: "s", display: "S" },
  { id: "follow", group: "Modes", label: "Follow", key: "w", display: "W" },
  { id: "follow-resume", group: "Modes", label: "Resume follow", key: "r", display: "R" },

  { id: "view-screens", group: "Views", label: "Screens", key: "1", display: "1", target: "screens" },
  { id: "view-design-system", group: "Views", label: "Design System", key: "2", display: "2", target: "design-system" },
  { id: "view-board", group: "Views", label: "Board", key: "3", display: "3", target: "board" },

  { id: "zoom-fit", group: "Zoom", label: "Fit", code: "Digit1", shift: true, display: "1", zoom: "fit", view: "screens" },
  { id: "zoom-50", group: "Zoom", label: "50%", code: "Digit5", shift: true, display: "5", zoom: 0.5, view: "screens" },
  { id: "zoom-100", group: "Zoom", label: "100%", code: "Digit0", shift: true, display: "0", zoom: 1, view: "screens" },
  { id: "zoom-200", group: "Zoom", label: "200%", code: "Digit2", shift: true, display: "2", zoom: 2, view: "screens" },
  { id: "zoom-in", group: "Zoom", label: "Zoom in", key: "+", alt: ["="], char: true, display: "+", aria: "Plus" },
  { id: "zoom-out", group: "Zoom", label: "Zoom out", key: "-", alt: ["_"], char: true, display: "−", aria: "-" },

  // Same keys as the Screens zoom presets; the active view picks which one applies.
  { id: "board-fit-all", group: "Board", label: "Fit all", code: "Digit1", shift: true, display: "1", view: "board" },
  { id: "board-100", group: "Board", label: "100%", code: "Digit0", shift: true, display: "0", view: "board" },
  { id: "board-edges", group: "Board", label: "Edges", key: "e", display: "E", view: "board" },
  { id: "board-clusters", group: "Board", label: "Clusters", key: "g", display: "G", view: "board" },
  { id: "board-collapse-all", group: "Board", label: "Collapse all", key: "g", shift: true, display: "G", view: "board" },

  { id: "panel-screens", group: "Panels", label: "Screens panel", key: "[", char: true, display: "[" },
  { id: "panel-context", group: "Panels", label: "Context panel", key: "\\", char: true, display: "\\" },
  { id: "panel-elements", group: "Panels", label: "Elements panel", key: "]", char: true, display: "]" },

  { id: "project-menu", group: "Project", label: "Project menu", key: "p", display: "P" },
  { id: "menu-open", group: "Project", label: "Open project (in menu)", key: "o", display: "O", overlay: "project-menu" },
  { id: "menu-new", group: "Project", label: "New project (in menu)", key: "n", display: "N", overlay: "project-menu" },

  { id: "filter", group: "General", label: "Filter screens", key: "/", char: true, display: "/" },
  { id: "theme", group: "General", label: "Cycle theme", key: "t", display: "T" },
  { id: "leave", group: "General", label: "Close, leave mode", key: "Escape", display: "Esc", aria: "Escape" },
  { id: "help", group: "General", label: "This list", key: "?", char: true, display: "?" },
];

/** @param {string} id */
export function shortcutById(id) {
  return SHORTCUTS.find((def) => def.id === id);
}

/**
 * @param {Navigator | { platform?: string, userAgent?: string }} nav
 * @returns {boolean}
 */
export function isMacPlatform(nav) {
  return /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent || "");
}

/**
 * The key as shown in a tooltip or menu: "F", "⇧1" on macOS, "Shift+1" elsewhere (the mapping only ever uses Shift).
 *
 * @param {ShortcutDef} def
 * @param {boolean} mac
 * @returns {string}
 */
export function formatShortcut(def, mac) {
  if (!def.shift) return def.display;
  return mac ? `⇧${def.display}` : `Shift+${def.display}`;
}

/**
 * Whether the event's target takes typed text, so a bare letter must reach it.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isTypingTarget(target) {
  const el = /** @type {HTMLElement | null} */ (target);
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable || el.closest("[contenteditable]:not([contenteditable=false])")) return true;
  const field = el.closest("input, textarea, select");
  if (!field) return false;
  if (field.tagName === "INPUT") return !NON_TEXT_INPUT_TYPES.has(/** @type {HTMLInputElement} */ (field).type);
  return true;
}

const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "file", "color", "image"]);

/**
 * @param {ShortcutDef} def
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function matches(def, event) {
  if (!def.char && event.shiftKey !== Boolean(def.shift)) return false;
  if (def.code) return event.code === def.code;
  // Letters match whatever the Shift / Caps Lock state produced (Shift itself is checked above); character keys match the produced character.
  return event.key.toLowerCase() === def.key?.toLowerCase() || (def.alt ?? []).includes(event.key);
}

/**
 * Which shortcut, if any, an event triggers.
 *
 * @param {KeyboardEvent} event
 * @param {{ view: string, overlay: null | "project-menu" | "zoom-menu" | "other", mac: boolean }} context `overlay`: the open menu / dialog / popover, if any; `mac`: whether a plain Option counts for a character key
 * @returns {string | null} a SHORTCUTS id
 */
export function resolveShortcut(event, { view, overlay, mac }) {
  // Cmd never counts; Ctrl only as half of Windows' AltGr (ctrl+alt with AltGraph set), which is how a layout types `[`.
  if (event.metaKey) return null;
  const altGraph = event.ctrlKey && event.altKey && Boolean(event.getModifierState?.("AltGraph"));
  if (event.ctrlKey && !altGraph) return null;
  // Option types characters on macOS ([ is Option+5 on a German Mac); elsewhere a lone Alt is the browser's or OS's (Alt+arrows, menus), only AltGr counts.
  const hasAlt = (mac && event.altKey) || altGraph;
  if (event.altKey && !mac && !altGraph) return null;
  // IME composition (keyCode 229 on browsers that don't set isComposing).
  if (event.isComposing || event.keyCode === 229) return null;
  if (isTypingTarget(event.target)) return null;

  for (const def of SHORTCUTS) {
    if (def.unbound || !matches(def, event)) continue;
    if (hasAlt && !def.char) continue; // Option / AltGr is only for the character keys
    if (def.view === "board" && view !== "board") continue;
    if (def.view === "screens" && view === "board") continue;
    if (event.repeat && def.id !== "zoom-in" && def.id !== "zoom-out") return null;
    if (def.overlay) return overlay === def.overlay ? def.id : null;
    // While a menu or dialog is open only its own keys act: the zoom presets and +/- belong to the zoom menu.
    if (overlay === "zoom-menu") return def.group === "Zoom" ? def.id : null;
    if (overlay) return null;
    return def.id;
  }
  return null;
}

/**
 * The next zoom level one step from `scale` along `ladder` (ascending). Never goes the wrong way: from a Fit scale below the smallest level, "out" has nowhere to go.
 *
 * @param {number} scale the effective scale now (Fit resolved to its number)
 * @param {1 | -1} direction
 * @param {number[]} ladder
 * @returns {number | undefined}
 */
export function nextZoomLevel(scale, direction, ladder) {
  const EPS = 0.001;
  if (direction > 0) return ladder.find((level) => level > scale + EPS);
  return [...ladder].reverse().find((level) => level < scale - EPS);
}

/**
 * The key as `aria-keyshortcuts` names it (platform-independent).
 *
 * @param {ShortcutDef} def
 * @returns {string}
 */
export function ariaKeyShortcut(def) {
  return `${def.shift ? "Shift+" : ""}${def.aria ?? def.display}`;
}

/**
 * Fills every `[data-shortcut-id]` under `root` from the mapping: the tooltip key slot (`data-shortcut`) and `aria-keyshortcuts` on a control; a menu hint element gets its text, is hidden from assistive tech, and passes `aria-keyshortcuts` on to the button it sits in.
 *
 * @param {ParentNode} root
 * @param {boolean} mac
 */
export function applyShortcutHints(root, mac) {
  for (const el of root.querySelectorAll("[data-shortcut-id]")) {
    const def = shortcutById(/** @type {HTMLElement} */ (el).dataset.shortcutId ?? "");
    if (!def) continue;
    if (el.classList.contains("chrome-menu-hint")) {
      el.textContent = formatShortcut(def, mac);
      el.setAttribute("aria-hidden", "true");
      el.closest("button")?.setAttribute("aria-keyshortcuts", ariaKeyShortcut(def));
    } else {
      /** @type {HTMLElement} */ (el).dataset.shortcut = formatShortcut(def, mac);
      el.setAttribute("aria-keyshortcuts", ariaKeyShortcut(def));
    }
  }
}
