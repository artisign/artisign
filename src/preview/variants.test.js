import { describe, it, expect } from "vitest";
import { buildScreenTree } from "./screens.js";
import { screenOfRef, variantContext, alsoReachedFrom, flowCounts } from "./variants.js";

// cart > clear (overlay) > confirm (step) > confirm-error (state); cart > two-items (state); cart > name (overlay)
const v = (name, variant_of, variant_kind) => ({ name, tags: [], ...(variant_of ? { variant_of, variant_kind } : {}) });
const screens = [
  v("plain"),
  v("cart"),
  v("clear", "cart", "overlay"),
  v("confirm", "clear", "step"),
  v("all", "clear", "step"),
  v("confirm-error", "confirm", "state"),
  v("two-items", "cart", "state"),
  v("orphan", "ghost", "state"),
];
const tree = buildScreenTree(screens);
const names = (nodes) => nodes.map((n) => n.name);

describe("variantContext", () => {
  it("returns the ancestor chain root-first with depth, kind, children and siblings", () => {
    const ctx = variantContext(tree, "confirm");
    expect(names(ctx.chain)).toEqual(["cart", "clear", "confirm"]);
    expect(ctx.root.name).toBe("cart");
    expect(ctx.parent.name).toBe("clear");
    expect(ctx.kind).toBe("step");
    expect(ctx.depth).toBe(3);
    expect(names(ctx.children)).toEqual(["confirm-error"]);
    expect(names(ctx.siblings)).toEqual(["all"]);
  });

  it("handles a depth-4 leaf", () => {
    const ctx = variantContext(tree, "confirm-error");
    expect(names(ctx.chain)).toEqual(["cart", "clear", "confirm", "confirm-error"]);
    expect(ctx.children).toEqual([]);
    expect(ctx.siblings).toEqual([]);
  });

  it("gives a cluster root its variants and no parent", () => {
    const ctx = variantContext(tree, "cart");
    expect(ctx.parent).toBeNull();
    expect(names(ctx.chain)).toEqual(["cart"]);
    expect(names(ctx.children)).toEqual(["clear", "two-items"]);
    expect(ctx.siblings).toEqual([]);
  });

  it("is null for a plain screen, an unknown name and no selection", () => {
    expect(variantContext(tree, "plain")).toBeNull();
    expect(variantContext(tree, "nope")).toBeNull();
    expect(variantContext(tree, null)).toBeNull();
  });

  it("treats a variant whose parent is missing as a plain root", () => {
    expect(variantContext(tree, "orphan")).toBeNull();
  });
});

describe("screenOfRef", () => {
  it("strips a node id", () => {
    expect(screenOfRef("screen.btn")).toBe("screen");
    expect(screenOfRef("screen")).toBe("screen");
  });
});

describe("alsoReachedFrom", () => {
  const flow = (from, to, to_kind = "screen") => ({ from, event: "tap", to, to_kind });

  it("lists distinct flow sources, screen- and node-targeted, deduped, in first-seen order", () => {
    const flows = [
      flow("feed.btn-a", "sheet"),
      flow("feed.btn-b", "sheet"),
      flow("calendar.card", "sheet.header", "node"),
      flow("other.x", "elsewhere"),
    ];
    expect(alsoReachedFrom(flows, "sheet", "cart")).toEqual(["feed", "calendar"]);
  });

  it("excludes the variant_of parent and self-loops", () => {
    const flows = [flow("cart.open", "sheet"), flow("sheet.again", "sheet"), flow("feed.x", "sheet")];
    expect(alsoReachedFrom(flows, "sheet", "cart")).toEqual(["feed"]);
  });

  it("includes cross-cluster sources and keeps variants of the parent", () => {
    const flows = [flow("cart-two-items.b", "sheet"), flow("other-cluster-leaf.b", "sheet")];
    expect(alsoReachedFrom(flows, "sheet", "cart")).toEqual(["cart-two-items", "other-cluster-leaf"]);
  });

  it("is empty when nothing else reaches the screen", () => {
    expect(alsoReachedFrom([flow("cart.x", "sheet")], "sheet", "cart")).toEqual([]);
    expect(alsoReachedFrom([], "sheet", "cart")).toEqual([]);
  });
});

describe("flowCounts", () => {
  it("counts edges in and out, ignoring self-loops", () => {
    const flows = [
      { from: "a.x", to: "b", to_kind: "screen", event: "tap" },
      { from: "c.x", to: "b.n", to_kind: "node", event: "tap" },
      { from: "b.x", to: "d", to_kind: "screen", event: "tap" },
      { from: "b.y", to: "b", to_kind: "screen", event: "tap" },
    ];
    expect(flowCounts(flows, "b")).toEqual({ in: 2, out: 1 });
  });
});
