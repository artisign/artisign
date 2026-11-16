// @vitest-environment jsdom
//
// The use-case list panel: a virtual tree (only the rows near the viewport exist as DOM), filter chips, result line and
// keyboard model. Built for thousands of rows: the DOM stays small however many rows the model holds.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createListPanel } from "./usecases-list.js";
import { EMPTY_FILTERS, buildGroupTree, flattenTree, flattenFlat } from "./usecases-data.js";

function handlersFor() {
  return {
    onQuery: vi.fn(),
    onFilterMenu: vi.fn(),
    onClearFilter: vi.fn(),
    onToggleHasVariants: vi.fn(),
    onSortMenu: vi.fn(),
    onOpenCase: vi.fn(),
    onToggleGroup: vi.fn(),
    onMore: vi.fn(),
    onActive: vi.fn(),
    onNeedMore: vi.fn(),
  };
}

const model = (over = {}) => ({ filters: { ...EMPTY_FILTERS }, sort: "group", total: 0, counts: { use_cases: 0 }, rows: [], selectedId: null, activeKey: null, labels: { persona: "" }, loading: false, error: "", empty: false, ...over });
const $ = (sel, root = document) => root.querySelector(sel);

describe("list panel", () => {
  let el;
  let handlers;
  let panel;
  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.append(el);
    handlers = handlersFor();
    panel = createListPanel(el, handlers);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders a window of a 5,000-row list, never all of it", () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, title: `Case ${i}`, status: "draft", steps: 1 }));
    const rows = flattenFlat({ items, withHeaders: false, total: 5000, loading: false });
    panel.update(model({ rows, total: 5000, counts: { use_cases: 5000 } }));
    expect(panel.totalRows()).toBe(5000);
    expect(panel.renderedRows()).toBeLessThan(40);
    expect($(".uc-result-text").textContent).toBe("5,000 use cases");
    expect($(".uc-tree-spacer").style.height).toBe(`${5000 * 46}px`);
  });

  it("marks the tree for assistive tech: tree / treeitem, levels, expanded state, the selected case", () => {
    const tree = buildGroupTree({ "mapping/elements": 2 });
    const rows = flattenTree({ roots: tree.roots, expanded: new Set(["mapping", "mapping/elements"]), groupState: new Map([["mapping/elements", { rows: [{ id: "a", title: "A", status: "ready", steps: 1 }, { id: "b", title: "B", status: "draft", steps: 1 }], loading: false }]]), ungrouped: null });
    panel.update(model({ rows, total: 2, selectedId: "b" }));
    expect($(".uc-tree").getAttribute("role")).toBe("tree");
    const items = [...el.querySelectorAll("[role=treeitem]")];
    expect(items.map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "3", "3"]);
    expect(items[0].getAttribute("aria-expanded")).toBe("true");
    expect(items[3].getAttribute("aria-selected")).toBe("true");
    expect(items[2].getAttribute("aria-selected")).toBe("false");
    expect(items[0].querySelector(".uc-group-count").textContent).toBe("2");
  });

  it("clicks: a group row toggles, a case row opens, 'Show N more' asks for more", () => {
    const tree = buildGroupTree({ g: 9 });
    const rows = flattenTree({ roots: tree.roots, expanded: new Set(["g"]), groupState: new Map([["g", { rows: [{ id: "a", title: "A", status: "draft", steps: 1 }], loading: false }]]), ungrouped: null });
    panel.update(model({ rows, total: 9 }));
    el.querySelector(".uc-group-row").click();
    expect(handlers.onToggleGroup).toHaveBeenCalledWith("g");
    el.querySelector(".uc-list-row").click();
    expect(handlers.onOpenCase).toHaveBeenCalledWith("a");
    expect(el.querySelector(".uc-more-row").textContent).toBe("Show 8 more");
    el.querySelector(".uc-more-row").click();
    expect(handlers.onMore).toHaveBeenCalledWith("g");
  });

  it("keyboard: arrows move the active row, Right opens a group, Enter opens a case", () => {
    const tree = buildGroupTree({ g: 1 });
    const rows = flattenTree({ roots: tree.roots, expanded: new Set(), groupState: new Map(), ungrouped: null });
    panel.update(model({ rows, total: 1, activeKey: "g:g" }));
    const treeEl = $(".uc-tree");
    treeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(handlers.onToggleGroup).toHaveBeenCalledWith("g");
    const caseRows = flattenFlat({ items: [{ id: "x", title: "X", status: "draft", steps: 1 }, { id: "y", title: "Y", status: "draft", steps: 1 }], withHeaders: false, total: 2, loading: false });
    panel.update(model({ rows: caseRows, total: 2, activeKey: "c:x" }));
    treeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(handlers.onActive).toHaveBeenLastCalledWith("c:y");
    treeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onOpenCase).toHaveBeenCalledWith("y");
  });

  it("shows the filtered count, active chips with a clear button, and the empty text", () => {
    panel.update(model({ filters: { ...EMPTY_FILTERS, persona: "dana", hasVariants: true }, total: 212, counts: { use_cases: 1284 }, labels: { persona: "Dana" } }));
    expect($(".uc-result-text").textContent).toBe("212 of 1,284 use cases");
    const chips = [...el.querySelectorAll(".uc-filter-chip")];
    expect(chips[0].dataset.state).toBe("active");
    expect(chips[0].textContent).toContain("Persona: Dana");
    expect(chips.at(-1).getAttribute("aria-pressed")).toBe("true");
    el.querySelector(".uc-filter-clear").click();
    expect(handlers.onClearFilter).toHaveBeenCalledWith("persona");
    expect($(".uc-list-status").textContent).toBe("No use case matches these filters.");
    expect($(".uc-list-status").hidden).toBe(false);
  });

  it("search is debounced and Escape clears it", () => {
    const input = $(".uc-search-input");
    input.value = "actor";
    input.dispatchEvent(new Event("input"));
    input.value = "owner";
    input.dispatchEvent(new Event("input"));
    expect(handlers.onQuery).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(handlers.onQuery).toHaveBeenCalledTimes(1);
    expect(handlers.onQuery).toHaveBeenCalledWith("owner");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handlers.onQuery).toHaveBeenLastCalledWith("");
  });

  it("an empty project hides filters and result line and says '0 use cases · 0 personas'", () => {
    panel.update(model({ empty: true, emptyText: "0 use cases · 0 personas" }));
    expect($(".uc-filters").hidden).toBe(true);
    expect($(".uc-list-status").textContent).toBe("0 use cases · 0 personas");
  });

  it("a flat list whose 'more' row is within reach asks for the next page by itself", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, title: `Case ${i}`, status: "draft", steps: 1 }));
    panel.update(model({ rows: flattenFlat({ items, withHeaders: false, total: 300, loading: false }), total: 300 }));
    expect(handlers.onNeedMore).toHaveBeenCalled();
    handlers.onNeedMore.mockClear();
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, title: `D ${i}`, status: "draft", steps: 1 }));
    panel.update(model({ rows: flattenFlat({ items: many, withHeaders: false, total: 300, loading: false }), total: 300 }));
    expect(handlers.onNeedMore).not.toHaveBeenCalled(); // far from the end of what is loaded
  });
});
