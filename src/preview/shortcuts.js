// Keyboard shortcuts (CHR-916): the one mapping (artisign-ui decision `chr905-shortcuts`), the key matcher with its guards, and the display strings. Tooltips, menu hints and the reference dialog all read SHORTCUTS, and app.js binds from the same ids, so displayed and bound keys cannot drift.
//
// Browser-safe by construction: plain single keys, plus Shift for the zoom presets and Collapse all. Nothing matches with Ctrl, Cmd or Alt held, in a text field, during IME composition, or while a menu / dialog is open (except that overlay's own keys).

/**
 * @typedef {{
 *   id: string,
 *   group: string,
 *   label: string,
 *   key?: string,          // KeyboardEvent.key to match (letters case-insensitive unless `shift`)
 *   code?: string,         // KeyboardEvent.code to match instead (Shift+digit: the produced key depends on the layout)
 *   alt?: string[],        // further `key` values bound to the same action ("=" for "+")
 *   shift?: boolean,       // Shift must be held (default: must not be held, unless `anyShift`)
 *   anyShift?: boolean,    // symbol keys whose Shift state depends on the layout
 *   display: string,       // the key as shown, without the Shift prefix
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

  { id: "view-screens", group: "Views", label: "Screens", key: "1", display: "1" },
  { id: "view-design-system", group: "Views", label: "Design System", key: "2", display: "2" },
  { id: "view-board", group: "Views", label: "Board", key: "3", display: "3" },

  { id: "zoom-fit", group: "Zoom", label: "Fit", code: "Digit1", shift: true, display: "1", view: "screens" },
  { id: "zoom-50", group: "Zoom", label: "50%", code: "Digit5", shift: true, display: "5", view: "screens" },
  { id: "zoom-100", group: "Zoom", label: "100%", code: "Digit0", shift: true, display: "0", view: "screens" },
  { id: "zoom-200", group: "Zoom", label: "200%", code: "Digit2", shift: true, display: "2", view: "screens" },
  { id: "zoom-in", group: "Zoom", label: "Zoom in", key: "+", alt: ["="], anyShift: true, display: "+" },
  { id: "zoom-out", group: "Zoom", label: "Zoom out", key: "-", alt: ["_"], anyShift: true, display: "−" },

  // Same keys as the Screens zoom presets; the active view picks which one applies.
  { id: "board-fit-all", group: "Board", label: "Fit all", code: "Digit1", shift: true, display: "1", view: "board" },
  { id: "board-100", group: "Board", label: "100%", code: "Digit0", shift: true, display: "0", view: "board" },
  { id: "board-edges", group: "Board", label: "Edges", key: "e", display: "E", view: "board" },
  { id: "board-clusters", group: "Board", label: "Clusters", key: "g", display: "G", view: "board" },
  { id: "board-collapse-all", group: "Board", label: "Collapse all", key: "g", shift: true, display: "G", view: "board" },

  { id: "panel-screens", group: "Panels", label: "Screens panel", key: "[", display: "[" },
  { id: "panel-context", group: "Panels", label: "Context panel", key: "\\", display: "\\" },
  { id: "panel-elements", group: "Panels", label: "Elements panel", key: "]", display: "]" },

  { id: "project-menu", group: "Project", label: "Project menu", key: "p", display: "P" },
  { id: "menu-open", group: "Project", label: "Open project (in menu)", key: "o", display: "O", overlay: "project-menu" },
  { id: "menu-new", group: "Project", label: "New project (in menu)", key: "n", display: "N", overlay: "project-menu" },

  { id: "filter", group: "General", label: "Filter screens", key: "/", display: "/" },
  { id: "theme", group: "General", label: "Cycle theme", key: "t", display: "T" },
  { id: "leave", group: "General", label: "Close, leave mode", key: "Escape", display: "Esc" },
  { id: "help", group: "General", label: "This list", key: "?", anyShift: true, display: "?" },
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
  if (!def.anyShift && event.shiftKey !== Boolean(def.shift)) return false;
  if (def.code) return event.code === def.code;
  // Letters match whatever the Shift / Caps Lock state produced; Shift itself is checked above.
  return event.key.toLowerCase() === def.key?.toLowerCase() || (def.alt ?? []).includes(event.key);
}

/**
 * Which shortcut, if any, an event triggers.
 *
 * @param {KeyboardEvent} event
 * @param {{ view: string, overlay: null | "project-menu" | "zoom-menu" | "other" }} context `overlay`: the open menu / dialog / popover, if any
 * @returns {string | null} a SHORTCUTS id
 */
export function resolveShortcut(event, { view, overlay }) {
  // Browser and OS combinations stay untouched.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  // IME composition (keyCode 229 on browsers that don't set isComposing).
  if (event.isComposing || event.keyCode === 229) return null;
  if (isTypingTarget(event.target)) return null;

  for (const def of SHORTCUTS) {
    if (def.unbound || !matches(def, event)) continue;
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
 * Fills every `[data-shortcut-id]` under `root`: the tooltip key slot (`data-shortcut`) on controls, the text of a menu hint element.
 *
 * @param {ParentNode} root
 * @param {boolean} mac
 */
export function applyShortcutHints(root, mac) {
  for (const el of root.querySelectorAll("[data-shortcut-id]")) {
    const def = shortcutById(/** @type {HTMLElement} */ (el).dataset.shortcutId ?? "");
    if (!def) continue;
    const text = formatShortcut(def, mac);
    if (el.classList.contains("chrome-menu-hint")) el.textContent = text;
    else /** @type {HTMLElement} */ (el).dataset.shortcut = text;
  }
}
