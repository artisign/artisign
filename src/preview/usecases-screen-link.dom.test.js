// @vitest-environment jsdom
//
// The reverse entry: use cases that map to the screen shown, as a short list in the Context panel.
import { describe, it, expect, vi } from "vitest";
import { renderScreenUseCases } from "./usecases-screen-link.js";

describe("screen -> use cases", () => {
  it("stays hidden when nothing maps to the screen", () => {
    const el = document.createElement("section");
    renderScreenUseCases(el, { total: 0, items: [], screen: "editor", onOpen: vi.fn(), onShowAll: vi.fn() });
    expect(el.hidden).toBe(true);
    expect(el.childElementCount).toBe(0);
  });

  it("lists the use cases (title as text, status dot), opens one, and offers all when there are more", () => {
    const el = document.createElement("section");
    const onOpen = vi.fn();
    const onShowAll = vi.fn();
    renderScreenUseCases(el, { total: 1284, items: [{ id: "a", title: "<b>Assign</b>", status: "ready" }, { id: "b", title: "Swap", status: "draft" }], screen: "editor-main", onOpen, onShowAll });
    expect(el.hidden).toBe(false);
    expect(el.querySelector(".screen-usecases-count").textContent).toBe("1,284");
    expect(el.querySelector(".screen-usecases-sub").textContent).toBe("Steps that map to editor-main");
    const rows = el.querySelectorAll(".screen-usecases-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("<b>Assign</b>");
    expect(rows[0].querySelector("b")).toBeNull();
    rows[1].click();
    expect(onOpen).toHaveBeenCalledWith("b");
    el.querySelector(".screen-usecases-all").click();
    expect(onShowAll).toHaveBeenCalled();
    expect(el.querySelector(".screen-usecases-all").textContent).toBe("Show all 1,284 in Use Cases");
  });

  it("no 'show all' when the list is complete", () => {
    const el = document.createElement("section");
    renderScreenUseCases(el, { total: 1, items: [{ id: "a", title: "A", status: "draft" }], screen: "s", onOpen: vi.fn(), onShowAll: vi.fn() });
    expect(el.querySelector(".screen-usecases-all")).toBeNull();
  });
});
