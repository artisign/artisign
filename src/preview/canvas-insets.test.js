import { describe, it, expect } from "vitest";
import { computeCanvasInsets } from "./canvas-insets.js";

const BANDS = { top: 76, bottom: 80, gap: 16 };

describe("computeCanvasInsets", () => {
  it("reads the open layout: card + tool bar on the left, the right column on the right", () => {
    const cards = [
      { left: 16, right: 272 }, // Screens card
      { left: 288, right: 340 }, // tool bar
      { left: 1328, right: 1584 }, // Agent bar
    ];
    expect(computeCanvasInsets(1600, cards, BANDS)).toEqual({ left: 356, right: 288, top: 76, bottom: 80 });
  });

  it("a folded Screens card leaves only the tool bar", () => {
    expect(computeCanvasInsets(1600, [{ left: 16, right: 68 }], BANDS).left).toBe(84);
  });

  it("cards dragged toward the centre never leave a collapsed free area", () => {
    const cards = [
      { left: 740, right: 792 }, // tool bar, centre left of 800
      { left: 810, right: 1066 }, // Agent bar, centre right of 800
    ];
    const insets = computeCanvasInsets(1600, cards, BANDS);
    expect(1600 - insets.left - insets.right).toBeGreaterThanOrEqual(200);
    expect(insets.left).toBeGreaterThan(0);
    expect(insets.right).toBeGreaterThan(0);
  });

  it("no cards, no insets beyond the bands", () => {
    expect(computeCanvasInsets(1600, [], BANDS)).toEqual({ left: 0, right: 0, top: 76, bottom: 80 });
  });
});
