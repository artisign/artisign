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

  it("outlines [data-unresolved-backdrop] with the other unresolved-ref markers", () => {
    expect(RENDER_BASELINE_CSS).toContain("[data-unresolved-backdrop]");
  });

  it("switches every marker's outline off inside a backdrop layer, but not the marker on the overlay root", () => {
    const markerRule = /^\[data-unresolved-component\][^{]*\{[^}]*outline: 2px[^}]*\}/m.exec(RENDER_BASELINE_CSS)?.[0] ?? "";
    const names = ["unresolved-component", "invalid-component", "recursive-component", "empty-component", "unresolved-token", "unresolved-icon-font", "unresolved-backdrop"];
    for (const name of names) {
      expect(markerRule).toContain(`[data-${name}]`);
      expect(RENDER_BASELINE_CSS).toContain(`[data-backdrop-layer] [data-${name}]`);
    }
    // the rule that switches them off applies only inside a layer
    const offRule = /\[data-backdrop-layer\] \[data-unresolved-component\][^{]*\{[^}]*\}/.exec(RENDER_BASELINE_CSS)?.[0] ?? "";
    expect(offRule).toContain("outline: none");
    for (const selector of offRule.slice(0, offRule.indexOf("{")).split(",")) {
      expect(selector.trim().startsWith("[data-backdrop-layer] ")).toBe(true);
    }
  });

  it("outlines [data-unresolved-icon-font] in the same diagnostic-marker rule as the other unresolved-ref markers", () => {
    const html = wrapRenderedHtml("<div></div>");
    expect(RENDER_BASELINE_CSS).toContain("[data-unresolved-icon-font]");
    expect(html).toContain("[data-unresolved-icon-font]");
  });
});
