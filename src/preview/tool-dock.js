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
 * The docked bar's place and how far the zoom pill moves to make room: bar, gap and pill form one group, centred in the area, or, when side panels leave less room than that, kept inside the free span between them. Without a pill (hidden while comparing) the bar is centred alone on the pill's baseline.
 * @param {{ width: number, height: number }} area the positioned area the bar and the pill live in
 * @param {{ width: number, height: number }} bar the horizontal bar's own size
 * @param {{ width: number, top: number, height: number } | null} pill the zoom pill, relative to the area (null: not shown)
 * @param {{ margin?: number, span?: { left: number, right: number } }} [opts] `margin`: the least distance to the area's left edge. `span`: the free space between the panels that reach the bottom band.
 * @returns {{ left: number, top: number, padLeft: number, padRight: number }} `padLeft` / `padRight` are the paddings of the element that centres the pill: together they put the pill one gap right of the bar
 */
export function computeDock(area, bar, pill, { margin = 8, span = { left: margin, right: area.width - margin } } = {}) {
  const shown = pill !== null && pill.width > 0;
  const group = bar.width + (shown ? DOCK_GAP + pill.width : 0);
  const centred = (area.width - group) / 2;
  // A group that does not fit the span stays centred (the panels then have to give way: the bar is above them).
  const left = group > span.right - span.left ? centred : Math.min(Math.max(centred, span.left), span.right - group);
  const top = shown ? pill.top + pill.height / 2 - bar.height / 2 : area.height - DOCK_BOTTOM - bar.height;
  const bounded = Math.max(margin, left);
  if (!shown) return { left: bounded, top, padLeft: 0, padRight: 0 };
  const pillCentre = bounded + bar.width + DOCK_GAP + pill.width / 2;
  const shift = 2 * pillCentre - area.width; // > 0: the pill sits right of the centre
  return { left: bounded, top, padLeft: Math.max(0, shift), padRight: Math.max(0, -shift) };
}
