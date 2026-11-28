// CHR-1268 — the side tool bar (design `tool-bar`, `tool-btn`, `hint-tooltip`): a vertical, icon-only toolbar between the left card and the screen. This module owns what is not app logic: the fold control, the grip (position remembered), the hint tooltips, the roving focus and the disabled state. What a tool does is app.js's business.
//
// Hints: every tool's name (and shortcut) shows as a blue `popover="hint"` tooltip after the pointer rests on the tool for about two seconds (`interest-delay-start` in style.css), wired with `interestfor` — only where interest invokers and anchor positioning both work. Elsewhere the tool keeps a native `title` (modern-web-guidance `toolbar`: no polyfill). A tool that does not apply is `aria-disabled` (still focusable) and its hint says why.

import { makeCardDraggable } from "./float-card.js";
import { readBoolPref, writeBoolPref } from "./prefs.js";
import { formatShortcut, shortcutById } from "./shortcuts.js";

/** Whether the browser can show interest-triggered hint popovers anchored to their tool. */
export function supportsInterestHints() {
  const probe = typeof document !== "undefined" ? document.createElement("button") : null;
  return (
    probe !== null &&
    "interestForElement" in HTMLButtonElement.prototype &&
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("position-area", "inline-end")
  );
}

/**
 * The text of a tool's hint: its name, plus why it is unavailable.
 * @param {string} name
 * @param {string} [reason]
 * @returns {string}
 */
export function hintText(name, reason) {
  return reason ? `${name}: ${reason}` : name;
}

/**
 * @param {{
 *   barEl: HTMLElement,
 *   toolsEl: HTMLElement,
 *   foldEl: HTMLButtonElement,
 *   gripEl: HTMLElement,
 *   liveEl: HTMLElement,
 *   storage: Storage,
 *   mac: boolean,
 *   interest?: boolean,
 * }} args `interest` overrides the feature detection (tests).
 */
