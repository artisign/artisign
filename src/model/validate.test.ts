import { describe, it, expect } from "vitest";
import { parseScreen } from "./parser.js";
import {
  computeDriftWarnings,
  computeRepeatedPatternWarnings,
  countLiteralDesignValues,
  isAdHocDesignElement,
  type StyleOccurrenceIndex,
} from "./validate.js";
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

  it("matches width against size and never falls back to typography when both hold the value (CHR-495 regression guard)", () => {
    const bothRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["size.tap", "typography.size-xxs"]),
      tokenFlatNames: new Set(["tap", "size-xxs"]),
    };
    const bothTokens: TokensDocument = { size: { tap: "11px" }, typography: { "size-xxs": "11px" } };
    const html = `<div id="n1" style="width: 11px"></div>`;
    const { doc } = parseScreen(html, "s", bothRegistry);
    const warnings = computeDriftWarnings(doc, bothTokens);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.suggestion).toBe("$size.tap");
  });

  it("still matches a multi-part value against a token holding the whole value (CHR-634)", () => {
    const shadowRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["shadow.card"]),
      tokenFlatNames: new Set(["card"]),
    };
    const shadowTokens: TokensDocument = { shadow: { card: "0 1px 2px rgba(0,0,0,0.1)" } };
    const html = `<div id="n1" style="box-shadow: 0 1px 2px rgba(0,0,0,0.1)"></div>`;
    const { doc } = parseScreen(html, "s", shadowRegistry);
    const warnings = computeDriftWarnings(doc, shadowTokens);
    expect(warnings).toEqual([
      {
        kind: "drift",
        message: 'inline value "0 1px 2px rgba(0,0,0,0.1)" for "box-shadow" matches token $shadow.card',
        nodeId: "n1",
        suggestion: "$shadow.card",
      },
    ]);
  });

  it("prefers a token holding the whole value over per-part matches (CHR-634)", () => {
    const spacingRegistry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.gutter", "spacing.sm"]),
      tokenFlatNames: new Set(["gutter", "sm"]),
    };
    const spacingTokens: TokensDocument = { spacing: { gutter: "8px 16px", sm: "8px" } };
    const html = `<div id="n1" style="padding: 8px 16px"></div>`;
    const { doc } = parseScreen(html, "s", spacingRegistry);
    const warnings = computeDriftWarnings(doc, spacingTokens);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.suggestion).toBe("$spacing.gutter");
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

