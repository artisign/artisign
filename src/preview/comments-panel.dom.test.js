// @vitest-environment jsdom
//
// CHR-1268 — the Comments tool's thread list: rows from the shown scope's threads and messages, Open | Resolved, detached first.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { panelRows, panelFootText, renderCommentsPanel } from "./comments-panel.js";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const threads = [
  { id: "t1", node_id: "home.logo", author: "human", status: "open", detached: false },
  { id: "t2", node_id: "home.gone", author: "agent", agent: "ux-agent", status: "open", detached: true },
  { id: "t3", node_id: null, author: "human", status: "resolved", detached: false },
  { id: "t4", node_id: "home.cta", author: "agent", status: "open", detached: false },
];
const comments = [
  { id: "t1", text: "Bigger please", author: "human", parent_id: null, ts: at(30) },
  { id: "r1", text: "Done", author: "agent", agent: "ux-agent", parent_id: "t1", ts: at(6) },
  { id: "t2", text: "Removed it", author: "agent", agent: "ux-agent", parent_id: null, ts: at(180) },
  { id: "t3", text: "Fine now", author: "human", parent_id: null, ts: at(900) },
  { id: "t4", text: "Check the colour", author: "agent", parent_id: null, ts: at(2) },
];

describe("panelRows", () => {
  it("the Open tab lists detached threads first, then the log order; each row names the node, the last message and its age", () => {
    const rows = panelRows(threads, comments, "open", { now: NOW });
    expect(rows.map((r) => [r.id, r.number, r.kind, r.node, r.preview, r.time])).toEqual([
      ["t2", 2, "detached", "gone", "ux-agent: Removed it", "3h"],
      ["t1", 1, "open", "logo", "ux-agent: Done", "6m"], // the last message of the thread, not the first
      ["t4", 4, "open", "cta", "Agent: Check the colour", "2m"], // an agent line without a name
    ]);
  });

  it("the Resolved tab lists the resolved threads with their original numbers; a whole-screen thread has no node", () => {
    const rows = panelRows(threads, comments, "resolved", { now: NOW });
    expect(rows.map((r) => [r.id, r.number, r.kind, r.node])).toEqual([["t3", 3, "resolved", null]]);
    expect(rows[0].label).toBe("Comment 3 on the whole screen, resolved");
  });

  it("a mockup thread carries its variant's letter", () => {
    const rows = panelRows([{ id: "m1", node_id: "cart.row", author: "human", status: "open", detached: false, variant: "b" }], [{ id: "m1", text: "x", author: "human", parent_id: null, ts: at(1) }], "open", { now: NOW, variantLabel: (v) => v.toUpperCase() });
    expect(rows[0].variant).toBe("B");
    expect(rows[0].label).toBe("Comment 1 in variant B on row");
  });
});

describe("panelFootText", () => {
  it("explains what a row does, and what detached means when there is one", () => {
    expect(panelFootText([{ kind: "open" }], "open")).toBe("Select a thread to open it on the canvas. Reply and resolve in its popover.");
    expect(panelFootText([{ kind: "detached" }], "open")).toBe("Detached threads lost their element. Open one to move it or resolve it.");
    expect(panelFootText([{ kind: "resolved" }], "resolved")).toBe("Resolved pins show on the canvas while this tab is open. Reopen a thread from its popover.");
  });
});

describe("renderCommentsPanel", () => {
  let els;
  beforeEach(() => {
    document.body.innerHTML = `<button id="to"></button><button id="tr"></button><span id="co"></span><span id="cr"></span><ul id="list"></ul><p id="empty"></p><p id="foot"></p>`;
    els = { tabOpenEl: document.getElementById("to"), tabResolvedEl: document.getElementById("tr"), countOpenEl: document.getElementById("co"), countResolvedEl: document.getElementById("cr"), listEl: document.getElementById("list"), emptyEl: document.getElementById("empty"), footEl: document.getElementById("foot") };
  });

  it("draws one button per thread, counts both tabs, marks the open thread and calls onOpen with its id", () => {
    const onOpen = vi.fn();
    renderCommentsPanel(els, { threads, comments, tab: "open", activeId: "t1", onOpen });
    const rows = [...document.querySelectorAll(".comment-row")];
    expect(rows.map((r) => r.dataset.thread)).toEqual(["t2", "t1", "t4"]);
    expect(rows.every((r) => r.tagName === "BUTTON")).toBe(true);
    expect([els.countOpenEl.textContent, els.countResolvedEl.textContent]).toEqual(["3", "1"]);
    expect(els.tabOpenEl.getAttribute("aria-selected")).toBe("true");
    expect(rows[1].classList.contains("is-active")).toBe(true);
    expect(rows[0].querySelector(".comment-row-tag").textContent).toBe("Detached");
    expect(rows[0].getAttribute("aria-label")).toContain("Comment 2 on gone, detached");
    rows[2].click();
    expect(onOpen).toHaveBeenCalledWith("t4");
  });

  it("an empty tab shows its line instead of the list and no foot", () => {
    renderCommentsPanel(els, { threads: [], comments: [], tab: "resolved", activeId: null, onOpen: () => {} });
    expect(els.emptyEl.hidden).toBe(false);
    expect(els.emptyEl.textContent).toBe("No resolved comments.");
    expect(els.footEl.hidden).toBe(true);
    expect(els.tabResolvedEl.getAttribute("aria-selected")).toBe("true");
  });
});
