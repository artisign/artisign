import { describe, it, expect } from "vitest";
import { rewriteLiteralStyleValueInDefinition } from "./rewrite-literal-style.js";

describe("rewriteLiteralStyleValueInDefinition", () => {
  it("replaces a matching literal declaration with a $path ref", () => {
    const { html, changed } = rewriteLiteralStyleValueInDefinition(
      `<button style="color: #3366ff">Go</button>`,
      "#3366ff",
      "color.brand",
    );
    expect(changed).toBe(true);
    expect(html).toBe(`<button style="color: $color.brand">Go</button>`);
  });

  it("reports changed:false and leaves html untouched when nothing matches", () => {
    const original = `<button style="color: #000000">Go</button>`;
    const { html, changed } = rewriteLiteralStyleValueInDefinition(original, "#3366ff", "color.brand");
    expect(changed).toBe(false);
    expect(html).toBe(original);
  });

  it("rewrites a value across every top-level element, including inside a <template> variant", () => {
    const original =
      `<button style="color: #3366ff">Go</button>\n` +
      `<template data-variant="hover"><button style="color: #3366ff; box-shadow: 0 1px 2px #000">Go</button></template>`;
    const { html, changed } = rewriteLiteralStyleValueInDefinition(original, "#3366ff", "color.brand");
    expect(changed).toBe(true);
    expect(html).toBe(original.replaceAll("color: #3366ff", "color: $color.brand"));
  });

  it("does not touch a matching literal inside a comment", () => {
    const original = `<button style="color: #3366ff">Go</button>\n<!-- <button style="color: #3366ff"> -->`;
    const { html } = rewriteLiteralStyleValueInDefinition(original, "#3366ff", "color.brand");
    expect(html).toContain(`<!-- <button style="color: #3366ff"> -->`);
    expect(html).toContain(`<button style="color: $color.brand">Go</button>`);
  });

  it("does not touch a matching literal inside escaped example text", () => {
    const original = `<button style="color: #3366ff">Go</button>\n<code>&lt;p style="color: #3366ff"&gt;</code>`;
    const { html } = rewriteLiteralStyleValueInDefinition(original, "#3366ff", "color.brand");
    expect(html).toContain(`<code>&lt;p style="color: #3366ff"&gt;</code>`);
    expect(html).toContain(`<button style="color: $color.brand">Go</button>`);
  });

  it("compares against the decoded value and re-escapes correctly on write", () => {
    const { html, changed } = rewriteLiteralStyleValueInDefinition(
      `<h1 style="font-family: &quot;Inter&quot;, sans-serif">Title</h1>`,
      `"Inter", sans-serif`,
      "typography.heading",
    );
    expect(changed).toBe(true);
    expect(html).toBe(`<h1 style="font-family: $typography.heading">Title</h1>`);
  });

  it("preserves a multi-rooted definition in full, only touching the matched attribute", () => {
    const original = `<section id="s" style="color: #3366ff"><h1>A</h1></section>\n<footer id="f">B</footer>`;
    const { html } = rewriteLiteralStyleValueInDefinition(original, "#3366ff", "color.brand");
    expect(html).toBe(`<section id="s" style="color: $color.brand"><h1>A</h1></section>\n<footer id="f">B</footer>`);
  });

  it("does not generate ids or otherwise reformat untouched markup", () => {
    const original =
      `<button style="color: #3366ff">\n  <span>Go</span>\n</button>\n` +
      `<template data-variant="hover">\n  <button style="color: #3366ff; box-shadow: 0 1px 2px #000">\n    <span>Go</span>\n  </button>\n</template>`;
    const { html } = rewriteLiteralStyleValueInDefinition(original, "#3366ff", "color.brand");
    expect(html).toBe(original.replaceAll("color: #3366ff", "color: $color.brand"));
    expect(html).not.toMatch(/id="/);
  });
});
