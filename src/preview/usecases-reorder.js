// Use Cases tab — reordering the rows of a list in a form (CHR-1110, design CHR-1103): the base steps of the edit dialog.
// Three paths on every row, all ending in one `moveRow`: (1) a pointer drag on the row's handle (the real row is lifted,
// a drop marker shows the landing gap, one move on release), (2) keyboard grab-move-drop on the same handle (Space/Enter
// pick up, ArrowUp/Down move, Space/Enter drop, Esc cancel), (3) a ⋯ menu with Move up / Move down — the single-pointer
// alternative to dragging (WCAG 2.2 SC 2.5.7), built on the tab's `openMenu`. The move reorders the existing DOM nodes
// (`moveBefore` where the browser has it), so focus and typed values survive; the caller keeps its model in step via
// `onReorder` and renumbers the row labels in `onMoved`. One polite live region says "<action>, moved to step N of M."
// or "Move cancelled.".

import { h, icon } from "./usecases-dom.js";
import { openMenu } from "./usecases-menu.js";

/** The slot a dragged row would land in: how many of the other rows have their midpoint above the pointer. */
export function dropIndex(midpoints, y) {
  let count = 0;
  for (const mid of midpoints) if (mid < y) count++;
  return count;
}

/** The wording shared by every path. */
export function movedText(name, to, total, noun = "step") {
  return `${name}, moved to ${noun} ${to + 1} of ${total}.`;
}

/** What a screen reader hears on pickup: the row, its place and the keys (the visual hint is aria-hidden). */
export function grabbedText(name, index, total, noun = "step") {
  return `${name}, grabbed, ${noun} ${index + 1} of ${total}. Arrow up and down move it, Space drops it, Escape cancels.`;
}

/**
 * Brings what a row was drawn from its position up to date after a move: labels (`aria-label` and `title`) and the field paths
 * (`data-path`, `data-error-path`) that match. Each regex captures the text before the number in group 1, e.g. `/^(Step )\d+/` and
 * `/^(step\.)\d+/`; `label` counts from 1, `path` from 0.
 */
export function renumberRow(row, index, { label, path }) {
  for (const attr of ["aria-label", "title"]) {
    for (const el of row.querySelectorAll(`[${attr}]`)) {
      const text = el.getAttribute(attr);
      if (label.test(text)) el.setAttribute(attr, text.replace(label, `$1${index + 1}`));
    }
  }
  for (const [data, attr] of [["path", "data-path"], ["errorPath", "data-error-path"]]) {
    for (const el of row.querySelectorAll(`[${attr}]`)) {
      if (path.test(el.dataset[data])) el.dataset[data] = el.dataset[data].replace(path, `$1${index}`);
    }
  }
}

