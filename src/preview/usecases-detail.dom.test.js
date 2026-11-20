// @vitest-environment jsdom
//
// The use-case detail view from get_use_case bundles: the base flow, a variant shown as a difference against the base,
// scope badges (Element / Screen / Stale), before/after data cards and the coverage matrix.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderDetail } from "./usecases-detail.js";
import { makePool, baseBundle, variantBundle, rawUseCase } from "./usecases.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function render(over = {}) {
  const root = document.createElement("div");
  const handlers = { onVariant: vi.fn(), onEdit: vi.fn(), onMap: vi.fn(), onCopyId: vi.fn(), onCopy: vi.fn(), onAddVariant: vi.fn(), onToggleCoverage: vi.fn(), onDelete: vi.fn() };
  renderDetail(root, { bundle: baseBundle, base: baseBundle, source: rawUseCase, variantId: null, pool: makePool(), coverageOpen: false, handlers, ...over });
  document.body.replaceChildren(root);
  return { root, handlers };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("base flow", () => {
  it("shows header, personas, the three-cell story and the numbered flow", () => {
    render();
    expect($(".uc-title").textContent).toBe("Map a step to an element");
    expect($(".uc-breadcrumb").textContent).toContain("mapping");
    expect($(".uc-status").dataset.status).toBe("ready");
    expect($$(".uc-person-name").map((n) => n.textContent)).toEqual(["Dana"]);
    expect($(".uc-trigger-text").textContent).toBe("Step has no target");
    expect($$(".uc-story-cell p").map((p) => p.textContent)).toEqual(["Map it", "Mapped"]);
    expect($$(".uc-step-no").map((n) => n.textContent)).toEqual(["Step 1 · Dana", "Step 2 · Dana", "Step 3 · System"]);
    expect($(".uc-h2-meta").textContent).toContain("3 steps");
  });

  it("derives the scope badge per step: Element, Screen, Stale", () => {
    render();
    const chips = $$(".uc-target");
    expect(chips.map((c) => c.dataset.scope)).toEqual(["element", "screen", "stale"]);
    expect(chips[0].textContent).toContain("Element");
    expect(chips[0].textContent).toContain("btn-map");
    expect(chips[1].textContent).toContain("Screen");
    expect(chips[2].textContent).toContain("Stale");
    expect($(".uc-warn").textContent).toContain("Screen gone-screen no longer exists. Pick a new target.");
  });

  it("opens the mapping view for a step from its chip and for all steps from 'Show on screens'", () => {
    const { handlers } = render();
    $$(".uc-target")[1].click();
    expect(handlers.onMap).toHaveBeenCalledWith("pick");
    $$(".uc-actions button")
      .find((b) => b.textContent.includes("Show on screens"))
      .click();
    expect(handlers.onMap).toHaveBeenLastCalledWith(null);
  });

  it("draws before/after cards and highlights only the changed fields in the after card", () => {
    render();
    const cards = $$(".uc-data-card");
    expect(cards.map((c) => c.dataset.kind)).toEqual(["before", "after"]);
    expect($$(".uc-data-line.is-changed", cards[1]).map((l) => l.textContent)).toEqual(["status: ready", "owner: Pablo"]);
    expect($$(".uc-data-line.is-changed", cards[0])).toHaveLength(0);
  });

  it("lists inputs and outputs as data-object cards with field, type and example; changed output rows are highlighted", () => {
    render();
    const cards = $$(".uc-io-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Mapping");
    expect(cards[0].textContent).toContain("from mapping");
    expect(cards[1].textContent).toContain("to mapping");
    expect($$("tr.is-highlight td:first-child", cards[1]).map((c) => c.textContent)).toEqual(["status", "owner"]);
  });

  it("a variant whose only difference is an actor swap shows its change on the chip (spec §4), not '0 changes'", () => {
    const source = { ...rawUseCase, variants: [{ id: "swap", title: "Dex runs it", when: { actor: ["agent"] }, actors: { dana: "dex", nobody: "dex" } }] };
    const bundle = { ...baseBundle, variants: [{ id: "swap", title: "Dex runs it", when: { actor: ["agent"] } }] };
    render({ bundle, base: bundle, source });
    // dana is the actor of two base steps and counts once; "nobody" is no base step's actor and changes nothing
    expect($$(".uc-variant-chip").map((c) => c.textContent)).toEqual(["Base3 steps", "Dex runs it1 change", "addVariant"]);
  });

  it("variant chips switch the variant; the add chip asks for a new one; the id chip copies", () => {
    const { handlers } = render();
    const chips = $$(".uc-variant-chip");
    expect(chips.map((c) => c.textContent)).toEqual(["Base3 steps", "No human4 changes", "Large project0 changes", "addVariant"]);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
    chips[1].click();
    expect(handlers.onVariant).toHaveBeenCalledWith("agent");
    chips[0].click();
    expect(handlers.onVariant).toHaveBeenLastCalledWith(null);
    chips.at(-1).click();
    expect(handlers.onAddVariant).toHaveBeenCalled();
    $(".uc-id-chip").click();
    expect(handlers.onCopyId).toHaveBeenCalled();
  });

  it("lists each persona once, without claims the data model cannot back", () => {
    render({ bundle: { ...baseBundle, use_case: { ...baseBundle.use_case, personas: ["dana", "dex"] } }, base: baseBundle });
    expect($$(".uc-person").map((p) => p.querySelector(".uc-person-name").textContent)).toEqual(["Dana", "Dex"]);
    expect(document.body.textContent).not.toContain("does not act");
  });

  it("the more menu holds Delete", () => {
    const { handlers } = render();
    $(".uc-actions button[aria-label='More actions']").click();
    $$(".uc-menu .uc-menu-item")
      .find((i) => i.textContent.includes("Delete use case"))
      .click();
    expect(handlers.onDelete).toHaveBeenCalled();
  });
});

