// CHR-1263 — where the comment controller (comment-canvas.js) works: a host
// names the overlay layer in the PARENT document, the scroll pane, the stage
// that holds the banner and the toolbar, and the frames — the documents
// comments attach to. A screen has one frame, a mockup one per variant.
//
// Boxes are in layer coordinates: pixels from the layer's top-left, already
// scaled by the frame's zoom; the controller multiplies an element's own
// (unscaled) rect by `scale` and adds the frame's offset.

import { commentTarget, mockupCommentTarget } from "./comment-canvas.js";

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
