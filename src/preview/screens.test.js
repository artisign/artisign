import { describe, it, expect } from "vitest";
import {
  filterScreens,
  buildScreenTree,
  displayName,
  ancestorNames,
  subtreeNames,
  highlightParts,
  flattenTree, viewportIconName, DESKTOP_MIN_WIDTH } from "./screens.js";

// renderScreenList itself isn't tested here — this file stays on the fast
// node default; its DOM smoke test lives in screens.dom.test.js. Filtering —
// the one piece of actual logic — is exercised
// directly instead.
describe("filterScreens", () => {
  const screens = [
    { name: "checkout-cart", tags: ["checkout"] },
    { name: "checkout-payment", tags: ["checkout", "payment"] },
    { name: "login", tags: ["auth"] },
  ];

  it("returns every screen for an empty filter", () => {
    expect(filterScreens(screens, "")).toEqual(screens);
  });

  it("matches a substring of the screen name", () => {
    expect(filterScreens(screens, "login")).toEqual([screens[2]]);
  });

  it("matches a substring of a tag", () => {
    expect(filterScreens(screens, "payment")).toEqual([screens[1]]);
  });

  it("is case-insensitive on both name and tags", () => {
    expect(filterScreens(screens, "LOGIN")).toEqual([screens[2]]);
    expect(filterScreens(screens, "Checkout")).toEqual([screens[0], screens[1]]);
  });

  it("matches screens with no tags only by name", () => {
    expect(filterScreens([{ name: "login", tags: [] }], "login")).toEqual([{ name: "login", tags: [] }]);
    expect(filterScreens([{ name: "login", tags: [] }], "auth")).toEqual([]);
  });

  it("returns no screens when nothing matches", () => {
    expect(filterScreens(screens, "nope")).toEqual([]);
  });
});

// CHR-731 — variant tree. `cart` is a depth-3 chain plus siblings:
//   cart > cart-sheet-clear (overlay) > cart-sheet-clear-confirm (step) > confirm-error
//   cart > cart-two-items (state)
const v = (name, variant_of, variant_kind, tags = []) => ({
  name,
  tags,
  ...(variant_of ? { variant_of, variant_kind } : {}),
});
const cart = [
  v("dashboard"),
  v("cart"),
  v("cart-sheet-clear", "cart", "overlay", ["sheet"]),
  v("cart-sheet-clear-confirm", "cart-sheet-clear", "step", ["sheet", "destructive"]),
  v("confirm-error", "cart-sheet-clear-confirm", "state"),
  v("cart-two-items", "cart", "state"),
  v("cart-sheet-name", "cart", "overlay"),
];
const names = (rows) =>
  rows.map((r) => (r.type === "hidden" ? `${r.count} hidden` : `${r.node.name}:${r.state}`));

describe("buildScreenTree", () => {
  it("nests variants at any depth and keeps input order among siblings", () => {
    const tree = buildScreenTree(cart);
    expect(tree.roots.map((n) => n.name)).toEqual(["dashboard", "cart"]);
    const fam = tree.nodes.get("cart");
    expect(fam.children.map((n) => n.name)).toEqual([
      "cart-sheet-clear",
      "cart-two-items",
      "cart-sheet-name",
    ]);
    expect(tree.nodes.get("confirm-error").depth).toBe(3);
    expect(tree.nodes.get("confirm-error").parent.name).toBe("cart-sheet-clear-confirm");
  });

  it("counts the whole subtree, not just direct children", () => {
    const tree = buildScreenTree(cart);
    expect(tree.nodes.get("cart").total).toBe(5);
    expect(tree.nodes.get("cart-sheet-clear").total).toBe(2);
    expect(tree.nodes.get("cart-two-items").total).toBe(0);
    expect(tree.nodes.get("dashboard").total).toBe(0);
  });

  it("treats a dangling parent as a root", () => {
    const tree = buildScreenTree([v("orphan", "ghost", "state"), v("other")]);
    expect(tree.roots.map((n) => n.name)).toEqual(["orphan", "other"]);
    expect(tree.nodes.get("orphan").parent).toBeNull();
  });

  it("does not loop on a cycle or a self-reference", () => {
    const tree = buildScreenTree([
      v("a", "b", "state"),
      v("b", "a", "state"),
      v("c", "c", "state"),
    ]);
    expect(tree.roots.map((n) => n.name).sort()).toEqual(["a", "c"]);
    expect(tree.nodes.get("b").parent.name).toBe("a");
  });

  it("returns every screen as a root when there are no variants", () => {
    const tree = buildScreenTree([v("a"), v("b")]);
    expect(tree.roots).toHaveLength(2);
  });
});

