import { describe, it, expect } from "vitest";
import { tokenRefPaths, formatTokenRef, isRefUnresolved } from "./token-ref-format.js";

describe("tokenRefPaths", () => {
  it("returns a plain ref's own path", () => {
    expect(tokenRefPaths("color.accent")).toEqual(["color.accent"]);
  });

  it("returns a modifier call's path args, ignoring numeric args", () => {
    expect(tokenRefPaths({ fn: "alpha", args: ["color.primary", 0.1] })).toEqual(["color.primary"]);
  });

  it("returns every atom's paths in a mixed value, in order", () => {
    const ref = { parts: ["", "color.border", " solid"] };
    expect(tokenRefPaths(ref)).toEqual(["color.border"]);
  });

  it("collects paths from multiple atoms in a mixed value", () => {
    const ref = { parts: ["", "spacing.sm", " ", "spacing.lg", ""] };
    expect(tokenRefPaths(ref)).toEqual(["spacing.sm", "spacing.lg"]);
  });
});

describe("formatTokenRef", () => {
  it("formats a plain path with a $ prefix", () => {
    expect(formatTokenRef("color.accent")).toBe("$color.accent");
  });

  it("formats a modifier call, prefixing its path args only", () => {
    expect(formatTokenRef({ fn: "alpha", args: ["color.primary", 0.1] })).toBe("alpha($color.primary, 0.1)");
  });

  it("formats a mixed literal/ref value", () => {
    const ref = { parts: ["1px solid ", "color.border", ""] };
    expect(formatTokenRef(ref)).toBe("1px solid $color.border");
  });

  it("formats a mixed value with multiple refs", () => {
    const ref = { parts: ["", "spacing.sm", " ", "spacing.lg", ""] };
    expect(formatTokenRef(ref)).toBe("$spacing.sm $spacing.lg");
  });
});

describe("isRefUnresolved", () => {
  it("matches an exact unresolved path", () => {
    expect(isRefUnresolved("spacing.xxl", ["spacing.xxl"])).toBe(true);
  });

  it("does not match a path that merely shares a prefix", () => {
    expect(isRefUnresolved("color.brand-old", ["color.brand"])).toBe(false);
    expect(isRefUnresolved("color.brand", ["color.brand-old"])).toBe(false);
  });

  it("matches inside a modifier call", () => {
    expect(isRefUnresolved({ fn: "alpha", args: ["color.brand-old", 0.1] }, ["color.brand-old"])).toBe(true);
  });

  it("matches any one path in a mixed value", () => {
    const ref = { parts: ["", "spacing.sm", " ", "spacing.xxl", ""] };
    expect(isRefUnresolved(ref, ["spacing.xxl"])).toBe(true);
  });

  it("returns false for an empty unresolved-paths list", () => {
    expect(isRefUnresolved("color.accent", [])).toBe(false);
  });
});
