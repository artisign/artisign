import { describe, it, expect } from "vitest";
import { numberThreads, pinnedThreads, placePopover, relativeTime, mentionAt, authorLabel, countRow, mockupCommentTarget, threadKind } from "./comment-canvas.js";

// CHR-1248 — the pure parts of the canvas comment layer.
describe("numberThreads", () => {
  it("numbers threads 1-based in log order, resolved ones included", () => {
    expect([...numberThreads([{ id: "a" }, { id: "b" }, { id: "c" }])]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });
});

describe("pinnedThreads", () => {
  const threads = [
    { id: "a", status: "open" },
    { id: "b", status: "resolved" },
  ];
  it("pins open threads, resolved ones only with Show resolved, none with Hide pins", () => {
    expect(pinnedThreads(threads, { showResolved: false, hidePins: false }).map((t) => t.id)).toEqual(["a"]);
    expect(pinnedThreads(threads, { showResolved: true, hidePins: false }).map((t) => t.id)).toEqual(["a", "b"]);
    expect(pinnedThreads(threads, { showResolved: true, hidePins: true })).toEqual([]);
  });
});

describe("placePopover", () => {
  const view = { left: 0, top: 0, right: 1000, bottom: 800 };
  const size = { width: 320, height: 200 };
  it("opens to the right of the element", () => {
    expect(placePopover({ left: 100, top: 100, right: 200, bottom: 140 }, size, view)).toEqual({ left: 214, top: 92, side: "right" });
  });
  it("flips left when the right has no room", () => {
    expect(placePopover({ left: 600, top: 100, right: 900, bottom: 140 }, size, view)).toMatchObject({ left: 266, side: "left" });
  });
  it("goes below when neither side has room, clamped into the view", () => {
    const place = placePopover({ left: 200, top: 100, right: 800, bottom: 140 }, size, view);
    expect(place).toMatchObject({ top: 154, side: "below" });
    expect(place.left).toBeLessThanOrEqual(view.right - size.width);
  });
  it("goes above when below has no room either", () => {
    expect(placePopover({ left: 200, top: 600, right: 800, bottom: 700 }, size, view)).toMatchObject({ top: 386, side: "above" });
  });
  it("keeps a side placement inside the view vertically", () => {
    expect(placePopover({ left: 100, top: 750, right: 200, bottom: 790 }, size, view).top).toBe(592);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  it("reads now, minutes, hours and days", () => {
    expect(relativeTime("2026-11-26T11:59:30.000Z", now)).toBe("now");
    expect(relativeTime("2026-11-26T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-11-26T10:00:00.000Z", now)).toBe("2h");
    expect(relativeTime("2026-11-23T12:00:00.000Z", now)).toBe("3d");
  });
  it("is empty for a missing or broken timestamp", () => {
    expect(relativeTime(undefined, now)).toBe("");
    expect(relativeTime("nope", now)).toBe("");
  });
});

describe("mentionAt", () => {
  it("finds the @-mention being typed at the caret", () => {
    expect(mentionAt("hi @ux", 6)).toEqual({ start: 3, query: "ux" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("ignores an @ inside a word and text after the caret", () => {
    expect(mentionAt("mail@ux", 7)).toBeNull();
    expect(mentionAt("hi @ux done", 11)).toBeNull();
  });
});

describe("authorLabel", () => {
  it("names the agent, falls back to Agent, and calls the human You", () => {
    expect(authorLabel({ author: "agent", agent: "ux-agent" })).toBe("ux-agent");
    expect(authorLabel({ author: "agent" })).toBe("Agent");
    expect(authorLabel({ author: "human" })).toBe("You");
  });
});

describe("countRow", () => {
  it("counts open threads and their detached share", () => {
    expect(countRow([])).toEqual({ label: "No open comments", open: 0, detached: 0 });
    expect(countRow([{ status: "resolved", detached: false }])).toMatchObject({ label: "No open comments" });
    expect(countRow([{ status: "open", detached: false }])).toMatchObject({ label: "1 open comment", open: 1 });
    expect(
      countRow([
        { status: "open", detached: true },
        { status: "open", detached: false },
      ]),
    ).toEqual({ label: "2 open comments", open: 2, detached: 1 });
  });
});

describe("threadKind", () => {
  it("is resolved first, then detached, else open", () => {
    expect(threadKind({ status: "resolved", detached: true })).toBe("resolved");
    expect(threadKind({ status: "open", detached: true })).toBe("detached");
    expect(threadKind({ status: "open", detached: false })).toBe("open");
  });
});

describe("mockupCommentTarget", () => {
  const el = (id, parent) => ({ id, closest: (sel) => (sel === "[id]" ? (id ? { id } : parent?.closest(sel) ?? null) : null) });
  it("picks the nearest element with an authored id, the whole variant when there is none", () => {
    const card = el("a-card");
    expect(mockupCommentTarget(el("", card))).toEqual({ el: { id: "a-card" }, id: "a-card" });
    expect(mockupCommentTarget(el(""))).toEqual({ el: null, id: null });
    expect(mockupCommentTarget(null)).toEqual({ el: null, id: null });
  });
});
