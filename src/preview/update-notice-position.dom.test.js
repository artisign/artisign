// @vitest-environment jsdom
//
// CHR-929 — the update toast sits in the upper right, 16px below the topbar or below the bar at the top of the current view.
import { describe, it, expect, vi, afterEach } from "vitest";
import { pinBelowTopBars } from "./update-notice.js";

function el(rect, shown = true) {
  const node = document.createElement("div");
  node.getBoundingClientRect = () => ({ top: rect.top, bottom: rect.bottom });
  node.getClientRects = () => (shown ? [rect] : []);
  return node;
}

afterEach(() => vi.unstubAllGlobals());

describe("pinBelowTopBars", () => {
  it("is 16px below the topbar when no bar is shown", () => {
    const region = document.createElement("div");
    pinBelowTopBars(region, el({ top: 44, bottom: 900 }), [el({ top: 44, bottom: 80 }, false)]);
    expect(region.style.top).toBe("16px");
  });

  it("is 16px below the lowest shown bar, and follows it when it resizes", () => {
    let observed;
    vi.stubGlobal("ResizeObserver", class { constructor(cb) { observed = cb; } observe() {} });
    const region = document.createElement("div");
    const bar = el({ top: 44, bottom: 80 });
    pinBelowTopBars(region, el({ top: 44, bottom: 900 }), [bar, el({ top: 44, bottom: 300 }, false)]);
    expect(region.style.top).toBe("52px");
    bar.getBoundingClientRect = () => ({ top: 44, bottom: 112 }); // the breadcrumb wrapped onto a second line
    observed();
    expect(region.style.top).toBe("84px");
  });
});
