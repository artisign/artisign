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
});
