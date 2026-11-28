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
    expect(applyCanvas({ ...stubs(), zoom: "fit" })).toEqual({ width: 390, height: 844 });
  });

  it("reserves a top band: the fit scale shrinks and the frame sits below it", () => {
    const plain = stubs();
    applyCanvas({ ...plain, zoom: "fit" });
    const banded = stubs();
    applyCanvas({ ...banded, zoom: "fit", topInset: 28 });
    expect(parseFloat(banded.holderEl.style.transform.slice(6))).toBeLessThan(parseFloat(plain.holderEl.style.transform.slice(6)));
    expect(parseFloat(banded.holderEl.style.top)).toBeGreaterThanOrEqual(28);
  });

  it("moves the frame off its centred place by the pan offset (CHR-1290)", () => {
    const centred = stubs();
    applyCanvas({ ...centred, zoom: 1 });
    const panned = stubs();
    applyCanvas({ ...panned, zoom: 1, pan: { x: 40, y: -25 } });
    expect(parseFloat(panned.holderEl.style.left)).toBe(parseFloat(centred.holderEl.style.left) + 40);
    expect(parseFloat(panned.holderEl.style.top)).toBe(parseFloat(centred.holderEl.style.top) - 25);
    expect(panned.holderEl.style.transform).toBe(centred.holderEl.style.transform);
  });
});
