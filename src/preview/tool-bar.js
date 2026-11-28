// CHR-1268 — the side tool bar (design `tool-bar`, `tool-btn`, `hint-tooltip`): a vertical, icon-only toolbar between the left card and the screen. This module owns what is not app logic: the fold control, the grip (position remembered), the hint tooltips, the roving focus and the disabled state. What a tool does is app.js's business.
//
// Hints: every tool's name (and shortcut) shows as a blue `popover="hint"` tooltip after the pointer rests on the tool for about two seconds (`interest-delay-start` in style.css), wired with `interestfor` — only where interest invokers and anchor positioning both work. Elsewhere the tool keeps a native `title` (modern-web-guidance `toolbar`: no polyfill). A tool that cannot act right now is `aria-disabled` (still focusable) and its hint says why; a tool that has no function in the view is `hidden` (CHR-1283, tool-states.js `TOOLS`).

import { makeCardDraggable, CARD_MARGIN } from "./float-card.js";
import { computeDock, inDockZone, DOCK_ZONE } from "./tool-dock.js";
import { readBoolPref, readStringPref, writeBoolPref, writeStringPref } from "./prefs.js";
import { ariaKeyShortcut, formatShortcut, shortcutById } from "./shortcuts.js";

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
 *   dock?: { pillEl: HTMLElement, wrapEl: HTMLElement, panelEls?: () => (HTMLElement | null)[] },
 * }} args `interest` overrides the feature detection (tests). `dock`: the zoom pill (`pillEl`) and the element that centres it (`wrapEl`), which the horizontal bar docks beside (CHR-1287); `panelEls` returns the side panels whose shown widths bound the free span.
 */
