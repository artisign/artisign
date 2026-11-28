// CHR-1290 / CHR-1291 — pointer and wheel input of the two canvases (Screens, Board): left-drag pan, wheel zoom at the pointer, pinch, two-finger scroll. One controller serves both; each view hands in what "pan" and "zoom" mean for it (the Screens frame moves by an offset, the Board scrolls). The screen's own document is a same-origin iframe, so its pointer, wheel and key events are forwarded through `attachDoc` and mapped into the shell's client coordinates.

import { isTypingTarget } from "./shortcuts.js";
import { computeWheelZoomFactor } from "./board.js";

/** A press moves the canvas only once it travelled this far (px), so a click stays a click. */
export const PAN_THRESHOLD = 4;
// A trackpad flick keeps sending small deltas for a while (inertia): after one pan event, the next events within this window stay pan.
const PAN_LATCH_MS = 200;
// A notched mouse wheel steps in whole pixels of at least this size per event (Chrome: 100, Windows: 120).
const NOTCH_MIN_DELTA = 50;

/**
 * THE mouse-vs-trackpad heuristic — the only place that decides what a wheel event means. Ctrl/Cmd (and a trackpad pinch, which browsers send as Ctrl + wheel) zoom. A line- or page-mode delta is a notched mouse wheel and zooms. In pixel mode a horizontal component, small or fractional steps are a trackpad two-finger scroll and pan; a whole-number step of a notch's size is a mouse wheel and zooms. A pan event latches for a moment so the tail of a trackpad flick never turns into a zoom.
 *
 * @param {() => number} [now]
 * @returns {(evt: { ctrlKey: boolean, metaKey: boolean, deltaX: number, deltaY: number, deltaMode: number }) => "zoom" | "pan"}
 */
export function createWheelClassifier(now = () => performance.now()) {
  let lastPanAt = Number.NEGATIVE_INFINITY;
  return (evt) => {
    if (evt.ctrlKey || evt.metaKey) return "zoom";
    if (evt.deltaMode !== 0) return "zoom";
    const at = now();
    const notch = evt.deltaX === 0 && Number.isInteger(evt.deltaY) && Math.abs(evt.deltaY) >= NOTCH_MIN_DELTA && at - lastPanAt > PAN_LATCH_MS;
    if (notch) return "zoom";
    lastPanAt = at;
    return "pan";
  };
}

/**
 * Where a frame edge sits after a zoom that keeps the point under the pointer in place: one axis, in the pane's own (viewport) coordinates.
 *
 * @param {{ pointer: number, position: number, oldScale: number, newScale: number }} args `position` is the frame's current edge (left or top)
 * @returns {number}
 */
export function anchoredPosition({ pointer, position, oldScale, newScale }) {
  return pointer - (pointer - position) * (newScale / oldScale);
}

/**
 * @typedef {{
 *   surfaceEl: HTMLElement,
 *   isToolActive: () => boolean,
 *   onPan: (dx: number, dy: number) => void,
 *   onZoom: (factor: number, clientX: number, clientY: number) => void,
 *   onWheelPan?: (dx: number, dy: number) => void,
 *   onManual?: () => void,
 *   ignoreSelector?: string,
 *   now?: () => number,
 * }} CanvasInputArgs
 */

/**
 * @param {CanvasInputArgs} args `isToolActive`: a canvas tool (Comment, Inspect, Flow) keeps the left button; Space and the middle button pan regardless. `onPan` moves the canvas by the pointer's delta (the way the content follows the pointer). `onZoom` gets the zoom factor and the shell client point to hold in place. `onWheelPan` handles a trackpad scroll as a pan of the canvas; without it that wheel is left to the browser's native scroll. `onManual` fires once per gesture that moves or zooms the canvas by hand (it pauses Follow). `ignoreSelector` names shell controls inside the surface that keep their own pointer and wheel behaviour (matched on targets of the shell document only).
 * @returns {{ mount: () => () => void, attachDoc: (doc: Document | null, frameEl: HTMLElement) => () => void }} `mount` listens on the surface and returns the teardown; `attachDoc` forwards a screen document's events (call again after each load) and returns its teardown
 */
