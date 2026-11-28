// CHR-1287 — the docked tool bar's geometry.
import { describe, it, expect } from "vitest";
import { computeDock, inDockZone, DOCK_ZONE, DOCK_GAP, DOCK_BOTTOM } from "./tool-dock.js";

describe("inDockZone", () => {
  it("is the bottom snap zone of the window", () => {
    expect(inDockZone(900 - DOCK_ZONE, 900)).toBe(true);
    expect(inDockZone(900 - DOCK_ZONE - 1, 900)).toBe(false);
    expect(inDockZone(10, 900)).toBe(false);
  });
});

describe("computeDock", () => {
  const area = { width: 1440, height: 900 };
  const bar = { width: 400, height: 56 };
  const pill = { width: 240, top: 840, height: 44 };

  it("centres bar, gap and pill together, so they never overlap", () => {
    const dock = computeDock(area, bar, pill);
    const group = bar.width + DOCK_GAP + pill.width;
    expect(dock.left).toBe((1440 - group) / 2);
    // the pill, centred in the area minus the inset, starts exactly one gap after the bar
    const pillLeft = dock.pillInset + (area.width - dock.pillInset) / 2 - pill.width / 2;
    expect(pillLeft).toBe(dock.left + bar.width + DOCK_GAP);
    expect(dock.pillInset).toBe(bar.width + DOCK_GAP);
  });

  it("shares the pill's baseline: both centred on one line", () => {
    const dock = computeDock(area, bar, pill);
    expect(dock.top + bar.height / 2).toBe(pill.top + pill.height / 2);
  });

  it("without a pill the bar is centred alone on the pill's bottom line", () => {
    expect(computeDock(area, bar, null)).toEqual({ left: (1440 - 400) / 2, top: 900 - DOCK_BOTTOM - 56, pillInset: 0 });
    expect(computeDock(area, bar, { ...pill, width: 0 }).pillInset).toBe(0);
  });

  it("a group wider than the area stays at the left margin", () => {
    expect(computeDock({ width: 500, height: 900 }, bar, pill, { margin: 8 }).left).toBe(8);
  });
});
