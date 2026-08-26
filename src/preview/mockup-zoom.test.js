// @vitest-environment jsdom
//
// jsdom needed (not the fast node environment other pure-math modules use
// like canvas.test.js) since applyMockupZoom reads/writes real DOM
// elements — but layout (clientWidth/scrollWidth) is stubbed since jsdom
// never actually lays anything out. Mirrors the applyCanvas/fitScale split.
import { describe, it, expect } from "vitest";
import { applyMockupZoom } from "./mockup-zoom.js";

/** Builds a paneEl > wrapperEl > columnsEl chain with stubbed layout sizes. */
function setup({ paneW, paneH, columnsW, columnsH }) {
  const paneEl = document.createElement("div");
  Object.defineProperty(paneEl, "clientWidth", { value: paneW });
  Object.defineProperty(paneEl, "clientHeight", { value: paneH });

  const wrapperEl = document.createElement("div");
  const columnsEl = document.createElement("div");
  Object.defineProperty(columnsEl, "scrollWidth", { value: columnsW, configurable: true });
  Object.defineProperty(columnsEl, "scrollHeight", { value: columnsH, configurable: true });

  wrapperEl.appendChild(columnsEl);
  paneEl.appendChild(wrapperEl);
  return { paneEl, wrapperEl, columnsEl };
}

describe("applyMockupZoom", () => {
  it("scales the columns row down to fit the pane at zoom 'fit'", () => {
    const { paneEl, wrapperEl, columnsEl } = setup({ paneW: 500, paneH: 900, columnsW: 1000, columnsH: 400 });
    applyMockupZoom({ paneEl, columnsEl, zoom: "fit" });

    expect(columnsEl.style.transform).toBe("scale(0.5)");
    expect(columnsEl.style.transformOrigin).toBe("top left");
    expect(wrapperEl.style.width).toBe("500px");
    expect(wrapperEl.style.height).toBe("200px");
  });

  it("caps 'fit' at 1 instead of upscaling a row smaller than the pane", () => {
    const { paneEl, wrapperEl, columnsEl } = setup({ paneW: 2000, paneH: 2000, columnsW: 400, columnsH: 200 });
    applyMockupZoom({ paneEl, columnsEl, zoom: "fit" });

    expect(columnsEl.style.transform).toBe("scale(1)");
    expect(wrapperEl.style.width).toBe("400px");
    expect(wrapperEl.style.height).toBe("200px");
  });

  it("applies a fixed zoom level as-is, ignoring the pane size", () => {
    const { paneEl, wrapperEl, columnsEl } = setup({ paneW: 100, paneH: 100, columnsW: 400, columnsH: 200 });
    applyMockupZoom({ paneEl, columnsEl, zoom: 2 });

    expect(columnsEl.style.transform).toBe("scale(2)");
    expect(wrapperEl.style.width).toBe("800px");
    expect(wrapperEl.style.height).toBe("400px");
  });

  it("subtracts the pane's own padding from the available space instead of overestimating room by it", () => {
    const { paneEl, wrapperEl, columnsEl } = setup({ paneW: 520, paneH: 500, columnsW: 1000, columnsH: 400 });
    paneEl.style.padding = "20px"; // matches #mockup-view's real padding: $spacing-2xl in style.css
    applyMockupZoom({ paneEl, columnsEl, zoom: "fit" });

    // Content-box width is 520 - 2*20 = 480, not the raw clientWidth (520).
    expect(columnsEl.style.transform).toBe("scale(0.48)");
    expect(wrapperEl.style.width).toBe("480px");
  });

  it("re-measures scrollHeight on every call — a wrapper sized while a column was still at its placeholder height is corrected once the real (taller) content is known", () => {
    const { paneEl, wrapperEl, columnsEl } = setup({ paneW: 900, paneH: 900, columnsW: 800, columnsH: 200 });
    applyMockupZoom({ paneEl, columnsEl, zoom: "fit" });
    expect(wrapperEl.style.height).toBe("200px"); // content still shorter than the pane, no shrink needed yet

    // The real variant turns out to be much taller than the pane (e.g. an
    // iframe whose height only settles one rAF after `load` — see
    // iframe-fit.js's onFitted). A later re-application must reflect the
    // NEW scrollHeight, not keep sizing the wrapper off the stale one.
    Object.defineProperty(columnsEl, "scrollHeight", { value: 1800, configurable: true });
    applyMockupZoom({ paneEl, columnsEl, zoom: "fit" });

    expect(columnsEl.style.transform).toBe("scale(0.5)"); // now height-bound: 900/1800
    expect(wrapperEl.style.height).toBe("900px");
    expect(wrapperEl.style.width).toBe("400px"); // 800 * 0.5, not the earlier call's width
  });

  it("does nothing when columnsEl has no parent (not yet attached)", () => {
    const paneEl = document.createElement("div");
    const columnsEl = document.createElement("div");
    expect(() => applyMockupZoom({ paneEl, columnsEl, zoom: "fit" })).not.toThrow();
  });
});
