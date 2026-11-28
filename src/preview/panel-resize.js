// CHR-1281 — resizable side panels. A thin handle on the canvas-facing edge of the left Screens card and of the right column (Agent bar + tool panel, one shared width). Drag, arrow keys (16px) and double-click (reset) change the width; the width is a per-viewer preference like the card positions (prefs.js).

import { readStringPref, writeStringPref } from "./prefs.js";

/** An arrow key on the handle changes the width by this much. */
export const PANEL_KEY_STEP = 16;
/** What the two panels must leave of the window width (window minus both panel widths). With the tool bar and the gaps taken off, that keeps the breadcrumb's width free at 1440px and wider. */
export const MIN_CANVAS_SPACE = 480;

/** The widths of the two panels: the defaults are the CSS defaults (`--size-nav-card`, `--size-agent-bar`). The right column's minimum is its default: it was never narrower than that. */
export const LEFT_PANEL = { min: 220, max: 480, defaultWidth: 256 };
export const RIGHT_PANEL = { min: 248, max: 560, defaultWidth: 248 };

/**
 * Keeps a width inside its limits.
 * @param {number} width
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampPanelWidth(width, min, max) {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

/**
 * Parses a stored width.
 * @param {string | null} raw
 * @returns {number | null} null for a missing, empty or malformed value
 */
export function parsePanelWidth(raw) {
  if (raw === null || raw.trim() === "") return null;
  const width = Number(raw);
  return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Wires the handles of one panel (one handle per card of the column).
 * @param {{ handleEls: HTMLElement[], cardEls: HTMLElement[], edge: "left" | "right", min: number, max: number, defaultWidth: number, storage: Storage | null, key: string, label: string, availableMax?: () => number, apply: (width: number) => void, onCommit?: (width: number) => void }} args
 *   `edge` is the card edge the handle sits on: "right" for the left panel, "left" for the right column. `availableMax` caps the width by what the window leaves for the canvas. `apply` sets the width on the page; `onCommit` runs once a drag, key press or reset is done (not on every pointer move).
 * @returns {{ getWidth: () => number }}
 */
export function makePanelResizable({ handleEls, cardEls, edge, min, max, defaultWidth, storage, key, label, availableMax = () => max, apply, onCommit, liveEl }) {
  const limit = () => Math.max(min, Math.min(max, availableMax()));
  let width = clampPanelWidth(parsePanelWidth(readStringPref(storage, key, null)) ?? defaultWidth, min, limit());

  const show = () => {
    const shown = clampPanelWidth(width, min, limit());
    // A dragged right-column card keeps its right edge, so its left edge follows the handle.
    const rights = edge === "left" ? cardEls.filter((el) => el.style.left !== "").map((el) => [el, el.getBoundingClientRect().right]) : [];
    apply(shown);
    for (const [el, right] of rights) el.style.left = `${right - shown}px`;
    for (const handle of handleEls) {
      handle.setAttribute("aria-valuenow", String(shown));
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(limit()));
    }
  };
  const set = (next) => {
    width = clampPanelWidth(next, min, limit());
    show();
  };
  const commit = () => {
    writeStringPref(storage, key, width === defaultWidth ? "" : String(width));
    onCommit?.(width);
  };
  let liveTimer;
  const announce = () => {
    if (!liveEl) return;
    liveEl.textContent = `${label} ${width} pixels wide`;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => (liveEl.textContent = ""), 1000);
  };

  show();
  // A window that shrank must not leave the canvas without room; the chosen width stays stored.
  window.addEventListener("resize", show);

  for (const handle of handleEls) {
    handle.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0) return;
      const cardRect = handle.parentElement.getBoundingClientRect();
      // The pointer keeps the spot it grabbed on the 6px handle: the edge does not jump by the grab offset.
      const onMove =
        edge === "right"
          ? (move) => set(cardRect.width + (move.clientX - evt.clientX))
          : (move) => set(cardRect.width + (evt.clientX - move.clientX));
      const end = () => {
        handle.classList.remove("is-dragging");
        document.body.classList.remove("is-panel-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        commit();
      };
      handle.classList.add("is-dragging");
      document.body.classList.add("is-panel-resizing");
      try {
        handle.setPointerCapture(evt.pointerId);
      } catch {
        // no active pointer to capture (synthetic events)
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      evt.preventDefault();
    });

    handle.addEventListener("dblclick", () => {
      set(defaultWidth);
      commit();
      announce();
    });

    // Arrow keys move the edge: right widens the left panel, left widens the right column.
    handle.addEventListener("keydown", (evt) => {
      const direction = { ArrowLeft: -1, ArrowRight: 1 }[evt.key];
      if (!direction || evt.ctrlKey || evt.metaKey || evt.altKey) return;
      evt.preventDefault();
      set(width + direction * PANEL_KEY_STEP * (edge === "right" ? 1 : -1));
      commit();
      announce();
    });
  }

  return { getWidth: () => width };
}
