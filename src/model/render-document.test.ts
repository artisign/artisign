import { describe, it, expect } from "vitest";
import { RENDER_BASELINE_CSS, wrapRenderedHtml } from "./render-document.js";

describe("wrapRenderedHtml", () => {
  it("wraps the fragment in a full document containing the baseline exactly once", () => {
    const fragment = `<div id="n1" style="color: #3366ff"></div>`;
    const html = wrapRenderedHtml(fragment);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(fragment);
    expect(html.split(RENDER_BASELINE_CSS)).toHaveLength(2); // present exactly once
    expect(html).toContain("box-sizing: border-box");
  });

  it("omits the font-face style block when no fontFaceCss is passed", () => {
    const html = wrapRenderedHtml("<div></div>");
    expect(html).not.toContain("@font-face");
  });

  it("includes the font-face style block when fontFaceCss is passed", () => {
    const fontFaceCss = `@font-face { font-family: "Inter"; src: url("inter.woff2"); }`;
    const html = wrapRenderedHtml("<div></div>", { fontFaceCss });
    expect(html).toContain(fontFaceCss);
  });

  it("outlines [data-unresolved-icon-font] in the same diagnostic-marker rule as the other unresolved-ref markers", () => {
    const html = wrapRenderedHtml("<div></div>");
    expect(RENDER_BASELINE_CSS).toContain("[data-unresolved-icon-font]");
    expect(html).toContain("[data-unresolved-icon-font]");
  });
});
