import { describe, it, expect } from "vitest";
import { anchoredPosition, createWheelClassifier } from "./canvas-input.js";

const wheel = (over) => ({ ctrlKey: false, metaKey: false, deltaX: 0, deltaY: 0, deltaMode: 0, ...over });

describe("createWheelClassifier — the one mouse-vs-trackpad heuristic", () => {
  it("zooms for Ctrl/Cmd + wheel and for a pinch (Ctrl + small deltas)", () => {
    const classify = createWheelClassifier(() => 0);
    expect(classify(wheel({ ctrlKey: true, deltaY: -3.5 }))).toBe("zoom");
    expect(classify(wheel({ metaKey: true, deltaY: 100 }))).toBe("zoom");
  });

  it("zooms for a notched wheel: line mode, or whole pixel steps of a notch's size", () => {
    const classify = createWheelClassifier(() => 0);
    expect(classify(wheel({ deltaMode: 1, deltaY: 3 }))).toBe("zoom");
    expect(classify(wheel({ deltaY: 100 }))).toBe("zoom");
    expect(classify(wheel({ deltaY: -120 }))).toBe("zoom");
  });

  it("pans for a trackpad two-finger scroll: small or fractional steps, any horizontal part", () => {
    const classify = createWheelClassifier(() => 0);
    expect(classify(wheel({ deltaY: 4 }))).toBe("pan");
    expect(classify(wheel({ deltaY: 61.5 }))).toBe("pan");
    expect(classify(wheel({ deltaX: 12, deltaY: 130 }))).toBe("pan");
  });

  it("keeps the tail of a trackpad flick a pan, then lets a notch zoom again", () => {
    let t = 0;
    const classify = createWheelClassifier(() => t);
    expect(classify(wheel({ deltaY: 8 }))).toBe("pan");
    t = 50;
    expect(classify(wheel({ deltaY: 100 }))).toBe("pan"); // inertia still going
    t = 600;
    expect(classify(wheel({ deltaY: 100 }))).toBe("zoom");
  });
});

describe("anchoredPosition", () => {
  it("keeps the point under the pointer in place", () => {
    // frame edge at 100, pointer at 300, zoom 1 -> 2: the content point 200 px right of the edge stays under the pointer
    const left = anchoredPosition({ pointer: 300, position: 100, oldScale: 1, newScale: 2 });
    expect(left).toBe(-100);
    expect((300 - left) / 2).toBe((300 - 100) / 1);
  });

  it("leaves the frame alone when the scale does not change", () => {
    expect(anchoredPosition({ pointer: 40, position: 12, oldScale: 0.5, newScale: 0.5 })).toBe(12);
  });
});
