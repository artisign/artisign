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

  it("no cards, no insets beyond the bands", () => {
    expect(computeCanvasInsets(1600, [], BANDS)).toEqual({ left: 0, right: 0, top: 76, bottom: 80 });
  });
});