export function createToolBar({ barEl, toolsEl, foldEl, gripEl, liveEl, storage, mac, interest = supportsInterestHints() }) {
  const FOLD_KEY = "artisign.tool-bar.collapsed";
  const POSITION_KEY = "artisign.tool-bar.position";
  const buttons = /** @type {HTMLButtonElement[]} */ ([...toolsEl.querySelectorAll("button.tool-btn")]);
  /** @type {Map<HTMLButtonElement, { hintEl: HTMLElement, labelEl: HTMLElement }>} */
  const hints = new Map();
  const iconEl = /** @type {HTMLElement} */ (foldEl.querySelector(".icon"));

  // --- fold ---------------------------------------------------------------------
  function applyFold(collapsed) {
    barEl.dataset.collapsed = String(collapsed);
    // Hidden by CSS (data-collapsed), not by the `hidden` attribute: the tools' keys must keep working while the bar is folded.
    foldEl.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "Unfold tool bar" : "Fold tool bar";
    foldEl.setAttribute("aria-label", label);
    foldEl.dataset.tooltip = label;
    iconEl.textContent = collapsed ? "keyboard_arrow_down" : "keyboard_arrow_up";
  }
  applyFold(readBoolPref(storage, FOLD_KEY, false));
  const toggleFold = () => {
    const collapsed = barEl.dataset.collapsed !== "true";
    applyFold(collapsed);
    writeBoolPref(storage, FOLD_KEY, collapsed);
  };
  foldEl.addEventListener("click", toggleFold);

  // --- grip ---------------------------------------------------------------------
  makeCardDraggable({ cardEl: barEl, gripEl, storage, key: POSITION_KEY, label: "Tool bar", liveEl });

  // --- hints --------------------------------------------------------------------
  /** One tooltip per tool, kept outside the toolbar so an open hint is not part of it. */
  function buildHint(button, index) {
    const hintEl = document.createElement("div");
    hintEl.id = `tool-hint-${index}`;
    hintEl.className = "tool-hint";
    hintEl.setAttribute("popover", "hint");
    const labelEl = document.createElement("span");
    labelEl.className = "tool-hint-label";
    hintEl.append(labelEl);
    (barEl.parentElement ?? document.body).append(hintEl);
    button.setAttribute("interestfor", hintEl.id);
    hints.set(button, { hintEl, labelEl, keyEl: null });
  }
  if (interest) buttons.forEach(buildHint);

  /** The key chip of a hint follows the tool's current shortcut id (the Flow tool is F in the Screens view and E on the Board). */
  function syncHintKey(button, entry) {
    const def = shortcutById(button.dataset.shortcutId ?? "");
    if (!def) {
      entry.keyEl?.remove();
      entry.keyEl = null;
      return;
    }
    if (!entry.keyEl) {
      entry.keyEl = document.createElement("kbd");
      entry.keyEl.className = "tool-hint-key";
      entry.keyEl.setAttribute("aria-hidden", "true");
      entry.hintEl.append(entry.keyEl);
    }
    entry.keyEl.textContent = formatShortcut(def, mac);
  }

  /** Brings the hint (or the title fallback) in line with the tool's current name and reason. A tool the design gives its own tooltip words (`data-tool-hint-text`) shows those instead. */
  function syncHint(button) {
    const name = button.getAttribute("aria-label") ?? "";
    const text = button.dataset.toolHintText ?? hintText(name, button.dataset.toolReason);
    const entry = hints.get(button);
    if (!entry) {
      const def = shortcutById(button.dataset.shortcutId ?? "");
      button.title = def ? `${text} (${formatShortcut(def, mac)})` : text;
      return;
    }
    entry.labelEl.textContent = text;
    syncHintKey(button, entry);
    // A hint that only repeats the accessible name adds nothing; one that says more (the reason) describes the tool.
    if (text === name) {
      entry.hintEl.removeAttribute("role");
      button.removeAttribute("aria-describedby");
    } else {
      entry.hintEl.setAttribute("role", "tooltip");
      button.setAttribute("aria-describedby", entry.hintEl.id);
    }
  }
  buttons.forEach(syncHint);

  // --- disabled tools: still focusable, never acting ---------------------------------
  // Capture on the bar, so no tool's own click handler (nor the More button's popovertarget) runs for an aria-disabled tool.
  barEl.addEventListener(
    "click",
    (evt) => {
      const button = /** @type {HTMLElement | null} */ (evt.target instanceof Element ? evt.target.closest("button.tool-btn") : null);
      if (button?.getAttribute("aria-disabled") === "true") {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        announce(button.dataset.toolHintText ?? (button.dataset.toolReason ? hintText(button.getAttribute("aria-label") ?? "", button.dataset.toolReason) : ""));
      }
    },
    true,
  );
  let liveTimer;
  function announce(text) {
    liveEl.textContent = text;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => (liveEl.textContent = ""), 1500);
  }

  // --- roving focus where the browser has no focusgroup --------------------------------
  // Only the tools that show take part: the Board adds tools and the Screens view hides them again.
  const roving = !("focusGroup" in HTMLElement.prototype);
  const visibleButtons = () => buttons.filter((b) => !b.hidden);
  function syncRoving() {
    if (!roving) return;
    const visible = visibleButtons();
    const stop = visible.find((b) => b.tabIndex === 0) ?? visible[0];
    for (const b of buttons) b.tabIndex = b === stop ? 0 : -1;
  }
  if (roving) {
    syncRoving();
    toolsEl.addEventListener("focusin", (evt) => {
      if (buttons.includes(/** @type {HTMLButtonElement} */ (evt.target))) buttons.forEach((b) => (b.tabIndex = b === evt.target ? 0 : -1));
    });
    toolsEl.addEventListener("keydown", (evt) => {
      const visible = visibleButtons();
      const index = visible.indexOf(/** @type {HTMLButtonElement} */ (evt.target));
      if (index === -1 || evt.ctrlKey || evt.metaKey || evt.altKey) return;
      const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: visible.length - 1 }[evt.key];
      if (next === undefined) return;
      evt.preventDefault();
      visible[(next + visible.length) % visible.length].focus();
    });
  }

  return {
    buttons,
    toggleFold,
    isFolded: () => barEl.dataset.collapsed === "true",
    /**
     * @param {HTMLButtonElement} button
     * @param {{ disabled?: boolean, reason?: string, pressed?: boolean, name?: string, hint?: string, shortcut?: string }} state `reason` is why the tool does not apply right now (ignored unless disabled); `pressed` is the toggle state (omit for a tool that has none); `name` replaces the accessible name; `hint` replaces the tooltip text of a disabled tool (default: name and reason); `shortcut` is the id of the key the tool answers to now.
     */
    setState(button, { disabled = false, reason = "", pressed, name, hint, shortcut }) {
      if (name !== undefined) button.setAttribute("aria-label", name);
      if (shortcut !== undefined) button.dataset.shortcutId = shortcut;
      if (disabled) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
      if (disabled && reason) button.dataset.toolReason = reason;
      else delete button.dataset.toolReason;
      if (hint !== undefined && disabled) button.dataset.toolHintText = hint;
      else delete button.dataset.toolHintText;
      if (pressed !== undefined) button.setAttribute("aria-pressed", String(pressed));
      syncHint(button);
    },
    /** Call after tools were shown or hidden: the roving tab stop moves to a visible tool when its own is gone. */
    syncRoving,
  };
}
