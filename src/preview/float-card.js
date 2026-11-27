// CHR-1267 — the draggable, foldable floating card (design `float-card`). The grip moves the card by pointer or by arrow keys; the position is a per-viewer preference (daemon settings via prefs.js, like every other per-browser choice). The card keeps its bottom line (CSS: the zoom pill's bottom edge), so only left/top move.

import { readStringPref, writeStringPref } from "./prefs.js";

/** Keep at least this much of the card inside the window on every side, so the grip can always be reached again. */
export const CARD_MIN_VISIBLE = 48;
/** An arrow key on the grip moves the card this far; Shift multiplies it. */
export const CARD_KEY_STEP = 16;

/**
 * Parses a stored "left,top" position.
 * @param {string | null} raw
 * @returns {{ left: number, top: number } | null} null for a missing or malformed value
 */
export function parseCardPosition(raw) {
  if (raw === null) return null;
  const parts = raw.split(",");
  if (parts.length !== 2 || parts.some((part) => part.trim() === "")) return null;
  const [left, top] = parts.map(Number);
  return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
}

/**
 * Keeps a card position reachable inside the window.
 * @param {{ left: number, top: number }} position
 * @param {{ width: number, height: number }} card the card's own size
 * @param {{ width: number, height: number }} win the window's size
 * @returns {{ left: number, top: number }}
 */
export function clampCardPosition({ left, top }, card, win) {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  return {
    left: clamp(left, CARD_MIN_VISIBLE - card.width, win.width - CARD_MIN_VISIBLE),
    top: clamp(top, 0, win.height - CARD_MIN_VISIBLE),
  };
}

/**
 * Makes `gripEl` move `cardEl` and remembers where it was left. Without a stored position the card keeps its CSS place.
 * @param {{ cardEl: HTMLElement, gripEl: HTMLElement, storage: Storage, key: string, label?: string, liveEl?: HTMLElement }} args `label` and `liveEl` (a visually hidden `aria-live` region) announce a move to screen readers.
 */
export function makeCardDraggable({ cardEl, gripEl, storage, key, label = "Card", liveEl }) {
  const bounds = () => {
    const rect = cardEl.getBoundingClientRect();
    return { card: { width: rect.width, height: rect.height }, win: { width: window.innerWidth, height: window.innerHeight } };
  };
  const moveTo = (position) => {
    const { card, win } = bounds();
    const next = clampCardPosition(position, card, win);
    cardEl.style.left = `${next.left}px`;
    cardEl.style.top = `${next.top}px`;
  };
  /** A short note for screen readers; cleared after a second, like any transient status. */
  let liveTimer;
  const announce = (text) => {
    if (!liveEl) return;
    liveEl.textContent = text;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => (liveEl.textContent = ""), 1000);
  };
  const save = () => {
    const rect = cardEl.getBoundingClientRect();
    writeStringPref(storage, key, `${Math.round(rect.left)},${Math.round(rect.top)}`);
  };

  const stored = parseCardPosition(readStringPref(storage, key, null));
  if (stored) moveTo(stored);

  // The move and release listeners live on the window for the length of one drag: they keep working when the pointer leaves the small grip, with or without pointer capture.
  let drag = null;
  const onMove = (evt) => {
    if (drag) moveTo({ left: evt.clientX - drag.dx, top: evt.clientY - drag.dy });
  };
  const end = () => {
    if (!drag) return;
    drag = null;
    cardEl.classList.remove("is-dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    save();
    announce(`${label} moved`);
  };
  gripEl.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    const rect = cardEl.getBoundingClientRect();
    drag = { dx: evt.clientX - rect.left, dy: evt.clientY - rect.top };
    cardEl.classList.add("is-dragging");
    try {
      gripEl.setPointerCapture(evt.pointerId); // keeps the pointer on the grip; the window listeners below cover a capture that is lost
    } catch {
      // no active pointer to capture (synthetic events)
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    evt.preventDefault();
  });

  // Keyboard: the grip is a button, arrows move the card (Shift = 4 steps), so moving it is not pointer-only.
  gripEl.addEventListener("keydown", (evt) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[evt.key];
    const direction = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[evt.key];
    if (!delta || evt.ctrlKey || evt.metaKey || evt.altKey) return;
    evt.preventDefault();
    const step = CARD_KEY_STEP * (evt.shiftKey ? 4 : 1);
    const rect = cardEl.getBoundingClientRect();
    moveTo({ left: rect.left + delta[0] * step, top: rect.top + delta[1] * step });
    save();
    announce(`${label} moved ${direction}`);
  });

  // A window that shrank must not strand the card outside it.
  window.addEventListener("resize", () => {
    if (cardEl.style.left === "") return;
    const rect = cardEl.getBoundingClientRect();
    moveTo({ left: rect.left, top: rect.top });
  });
}
