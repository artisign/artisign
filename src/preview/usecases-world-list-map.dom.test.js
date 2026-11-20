// @vitest-environment jsdom
//
// The world model in the list (constellation filter chip, count pills, "matched by a variant") and in the mapping view
// (branch steps numbered under their fork). Neutral insurance fixtures.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createListPanel } from "./usecases-list.js";
import { createMappingView, framesOf } from "./usecases-mapping.js";
import { EMPTY_FILTERS, buildQuery, flattenFlat } from "./usecases-data.js";
import { baseCase, worldBundle, makeWorldPool } from "./usecases-world.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("list", () => {
  let el;
  let handlers;
  let panel;
  beforeEach(() => {
    document.body.replaceChildren();
    el = document.createElement("div");
    document.body.append(el);
    handlers = { onQuery: vi.fn(), onFilterMenu: vi.fn(), onClearFilter: vi.fn(), onToggleHasVariants: vi.fn(), onSortMenu: vi.fn(), onOpenCase: vi.fn(), onToggleGroup: vi.fn(), onMore: vi.fn(), onActive: vi.fn(), onNeedMore: vi.fn() };
    panel = createListPanel(el, handlers);
  });
  const update = (items, filters = {}) =>
    panel.update({ filters: { ...EMPTY_FILTERS, ...filters }, sort: "title", total: items.length, counts: { use_cases: items.length }, rows: flattenFlat({ items, withHeaders: false, total: items.length, loading: false }), selectedId: null, activeKey: null, labels: { persona: "", constellation: filters.constellation ? "Single parent, one child" : "" }, loading: false, error: "", empty: false });

  it("has a Constellation chip after Persona that opens its menu", () => {
    update([]);
    const chips = $$(".uc-filter-chip");
    expect(chips[1].textContent).toContain("Constellation");
    $(".uc-filter-chip-main", chips[1]).click();
    expect(handlers.onFilterMenu).toHaveBeenCalledWith("constellation", expect.any(HTMLElement));
  });

  it("an active constellation filter says its name and clears", () => {
    update([], { constellation: "single-parent" });
    const chip = $$(".uc-filter-chip")[1];
    expect(chip.dataset.state).toBe("active");
    expect(chip.textContent).toContain("Constellation: Single parent, one child");
    $(".uc-filter-clear", chip).click();
    expect(handlers.onClearFilter).toHaveBeenCalledWith("constellation");
  });

  it("rows show branch and constellation counts as pills with a visually hidden word; a pill at 0 is omitted", () => {
    update([{ id: "a", title: "A", status: "ready", steps: 3, branches: 3, constellations: ["x", "y", "z"] }, { id: "b", title: "B", status: "draft", steps: 1, constellations: ["x"] }, { id: "c", title: "C", status: "draft", steps: 1 }]);
    const rows = $$(".uc-list-row");
    expect($$(".uc-count-pill", rows[0]).map((p) => p.textContent.replace(/^[a-z_]+/, "").trim())).toEqual(["3 branches", "3 constellations"]);
    expect($$(".uc-count-pill", rows[1]).map((p) => p.textContent.includes("constellation") && !p.textContent.includes("constellations"))).toEqual([true]);
    expect($$(".uc-count-pill", rows[2])).toHaveLength(0);
    expect($(".mcp-visually-hidden", rows[0])).not.toBeNull();
  });

  it("a case the constellation filter found only through a variant says so", () => {
    update([{ id: "a", title: "A", status: "draft", steps: 1, constellations: ["x"] }, { id: "b", title: "B", status: "draft", steps: 1, constellations: ["single-parent"] }], { constellation: "single-parent" });
    expect($$(".uc-list-via").map((n) => n.textContent)).toEqual(["matched by a variant"]);
    expect($$(".uc-list-row")[0].querySelector(".uc-list-via")).not.toBeNull();
  });

  it("the filter goes to list_use_cases as `constellation`", () => {
    expect(buildQuery({ ...EMPTY_FILTERS, constellation: "single-parent" })).toEqual({ constellation: "single-parent" });
    expect(buildQuery({ ...EMPTY_FILTERS })).toEqual({});
  });
});