describe("computeRepeatedPatternWarnings", () => {
  const noopRegistry: DesignSystemRegistry = { componentNames: new Set(), tokenPaths: new Set(), tokenFlatNames: new Set() };
  const emptyIndex: StyleOccurrenceIndex = { byScreen: new Map(), byComponent: new Map() };

  /** Builds a `StyleOccurrenceIndex` reporting one fingerprint as present on `screens`, with `component` (if given) as its default-variant-root match. */
  function indexFor(fingerprint: string, screens: string[], component?: string): StyleOccurrenceIndex {
    const byComponent = new Map<string, string>();
    if (component) byComponent.set(fingerprint, component);
    return { byScreen: new Map([[fingerprint, new Set(screens)]]), byComponent };
  }

  it("warns when a node's normalized style matches ≥1 other screen's ad-hoc node", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const fingerprint = "background:rgba(0,0,0,.4);color:#fff";
    const index = indexFor(fingerprint, ["home", "checkout"]);

    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings).toEqual([
      {
        kind: "repeated_pattern",
        nodeId: "n1",
        message: `inline style repeated on 1 other screen (checkout): "${fingerprint}"`,
        suggestion: "promote_to_system",
      },
    ]);
  });

  it("does not warn below threshold — style unique to this screen", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    // Only "home" itself holds the fingerprint — no OTHER screen does.
    const index = indexFor("background:rgba(0,0,0,.4);color:#fff", ["home"]);
    expect(computeRepeatedPatternWarnings(doc, "home", index)).toEqual([]);
  });

  it("does not warn for a layout-only wrapper (any combination of display/flex/gap/padding/position/inset/size)", () => {
    const html = `<div id="n1" style="display: flex; gap: 8px; padding: 16px; position: absolute; inset: 0; width: 320px; height: 180px"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    // Even a full occurrence-index match must never fire — the node itself
    // is excluded by the candidate gate before any lookup happens.
    const index = indexFor(
      "display:flex;gap:8px;height:180px;inset:0;padding:16px;position:absolute;width:320px",
      ["checkout", "cart"],
    );
    expect(computeRepeatedPatternWarnings(doc, "home", index)).toEqual([]);
  });

  it("a single non-layout declaration alone never warns — needs at least two (CHR-635 review)", () => {
    // One real visual declaration (color) plus a pile of layout ones — on a
    // real, dense project a bare single declaration like this matched
    // dozens of screens by coincidence and produced nothing an agent could
    // act on.
    const html = `<div id="n1" style="display: flex; padding: 16px; color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const index = indexFor("color:#fff;display:flex;padding:16px", ["checkout", "cart", "cash"]);
    expect(computeRepeatedPatternWarnings(doc, "home", index)).toEqual([]);
  });

  it("warns once two non-layout declarations are present, even mixed with layout props", () => {
    const html = `<div id="n1" style="position: fixed; background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const fingerprint = "background:rgba(0,0,0,.4);color:#fff;position:fixed";
    const index = indexFor(fingerprint, ["checkout"]);
    expect(computeRepeatedPatternWarnings(doc, "home", index)).toHaveLength(1);
  });

  it("fingerprints a token-ref declaration in its as-written form, not just literal ones (CHR-635 review)", () => {
    // The real-world case that motivated this: a scrim whose only visual
    // declaration is a token ref (`alpha($color.x, n)`) — invisible to
    // `inlineStyles` entirely, since any `$ref` routes the whole property
    // into `refs.tokens` instead.
    const registry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["color.inverse-surface"]),
      tokenFlatNames: new Set(["inverse-surface"]),
    };
    const html = `<div id="n1" style="background: alpha($color.inverse-surface, 0.32); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", registry);
    const fingerprint = "background:alpha($color.inverse-surface, 0.32);color:#fff";
    const index = indexFor(fingerprint, ["checkout"]);
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(fingerprint);
  });

  it("names the component when a default-variant root matches", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const fingerprint = "background:rgba(0,0,0,.4);color:#fff";
    const index = indexFor(fingerprint, ["checkout"], "modal-scrim");
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings[0]!.suggestion).toBe("$modal-scrim");
  });

  it("omits the component suggestion when no default-variant root matches — falls back to promote_to_system", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const index = indexFor("background:rgba(0,0,0,.4);color:#fff", ["checkout"]); // no component
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings[0]!.suggestion).toBe("promote_to_system");
  });

  it("excludes component_instance nodes and nodes already carrying refs.component", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(["card"]),
      tokenPaths: new Set(),
      tokenFlatNames: new Set(),
    };
    const html = `<div id="n1" class="$card" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", registry);
    const index = indexFor("background:rgba(0,0,0,.4);color:#fff", ["checkout", "cart"]);
    expect(computeRepeatedPatternWarnings(doc, "home", index)).toEqual([]);
  });

  it("excludes text nodes", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff">Some text</div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    // The text node itself carries no inline style at all, so it could never
    // match a real fingerprint anyway — this proves the kind check still
    // excludes it rather than relying on that coincidence.
    const index: StyleOccurrenceIndex = { byScreen: new Map([["", new Set(["checkout"])]]), byComponent: new Map() };
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    // Only n1 (the styled div) can possibly warn; confirm no warning names
    // a text-node id.
    expect(warnings.every((w) => w.nodeId === "n1")).toBe(true);
  });

  it("carries hex-color case-insensitivity over from drift's normalizer", () => {
    const html = `<div id="n1" style="background: #ABCDEF; color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    // Index built with the lowercase form — the node's own uppercase value
    // must still normalize to the same fingerprint and match.
    const index = indexFor("background:#abcdef;color:#fff", ["checkout"]);
    expect(computeRepeatedPatternWarnings(doc, "home", index)).toHaveLength(1);
  });

  it("orders example screens deterministically and caps them at 3", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const index = indexFor("background:rgba(0,0,0,.4);color:#fff", ["zeta", "alpha", "delta", "beta"]);
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings[0]!.message).toContain("repeated on 4 other screens (alpha, beta, delta):");
  });

  it("respects minOtherScreens when raised above the default of 1", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const index = indexFor("background:rgba(0,0,0,.4);color:#fff", ["checkout"]);
    expect(computeRepeatedPatternWarnings(doc, "home", index, { minOtherScreens: 2 })).toEqual([]);
  });

  it("groups several matching nodes on this screen into ONE warning, targeted at the first in document order, node count folded into the message", () => {
    const html =
      `<section id="root">` +
      `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>` +
      `<div id="n2" style="background: rgba(0,0,0,.4); color: #fff"></div>` +
      `</section>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const fingerprint = "background:rgba(0,0,0,.4);color:#fff";
    const index = indexFor(fingerprint, ["checkout"]);
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.nodeId).toBe("n1");
    expect(warnings[0]!.message).toContain("(2 nodes here)");
  });

  it("a lone match (group of one) never adds the node-count suffix", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const index = indexFor("background:rgba(0,0,0,.4);color:#fff", ["checkout"]);
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings[0]!.message).not.toContain("nodes here");
  });

  it("scopeNodeIds re-derives the representative and count from the scoped subset — the case a post-hoc target filter would get wrong", () => {
    const html =
      `<section id="root">` +
      `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>` +
      `<div id="n2" style="background: rgba(0,0,0,.4); color: #fff"></div>` +
      `</section>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const fingerprint = "background:rgba(0,0,0,.4);color:#fff";
    const index = indexFor(fingerprint, ["checkout"]);

    // Only n2 is "in scope" (e.g. the one node a patch_html call actually
    // touched) — the warning must target n2, not n1 (document order's
    // earlier member), and must not claim "2 nodes here".
    const warnings = computeRepeatedPatternWarnings(doc, "home", index, { scopeNodeIds: new Set(["n2"]) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.nodeId).toBe("n2");
    expect(warnings[0]!.message).not.toContain("nodes here");
  });

  it("scopeNodeIds excludes a group entirely when none of its members fall inside it", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const index = indexFor("background:rgba(0,0,0,.4);color:#fff", ["checkout"]);
    const warnings = computeRepeatedPatternWarnings(doc, "home", index, { scopeNodeIds: new Set(["some-other-node"]) });
    expect(warnings).toEqual([]);
  });

  it("sorts distinct patterns by other-screen occurrence count descending", () => {
    const html =
      `<section id="root">` +
      `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>` +
      `<div id="n2" style="border: 1px solid #000; color: #111"></div>` +
      `</section>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    const byScreen = new Map([
      ["background:rgba(0,0,0,.4);color:#fff", new Set(["a"])],
      ["border:1px solid #000;color:#111", new Set(["a", "b", "c"])],
    ]);
    const index: StyleOccurrenceIndex = { byScreen, byComponent: new Map() };
    const warnings = computeRepeatedPatternWarnings(doc, "home", index);
    expect(warnings.map((w) => w.nodeId)).toEqual(["n2", "n1"]); // n2's pattern: 3 other screens vs. n1's 1
  });

  it("an empty index never warns", () => {
    const html = `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`;
    const { doc } = parseScreen(html, "home", noopRegistry);
    expect(computeRepeatedPatternWarnings(doc, "home", emptyIndex)).toEqual([]);
  });
});

describe("countLiteralDesignValues", () => {
  it("counts a plain literal value once", () => {
    expect(countLiteralDesignValues({ color: "#3366ff" }, {})).toBe(1);
  });

  it("counts a shorthand per embedded literal, not per property (border: 1px solid #333 -> 2)", () => {
    expect(countLiteralDesignValues({ border: "1px solid #333" }, {})).toBe(2);
  });

  it("counts every color/dimension literal across every declaration", () => {
    const inlineStyles = { padding: "8px 16px", color: "#fff" };
    // padding: 8px, 16px -> 2; color: #fff -> 1
    expect(countLiteralDesignValues(inlineStyles, {})).toBe(3);
  });

  it("filters out a zero-value dimension (margin: 0 is not a design value)", () => {
    expect(countLiteralDesignValues({ margin: "0" }, {})).toBe(0);
    expect(countLiteralDesignValues({ margin: "0 8px" }, {})).toBe(1);
  });

  it("applies no layout-property exclusion — height/padding count like any other property", () => {
    // Unlike isAdHocDesignElement's gate, every property counts here.
    expect(countLiteralDesignValues({ height: "44px", padding: "8px" }, {})).toBe(2);
  });

  it("a value carrying only a token ref (no literal text) contributes 0", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.md"]),
      tokenFlatNames: new Set(["md"]),
    };
    const { doc } = parseScreen(`<div id="n1" style="padding: $spacing.md"></div>`, "s", registry);
    const node = doc.nodes.n1!;
    expect(countLiteralDesignValues(node.inlineStyles, node.refs.tokens)).toBe(0);
  });

  it("a MixedTokenValue's literal text still counts, even though the whole property lives in refs.tokens, not inlineStyles", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["spacing.page"]),
      tokenFlatNames: new Set(["page"]),
    };
    const { doc } = parseScreen(`<div id="n1" style="padding: 12px $spacing.page"></div>`, "s", registry);
    const node = doc.nodes.n1!;
    // The whole "padding" declaration is a MixedTokenValue in refs.tokens —
    // absent from inlineStyles entirely (parser invariant) — yet its "12px"
    // literal chunk must still be counted.
    expect(node.inlineStyles).toEqual({});
    expect(countLiteralDesignValues(node.inlineStyles, node.refs.tokens)).toBe(1);
  });

  it("excludes the \"class\" key in refsTokens — a component/token-class ref, never a style declaration", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["color.primary"]),
      tokenFlatNames: new Set(["primary"]),
    };
    // class="$color.primary" resolves as a token-class ref (refs.tokens.class) — never mixed with literal text in practice, but even if it were, it must not count.
    const { doc } = parseScreen(`<div id="n1" class="$color.primary"></div>`, "s", registry);
    const node = doc.nodes.n1!;
    expect(countLiteralDesignValues(node.inlineStyles, node.refs.tokens)).toBe(0);
  });
});

describe("isAdHocDesignElement", () => {
  const noopRegistry: DesignSystemRegistry = { componentNames: new Set(), tokenPaths: new Set(), tokenFlatNames: new Set() };

  it("true for an element with at least one non-layout literal declaration", () => {
    const { doc } = parseScreen(`<div id="n1" style="color: #fff"></div>`, "s", noopRegistry);
    expect(isAdHocDesignElement(doc.nodes.n1!)).toBe(true);
  });

  it("false for a layout-only element (any combination of display/flex/gap/padding/position/inset)", () => {
    const { doc } = parseScreen(
      `<div id="n1" style="display: flex; gap: 8px; padding: 16px; position: absolute; inset: 0"></div>`,
      "s",
      noopRegistry,
    );
    expect(isAdHocDesignElement(doc.nodes.n1!)).toBe(false);
  });

  it("a single non-layout declaration is enough — unlike isRepeatedPatternCandidate's two-declaration floor, this predicate stays at the original ≥1", () => {
    const { doc } = parseScreen(`<div id="n1" style="display: flex; text-transform: uppercase"></div>`, "s", noopRegistry);
    expect(isAdHocDesignElement(doc.nodes.n1!)).toBe(true);
  });

  it("false for a node styled entirely through token refs — token_coverage's whole point is literal-vs-ref usage, so a $ref-only node must not also count as ad-hoc", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(),
      tokenPaths: new Set(["color.primary"]),
      tokenFlatNames: new Set(["primary"]),
    };
    const { doc } = parseScreen(`<div id="n1" style="color: $color.primary"></div>`, "s", registry);
    // The whole declaration lives in refs.tokens, not inlineStyles (parser
    // invariant) — this predicate deliberately only ever looks at
    // inlineStyles, unlike isRepeatedPatternCandidate.
    expect(doc.nodes.n1!.inlineStyles).toEqual({});
    expect(isAdHocDesignElement(doc.nodes.n1!)).toBe(false);
  });

  it("false for a component_instance node, even with a visually-styled root element otherwise", () => {
    const registry: DesignSystemRegistry = { componentNames: new Set(["card"]), tokenPaths: new Set(), tokenFlatNames: new Set() };
    const { doc } = parseScreen(`<div id="n1" class="$card" style="color: #fff"></div>`, "s", registry);
    expect(isAdHocDesignElement(doc.nodes.n1!)).toBe(false);
  });

  it("false for a text node", () => {
    const { doc } = parseScreen(`<div id="n1">Hello</div>`, "s", noopRegistry);
    const textNode = Object.values(doc.nodes).find((n) => n.kind === "text");
    expect(textNode).toBeDefined();
    expect(isAdHocDesignElement(textNode!)).toBe(false);
  });

  it("true for an svg/svg_path node with a non-layout style", () => {
    const { doc } = parseScreen(`<svg id="n1" style="fill: #000"></svg>`, "s", noopRegistry);
    expect(isAdHocDesignElement(doc.nodes.n1!)).toBe(true);
  });
});
