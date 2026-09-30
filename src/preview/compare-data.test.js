import { describe, it, expect } from "vitest";
import { buildScreenTree } from "./screens.js";
import {
  COMPARE_MAX_MEMBERS,
  familyOf,
  canCompare,
  mergeSelection,
  toggleMember,
  diffRows,
  overlapPercent,
  modeToggleStates,
} from "./compare-data.js";

const s = (name, variant_of) => ({ name, tags: [], ...(variant_of ? { variant_of, variant_kind: "state" } : {}) });
const tree = buildScreenTree([
  s("plain"),
  s("family"),
  s("a", "family"),
  s("a1", "a"),
  s("b", "family"),
  s("c", "family"),
  s("d", "family"),
]);

describe("familyOf", () => {
  it("names the main screen of the variant_of chain as the reference and lists every descendant", () => {
    expect(familyOf(tree, "a1")).toEqual({ reference: "family", members: ["a", "a1", "b", "c", "d"] });
    expect(familyOf(tree, "family")).toEqual({ reference: "family", members: ["a", "a1", "b", "c", "d"] });
  });

  it("is null for an unknown or missing name", () => {
    expect(familyOf(tree, "nope")).toBeNull();
    expect(familyOf(tree, null)).toBeNull();
  });
});

describe("canCompare", () => {
  it("is false for a screen whose family has no other screen, true otherwise", () => {
    expect(canCompare(tree, "plain")).toBe(false);
    expect(canCompare(tree, "a")).toBe(true);
    expect(canCompare(tree, "nope")).toBe(false);
  });
});

describe("mergeSelection", () => {
  const family = familyOf(tree, "family");

  it("preselects the open screen first, unless it is the main screen", () => {
    expect(mergeSelection(family, "a1", [])).toEqual(["a1"]);
    expect(mergeSelection(family, "family", [])).toEqual([]);
  });

  it("keeps stored members that still exist, drops the rest, and caps at three", () => {
    expect(mergeSelection(family, "b", ["c", "gone", "b", "a", "d"])).toEqual(["b", "c", "a"]);
    expect(COMPARE_MAX_MEMBERS).toBe(3);
  });
});

describe("toggleMember", () => {
  const family = familyOf(tree, "family");

  it("adds a family member, removes a selected one", () => {
    expect(toggleMember(["a"], "b", family)).toEqual(["a", "b"]);
    expect(toggleMember(["a", "b"], "a", family)).toEqual(["b"]);
  });

  it("never adds the reference, an outsider, or a fourth member", () => {
    expect(toggleMember(["a"], "family", family)).toEqual(["a"]);
    expect(toggleMember(["a"], "plain", family)).toEqual(["a"]);
    expect(toggleMember(["a", "b", "c"], "d", family)).toEqual(["a", "b", "c"]);
  });
});

describe("diffRows", () => {
  const member = (screen, extra = {}) => ({
    screen,
    status: "ok",
    overlap: { shared: 5, base: 6, member: 5, ratio: 0.8 },
    added: [],
    removed: [],
    changed: [],
    counts: { added: 0, removed: 0, changed: 0 },
    ...extra,
  });

  it("lists added, then changed, then removed rows across members, one per node id", () => {
    const rows = diffRows({
      base: "family",
      members: [
        member("a", { added: ["x"], changed: ["g"] }),
        member("b", { removed: [{ id: "card", parent: "list" }], added: ["y"] }),
      ],
    });
    expect(rows).toEqual([
      { sign: "+", kind: "added", id: "x", member: "a" },
      { sign: "+", kind: "added", id: "y", member: "b" },
      { sign: "~", kind: "changed", id: "g", member: "a" },
      { sign: "−", kind: "removed", id: "card", member: "b" },
    ]);
  });

  it("gives a low_overlap member no rows and tolerates missing data", () => {
    expect(diffRows({ base: "f", members: [member("a", { status: "low_overlap" })] })).toEqual([]);
    expect(diffRows(null)).toEqual([]);
  });
});

describe("overlapPercent", () => {
  it("rounds the shared-id ratio to a whole percent", () => {
    expect(overlapPercent({ overlap: { ratio: 0.784 } })).toBe(78);
    expect(overlapPercent({ overlap: { ratio: 0 } })).toBe(0);
  });
});

describe("modeToggleStates", () => {
  it("disables comment and inspect with a tooltip while comparing; flow stays usable", () => {
    const states = modeToggleStates({ view: "screens", showMockup: false, comparing: true });
    expect(states.comment).toEqual({ disabled: true, title: "Not available while comparing variants" });
    expect(states.inspect).toEqual({ disabled: true, title: "Not available while comparing variants" });
    expect(states.flow.disabled).toBe(false);
    expect(states.flow.title).toContain("Single");
  });

  it("is the old rule otherwise: board and mockup disable comment and inspect, a mockup disables flow", () => {
    expect(modeToggleStates({ view: "screens", showMockup: false, comparing: false })).toEqual({
      flow: { disabled: false, title: "" },
      comment: { disabled: false, title: "" },
      inspect: { disabled: false, title: null },
    });
    const board = modeToggleStates({ view: "board", showMockup: false, comparing: false });
    expect([board.flow.disabled, board.comment.disabled, board.inspect.disabled]).toEqual([false, true, true]);
    const mockup = modeToggleStates({ view: "screens", showMockup: true, comparing: false });
    expect([mockup.flow.disabled, mockup.comment.disabled, mockup.inspect.disabled]).toEqual([true, true, true]);
  });
});