describe("displayName", () => {
  const tree = buildScreenTree([...cart, v("unrelated-name", "cart", "overlay")]);
  it("shows the suffix behind an ellipsis when the name starts with the parent's", () => {
    expect(displayName(tree.nodes.get("cart-two-items"))).toBe("…-two-items");
    expect(displayName(tree.nodes.get("confirm-error"))).toBe("confirm-error");
    expect(displayName(tree.nodes.get("cart-sheet-clear-confirm"))).toBe("…-confirm");
  });
  it("shows the full name when it lacks the parent prefix, and for roots", () => {
    expect(displayName(tree.nodes.get("unrelated-name"))).toBe("unrelated-name");
    expect(displayName(tree.nodes.get("cart"))).toBe("cart");
  });
});

describe("ancestorNames / subtreeNames", () => {
  const tree = buildScreenTree(cart);
  it("lists ancestors root first", () => {
    expect(ancestorNames(tree, "confirm-error")).toEqual([
      "cart",
      "cart-sheet-clear",
      "cart-sheet-clear-confirm",
    ]);
    expect(ancestorNames(tree, "cart")).toEqual([]);
    expect(ancestorNames(tree, "nope")).toEqual([]);
  });
  it("lists a node and all descendants", () => {
    expect(subtreeNames(tree.nodes.get("cart-sheet-clear"))).toEqual([
      "cart-sheet-clear",
      "cart-sheet-clear-confirm",
      "confirm-error",
    ]);
  });
});

describe("highlightParts", () => {
  it("splits around the first case-insensitive match", () => {
    expect(highlightParts("cart-Empty-x", "empty")).toEqual([
      { text: "cart-", match: false },
      { text: "Empty", match: true },
      { text: "-x", match: false },
    ]);
  });
  it("returns the whole text when nothing matches or the needle is empty", () => {
    expect(highlightParts("abc", "z")).toEqual([{ text: "abc", match: false }]);
    expect(highlightParts("abc", "")).toEqual([{ text: "abc", match: false }]);
  });
});

describe("flattenTree", () => {
  const tree = buildScreenTree(cart);

  it("shows only roots when nothing is expanded", () => {
    expect(names(flattenTree(tree).rows)).toEqual(["dashboard:plain", "cart:plain"]);
  });

  it("shows children of expanded nodes only, at their depth", () => {
    const { rows } = flattenTree(tree, { expanded: new Set(["cart", "cart-sheet-clear"]) });
    expect(names(rows)).toEqual([
      "dashboard:plain",
      "cart:plain",
      "cart-sheet-clear:plain",
      "cart-sheet-clear-confirm:plain",
      "cart-two-items:plain",
      "cart-sheet-name:plain",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 2, 1, 1]);
  });

  it("with a filter: a depth-3 match keeps its non-matching ancestors as context and folds siblings", () => {
    const { rows, matchCount, contextCount } = flattenTree(tree, { filter: "error" });
    expect(names(rows)).toEqual([
      "cart:context",
      "cart-sheet-clear:context",
      "cart-sheet-clear-confirm:context",
      "confirm-error:match",
      "2 hidden", // two-items + sheet-name, the folded siblings of cart-sheet-clear
    ]);
    expect(matchCount).toBe(1);
    expect(contextCount).toBe(3);
  });

  it("with a filter: matches by tag and does not expand a match's own subtree", () => {
    const { rows } = flattenTree(tree, { filter: "destructive" });
    expect(names(rows)).toEqual([
      "cart:context",
      "cart-sheet-clear:context",
      "cart-sheet-clear-confirm:match",
      "2 hidden",
    ]);
    expect(rows[2].expanded).toBe(false);
  });

  it("with a filter: a matching ancestor is a match row, not context", () => {
    const { rows } = flattenTree(tree, { filter: "sheet-clear" });
    expect(names(rows).slice(0, 3)).toEqual([
      "cart:context",
      "cart-sheet-clear:match",
      "cart-sheet-clear-confirm:match",
    ]);
  });

  it("with a filter: a user-expanded match shows all its children; an expanded path node still folds", () => {
    const { rows } = flattenTree(tree, { filter: "sheet-clear-confirm", expanded: new Set(["cart", "cart-sheet-clear-confirm"]) });
    expect(names(rows)).toEqual([
      "cart:context",
      "cart-sheet-clear:context",
      "cart-sheet-clear-confirm:match",
      "confirm-error:plain",
      "2 hidden",
    ]);
  });

  it("with a filter: unrelated roots disappear", () => {
    expect(names(flattenTree(tree, { filter: "dash" }).rows)).toEqual(["dashboard:match"]);
  });
});

describe("viewportIconName (CHR-1267)", () => {
  it("is a monitor from the desktop width up and a phone below it, also for an unknown size", () => {
    expect(viewportIconName({ width: 1280 })).toBe("desktop_windows");
    expect(viewportIconName({ width: DESKTOP_MIN_WIDTH })).toBe("desktop_windows");
    expect(viewportIconName({ width: 768 })).toBe("desktop_windows");
    expect(viewportIconName({ width: 390 })).toBe("smartphone");
    expect(viewportIconName(undefined)).toBe("smartphone");
  });
});