export function createCanvasInput({ surfaceEl, isToolActive, onPan, onZoom, onWheelPan, onManual, ignoreSelector = "", now }) {
  const classify = createWheelClassifier(now);
  const shellIgnore = ["button", "a[href]", "input", "textarea", "select", "[contenteditable]", "[role=dialog]", "[popover]", ignoreSelector].filter(Boolean).join(", ");
  /** @type {Map<Document, HTMLElement>} document -> the iframe that shows it */
  const frames = new Map();
  /** @type {WeakSet<Document>} documents whose root carries our cursor */
  const cursored = new WeakSet();
  let spaceHeld = false;
  let hovering = false;
  let suppressClick = false;
  /** @type {{ x: number, y: number, startX: number, startY: number, forced: boolean, started: boolean, docs: Document[] } | null} */
  let drag = null;
  let shown = ""; // the cursor state last applied

  /** The pointer in shell client coordinates, wherever the event came from. */
  function point(evt) {
    const frame = frames.get(evt.target?.ownerDocument);
    if (!frame) return { x: evt.clientX, y: evt.clientY };
    const rect = frame.getBoundingClientRect();
    const scale = frame.offsetWidth > 0 ? rect.width / frame.offsetWidth : 1;
    return { x: rect.left + evt.clientX * scale, y: rect.top + evt.clientY * scale };
  }

  const panReady = () => spaceHeld || !isToolActive();
  const cursorState = () => (drag?.started ? "grabbing" : panReady() ? "grab" : "");

  /** The cursor: an attribute on the surface for the shell's own elements (style.css), a style on the root of each forwarded document. */
  function syncCursor() {
    const state = cursorState();
    shown = state;
    if (state) surfaceEl.dataset.pan = state;
    else delete surfaceEl.dataset.pan;
    for (const doc of frames.keys()) {
      const root = doc.documentElement;
      if (!root) continue;
      if (state) {
        root.style.cursor = state;
        cursored.add(doc);
      } else if (cursored.has(doc)) {
        root.style.removeProperty("cursor");
        cursored.delete(doc);
      }
    }
  }

  function clearSelections() {
    window.getSelection?.()?.removeAllRanges();
    for (const doc of frames.keys()) doc.getSelection?.()?.removeAllRanges();
  }

  function endDrag() {
    if (!drag) return;
    for (const doc of drag.docs) {
      doc.removeEventListener("pointermove", onDragMove, true);
      doc.removeEventListener("pointerup", onDragEnd, true);
      doc.removeEventListener("pointercancel", onDragEnd, true);
    }
    if (drag.started || drag.forced) suppressClick = true;
    drag = null;
    setTimeout(() => (suppressClick = false), 0); // the click that closes this press fires right after pointerup
    syncCursor();
  }

  function onDragMove(evt) {
    if (!drag) return;
    if (evt.buttons === 0 && evt.pointerType !== "touch") return endDrag(); // the button was released outside the window
    const { x, y } = point(evt);
    if (!drag.started) {
      if (Math.hypot(x - drag.startX, y - drag.startY) < PAN_THRESHOLD) return;
      drag.started = true;
      clearSelections();
      onManual?.();
      syncCursor();
    }
    onPan(x - drag.x, y - drag.y);
    drag.x = x;
    drag.y = y;
  }

  function onDragEnd() {
    endDrag();
  }

  /** @param {PointerEvent} evt @param {boolean} inDoc the press came from a forwarded screen document */
  function onPointerDown(evt, inDoc) {
    if (drag || evt.pointerType === "touch" || (evt.button !== 0 && evt.button !== 1)) return;
    const forced = evt.button === 1 || spaceHeld;
    if (!forced && isToolActive()) return;
    const target = /** @type {Element} */ (evt.target);
    if (inDoc ? target.closest?.("input, textarea, select, [contenteditable]") : target.closest?.(shellIgnore)) return;
    if (evt.button === 1) evt.preventDefault(); // no middle-button autoscroll
    const { x, y } = point(evt);
    const docs = [document, ...frames.keys()];
    drag = { x, y, startX: x, startY: y, forced, started: false, docs };
    for (const doc of docs) {
      doc.addEventListener("pointermove", onDragMove, true);
      doc.addEventListener("pointerup", onDragEnd, true);
      doc.addEventListener("pointercancel", onDragEnd, true);
    }
  }

  /** The wheel, from the surface or a forwarded document. */
  function onWheel(evt, inDoc) {
    const target = /** @type {Element} */ (evt.target);
    if (!inDoc && ignoreSelector && target.closest?.(ignoreSelector)) return; // a panel inside the surface scrolls itself
    const { x, y } = point(evt);
    if (classify(evt) === "zoom") {
      evt.preventDefault(); // never the browser's page zoom
      onManual?.();
      onZoom(computeWheelZoomFactor(evt.deltaY, evt.deltaMode, surfaceEl.clientHeight), x, y);
    } else if (onWheelPan) {
      evt.preventDefault();
      onManual?.();
      onWheelPan(-evt.deltaX, -evt.deltaY);
    }
  }

  function onKeyDown(evt) {
    if (evt.code !== "Space" && evt.key !== " ") return;
    if (!hovering || spaceHeld) return;
    const target = /** @type {Element} */ (evt.target);
    if (isTypingTarget(target) || target.closest?.("button, a[href], summary, [role=button], [role=menuitem]")) return;
    spaceHeld = true;
    evt.preventDefault();
    syncCursor();
  }

  function onKeyUp(evt) {
    if (evt.code !== "Space" && evt.key !== " ") return;
    if (!spaceHeld) return;
    spaceHeld = false;
    syncCursor();
  }

  function onClickCapture(evt) {
    if (!suppressClick) return;
    evt.preventDefault();
    evt.stopImmediatePropagation(); // the screen's own capture handlers (tools, flows) come after this one
  }

  const onSurfaceDown = (evt) => onPointerDown(evt, false);
  const onSurfaceWheel = (evt) => onWheel(evt, false);
  const onDocDown = (evt) => onPointerDown(evt, true);
  const onDocWheel = (evt) => onWheel(evt, true);
  const preventDrag = (evt) => {
    if (panReady()) evt.preventDefault(); // an image or link must not start the browser's own drag
  };
  // A tool turns on or off without telling us: the next move over the canvas picks the cursor up.
  const onHoverMove = () => {
    if (!drag && cursorState() !== shown) syncCursor();
  };
  const onEnter = () => {
    hovering = true;
    syncCursor();
  };
  const onLeave = () => (hovering = false);
  const onBlur = () => {
    if (document.activeElement?.tagName === "IFRAME") return; // the focus moved into a screen's document: the press that did it is still ours
    spaceHeld = false;
    endDrag();
    syncCursor();
  };

  return {
    mount() {
      surfaceEl.addEventListener("pointerdown", onSurfaceDown);
      surfaceEl.addEventListener("wheel", onSurfaceWheel, { passive: false });
      surfaceEl.addEventListener("pointerenter", onEnter);
      surfaceEl.addEventListener("pointerleave", onLeave);
      surfaceEl.addEventListener("pointermove", onHoverMove);
      surfaceEl.addEventListener("click", onClickCapture, true);
      surfaceEl.addEventListener("dragstart", preventDrag);
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("keyup", onKeyUp);
      window.addEventListener("blur", onBlur);
      syncCursor();
      return () => {
        endDrag();
        surfaceEl.removeEventListener("pointerdown", onSurfaceDown);
        surfaceEl.removeEventListener("wheel", onSurfaceWheel);
        surfaceEl.removeEventListener("pointerenter", onEnter);
        surfaceEl.removeEventListener("pointerleave", onLeave);
        surfaceEl.removeEventListener("pointermove", onHoverMove);
        surfaceEl.removeEventListener("click", onClickCapture, true);
        surfaceEl.removeEventListener("dragstart", preventDrag);
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
        delete surfaceEl.dataset.pan;
      };
    },
    attachDoc(doc, frameEl) {
      if (!doc) return () => {};
      frames.set(doc, frameEl);
      doc.addEventListener("pointerdown", onDocDown, true);
      doc.addEventListener("wheel", onDocWheel, { passive: false });
      doc.addEventListener("pointermove", onHoverMove);
      doc.addEventListener("click", onClickCapture, true);
      doc.addEventListener("dragstart", preventDrag, true);
      doc.addEventListener("keydown", onKeyDown);
      doc.addEventListener("keyup", onKeyUp);
      syncCursor();
      return () => {
        doc.removeEventListener("pointerdown", onDocDown, true);
        doc.removeEventListener("wheel", onDocWheel);
        doc.removeEventListener("pointermove", onHoverMove);
        doc.removeEventListener("click", onClickCapture, true);
        doc.removeEventListener("dragstart", preventDrag, true);
        doc.removeEventListener("keydown", onKeyDown);
        doc.removeEventListener("keyup", onKeyUp);
        frames.delete(doc);
      };
    },
  };
}
