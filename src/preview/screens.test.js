import { describe, it, expect } from "vitest";
import {
  filterScreens,
  buildScreenTree,
  displayName,
  ancestorNames,
  subtreeNames,
  highlightParts,
  flattenTree,
} from "./screens.js";

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

// CHR-731 — variant tree. `family` is a depth-3 chain plus siblings:
//   family > family-sheet-leave (overlay) > family-sheet-leave-confirm (step) > confirm-error
//   family > family-two-parents (state)
const v = (name, variant_of, variant_kind, tags = []) => ({
  name,
  tags,
  ...(variant_of ? { variant_of, variant_kind } : {}),
});
const family = [
  v("dashboard"),
  v("family"),
  v("family-sheet-leave", "family", "overlay", ["sheet"]),
  v("family-sheet-leave-confirm", "family-sheet-leave", "step", ["sheet", "destructive"]),
  v("confirm-error", "family-sheet-leave-confirm", "state"),
  v("family-two-parents", "family", "state"),
  v("family-sheet-name", "family", "overlay"),
];
const names = (rows) =>
  rows.map((r) => (r.type === "hidden" ? `${r.count} hidden` : `${r.node.name}:${r.state}`));

describe("buildScreenTree", () => {
  it("nests variants at any depth and keeps input order among siblings", () => {
    const tree = buildScreenTree(family);
    expect(tree.roots.map((n) => n.name)).toEqual(["dashboard", "family"]);
    const fam = tree.nodes.get("family");
    expect(fam.children.map((n) => n.name)).toEqual([
      "family-sheet-leave",
      "family-two-parents",
      "family-sheet-name",
    ]);
    expect(tree.nodes.get("confirm-error").depth).toBe(3);
    expect(tree.nodes.get("confirm-error").parent.name).toBe("family-sheet-leave-confirm");
  });

  it("counts the whole subtree, not just direct children", () => {
    const tree = buildScreenTree(family);
    expect(tree.nodes.get("family").total).toBe(5);
    expect(tree.nodes.get("family-sheet-leave").total).toBe(2);
    expect(tree.nodes.get("family-two-parents").total).toBe(0);
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
  const tree = buildScreenTree([...family, v("unrelated-name", "family", "overlay")]);
  it("shows the suffix behind an ellipsis when the name starts with the parent's", () => {
    expect(displayName(tree.nodes.get("family-two-parents"))).toBe("…-two-parents");
    expect(displayName(tree.nodes.get("confirm-error"))).toBe("confirm-error");
    expect(displayName(tree.nodes.get("family-sheet-leave-confirm"))).toBe("…-confirm");
  });
  it("shows the full name when it lacks the parent prefix, and for roots", () => {
    expect(displayName(tree.nodes.get("unrelated-name"))).toBe("unrelated-name");
    expect(displayName(tree.nodes.get("family"))).toBe("family");
  });
});

describe("ancestorNames / subtreeNames", () => {
  const tree = buildScreenTree(family);
  it("lists ancestors root first", () => {
    expect(ancestorNames(tree, "confirm-error")).toEqual([
      "family",
      "family-sheet-leave",
      "family-sheet-leave-confirm",
    ]);
    expect(ancestorNames(tree, "family")).toEqual([]);
    expect(ancestorNames(tree, "nope")).toEqual([]);
  });
  it("lists a node and all descendants", () => {
    expect(subtreeNames(tree.nodes.get("family-sheet-leave"))).toEqual([
      "family-sheet-leave",
      "family-sheet-leave-confirm",
      "confirm-error",
    ]);
  });
});

describe("highlightParts", () => {
  it("splits around the first case-insensitive match", () => {
    expect(highlightParts("family-Empty-x", "empty")).toEqual([
      { text: "family-", match: false },
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
  const tree = buildScreenTree(family);

  it("shows only roots when nothing is expanded", () => {
    expect(names(flattenTree(tree).rows)).toEqual(["dashboard:plain", "family:plain"]);
  });

  it("shows children of expanded nodes only, at their depth", () => {
    const { rows } = flattenTree(tree, { expanded: new Set(["family", "family-sheet-leave"]) });
    expect(names(rows)).toEqual([
      "dashboard:plain",
      "family:plain",
      "family-sheet-leave:plain",
      "family-sheet-leave-confirm:plain",
      "family-two-parents:plain",
      "family-sheet-name:plain",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 2, 1, 1]);
  });

  it("with a filter: a depth-3 match keeps its non-matching ancestors as context and folds siblings", () => {
    const { rows, matchCount, contextCount } = flattenTree(tree, { filter: "error" });
    expect(names(rows)).toEqual([
      "family:context",
      "family-sheet-leave:context",
      "family-sheet-leave-confirm:context",
      "confirm-error:match",
      "2 hidden", // two-parents + sheet-name, the folded siblings of family-sheet-leave
    ]);
    expect(matchCount).toBe(1);
    expect(contextCount).toBe(3);
  });

  it("with a filter: matches by tag and does not expand a match's own subtree", () => {
    const { rows } = flattenTree(tree, { filter: "destructive" });
    expect(names(rows)).toEqual([
      "family:context",
      "family-sheet-leave:context",
      "family-sheet-leave-confirm:match",
      "2 hidden",
    ]);
    expect(rows[2].expanded).toBe(false);
  });

  it("with a filter: a matching ancestor is a match row, not context", () => {
    const { rows } = flattenTree(tree, { filter: "sheet-leave" });
    expect(names(rows).slice(0, 3)).toEqual([
      "family:context",
      "family-sheet-leave:match",
      "family-sheet-leave-confirm:match",
    ]);
  });

  it("with a filter: a user-expanded match shows all its children; an expanded path node still folds", () => {
    const { rows } = flattenTree(tree, { filter: "sheet-leave-confirm", expanded: new Set(["family", "family-sheet-leave-confirm"]) });
    expect(names(rows)).toEqual([
      "family:context",
      "family-sheet-leave:context",
      "family-sheet-leave-confirm:match",
      "confirm-error:plain",
      "2 hidden",
    ]);
  });

  it("with a filter: unrelated roots disappear", () => {
    expect(names(flattenTree(tree, { filter: "dash" }).rows)).toEqual(["dashboard:match"]);
  });
});