describe("mapping view", () => {
  it("framesOf numbers main steps 1, 2, 3 and branch steps by fork, letter and position; a branch before the first step leads", () => {
    const frames = framesOf(baseCase.steps, worldBundle, baseCase.branches);
    expect(frames.map((f) => f.screen)).toEqual(["notice-offline", "notice", "options", "ends"]);
    expect(frames.map((f) => f.steps.map((s) => s.number))).toEqual([["A.1"], [1, 2, 3], ["2A.1", "2A.2"], ["2B.1"]]);
    expect(frames[2].steps.map((s) => s.branch)).toEqual([true, true]);
  });

  describe("view", () => {
    let root;
    let handlers;
    let view;
    beforeEach(() => {
      document.body.replaceChildren();
      root = document.createElement("div");
      document.body.append(root);
      handlers = { onBack: vi.fn(), onVariantMenu: vi.fn(), onOpenScreen: vi.fn(), onPickTarget: vi.fn(), onUnmap: vi.fn(), onStep: vi.fn() };
      view = createMappingView({ root, fetchRender: vi.fn(async (screen) => ({ ok: true, html: `<main id="${screen}"><div id="compare">x</div><div id="btn-accept">y</div><div id="btn-cosign">z</div></main>` })), handlers });
    });
    const show = (over = {}) => view.show({ project: "/p", bundle: worldBundle, variantId: null, variants: worldBundle.variants, pool: makeWorldPool(), stepId: null, ...over });

    it("lists each branch as a block under its fork step with numbered steps and its end", async () => {
      show();
      await flush();
      const order = $$(".uc-map-flow > .uc-map-steps > li").map((li) => li.dataset.branch || li.dataset.step);
      expect(order).toEqual(["offline", "open", "compare", "rise", "adult", "accept"]);
      const rise = $(".uc-map-branch[data-branch=rise]");
      expect($(".uc-map-branch-head", rise).textContent).toContain("Branch 2A · Premium rises by more than 15 %");
      expect($(".uc-map-branch-head", $(".uc-map-branch[data-branch=offline]")).textContent).toContain("Branch A · before the first step · Device is offline");
      expect($$(".uc-frame-no", rise).map((n) => n.textContent)).toEqual(["2A.1", "2A.2"]);
      expect($$(".uc-frame-no.is-branch", rise)).toHaveLength(2);
      expect($(".uc-map-branch-end", rise).textContent).toBe("continues at 3");
      expect($(".uc-map-branch-end", $(".uc-map-branch[data-branch=adult]")).textContent).toBe("ends the case");
      expect($(".uc-map-branch-end", $(".uc-map-branch[data-branch=offline]")).textContent).toBe("continues at 2");
    });

    it("frame labels list every step number of the frame, branch numbers dashed; a pin carries the branch number; the legend explains both", async () => {
      show();
      await flush();
      const frame = $$(".uc-frame").find((f) => f.textContent.includes("options"));
      expect($$(".uc-frame-label .uc-frame-no", frame).map((n) => [n.textContent, n.classList.contains("is-branch")])).toEqual([["2A.1", true], ["2A.2", true]]);
      expect($(".uc-pin[data-step=cosign] .uc-pin-no").textContent).toBe("2A.2");
      expect($(".uc-map-bar").textContent).toContain("Branch step: fork, letter, position");
    });

    it("selecting a branch step focuses its frame", async () => {
      show({ stepId: "cosign" });
      await flush();
      expect($(".uc-map-step[data-step=cosign]").classList.contains("is-selected")).toBe(true);
      expect($(".uc-frame-label.is-selected .uc-frame-name").textContent).toBe("options");
    });
  });
});
