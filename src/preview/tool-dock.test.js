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
    const pillLeft = dock.padLeft + (area.width - dock.padLeft - dock.padRight) / 2 - pill.width / 2;
    expect(pillLeft).toBe(dock.left + bar.width + DOCK_GAP);
    expect(dock.padLeft).toBe(bar.width + DOCK_GAP);
    expect(dock.padRight).toBe(0);
  });

  it("shares the pill's baseline: both centred on one line", () => {
    const dock = computeDock(area, bar, pill);
    expect(dock.top + bar.height / 2).toBe(pill.top + pill.height / 2);
  });

  it("without a pill the bar is centred alone on the pill's bottom line", () => {
    expect(computeDock(area, bar, null)).toEqual({ left: (1440 - 400) / 2, top: 900 - DOCK_BOTTOM - 56, padLeft: 0, padRight: 0 });
    expect(computeDock(area, bar, { ...pill, width: 0 }).padLeft).toBe(0);
  });

  it("a group wider than the area stays at the left margin", () => {
    expect(computeDock({ width: 500, height: 900 }, bar, pill, { margin: 8 }).left).toBe(8);
  });

  it("wide panels on both sides keep the group inside the free span between them, the pill following", () => {
    const span = { left: 504, right: 1432 };
    const dock = computeDock(area, bar, pill, { span });
    const group = bar.width + DOCK_GAP + pill.width;
    expect(dock.left).toBeGreaterThanOrEqual(span.left);
    expect(dock.left + group).toBeLessThanOrEqual(span.right);
    const pillLeft = dock.padLeft + (area.width - dock.padLeft - dock.padRight) / 2 - pill.width / 2;
    expect(pillLeft).toBeCloseTo(dock.left + bar.width + DOCK_GAP, 6);
  });

  it("a left panel alone pushes the group right; a right panel alone pushes it left, padding the other side", () => {
    const right = computeDock(area, bar, pill, { span: { left: 8, right: 800 } });
    expect(right.left + bar.width + DOCK_GAP + pill.width).toBeLessThanOrEqual(800);
    expect(right.padRight).toBeGreaterThan(0);
    expect(right.padLeft).toBe(0);
  });

  it("a group wider than the span stays centred", () => {
    expect(computeDock(area, bar, pill, { span: { left: 600, right: 700 } }).left).toBe((1440 - (bar.width + DOCK_GAP + pill.width)) / 2);
  });
});
