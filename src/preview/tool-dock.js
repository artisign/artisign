// CHR-1287 — where the horizontal tool bar docks: at the bottom of the window, directly left of the zoom pill, the two centred together. Pure geometry; tool-bar.js measures the DOM and applies the answer.

/** How close to the bottom edge (window pixels) the pointer has to be for a dragged tool bar to offer the dock. */
export const DOCK_ZONE = 80;
/** The space between the docked bar and the zoom pill. */
export const DOCK_GAP = 12;
/** The distance of the bar from the window's bottom edge when there is no zoom pill to line up with (the pill's own `bottom`). */
export const DOCK_BOTTOM = 18;

/**
 * Whether the pointer is in the bottom snap zone.
 * @param {number} pointerY window pixels
 * @param {number} windowHeight
 * @returns {boolean}
 */
export function inDockZone(pointerY, windowHeight) {
  return pointerY >= windowHeight - DOCK_ZONE;
}

/**
 * The docked bar's place and how far the zoom pill shifts right to make room: bar, gap and pill form one group centred in the area. Without a pill (hidden while comparing) the bar is centred alone on the pill's baseline.
 * @param {{ width: number, height: number }} area the positioned area the bar and the pill live in
 * @param {{ width: number, height: number }} bar the horizontal bar's own size
 * @param {{ width: number, top: number, height: number } | null} pill the zoom pill, relative to the area (null: not shown)
 * @param {{ margin?: number }} [opts] `margin`: the least distance to the area's left edge
 * @returns {{ left: number, top: number, pillInset: number }} `pillInset` is the padding-left that moves a centred pill by half of bar + gap
 */
export function computeDock(area, bar, pill, { margin = 8 } = {}) {
  const shown = pill !== null && pill.width > 0;
  const group = bar.width + (shown ? DOCK_GAP + pill.width : 0);
  const left = Math.max(margin, (area.width - group) / 2);
  const top = shown ? pill.top + pill.height / 2 - bar.height / 2 : area.height - DOCK_BOTTOM - bar.height;
  return { left, top, pillInset: shown ? bar.width + DOCK_GAP : 0 };
}