describe("variant as a difference", () => {
  const variantCtx = { bundle: variantBundle, base: baseBundle, variantId: "agent" };

  it("shows the when condition, matching personas, description and the diff legend", () => {
    render(variantCtx);
    expect($(".uc-variant-chip[aria-pressed=true]").textContent).toContain("No human");
    expect($(".uc-applies").textContent).toContain("Actor type");
    expect($(".uc-applies").textContent).toContain("Agent");
    expect($(".uc-applies").textContent).toContain("matches 1 persona");
    expect($(".uc-variant-desc").textContent).toBe("Agent covers the day.");
    expect($$(".uc-legend .uc-diff").map((d) => d.dataset.kind)).toEqual(["changed", "added", "removed", "base"]);
    expect($(".uc-legend-note").textContent).toBe("Overrides personas, outputs");
  });

  it("flags changed / added / from-base steps, says what changed and keeps the removed step as a ghost in place", () => {
    render(variantCtx);
    const steps = $$(".uc-step");
    expect(steps.map((s) => s.dataset.change || "removed")).toEqual(["base", "changed", "removed", "added"]); // the ghost stays where the base step was, after "pick"
    expect(steps[1].textContent).toContain("Actor was Dana");
    expect(steps[1].textContent).toContain("Base: Picks Pablo");
    expect(steps[2].classList.contains("is-removed")).toBe(true);
    expect(steps[2].querySelector("s").textContent).toBe("Base step · Dex gets a push");
    expect($(".uc-h2-meta").textContent).toBe("3 steps in this variant · 1 changed · 1 added · 1 removed");
    expect($$(".uc-step-no").map((n) => n.textContent)).toEqual(["Step 1 · Dana", "Step 2 · Dex", "Step 3 · Dex"]);
  });

  it("outputs replaced by the variant read 'Changed': old value struck, new field marked", () => {
    render(variantCtx);
    const outputs = $$(".uc-io-col")[1];
    expect(outputs.textContent).toContain("Changed");
    expect($("tr.is-changed s.uc-old", outputs).textContent).toBe("Pablo");
    expect($("tr.is-changed td:last-child", outputs).textContent).toContain("Agent");
    expect($$(".uc-io-col")[0].textContent).not.toContain("Changed");
  });

  it("coverage matrix: rows Base and each variant, columns the trait values, gaps from the tool", () => {
    const suggest = { coverage: [{ dimension: "size", covered: ["small", "large"], uncovered: ["medium"] }, { dimension: "actor", covered: ["human", "agent"], uncovered: [] }] };
    render({ ...variantCtx, suggest });
    const panel = $(".uc-coverage");
    expect($$("tbody th[scope=row]", panel).map((th) => th.textContent)).toEqual(["Base", "No human", "Large project"]);
    expect($$("thead th[scope=colgroup]", panel).map((th) => th.textContent)).toEqual(["Project size", "Actor type"]);
    const gapHead = $("thead th.is-gap", panel);
    expect(gapHead.textContent).toContain("Medium project");
    expect(gapHead.textContent).toContain("gap");
    expect($("tbody tr.is-selected th", panel).textContent).toBe("No human");
    expect($$("tbody tr", panel)[1].textContent).toContain("any"); // the variant's when does not constrain size
    expect($(".uc-legend-line", panel).textContent).toContain("A column that neither Base nor any variant covers is a gap");
    expect($(".uc-gap-box code", panel).textContent).toBe("Suggest variants for map-step");
    expect($(".uc-gap-box").textContent).toContain("1 gap: Project size (Medium project).");
  });

  it("the base view opens the coverage panel only on request (the hint toggles it)", () => {
    const { handlers } = render();
    expect($(".uc-coverage")).toBeNull();
    const hint = $(".uc-gap-hint");
    expect(hint.textContent).toContain("1 trait value not covered");
    hint.click();
    expect(handlers.onToggleCoverage).toHaveBeenCalled();
    render({ coverageOpen: true });
    expect($(".uc-coverage")).not.toBeNull();
  });
});

describe("empty parts", () => {
  it("shows no literal null text for a case without personas, actors, variants or description", () => {
    const bare = { ...baseBundle, use_case: { ...baseBundle.use_case, personas: [], steps: [], description: null }, variants: [] };
    const { root } = render({ bundle: bare, base: bare, source: { ...rawUseCase, personas: [], steps: [], variants: [] } });
    expect($(".uc-variant-bar")).not.toBeNull();
    expect(root.textContent).not.toContain("null");
    expect($(".uc-people")).toBeNull();
  });
});

describe("text safety", () => {
  it("authored text is shown as text, never as markup", () => {
    const evil = { ...baseBundle, use_case: { ...baseBundle.use_case, title: '<img src=x onerror="alert(1)">', trigger: "<b>bold</b>" } };
    render({ bundle: evil, base: evil });
    expect($(".uc-title").textContent).toBe('<img src=x onerror="alert(1)">');
    expect($(".uc-title img")).toBeNull();
    expect($(".uc-story-cell p b")).toBeNull();
  });
});