export const CANCELLED_TEXT = "Move cancelled.";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function scrollParent(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * @param {{
 *   list: HTMLElement, // the rows' parent (position: relative)
 *   rowSelector: string,
 *   nameOf: (row: HTMLElement, index: number) => string, // what the row is called in the announcement and the handle label
 *   onReorder: (from: number, to: number) => void, // move the item in the caller's model
 *   onMoved: () => void, // the DOM order changed: renumber the labels
 *   onCommit?: () => void, // the user settled a move (not an Esc): mark the form dirty
 *   noun?: string,
 * }} spec
 */
export function createReorder({ list, rowSelector, nameOf, onReorder, onMoved, onCommit, noun = "step" }) {
  const rows = () => [...list.querySelectorAll(`:scope > ${rowSelector}`)];
  const live = h("p", { class: "mcp-visually-hidden uc-reorder-live", role: "status" });
  let announceTimer = 0;
  let drag = null; // a pointer drag in progress
  let grab = null; // a keyboard grab in progress
  const settling = new WeakMap(); // row -> the settle animation of its last release
  let moving = false; // the DOM move in progress: a blur it causes must not end a grab
  const nativeMove = typeof list.moveBefore === "function";

  function announce(text) {
    clearTimeout(announceTimer);
    live.textContent = "";
    // Cleared now, set on a later task, so the same text twice in a row is announced twice. Without moveBefore the focused
    // handle is re-inserted and the screen reader re-announces it: wait a moment longer.
    announceTimer = setTimeout(() => { live.textContent = text; }, nativeMove ? 0 : 500);
  }

  /** Drops the lifted look, unless a new drag of the same row started meanwhile (a re-grab during the settle animation keeps it). */
  function unlift(row) {
    if (drag?.row !== row) row.classList.remove("is-lifted");
  }

  function flip(before, overrides = new Map()) {
    const animate = !reducedMotion();
    for (const row of rows()) {
      const lifted = overrides.has(row);
      const old = overrides.get(row) ?? before.get(row);
      const dy = old === undefined ? 0 : old - row.getBoundingClientRect().top;
      if (!animate || typeof row.animate !== "function" || Math.abs(dy) < 1) {
        if (lifted) unlift(row);
        continue;
      }
      const animation = row.animate(lifted ? [{ translate: `0 ${dy}px`, scale: "1.02" }, { translate: "0 0", scale: "1" }] : [{ translate: `0 ${dy}px` }, { translate: "0 0" }], { duration: 160, easing: "ease-out" });
      if (lifted) {
        settling.set(row, animation);
        animation.addEventListener("finish", () => unlift(row));
      }
    }
  }

  /** Move row `from` to position `to` (both indexes into the current order). Returns whether anything moved. */
  function moveRow(from, to, { releasedTop, silent = false } = {}) {
    const all = rows();
    if (from === to || from < 0 || to < 0 || from >= all.length || to >= all.length) return false;
    const row = all[from];
    const handle = row.querySelector(".uc-drag-handle");
    const hadFocus = handle !== null && document.activeElement === handle;
    const before = new Map(all.map((r) => [r, r.getBoundingClientRect().top]));
    const reference = to > from ? all[to].nextSibling : all[to];
    onReorder(from, to);
    moving = true;
    try {
      if (nativeMove) list.moveBefore(row, reference);
      else list.insertBefore(row, reference);
      if (hadFocus) handle.focus({ preventScroll: true });
    } finally {
      moving = false;
    }
    onMoved();
    row.scrollIntoView?.({ block: "nearest" });
    flip(before, releasedTop === undefined ? new Map() : new Map([[row, releasedTop]]));
    if (!silent) announce(movedText(nameOf(row, to), to, all.length, noun));
    return true;
  }

  // --- Keyboard: grab, move, drop ----------------------------------------------------------------------------
  function setGrabbed(handle, on) {
    handle.setAttribute("aria-pressed", on ? "true" : "false");
    const row = handle.closest(rowSelector);
    row.classList.toggle("is-grabbed", on);
  }

  function endGrab(handle, { cancel }) {
    if (!grab || grab.handle !== handle) return;
    const row = handle.closest(rowSelector);
    const { origin } = grab;
    grab = null;
    if (cancel) {
      moveRow(rows().indexOf(row), origin, { silent: true });
      announce(CANCELLED_TEXT);
    } else if (rows().indexOf(row) !== origin) onCommit?.();
    setGrabbed(handle, false);
  }

  function onHandleKey(event) {
    const handle = event.currentTarget;
    const row = handle.closest(rowSelector);
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (drag) return;
      if (grab) endGrab(handle, { cancel: false });
      else {
        grab = { handle, origin: rows().indexOf(row) };
        setGrabbed(handle, true);
        announce(grabbedText(nameOf(row, grab.origin), grab.origin, rows().length, noun));
      }
    } else if (grab?.handle === handle && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const index = rows().indexOf(row);
      moveRow(index, index + (event.key === "ArrowUp" ? -1 : 1));
    } else if (grab?.handle === handle && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      endGrab(handle, { cancel: true });
    }
  }

  // --- Pointer drag ----------------------------------------------------------------------------------------------
  function startDrag(event) {
    const handle = event.currentTarget;
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    if (grab) endGrab(grab.handle, { cancel: false }); // dragging another handle drops the grabbed row where it is
    event.preventDefault();
    const row = handle.closest(rowSelector);
    settling.get(row)?.finish(); // the settle animation of this row's last release: measure the row where it rests
    const scroller = scrollParent(list);
    const slot = h("div", { class: "uc-step-slot", "aria-hidden": "true" });
    const marker = h("div", { class: "uc-drop-marker", "aria-hidden": "true" });
    const slotTop = row.offsetTop;
    const rowHeight = row.offsetHeight;
    slot.style.top = `${slotTop}px`;
    slot.style.height = `${rowHeight}px`;
    // Layout positions of the other rows do not change during a drag: measure them once, not on every pointermove.
    const others = rows().filter((r) => r !== row).map((r) => ({ top: r.offsetTop, bottom: r.offsetTop + r.offsetHeight, mid: r.offsetTop + r.offsetHeight / 2 }));
    list.append(slot, marker);
    marker.hidden = true;
    row.classList.add("is-lifted");
    document.documentElement.classList.add("uc-dragging");
    drag = { handle, row, scroller, slot, marker, slotTop, rowHeight, others, listHeight: list.offsetHeight, listTop: list.getBoundingClientRect().top, scroll0: scroller?.scrollTop ?? 0, pointerId: event.pointerId, offset: event.clientY - row.getBoundingClientRect().top, y: event.clientY, from: rows().indexOf(row), target: rows().indexOf(row), frame: 0, last: 0 };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // a synthetic pointer: the document listeners below still get the moves
    }
    handle.setAttribute("aria-pressed", "true");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onDragKey, true);
    handle.addEventListener("lostpointercapture", onLost);
    if (scroller && typeof requestAnimationFrame === "function") drag.frame = requestAnimationFrame(tick);
  }

  /** Position the lifted row under the pointer and find the landing slot from the other rows' layout midpoints. */
  function update() {
    const { row, marker, from, others, slotTop, rowHeight } = drag;
    const listTop = drag.listTop - ((drag.scroller?.scrollTop ?? 0) - drag.scroll0); // the list moves with its scroller
    const rowTop = Math.min(Math.max(drag.y - listTop - drag.offset, 0), Math.max(drag.listHeight - rowHeight, 0));
    row.style.translate = `0 ${rowTop - slotTop}px`;
    // The landing slot is read at the lifted row's leading edge (top going up, bottom going down), so the marker sits at the edge, not across the row.
    const leading = rowTop < slotTop ? rowTop : rowTop + rowHeight;
    drag.target = dropIndex(others.map((o) => o.mid), leading);
    if (drag.target === from) {
      marker.hidden = true;
      return;
    }
    const top = others[drag.target - 1]?.bottom ?? 0;
    const bottom = others[drag.target]?.top ?? top + 8;
    marker.style.top = `${(top + bottom) / 2 - 4}px`;
    marker.hidden = false;
  }

  function tick(now) {
    if (!drag) return;
    const { scroller } = drag;
    const rect = scroller.getBoundingClientRect();
    const zone = Math.min(drag.row.offsetHeight, rect.height / 3);
    const dt = drag.last ? Math.min(now - drag.last, 50) : 16;
    drag.last = now;
    const into = drag.y < rect.top + zone ? drag.y - (rect.top + zone) : drag.y > rect.bottom - zone ? drag.y - (rect.bottom - zone) : 0;
    if (into !== 0) {
      scroller.scrollTop += (Math.max(-2, Math.min(2, into / zone)) * dt * 0.6);
      update();
    }
    drag.frame = requestAnimationFrame(tick);
  }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.y = event.clientY;
    update();
  }

  function finishDrag() {
    const state = drag;
    drag = null;
    cancelAnimationFrame?.(state.frame);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onDragKey, true);
    state.handle.removeEventListener("lostpointercapture", onLost);
    state.slot.remove();
    state.marker.remove();
    document.documentElement.classList.remove("uc-dragging");
    state.handle.setAttribute("aria-pressed", "false");
    return state;
  }

  function onUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const releasedTop = drag.row.getBoundingClientRect().top;
    const { row, from, target } = finishDrag();
    row.style.translate = "";
    if (!moveRow(from, target, { releasedTop })) {
      unlift(row);
      return;
    }
    onCommit?.();
  }

  function cancelDrag() {
    const releasedTop = drag.row.getBoundingClientRect().top;
    const { row } = finishDrag();
    row.style.translate = "";
    if (!reducedMotion() && typeof row.animate === "function") {
      const dy = releasedTop - row.getBoundingClientRect().top;
      const animation = row.animate([{ translate: `0 ${dy}px`, scale: "1.02" }, { translate: "0 0", scale: "1" }], { duration: 160, easing: "ease-out" });
      settling.set(row, animation);
      animation.addEventListener("finish", () => unlift(row));
    } else unlift(row);
    announce(CANCELLED_TEXT);
  }

  function onCancel(event) {
    if (drag && event.pointerId === drag.pointerId) cancelDrag();
  }

  function onLost() {
    // Capture is released right after pointerup (drag is gone by then); losing it mid-drag ends the drag as a cancel.
    if (drag) cancelDrag();
  }

  function onDragKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelDrag();
  }

  // --- Pieces the caller puts into a row ----------------------------------------------------------------------
  /** The drag handle: a native button, named after its row so a screen reader says what it moves. */
  function handle(getRow) {
    const button = h("button", { type: "button", class: "uc-drag-handle", "aria-pressed": "false" }, icon("drag_indicator"));
    const relabel = () => {
      const row = getRow();
      const index = rows().indexOf(row);
      button.setAttribute("aria-label", `Reorder ${noun} ${index + 1}, ${nameOf(row, index)}`);
    };
    button.addEventListener("pointerdown", startDrag);
    button.addEventListener("keydown", onHandleKey);
    button.addEventListener("focus", relabel);
    button.addEventListener("pointerenter", relabel);
    button.addEventListener("keyup", (event) => { if (event.key === " ") event.preventDefault(); });
    button.addEventListener("blur", () => { if (!moving && grab?.handle === button) endGrab(button, { cancel: false }); });
    button.relabel = relabel;
    return button;
  }

  /** The key hint (shown by CSS while the handle has keyboard focus or the row is grabbed; not read out: the handle's pressed state and the live region carry it). */
  function keyHint() {
    return h("span", { class: "uc-step-keys", "aria-hidden": "true" }, icon("keyboard"), h("span", { class: "uc-step-keys-rest" }, "Space to reorder"), h("span", { class: "uc-step-keys-grab" }, "Arrows to move · Space to drop · Esc to cancel"));
  }

  /** The ⋯ button with Move up / Move down: the pointer path that needs no dragging. */
  function moreButton(getRow) {
    const button = h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", title: "More actions", "aria-haspopup": "menu", "aria-expanded": "false" }, icon("more_horiz"));
    const relabel = () => button.setAttribute("aria-label", `Actions for ${noun} ${rows().indexOf(getRow()) + 1}`); // the caller relabels once the row is in the list
    button.relabel = relabel;
    button.addEventListener("click", () => {
      const row = getRow();
      const index = rows().indexOf(row);
      const total = rows().length;
      openMenu({
        anchor: button,
        align: "end",
        width: 180,
        label: `Actions for ${noun} ${index + 1}`,
        items: [
          { value: "up", label: "Move up", command: true, icon: "arrow_upward", disabled: index === 0 },
          { value: "down", label: "Move down", command: true, icon: "arrow_downward", disabled: index === total - 1 },
        ],
        onPick: (value) => {
          const at = rows().indexOf(row);
          if (moveRow(at, at + (value === "up" ? -1 : 1))) onCommit?.();
          button.focus({ preventScroll: true });
        },
      });
    });
    return button;
  }

  return { live, handle, keyHint, moreButton, moveRow };
}
