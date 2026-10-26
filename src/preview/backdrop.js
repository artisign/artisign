// The inert backdrop layer (ADR-008, CHR-940): a screen root with `data-backdrop` carries the referenced screen as its first child, `[data-backdrop-layer]`. It is context, not content — no hit-testing, picking, commenting, inspecting or flow click-through may reach into it, so every walk over the rendered document goes through these two helpers.
const BACKDROP_LAYER_SELECTOR = "[data-backdrop-layer]";

/**
 * Whether `el` sits inside (or is) an inert backdrop layer.
 * @param {Element | null} el
 * @returns {boolean}
 */
export function inBackdrop(el) {
  return !!el?.closest(BACKDROP_LAYER_SELECTOR);
}

/**
 * `querySelectorAll` that leaves out everything inside a backdrop layer.
 * @param {ParentNode} scope
 * @param {string} selector
 * @returns {Element[]}
 */
export function queryOutsideBackdrop(scope, selector) {
  return Array.from(scope.querySelectorAll(selector)).filter((el) => !inBackdrop(el));
}
