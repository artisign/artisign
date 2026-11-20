// @vitest-environment jsdom
//
// CHR-1125 / ADR-010 amendment, item 10: what the case names but the pools lack is marked on the element, one marker per kind.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderDetail } from "./usecases-detail.js";
import { orphansOf, orphanSummary } from "./usecases-orphans.js";
import { baseCase, worldBundle, rawVariant, makeWorldPool, constellations } from "./usecases-world.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);

function render(bundle) {
  const root = document.createElement("div");
  const handlers = { onVariant: vi.fn(), onEdit: vi.fn(), onMap: vi.fn(), onCopyId: vi.fn(), onCopy: vi.fn(), onAddVariant: vi.fn(), onToggleCoverage: vi.fn(), onDelete: vi.fn() };
  renderDetail(root, { bundle, base: bundle, source: { ...baseCase, variants: [rawVariant] }, variantId: null, pool: makeWorldPool(), coverageOpen: true, suggest: { coverage: [] }, handlers });
  document.body.replaceChildren(root);
  return root;
}
const withWarnings = (bundle, warnings, over = {}) => ({ ...bundle, ...over, warnings: warnings.concat(bundle.warnings.filter((w) => w.kind !== "unknown_constellation" && w.kind !== "unknown_participant")) });

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("orphan markers", () => {
  it("unknown_participant: a relationship end and a member chip that is neither persona nor entity", () => {
    const broken = constellations.map((c) => (c.id === "single-parent" ? { ...c, relationships: [{ from: "maria", type: "parent-of", to: "ghost" }] } : c));
    const warnings = [{ kind: "unknown_participant", target: "constellation:single-parent", message: '"ghost" in relationship "maria parent-of ghost" is neither a persona nor an entity' }];
    render(withWarnings(worldBundle, warnings, { constellations: broken }));
    const card = $('.uc-cst[data-constellation="single-parent"]');
    expect($('.uc-relation-end[data-orphan="participant"]', card).textContent).toContain("ghost");
    expect($('.uc-participant[data-orphan="participant"]', card).textContent).toContain("ghost");
  });

  it("unknown_relationship_type: the type label of a relationship is marked", () => {
    const broken = constellations.map((c) => (c.id === "single-parent" ? { ...c, relationships: [{ from: "maria", type: "mentors", to: "leo" }] } : c));
    const warnings = [{ kind: "unknown_relationship_type", target: "constellation:single-parent", message: 'relationship "maria mentors leo" names undeclared type "mentors"' }];
    render(withWarnings(worldBundle, warnings, { constellations: broken }));
    expect($('.uc-cst[data-constellation="single-parent"] [data-orphan="relationship_type"]').textContent).toBe("mentors");
    expect($('.uc-cst[data-constellation="two-parents"] [data-orphan="relationship_type"]')).toBeNull();
  });

  it("unknown_data_object: an input/output card and a step data card are marked as missing", () => {
    const steps = baseCase.steps.map((s) => (s.id === "open" ? { ...s, data: [{ object: "premium", before: { amount: 1 }, after: { amount: 2 } }] } : s));
    const warnings = [{ kind: "unknown_data_object", target: "use_case:review-premium", message: 'data object "premium" does not exist' }];
    render(withWarnings(worldBundle, warnings, { use_case: { ...baseCase, steps } }));
    expect($('.uc-io-head [data-orphan="data_object"]').textContent).toContain("Missing from the pool");
    expect($('.uc-step-data[data-orphan="data_object"]').textContent).toContain('Data object "premium" is missing');
  });

  it("actor markers: a step actor and a trigger actor the pool no longer has", () => {
    const steps = baseCase.steps.map((s) => (s.id === "open" ? { ...s, actor: "ghost" } : s));
    const trigger = { ...baseCase.trigger, actor: "phantom" };
    const warnings = [
      { kind: "unknown_persona", target: "use_case:review-premium/open", message: 'persona "ghost" does not exist' },
      { kind: "unknown_persona", target: "use_case:review-premium", message: 'persona "phantom" does not exist' },
    ];
    render(withWarnings(worldBundle, warnings, { use_case: { ...baseCase, steps, trigger } }));
    expect($('.uc-step[data-step="open"] [data-orphan="actor"]').textContent).toContain("ghost is missing from the persona pool");
    expect($('.uc-trigger-actor[data-orphan="actor"]').textContent).toContain("Missing from the persona pool");
    expect($('.uc-step[data-step="compare"] [data-orphan="actor"]')).toBeNull(); // system never is
  });

  it("a constellation the case lists but the world lacks is a marked row in the World card", () => {
    render(worldBundle);
    const card = $('.uc-cst[data-orphan="constellation"]');
    expect(card.dataset.constellation).toBe("three-generations");
    expect(card.textContent).toContain("Not in the world pool");
  });
});

describe("the coverage card counts the new kinds", () => {
  it.each([
    ["unknown_participant", "constellation:single-parent", '"ghost" in relationship "a b ghost" is neither a persona nor an entity', "participant"],
    ["unknown_relationship_type", "constellation:single-parent", 'relationship "a mentors b" names undeclared type "mentors"', "relationship type"],
    ["unknown_data_object", "use_case:review-premium", 'data object "premium" does not exist', "data object"],
  ])("%s: never full coverage, and the card names it", (kind, target, message, word) => {
    const root = render(withWarnings(worldBundle, [{ kind, target, message }]));
    const panel = $(".uc-coverage", root);
    expect(panel.textContent).not.toContain("Every trait value the persona pool uses is covered");
    expect($(".uc-orphan-box", panel).textContent).toContain(word);
  });

  it("orphansOf reads the ids out of the messages, only for this case and its constellations", () => {
    const o = orphansOf(
      [
        { kind: "unknown_participant", target: "constellation:c1", message: '"ghost" in relationship "x" is neither a persona nor an entity' },
        { kind: "unknown_participant", target: "constellation:other", message: '"nobody" in relationship "x" is neither a persona nor an entity' },
        { kind: "unknown_data_object", target: "use_case:a/step", message: 'data object "book" does not exist' },
        { kind: "unknown_data_object", target: "use_case:b", message: 'data object "ignored" does not exist' },
      ],
      "a",
      ["c1"],
    );
    expect([...o.participants]).toEqual(["ghost"]);
    expect([...o.dataObjects]).toEqual(["book"]);
    expect(orphanSummary(o)).toContain("ghost");
  });
});
