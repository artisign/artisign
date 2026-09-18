import { describe, it, expect } from "vitest";
import { parseScreen } from "./parser.js";
import { computeDriftWarnings } from "./validate.js";
import type { DesignSystemRegistry } from "./registry.js";
import type { TokensDocument } from "../store/index.js";

const registry: DesignSystemRegistry = {
  componentNames: new Set(),
  tokenPaths: new Set(["color.primary"]),
  tokenFlatNames: new Set(["primary"]),
};

const tokens: TokensDocument = { color: { primary: "#3366ff" } };

describe("computeDriftWarnings", () => {
  it("warns when an inline style value equals an existing token's value", () => {
    const html = `<div id="n1" style="color: #3366ff"></div>`;
    const { doc } = parseScreen(html, "s", registry);
    const warnings = computeDriftWarnings(doc, tokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "#3366ff" for "color" matches token $color.primary',
        nodeId: "n1",
        suggestion: "$color.primary",
      },
    ]);
  });

  it("does not warn when the inline value matches no token", () => {
    const html = `<div id="n1" style="color: #000000"></div>`;
    const { doc } = parseScreen(html, "s", registry);
    expect(computeDriftWarnings(doc, tokens)).toEqual([]);
  });

  it("never blocks — drift is a warning, not an error", () => {
    const html = `<div id="n1" style="color: #3366ff"></div>`;
    const { errors } = parseScreen(html, "s", registry);
    expect(errors).toEqual([]);
  });

  it("matches a hex color case-insensitively", () => {
    const html = `<div id="n1" style="color: #3366FF"></div>`;
    const { doc } = parseScreen(html, "s", registry);
    const warnings = computeDriftWarnings(doc, tokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "#3366FF" for "color" matches token $color.primary',
        nodeId: "n1",
        suggestion: "$color.primary",
      },
    ]);
  });

  it("fires for a non-color bucket too (spacing), on exact match", () => {
    const spacingRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.md"]),
      tokenFlatNames: new Set(["md"]),
    };
    const spacingTokens: TokensDocument = { spacing: { md: "16px" } };
    const html = `<div id="n1" style="padding: 16px"></div>`;
    const { doc } = parseScreen(html, "s", spacingRegistry);
    const warnings = computeDriftWarnings(doc, spacingTokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "16px" for "padding" matches token $spacing.md',
        nodeId: "n1",
        suggestion: "$spacing.md",
      },
    ]);
  });

  it("does not false-positive on two different hex colors that merely share case", () => {
    const html = `<div id="n1" style="color: #ABCDEF"></div>`;
    const { doc } = parseScreen(html, "s", registry);
    expect(computeDriftWarnings(doc, tokens)).toEqual([]);
  });

  it("resolves a value collision between two tokens deterministically", () => {
    const collideTokens: TokensDocument = { color: { text: "#000000", black: "#000000" } };
    const collideRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["color.text", "color.black"]),
      tokenFlatNames: new Set(["text", "black"]),
    };
    const html = `<div id="n1" style="color: #000000"></div>`;
    const { doc } = parseScreen(html, "s", collideRegistry);
    const warnings = computeDriftWarnings(doc, collideTokens);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.suggestion).toBe("$color.black"); // lexicographically first of the tied candidates
  });

  it("prefers an exact-notation match over a case-insensitive-only match when both exist", () => {
    const collideTokens: TokensDocument = { color: { upper: "#3366FF", lower: "#3366ff" } };
    const collideRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["color.upper", "color.lower"]),
      tokenFlatNames: new Set(["upper", "lower"]),
    };
    const html = `<div id="n1" style="color: #3366ff"></div>`;
    const { doc } = parseScreen(html, "s", collideRegistry);
    const warnings = computeDriftWarnings(doc, collideTokens);
    expect(warnings[0]!.suggestion).toBe("$color.lower");
  });

  it("does not suggest a token from an unrelated bucket for a known property", () => {
    const spacingRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.md"]),
      tokenFlatNames: new Set(["md"]),
    };
    const spacingTokens: TokensDocument = { spacing: { md: "16px" } };
    const html = `<div id="n1" style="font-size: 16px"></div>`;
    const { doc } = parseScreen(html, "s", spacingRegistry);
    expect(computeDriftWarnings(doc, spacingTokens)).toEqual([]);
  });

  it("prefers the property-appropriate bucket when multiple buckets share a value", () => {
    const mixedRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.md", "typography.body"]),
      tokenFlatNames: new Set(["md", "body"]),
    };
    const mixedTokens: TokensDocument = { spacing: { md: "16px" }, typography: { body: "16px" } };
    const html = `<div id="n1" style="font-size: 16px"></div>`;
    const { doc } = parseScreen(html, "s", mixedRegistry);
    const warnings = computeDriftWarnings(doc, mixedTokens);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.suggestion).toBe("$typography.body");
  });

  it("does not match width against typography, despite equal values", () => {
    const typographyRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["typography.size-xxs"]),
      tokenFlatNames: new Set(["size-xxs"]),
    };
    const typographyTokens: TokensDocument = { typography: { "size-xxs": "11px" } };
    const html = `<div id="n1" style="width: 11px"></div>`;
    const { doc } = parseScreen(html, "s", typographyRegistry);
    expect(computeDriftWarnings(doc, typographyTokens)).toEqual([]);
  });

  it("never matches a positioning offset like left, even against a spacing token", () => {
    const spacingRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.sm"]),
      tokenFlatNames: new Set(["sm"]),
    };
    const spacingTokens: TokensDocument = { spacing: { sm: "8px" } };
    const html = `<div id="n1" style="left: 8px"></div>`;
    const { doc } = parseScreen(html, "s", spacingRegistry);
    expect(computeDriftWarnings(doc, spacingTokens)).toEqual([]);
  });

  // CHR-634: letter-spacing, width/height and shorthand values were missed.

  it("matches letter-spacing against a dedicated tracking bucket (CHR-634)", () => {
    const trackingRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["tracking.wider"]),
      tokenFlatNames: new Set(["wider"]),
    };
    const trackingTokens: TokensDocument = { tracking: { wider: "0.18em" } };
    const html = `<div id="n1" style="letter-spacing: 0.18em"></div>`;
    const { doc } = parseScreen(html, "s", trackingRegistry);
    const warnings = computeDriftWarnings(doc, trackingTokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "0.18em" for "letter-spacing" matches token $tracking.wider',
        nodeId: "n1",
        suggestion: "$tracking.wider",
      },
    ]);
  });

  it("matches width against a size bucket (CHR-634)", () => {
    const sizeRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["size.tap"]),
      tokenFlatNames: new Set(["tap"]),
    };
    const sizeTokens: TokensDocument = { size: { tap: "44px" } };
    const html = `<div id="n1" style="width: 44px"></div>`;
    const { doc } = parseScreen(html, "s", sizeRegistry);
    const warnings = computeDriftWarnings(doc, sizeTokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "44px" for "width" matches token $size.tap',
        nodeId: "n1",
        suggestion: "$size.tap",
      },
    ]);
  });

  it("matches each part of a shorthand value independently (CHR-634)", () => {
    const spacingRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.clip-gap", "spacing.feed"]),
      tokenFlatNames: new Set(["clip-gap", "feed"]),
    };
    const spacingTokens: TokensDocument = { spacing: { "clip-gap": "14px", feed: "20px" } };
    const html = `<div id="n1" style="padding: 14px 20px"></div>`;
    const { doc } = parseScreen(html, "s", spacingRegistry);
    const warnings = computeDriftWarnings(doc, spacingTokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "14px 20px" for "padding" matches tokens $spacing.clip-gap $spacing.feed',
        nodeId: "n1",
        suggestion: "$spacing.clip-gap $spacing.feed",
      },
    ]);
  });

  it("still does not match width against a typography-only 11px token (CHR-495 regression guard)", () => {
    const typographyRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["typography.size-xxs"]),
      tokenFlatNames: new Set(["size-xxs"]),
    };
    const typographyTokens: TokensDocument = { typography: { "size-xxs": "11px" } };
    const html = `<div id="n1" style="width: 11px"></div>`;
    const { doc } = parseScreen(html, "s", typographyRegistry);
    expect(computeDriftWarnings(doc, typographyTokens)).toEqual([]);
  });

  it("only replaces the matching parts of a shorthand, leaving the rest literal (CHR-634)", () => {
    const spacingRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.clip-gap"]),
      tokenFlatNames: new Set(["clip-gap"]),
    };
    const spacingTokens: TokensDocument = { spacing: { "clip-gap": "14px" } };
    const html = `<div id="n1" style="padding: 14px 20px"></div>`;
    const { doc } = parseScreen(html, "s", spacingRegistry);
    const warnings = computeDriftWarnings(doc, spacingTokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "14px 20px" for "padding" matches tokens $spacing.clip-gap 20px',
        nodeId: "n1",
        suggestion: "$spacing.clip-gap 20px",
      },
    ]);
  });

  it("does not split a value inside a function call (calc/rgb/alpha) (CHR-634)", () => {
    const radiusRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["radius.pill"]),
      tokenFlatNames: new Set(["pill"]),
    };
    const radiusTokens: TokensDocument = { radius: { pill: "calc(1px + 2px)" } };
    const html = `<div id="n1" style="border-radius: calc(1px + 2px)"></div>`;
    const { doc } = parseScreen(html, "s", radiusRegistry);
    const warnings = computeDriftWarnings(doc, radiusTokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "calc(1px + 2px)" for "border-radius" matches token $radius.pill',
        nodeId: "n1",
        suggestion: "$radius.pill",
      },
    ]);
  });
});
