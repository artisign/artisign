// CHR-1267 — the draggable, foldable floating card (design `float-card`). The grip moves the card by pointer or by arrow keys; the position is a per-viewer preference (daemon settings via prefs.js, like every other per-browser choice). The card keeps its bottom line (CSS: the zoom pill's bottom edge), so only left/top move.

import { readStringPref, writeStringPref } from "./prefs.js";

/** The gap kept between a card and the window edge, and between a card and the top bar. */
export const CARD_MARGIN = 8;
/** A card that is not required to stay fully inside (the tall columns, whose bottom is fixed by CSS) keeps at least this much of its head above the window's bottom edge, so the grip can always be reached again. */
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
 * The lowest line (window pixels) of the top bar plus a small gap: no movable card goes above it. Read from the DOM, never hard-coded; 0 where there is no top bar.
 * @param {Document} [doc]
 * @returns {number}
 */
export function topBarLimit(doc = document) {
  const bottom = doc.getElementById("topbar")?.getBoundingClientRect().bottom ?? 0;
  return bottom > 0 ? bottom + CARD_MARGIN : 0;
}

/**
 * The one drag constraint of every movable card: inside the window minus a margin, and never above `top` (the top bar's lower edge). The head always stays reachable.
 * @param {{ left: number, top: number }} position
 * @param {{ width: number, height: number }} card the card's own size
 * @param {{ width: number, height: number }} win the window's size
 * @param {{ top?: number, fullyInside?: boolean }} [limits] `top`: the lowest top-bar line (default 0). `fullyInside`: the whole card must fit above the bottom margin too (the tool bar); otherwise only its head has to.
 * @returns {{ left: number, top: number }}
 */
export function clampCardPosition({ left, top }, card, win, { top: topLimit = 0, fullyInside = false } = {}) {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  return {
    left: clamp(left, CARD_MARGIN, win.width - card.width - CARD_MARGIN),
    top: clamp(top, topLimit, fullyInside ? win.height - card.height - CARD_MARGIN : win.height - CARD_MIN_VISIBLE),
  };
}

/**
 * Makes `gripEl` move `cardEl` and remembers where it was left. Without a stored position the card keeps its CSS place. Every move, stored or live, goes through `clampCardPosition` with the top bar's current lower edge; the card is clamped again when the window resizes and when the top bar changes size.
 * @param {{
 *   cardEl: HTMLElement,
 *   gripEl: HTMLElement,
 *   storage: Storage,
 *   key: string,
 *   label?: string,
 *   liveEl?: HTMLElement,
 *   fullyInside?: boolean,
 *   canPlace?: () => boolean,
 *   onDragStart?: () => void,
 *   onDragMove?: (info: { x: number, y: number, left: number, top: number }) => boolean | void,
 *   onDragEnd?: (info: { x: number, y: number }) => boolean | void,
 *   onKeyMove?: (direction: "left" | "right" | "up" | "down", rect: DOMRect) => boolean | "ignored",
 * }} args `label` and `liveEl` (a visually hidden `aria-live` region) announce a move to screen readers. `fullyInside`: the whole card, not only its head, stays inside the window (the tool bar). `canPlace` false: the card's place is not its own (a docked bar), so nothing is restored, clamped on resize or saved. The hooks let an owner react to a drag: `onDragMove` returns true when it changed the card's layout (the grab point is then re-anchored on the grip); `onDragEnd` returns true when it placed the card itself (nothing is saved); `onKeyMove` returns true when it handled the arrow key (announced), "ignored" when it swallowed the key without any move (not announced).
 * @returns {{ moveTo: (position: { left: number, top: number }) => void, save: () => void, reclamp: () => void }}
 */
export function makeCardDraggable({ cardEl, gripEl, storage, key, label = "Card", liveEl, fullyInside = false, canPlace = () => true, onDragStart, onDragMove, onDragEnd, onKeyMove }) {
  const bounds = () => {
    const rect = cardEl.getBoundingClientRect();
    return { card: { width: rect.width, height: rect.height }, win: { width: window.innerWidth, height: window.innerHeight } };
  };
  const moveTo = (position) => {
    const { card, win } = bounds();
    const next = clampCardPosition(position, card, win, { top: topBarLimit(), fullyInside });
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
  /** Clamps a card that has an own place again: after a window resize, a change of the top bar's size, a saved position from another window. */
  const reclamp = () => {
    if (cardEl.style.left === "" || !canPlace()) return;
    const rect = cardEl.getBoundingClientRect();
    moveTo({ left: rect.left, top: rect.top });
  };

  const stored = parseCardPosition(readStringPref(storage, key, null));
  if (stored && canPlace()) moveTo(stored);

  // The move and release listeners live on the window for the length of one drag: they keep working when the pointer leaves the small grip, with or without pointer capture.
  let drag = null;
  /** Keeps the pointer on the grip after the card changed its layout under it. */
  const reanchor = () => {
    const rect = cardEl.getBoundingClientRect();
    const grip = gripEl.getBoundingClientRect();
    drag = { dx: grip.left - rect.left + grip.width / 2, dy: grip.top - rect.top + grip.height / 2 };
  };
  const onMove = (evt) => {
    if (!drag) return;
    const left = evt.clientX - drag.dx;
    const top = evt.clientY - drag.dy;
    moveTo({ left, top });
    if (onDragMove?.({ x: evt.clientX, y: evt.clientY, left, top }) === true) {
      reanchor();
      moveTo({ left: evt.clientX - drag.dx, top: evt.clientY - drag.dy });
    }
  };
  const end = (evt) => {
    if (!drag) return;
    drag = null;
    cardEl.classList.remove("is-dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (onDragEnd?.({ x: evt?.clientX ?? 0, y: evt?.clientY ?? 0 }) !== true) save();
    announce(`${label} moved`);
  };
  gripEl.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    const rect = cardEl.getBoundingClientRect();
    drag = { dx: evt.clientX - rect.left, dy: evt.clientY - rect.top };
    cardEl.classList.add("is-dragging");
    onDragStart?.();
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
    const handled = onKeyMove?.(direction, rect);
    if (handled === true || handled === "ignored") {
      if (handled === true) announce(`${label} moved ${direction}`);
      return;
    }
    moveTo({ left: rect.left + delta[0] * step, top: rect.top + delta[1] * step });
    save();
    announce(`${label} moved ${direction}`);
  });

  // A window that shrank must not strand the card outside it, nor under the top bar.
  window.addEventListener("resize", reclamp);
  const topBarEl = document.getElementById("topbar");
  if (topBarEl && typeof ResizeObserver === "function") new ResizeObserver(reclamp).observe(topBarEl);

  return { moveTo, save, reclamp };
}
