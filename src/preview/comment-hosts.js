// CHR-1263 — where the comment controller (comment-canvas.js) works: a host
// names the overlay layer in the PARENT document, the scroll pane, the stage
// that holds the banner and the toolbar, and the frames — the documents
// comments attach to. A screen has one frame, a mockup one per variant.
//
// Boxes are in layer coordinates: pixels from the layer's top-left, already
// scaled by the frame's zoom; the controller multiplies an element's own
// (unscaled) rect by `scale` and adds the frame's offset.
//
// Optional flags: `pins: false` — the host draws the pins itself; `reanchor:
// false` — no pick-an-element flow; `noun` — what a frame is called in a
// sentence (default "variant"); `numberPerFrame` — a thread is numbered among
// its own frame's; `lockedHint` — what the popover says where writing is off.

import { commentTarget, mockupCommentTarget } from "./comment-canvas.js";
import { TOOL_MIN_ZOOM } from "./board.js";
import { tileScale } from "./tile-hit.js";

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 * @typedef {{
 *   key: string | null,
 *   label: string | null,
 *   getDoc: () => Document | null,
 *   box: () => { left: number, top: number, width: number, height: number, scale: number } | null,
 *   pick: (target: EventTarget | null, doc: Document) => { el: Element | null, id: string | null } | null,
 *   hoverLabel: (hit: { el: Element | null, id: string | null }) => string,
 * }} CommentFrame
 * @typedef {{
 *   layerEl: HTMLElement,
 *   stageEl: HTMLElement,
 *   placement?: "top" | "bottom",
 *   modeText?: string,
 *   pins?: boolean,
 *   reanchor?: boolean,
 *   noun?: string,
 *   numberPerFrame?: boolean,
 *   lockedHint?: string,
 *   frames: () => CommentFrame[],
 *   view: () => Rect,
 * }} CommentHost
 */

/**
 * The single-screen canvas: the layer sits in #canvas's scrolled content box,
 * and the one frame is the screen holder (its offset and zoom come from the
 * holder's own style, set by canvas.js).
 * @param {{ canvasEl: HTMLElement, holderEl: HTMLElement, layerEl: HTMLElement, stageEl: HTMLElement, getDoc: () => Document | null }} deps
 * @returns {CommentHost}
 */
export function createScreenHost({ canvasEl, holderEl, layerEl, stageEl, getDoc }) {
  /** @type {CommentFrame} */
  const frame = {
    key: null,
    label: null,
    getDoc,
    box() {
      const scale = Number.parseFloat(holderEl.style.getPropertyValue("--zoom")) || 1;
      return {
        left: Number.parseFloat(holderEl.style.left) || 0,
        top: Number.parseFloat(holderEl.style.top) || 0,
        width: (Number.parseFloat(holderEl.style.width) || holderEl.offsetWidth) * scale,
        height: (Number.parseFloat(holderEl.style.height) || holderEl.offsetHeight) * scale,
        scale,
      };
    },
    pick: (target, doc) => commentTarget(doc, target),
    hoverLabel: (hit) => (hit.el === getDoc()?.body.firstElementChild ? "screen" : (hit.el?.id ?? "screen")),
  };
  return {
    layerEl,
    stageEl,
    frames: () => [frame],
    view: () => ({
      left: canvasEl.scrollLeft,
      top: canvasEl.scrollTop,
      right: canvasEl.scrollLeft + canvasEl.clientWidth,
      bottom: canvasEl.scrollTop + canvasEl.clientHeight,
    }),
  };
}

/**
 * The mockup columns: the layer covers the stage (#main), clipped to it, so
 * pins follow the scrolled and zoomed row through each iframe's own screen
 * rect. One frame per variant column, in column order.
 * @param {{ layerEl: HTMLElement, stageEl: HTMLElement, getColumns: () => { variantId: string, letter: string, iframe: HTMLIFrameElement }[] }} deps
 * @returns {CommentHost}
 */
export function createMockupHost({ layerEl, stageEl, getColumns }) {
  return {
    layerEl,
    stageEl,
    placement: "bottom",
    modeText: "Comment mode: click an element in any variant to start a thread",
    frames: () =>
      getColumns().map(({ variantId, letter, iframe }) => ({
        key: variantId,
        label: letter,
        getDoc: () => iframe.contentDocument,
        box() {
          const r = iframe.getBoundingClientRect();
          const origin = layerEl.getBoundingClientRect();
          return { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height, scale: r.width / (iframe.offsetWidth || r.width || 1) };
        },
        pick: (target) => mockupCommentTarget(target),
        hoverLabel: (hit) => `${letter} · ${hit.id ?? "variant"}`,
      })),
    view() {
      const r = layerEl.getBoundingClientRect();
      return { left: 0, top: 0, right: r.width, bottom: r.height };
    },
  };
}

/**
 * The Board: the layer covers the board view, clipped to it, and every tile is a frame keyed by its screen. The pins are board-comments.js's (in the scrolled canvas); this host only serves the popover, the new-thread composer and the hover outline, and places them from each tile iframe's on-screen rect, so they follow pan, zoom and any padding of the surface.
 * @param {{ layerEl: HTMLElement, stageEl: HTMLElement, getFrames: () => import("./tile-hit.js").TileFrame[], getZoom: () => number }} deps
 * @returns {CommentHost}
 */
export function createBoardHost({ layerEl, stageEl, getFrames, getZoom }) {
  return {
    layerEl,
    stageEl,
    pins: false,
    reanchor: false,
    noun: "screen",
    numberPerFrame: true,
    lockedHint: "Zoom in to comment",
    // Below the zoom limit writing is off, and the banner says why instead of inviting a click.
    get modeText() {
      return getZoom() < TOOL_MIN_ZOOM ? "Zoom in to comment" : "Comment mode: click an element to start a thread";
    },
    frames: () =>
      getFrames().map((frame) => ({
        key: frame.screen,
        label: frame.screen,
        getDoc: frame.doc,
        box() {
          const r = frame.rect();
          const origin = layerEl.getBoundingClientRect();
          return { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height, scale: tileScale(frame) };
        },
        pick: (target, doc) => commentTarget(doc, target),
        hoverLabel: (hit) => `${frame.screen} · ${hit.id ?? "screen"}`,
      })),
    view() {
      const r = layerEl.getBoundingClientRect();
      return { left: 0, top: 0, right: r.width, bottom: r.height };
    },
  };
}