export function createToolBar({ barEl, toolsEl, foldEl, gripEl, liveEl, storage, mac, interest = supportsInterestHints(), dock }) {
  const FOLD_KEY = "artisign.tool-bar.collapsed";
  const POSITION_KEY = "artisign.tool-bar.position";
  const ORIENTATION_KEY = "artisign.tool-bar.orientation";
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

  // --- orientation and dock (CHR-1287) ----------------------------------------------
  /** @type {"vertical" | "horizontal"} */
  let orientation = readStringPref(storage, ORIENTATION_KEY, null) === "horizontal" ? "horizontal" : "vertical";
  const separatorEls = [...toolsEl.querySelectorAll(".tool-sep")];
  /** @type {HTMLElement | null} */
  let previewEl = null;

  /** The place the docked bar takes, measured from the DOM; null while the bar is not shown (another view hides it). */
  function dockGeometry(size = { width: barEl.offsetWidth, height: barEl.offsetHeight }) {
    const area = /** @type {HTMLElement | null} */ (barEl.offsetParent);
    if (!area || size.width === 0) return null;
    const areaRect = area.getBoundingClientRect();
    const pillRect = dock?.pillEl.offsetWidth ? dock.pillEl.getBoundingClientRect() : null;
    const width = dock?.wrapEl.offsetWidth || areaRect.width;
    const height = areaRect.height;
    const pill = pillRect ? { width: pillRect.width, top: pillRect.top - areaRect.top, height: pillRect.height } : null;
    // The panels that reach down into the bar's band bound the free span (their shown widths, not defaults).
    const bandTop = (pill ? pill.top : height - 60) + areaRect.top;
    let spanLeft = CARD_MARGIN;
    let spanRight = width - CARD_MARGIN;
    for (const el of dock?.panelEls?.() ?? []) {
      if (!el || el.hidden || el === barEl) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.bottom <= bandTop) continue;
      const left = rect.left - areaRect.left;
      const right = rect.right - areaRect.left;
      if ((left + right) / 2 < width / 2) spanLeft = Math.max(spanLeft, right + CARD_MARGIN);
      else spanRight = Math.min(spanRight, left - CARD_MARGIN);
    }
    return computeDock({ width, height }, size, pill, { margin: CARD_MARGIN, span: { left: spanLeft, right: spanRight } });
  }

  /** The bar's size were it horizontal: measured by switching for the length of one synchronous read (nothing paints in between). */
  function horizontalSize() {
    const before = barEl.dataset.orientation;
    barEl.dataset.orientation = "horizontal";
    const size = { width: barEl.offsetWidth, height: barEl.offsetHeight };
    barEl.dataset.orientation = before ?? "vertical";
    return size;
  }

  /** Moves the pill over (paddings of its centring element) to make room for a docked bar; null frees it. */
  function setPillRoom(place) {
    if (!dock) return;
    for (const [prop, value] of [["padding-left", place?.padLeft ?? 0], ["padding-right", place?.padRight ?? 0]]) {
      if (value > 0) dock.wrapEl.style.setProperty(prop, `${value}px`);
      else dock.wrapEl.style.removeProperty(prop);
    }
  }

  /** Puts a docked bar in its place and makes room for it beside the zoom pill; frees the pill again otherwise. */
  function syncDock() {
    if (previewEl && !previewEl.hidden) return; // the preview owns the pill's room while it shows
    if (orientation !== "horizontal") {
      if (dock) {
        dock.wrapEl.style.removeProperty("padding-left");
        dock.wrapEl.style.removeProperty("padding-right");
      }
      return;
    }
    const place = dockGeometry();
    if (dock) setPillRoom(place);
    if (!place) return;
    barEl.style.left = `${place.left}px`;
    barEl.style.top = `${place.top}px`;
  }

  function applyOrientation(next) {
    const previous = orientation;
    orientation = next;
    barEl.dataset.orientation = next;
    barEl.setAttribute("aria-orientation", next);
    barEl.setAttribute("focusgroup", next === "horizontal" ? "toolbar wrap inline" : "toolbar wrap block");
    for (const sep of separatorEls) sep.setAttribute("aria-orientation", next === "horizontal" ? "vertical" : "horizontal");
    for (const { hintEl } of hints.values()) hintEl.dataset.placement = next === "horizontal" ? "top" : "end";
    if (next === "vertical" && previous === "horizontal") {
      barEl.style.removeProperty("left"); // the docked place was computed, not the bar's own
      barEl.style.removeProperty("top");
    }
    syncDock();
  }

  function showPreview(show) {
    if (!show) {
      if (!previewEl || previewEl.hidden) return;
      previewEl.hidden = true;
      syncDock(); // the pill goes back to where the bar's real layout puts it
      return;
    }
    if (previewEl && !previewEl.hidden) return; // already showing; the dock does not move during a drag
    const size = horizontalSize();
    const place = dockGeometry(size);
    if (!place) return;
    if (!previewEl) {
      previewEl = document.createElement("div");
      previewEl.className = "tool-dock-preview";
      previewEl.setAttribute("aria-hidden", "true");
      (barEl.parentElement ?? document.body).append(previewEl);
    }
    setPillRoom(place); // the pill makes room for the preview, as it will for the bar
    Object.assign(previewEl.style, { left: `${place.left}px`, top: `${place.top}px`, width: `${size.width}px`, height: `${size.height}px` });
    previewEl.hidden = false;
  }

  function persistOrientation() {
    writeStringPref(storage, ORIENTATION_KEY, orientation);
  }

  // --- grip ---------------------------------------------------------------------
  const draggable = makeCardDraggable({
    cardEl: barEl,
    gripEl,
    storage,
    key: POSITION_KEY,
    label: "Tool bar",
    liveEl,
    fullyInside: true,
    canPlace: () => orientation === "vertical",
    onDragMove({ y }) {
      const inZone = inDockZone(y, window.innerHeight);
      showPreview(inZone);
      if (!inZone && orientation === "horizontal") {
        applyOrientation("vertical");
        persistOrientation();
        return true; // the grip is somewhere else now
      }
    },
    onDragEnd() {
      const previewing = previewEl !== null && !previewEl.hidden; // the preview shows only after a real move into the zone
      showPreview(false);
      if (previewing) {
        applyOrientation("horizontal");
        persistOrientation();
        return true;
      }
      return orientation === "horizontal"; // a click on a docked bar's grip: nothing moved, its own place is not saved
    },
    onKeyMove(direction, rect) {
      if (orientation === "horizontal") {
        if (direction !== "up") return "ignored"; // docked: only Up leaves the dock
        applyOrientation("vertical");
        persistOrientation();
        const height = barEl.offsetHeight;
        draggable.moveTo({ left: rect.left, top: window.innerHeight - DOCK_ZONE - height });
        draggable.save();
        return true;
      }
      if (direction === "down" && rect.bottom >= window.innerHeight - CARD_MARGIN - 1) {
        applyOrientation("horizontal"); // already at the bottom: one more step down docks
        persistOrientation();
        return true;
      }
      return false;
    },
  });

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
    hintEl.dataset.placement = "end";
    hints.set(button, { hintEl, labelEl, keyEl: null });
  }
  if (interest) buttons.forEach(buildHint);
  applyOrientation(orientation);
  if (typeof ResizeObserver === "function") {
    // The docked bar follows its own size (folding, tools shown or hidden per view), the zoom pill's (hidden while comparing) and the area's.
    const observer = new ResizeObserver(syncDock);
    observer.observe(barEl);
    if (dock) {
      observer.observe(dock.pillEl);
      observer.observe(dock.wrapEl);
      for (const el of dock.panelEls?.() ?? []) if (el) observer.observe(el); // a resized or folded panel moves the free span
    }
  }
  window.addEventListener("resize", syncDock);

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
      const [forward, back] = orientation === "horizontal" ? ["ArrowRight", "ArrowLeft"] : ["ArrowDown", "ArrowUp"];
      const next = { [forward]: index + 1, [back]: index - 1, Home: 0, End: visible.length - 1 }[evt.key];
      if (next === undefined) return;
      evt.preventDefault();
      visible[(next + visible.length) % visible.length].focus();
    });
  }

  return {
    buttons,
    toggleFold,
    isFolded: () => barEl.dataset.collapsed === "true",
    orientation: () => orientation,
    syncDock,
    /**
     * @param {HTMLButtonElement} button
     * @param {{ disabled?: boolean, reason?: string, pressed?: boolean, name?: string, hint?: string, shortcut?: string }} state `reason` is why the tool does not apply right now (ignored unless disabled); `pressed` is the toggle state (omit for a tool that has none); `name` replaces the accessible name; `hint` replaces the tooltip text (default: name and, for a disabled tool, its reason); `shortcut` is the id of the key the tool answers to now.
     */
    setState(button, { disabled = false, reason = "", pressed, name, hint, shortcut }) {
      if (name !== undefined) button.setAttribute("aria-label", name);
      if (shortcut !== undefined) {
        // The key the tool answers to now, for the hint, `data-shortcut` and assistive tech alike.
        button.dataset.shortcutId = shortcut;
        const def = shortcutById(shortcut);
        if (def) {
          button.dataset.shortcut = formatShortcut(def, mac);
          button.setAttribute("aria-keyshortcuts", ariaKeyShortcut(def));
        } else {
          delete button.dataset.shortcut;
          button.removeAttribute("aria-keyshortcuts");
        }
      }
      if (disabled) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
      if (disabled && reason) button.dataset.toolReason = reason;
      else delete button.dataset.toolReason;
      if (hint !== undefined) button.dataset.toolHintText = hint;
      else delete button.dataset.toolHintText;
      if (pressed !== undefined) button.setAttribute("aria-pressed", String(pressed));
      syncHint(button);
    },
    /** Call after tools were shown or hidden: the roving tab stop moves to a visible tool when its own is gone. */
    syncRoving,
  };
}
