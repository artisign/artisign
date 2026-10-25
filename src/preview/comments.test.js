import { describe, it, expect } from "vitest";
import { formatCommentTime, openNodeIds, openThreadCount, resolveSelectionAfterReload } from "./comments.js";

// node_id on a comment record is a full "<screen>.<node-id>" ref (see
// src/tools/comments.ts createComment) — DOM element ids inside the iframe
// are always bare (el.id has no dots), so openNodeIds must strip the
// screen prefix.
describe("openNodeIds", () => {
  it("returns bare node ids anchoring an unresolved root comment", () => {
    const comments = [
      { id: "c1", parent_id: null, node_id: "home.btn-1", resolved: false },
      { id: "c2", parent_id: null, node_id: "home.btn-2", resolved: false },
    ];
    expect(openNodeIds(comments)).toEqual(new Set(["btn-1", "btn-2"]));
  });

  it("excludes threads resolved by the root comment itself", () => {
    const comments = [{ id: "c1", parent_id: null, node_id: "home.btn-1", resolved: true }];
    expect(openNodeIds(comments)).toEqual(new Set());
  });

  it("excludes threads resolved by a reply, not just the root", () => {
    const comments = [
      { id: "c1", parent_id: null, node_id: "home.btn-1", resolved: false },
      { id: "c2", parent_id: "c1", node_id: "home.btn-1", resolved: true },
    ];
    expect(openNodeIds(comments)).toEqual(new Set());
  });

  it("excludes screen-level comments (node_id: null) — nothing to mark", () => {
    const comments = [{ id: "c1", parent_id: null, node_id: null, resolved: false }];
    expect(openNodeIds(comments)).toEqual(new Set());
  });

  it("ignores replies when collecting root node ids", () => {
    const comments = [
      { id: "c1", parent_id: null, node_id: "home.btn-1", resolved: false },
      { id: "c2", parent_id: "c1", node_id: "home.btn-1", resolved: false },
    ];
    expect(openNodeIds(comments)).toEqual(new Set(["btn-1"]));
  });
});

// After an SSE-triggered iframe reload, a same-screen comment
// selection should survive if its target still exists, and drop silently
// otherwise. A DIFFERENT-screen reload (selectionScreen !== reloadedScreen)
// always drops it — this is what catches a screen switch racing a click on
// the still-attached old screen's document, on top of
// app.js's own eager clear on switch.
describe("resolveSelectionAfterReload", () => {
  const base = { selectedNode: "btn-1", selectionScreen: "home", reloadedScreen: "home", nodeExists: true };

  it("keeps nothing selected as nothing selected", () => {
    expect(resolveSelectionAfterReload({ ...base, selectedNode: undefined })).toBeUndefined();
  });

  it("always keeps a screen-level target — the screen root is never gone", () => {
    expect(resolveSelectionAfterReload({ ...base, selectedNode: null, nodeExists: false })).toBeNull();
  });

  it("keeps a node target whose id still exists in the reloaded document", () => {
    expect(resolveSelectionAfterReload(base)).toBe("btn-1");
  });

  it("drops a node target silently once its id is gone from the reloaded document", () => {
    expect(resolveSelectionAfterReload({ ...base, nodeExists: false })).toBeUndefined();
  });

  it("drops a node target when the reload is for a different screen, even if the id still exists there", () => {
    expect(resolveSelectionAfterReload({ ...base, reloadedScreen: "second" })).toBeUndefined();
  });

  it("drops a screen-level target when the reload is for a different screen", () => {
    expect(resolveSelectionAfterReload({ ...base, selectedNode: null, reloadedScreen: "second" })).toBeUndefined();
  });
});

describe("openThreadCount", () => {
  it("counts root threads without a resolved record on the root or any reply", () => {
    const comments = [
      { id: "c1", parent_id: null, resolved: false },
      { id: "c2", parent_id: "c1", resolved: true },
      { id: "c3", parent_id: null, resolved: false },
      { id: "c4", parent_id: "c3", resolved: false },
      { id: "c5", parent_id: null, resolved: false },
    ];
    expect(openThreadCount(comments)).toBe(2);
    expect(openThreadCount([])).toBe(0);
  });
});

describe("formatCommentTime", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  it("is relative inside a day", () => {
    expect(formatCommentTime("2026-10-25T11:59:50Z", now)).toBe("just now");
    expect(formatCommentTime("2026-10-25T11:30:00Z", now)).toBe("30m ago");
    expect(formatCommentTime("2026-10-25T09:00:00Z", now)).toBe("3h ago");
  });
  it("is empty for a missing or unparseable timestamp", () => {
    expect(formatCommentTime(undefined, now)).toBe("");
    expect(formatCommentTime("nope", now)).toBe("");
  });
});
