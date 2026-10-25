// @vitest-environment jsdom
//
// Smoke tests for renderCommentsPanel's DOM output — thread/reply structure
// and reply-form wiring only. openNodeIds/resolveSelectionAfterReload (the
// actual logic) are tested directly in comments.test.js under the fast node
// environment; this file exists solely because rendering needs a real
// `document`.
import { describe, it, expect } from "vitest";
import { renderCommentsPanel } from "./comments.js";

describe("renderCommentsPanel", () => {
  it("shows an empty state when there are no comments", () => {
    const listEl = document.createElement("ul");
    renderCommentsPanel(listEl, [], () => {});
    expect(listEl.querySelector(".comments-empty")).not.toBeNull();
  });

  it("renders a root comment with its replies indented, in append order", () => {
    const listEl = document.createElement("ul");
    const comments = [
      { id: "c1", parent_id: null, node_id: "home.btn-1", author: "agent", text: "Looks off", resolved: false },
      { id: "c2", parent_id: "c1", node_id: "home.btn-1", author: "human", text: "Fixed", resolved: false },
    ];
    renderCommentsPanel(listEl, comments, () => {});

    const items = listEl.querySelectorAll(".comment-item");
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains("comment-reply")).toBe(false);
    expect(items[0].querySelector(".comment-author").textContent).toBe("agent");
    expect(items[0].querySelector(".comment-target").textContent).toBe("btn-1");
    expect(items[1].classList.contains("comment-reply")).toBe(true);
    expect(items[1].querySelector(".comment-author").textContent).toBe("human");
    expect(items[1].querySelector(".comment-target")).toBeNull(); // a reply shares its root's anchor

    // The reply affordance must come after the replies it answers, not
    // before (comments.js's renderCommentsPanel doc comment) — assert the
    // actual DOM order, not just presence of each piece.
    const children = [...listEl.children];
    expect(children.map((el) => el.className)).toEqual([
      "comment-item",
      "comment-item comment-reply",
      "comment-reply-affordance comment-reply",
    ]);
  });

  it("folds a thread any reply of which carries resolved:true into the collapsed N resolved row", () => {
    const listEl = document.createElement("ul");
    const comments = [
      { id: "c1", parent_id: null, node_id: null, author: "agent", text: "Root", resolved: false },
      { id: "c2", parent_id: "c1", node_id: null, author: "human", text: "Done", resolved: true },
      { id: "c3", parent_id: null, node_id: "home.n1", author: "human", text: "Still open", resolved: false },
    ];
    renderCommentsPanel(listEl, comments, () => {});
    // The open thread stays in the list; the resolved one hides behind the row.
    expect([...listEl.children].filter((el) => el.classList.contains("comment-item")).map((el) => el.querySelector(".comment-body").textContent)).toEqual(["Still open"]);
    const toggle = listEl.querySelector(".comments-resolved-toggle");
    expect(toggle.textContent).toBe("check_circle1 resolved");
    const resolvedList = listEl.querySelector(".comments-resolved-list");
    expect(resolvedList.hidden).toBe(true);
    expect(resolvedList.querySelector(".comment-target").textContent).toBe("screen");
    toggle.click();
    expect(resolvedList.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The open state survives the next re-render (every SSE comments event re-renders).
    renderCommentsPanel(listEl, comments, () => {});
    expect(listEl.querySelector(".comments-resolved-list").hidden).toBe(false);
    listEl.querySelector(".comments-resolved-toggle").click();
    expect(listEl.querySelector(".comments-resolved-list").hidden).toBe(true);
  });

  it("shows a relative time next to the author when the record has a timestamp", () => {
    const listEl = document.createElement("ul");
    const ts = new Date(Date.now() - 5 * 60000).toISOString();
    renderCommentsPanel(listEl, [{ id: "c1", parent_id: null, node_id: null, author: "human", text: "t", resolved: false, ts }]);
    expect(listEl.querySelector(".comment-time").textContent).toBe("· 5m ago");
  });

  it("only adds a reply affordance when onReply is passed, and wires submit to it", () => {
    const listElWithout = document.createElement("ul");
    renderCommentsPanel(listElWithout, [{ id: "c1", parent_id: null, node_id: null, author: "a", text: "t", resolved: false }]);
    expect(listElWithout.querySelector(".comment-reply-affordance")).toBeNull();

    const listEl = document.createElement("ul");
    const replies = [];
    renderCommentsPanel(listEl, [{ id: "c1", parent_id: null, node_id: null, author: "a", text: "t", resolved: false }], (rootId, text) =>
      replies.push([rootId, text]),
    );

    const toggle = listEl.querySelector(".comment-reply-toggle");
    toggle.click();
    const form = listEl.querySelector(".comment-reply-form");
    expect(form.hidden).toBe(false);

    form.querySelector("textarea").value = "  a reply  ";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(replies).toEqual([["c1", "a reply"]]);
  });

  it("shows the reply error message when onReply calls its onError callback", () => {
    const listEl = document.createElement("ul");
    renderCommentsPanel(listEl, [{ id: "c1", parent_id: null, node_id: null, author: "a", text: "t", resolved: false }], (rootId, text, onError) =>
      onError("could not post reply"),
    );

    listEl.querySelector(".comment-reply-toggle").click();
    const form = listEl.querySelector(".comment-reply-form");
    form.querySelector("textarea").value = "a reply";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    const error = listEl.querySelector(".comment-reply-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("could not post reply");
  });
});
