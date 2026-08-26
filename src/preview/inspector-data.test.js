import { describe, it, expect } from "vitest";
import {
  relativeRect,
  resolveModelId,
  parseUnresolvedPaths,
  rgbToHex,
  shortFontFamily,
  formatPosition,
  formatTypography,
  formatSpacing,
  buildEntries,
} from "./inspector-data.js";

describe("relativeRect", () => {
  it("computes a rounded rect relative to the root", () => {
    const elRect = { left: 44.4, top: 236.6, width: 411.7, height: 44.2 };
    const rootRect = { left: 20, top: 24.6 };
    expect(relativeRect(elRect, rootRect)).toEqual({ x: 24, y: 212, w: 412, h: 44 });
  });

  it("returns a zero offset when the element is the root itself", () => {
    const rect = { left: 10, top: 10, width: 100, height: 50 };
    expect(relativeRect(rect, rect)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });
});

describe("resolveModelId", () => {
  it("returns the id unchanged when it's a plain model node id", () => {
    const modelIds = new Set(["btn-checkout"]);
    expect(resolveModelId("btn-checkout", modelIds)).toEqual({ modelId: "btn-checkout", isPart: false });
  });

  it("prefers an exact match over any '--' split, even when the id itself contains '--'", () => {
    const modelIds = new Set(["card--wide"]);
    expect(resolveModelId("card--wide", modelIds)).toEqual({ modelId: "card--wide", isPart: false });
  });

  it("resolves a component-instance descendant id to its containing instance", () => {
    const modelIds = new Set(["card-header"]);
    expect(resolveModelId("card-header--title", modelIds)).toEqual({ modelId: "card-header", isPart: true });
  });

  it("picks the LONGEST known-id prefix across multiple '--' split points (nested instances)", () => {
    const modelIds = new Set(["outer", "outer--inner"]);
    expect(resolveModelId("outer--inner--title", modelIds)).toEqual({ modelId: "outer--inner", isPart: true });
  });

  it("falls back to the shorter prefix when the longer one isn't a known id", () => {
    const modelIds = new Set(["outer"]);
    expect(resolveModelId("outer--inner--title", modelIds)).toEqual({ modelId: "outer", isPart: true });
  });

  it("falls back to treating the id as its own when nothing matches", () => {
    const modelIds = new Set(["unrelated"]);
    expect(resolveModelId("mystery--id", modelIds)).toEqual({ modelId: "mystery--id", isPart: false });
  });
});

describe("parseUnresolvedPaths", () => {
  it("returns an empty list for null or empty input", () => {
    expect(parseUnresolvedPaths(null)).toEqual([]);
    expect(parseUnresolvedPaths("")).toEqual([]);
  });

  it("splits and trims a comma-separated list", () => {
    expect(parseUnresolvedPaths("spacing.xxl, color.brand-old")).toEqual(["spacing.xxl", "color.brand-old"]);
  });

  it("drops empty entries", () => {
    expect(parseUnresolvedPaths("spacing.xxl,,")).toEqual(["spacing.xxl"]);
  });
});

describe("rgbToHex", () => {
  it("converts a plain rgb() to hex", () => {
    expect(rgbToHex("rgb(42, 62, 219)")).toBe("#2a3edb");
  });

  it("converts an opaque rgba() to hex, dropping the alpha suffix", () => {
    expect(rgbToHex("rgba(255, 255, 255, 1)")).toBe("#ffffff");
  });

  it("appends a percentage for partial alpha", () => {
    expect(rgbToHex("rgba(42, 62, 219, 0.1)")).toBe("#2a3edb / 10%");
  });

  it("reports fully transparent black as 'transparent'", () => {
    expect(rgbToHex("rgba(0, 0, 0, 0)")).toBe("transparent");
  });

  it("passes through a value it doesn't recognize", () => {
    expect(rgbToHex("currentcolor")).toBe("currentcolor");
    expect(rgbToHex("")).toBe("");
  });
});

describe("shortFontFamily", () => {
  it("takes the first family in a stack", () => {
    expect(shortFontFamily("system-ui, -apple-system, sans-serif")).toBe("system-ui");
  });

  it("strips surrounding quotes", () => {
    expect(shortFontFamily('"Segoe UI", sans-serif')).toBe("Segoe UI");
  });

  it("returns an empty string for empty input", () => {
    expect(shortFontFamily("")).toBe("");
  });
});

describe("formatPosition", () => {
  it("formats the four values in order", () => {
    expect(formatPosition({ x: 24, y: 212, w: 412, h: 44 })).toBe("X 24 · Y 212 · W 412 · H 44");
  });
});

describe("formatTypography", () => {
  it("joins family/size/weight, omitting a 'normal' line-height", () => {
    expect(formatTypography({ fontFamily: "system-ui, sans-serif", fontSize: "0.9rem", fontWeight: "600", lineHeight: "normal" })).toBe(
      "system-ui · 0.9rem · 600",
    );
  });

  it("appends a non-normal line-height", () => {
    expect(formatTypography({ fontFamily: "system-ui", fontSize: "0.9rem", fontWeight: "600", lineHeight: "1.2" })).toBe(
      "system-ui · 0.9rem · 600 · lh 1.2",
    );
  });
});

describe("formatSpacing", () => {
  it("formats padding/margin/radius in order", () => {
    expect(formatSpacing({ padding: "12px 16px", margin: "0px", radius: "6px" })).toBe("pad 12px 16px · margin 0px · radius 6px");
  });
});

describe("buildEntries", () => {
  it("gives a node with no refs key empty refs", () => {
    expect(buildEntries([{ id: "n1", tag: "div" }])).toEqual([{ id: "n1", tag: "div", componentRef: null, variant: null, tokenRefs: [] }]);
  });

  it("reads component_ref and variant straight through", () => {
    const nodes = [{ id: "n1", tag: "button", refs: { component_ref: "btn-primary", variant: "hover" } }];
    expect(buildEntries(nodes)[0]).toMatchObject({ componentRef: "btn-primary", variant: "hover" });
  });

  it("maps token_refs into a property/ref list, preserving each ref's own shape", () => {
    const nodes = [{ id: "n1", tag: "div", refs: { token_refs: { background: "color.accent", padding: { fn: "alpha", args: ["color.primary", 0.1] } } } }];
    expect(buildEntries(nodes)[0].tokenRefs).toEqual([
      { property: "background", ref: "color.accent" },
      { property: "padding", ref: { fn: "alpha", args: ["color.primary", 0.1] } },
    ]);
  });

  it("preserves node order", () => {
    const nodes = [{ id: "a", tag: "div" }, { id: "b", tag: "span" }];
    expect(buildEntries(nodes).map((e) => e.id)).toEqual(["a", "b"]);
  });
});
