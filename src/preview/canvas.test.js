import { describe, it, expect } from "vitest";
import { fitScale, applyCanvas } from "./canvas.js";

describe("fitScale", () => {
  it("shrinks a 390x844 screen to fit a 900px-tall available area when height is the tighter constraint", () => {
    const scale = fitScale(1200, 700, 390, 844);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeCloseTo(700 / 844, 5);
  });

  it("shrinks to the tighter constraint when width is the limiting dimension", () => {
    const scale = fitScale(300, 900, 390, 844);
    expect(scale).toBeCloseTo(300 / 390, 5);
  });

  it("caps at 1 instead of upscaling a screen smaller than the available space", () => {
    const scale = fitScale(1200, 900, 200, 300);
    expect(scale).toBe(1);
  });

  it("returns 1 for a degenerate (zero or negative) size instead of dividing by zero", () => {
    expect(fitScale(1200, 900, 0, 844)).toBe(1);
    expect(fitScale(0, 900, 390, 844)).toBe(1);
  });
});

describe("applyCanvas", () => {
  function stubs() {
    const style = () => ({ setProperty() {} });
    return {
      canvasEl: { clientWidth: 1000, clientHeight: 700 },
      holderEl: { style: style() },
      iframeEl: { style: style(), contentDocument: { body: { firstElementChild: { offsetWidth: 390, offsetHeight: 844 } } } },
    };
  }

  it("returns the screen's unscaled size for the frame caption", () => {
    expect(applyCanvas({ ...stubs(), zoom: "fit" })).toMatchObject({ width: 390, height: 844 });
  });

  it("reserves a top band: the fit scale shrinks and the frame sits below it", () => {
    const plain = stubs();
    applyCanvas({ ...plain, zoom: "fit" });
    const banded = stubs();
    applyCanvas({ ...banded, zoom: "fit", topInset: 28 });
    expect(parseFloat(banded.holderEl.style.transform.slice(6))).toBeLessThan(parseFloat(plain.holderEl.style.transform.slice(6)));
    expect(parseFloat(banded.holderEl.style.top)).toBeGreaterThanOrEqual(28);
  });

  it("fits and centres in the area the cards leave free, without moving the canvas origin (CHR-1299)", () => {
    const open = stubs();
    applyCanvas({ ...open, zoom: 1, insets: { left: 356, right: 288, top: 76, bottom: 80 } });
    // 1000 - 356 - 288 = 356 free: the 390px frame no longer fits; it starts at the left inset.
    expect(parseFloat(open.holderEl.style.left)).toBe(356);
    const fit = stubs();
    applyCanvas({ ...fit, zoom: "fit", insets: { left: 356, right: 288, top: 76, bottom: 80 } });
    expect(parseFloat(fit.holderEl.style.transform.slice(6))).toBeCloseTo(544 / 844, 5); // height is the tighter side: 700 - 76 - 80
    const centred = stubs();
    applyCanvas({ ...centred, zoom: 0.25, insets: { left: 200, right: 100, top: 0, bottom: 0 } });
    // free 700 wide, frame 97.5 wide: centred in it, offset by the left inset.
    expect(parseFloat(centred.holderEl.style.left)).toBeCloseTo(200 + (700 - 97.5) / 2, 5);
  });

  it("leaves scroll room for what the cards cover beyond the frame's far edge (CHR-1299)", () => {
    const props = {};
    const c = { ...stubs(), canvasEl: { clientWidth: 1000, clientHeight: 700, style: { setProperty: (k, v) => (props[k] = v) } } };
    applyCanvas({ ...c, zoom: 2, insets: { left: 100, right: 300, top: 76, bottom: 80 } });
    // 390 x 844 at 200 %: 780 x 1688, starting at the insets (it is larger than the free area).
    expect(props["--room-w"]).toBe(`${100 + 780 + 300}px`);
    expect(props["--room-h"]).toBe(`${76 + 1688 + 80}px`);
  });

  it("pans a frame that fits by the offset, per axis, inside the pane (CHR-1290)", () => {
    const centred = stubs();
    applyCanvas({ ...centred, zoom: 0.25 });
    const moved = stubs();
    const out = applyCanvas({ ...moved, zoom: 0.25, pan: { x: 40, y: -25 } });
    expect(parseFloat(moved.holderEl.style.left)).toBe(parseFloat(centred.holderEl.style.left) + 40);
    expect(parseFloat(moved.holderEl.style.top)).toBe(parseFloat(centred.holderEl.style.top) - 25);
    expect(out.pan).toEqual({ x: 40, y: -25 });
    const far = stubs();
    const clamped = applyCanvas({ ...far, zoom: 0.25, pan: { x: 99999, y: -99999 } });
    expect(parseFloat(far.holderEl.style.left)).toBe(1000 - 390 * 0.25); // the frame stays inside the pane
    expect(parseFloat(far.holderEl.style.top)).toBe(0);
    expect(clamped.pan.x).toBeGreaterThan(0);
  });

  it("ignores the offset on an axis where the frame overflows: that axis scrolls (CHR-1290)", () => {
    const a = stubs();
    applyCanvas({ ...a, zoom: 2 });
    const b = stubs();
    const out = applyCanvas({ ...b, zoom: 2, pan: { x: 40, y: 40 } });
    expect(parseFloat(b.holderEl.style.left)).toBe(parseFloat(a.holderEl.style.left) + 40); // 780 fits the 1000 wide pane: the offset applies
    expect(b.holderEl.style.top).toBe(a.holderEl.style.top); // 1688 does not fit 700: scroll, no offset
    expect(out.pan).toEqual({ x: 40, y: 0 });
  });
});
