// @vitest-environment jsdom
//
// The world model in the detail view (ADR-011): trigger line, World cards, starting-state table, branch lanes, the variant
// differences, and warnings at their targets. Neutral insurance fixtures.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderDetail } from "./usecases-detail.js";
import { baseCase, rawVariant, worldBundle, worldVariantBundle, makeWorldPool } from "./usecases-world.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

function render(over = {}) {
  const root = document.createElement("div");
  const handlers = { onVariant: vi.fn(), onEdit: vi.fn(), onMap: vi.fn(), onCopyId: vi.fn(), onCopy: vi.fn(), onAddVariant: vi.fn(), onToggleCoverage: vi.fn(), onDelete: vi.fn() };
  renderDetail(root, { bundle: worldBundle, base: worldBundle, source: { ...baseCase, variants: [rawVariant] }, variantId: null, pool: makeWorldPool(), coverageOpen: false, handlers, ...over });
  document.body.replaceChildren(root);
  return { root, handlers };
}
const renderVariant = (over = {}) => render({ bundle: worldVariantBundle, variantId: "single", ...over });

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("trigger line", () => {
  it("an action trigger shows the actor with its kind icon, the text and the via chip", () => {
    render();
    const trigger = $(".uc-trigger");
    expect(text(trigger)).toContain("Trigger · an action");
    expect($(".uc-trigger-name", trigger).textContent).toBe("Insurer North");
    expect($(".uc-kind", trigger).getAttribute("aria-label")).toBe("Organization");
    expect($(".uc-trigger-text", trigger).textContent).toBe("sends the renewal notice");
    expect(text($(".uc-trigger-via", trigger))).toBe("viawebhook");
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("a state trigger shows condition chips and the time chip; a string trigger shows its text only", () => {
    const state = { ...worldBundle, use_case: { ...baseCase, trigger: { text: "The premium crosses the limit", state: [{ subject: "policy", property: "premium", op: "gte", value: 150 }], at: "2027-01-01" } } };
    render({ bundle: state, base: state });
    expect(text($(".uc-trigger"))).toContain("Trigger · a state or time");
    expect(text($(".uc-trigger .uc-cond"))).toBe("policy.premium≥150");
    expect(text($(".uc-cond-time"))).toBe("eventfrom2027-01-01");
    const plain = { ...worldBundle, use_case: { ...baseCase, trigger: "A plain text trigger" } };
    render({ bundle: plain, base: plain });
    expect($(".uc-trigger-actor")).toBeNull();
    expect($(".uc-trigger-text").textContent).toBe("A plain text trigger");
    expect(text($(".uc-trigger .uc-story-label"))).toBe("boltTrigger");
  });

  it("the trigger actor's warning shows on the trigger line", () => {
    render();
    expect(text($(".uc-trigger"))).toContain("not a member of any of the constellations");
  });
});

describe("world cards", () => {
  it("draws one card per constellation with trait chips, relation rows (with the note) and the members", () => {
    render();
    const cards = $$(".uc-cst:not(.is-unknown)");
    expect(cards.map((c) => $(".uc-cst-name", c).textContent)).toEqual(["Two parents, one child", "Single parent, one child"]);
    expect(text($(".uc-cst-traits", cards[0]))).toBe("HouseholdTwo parents");
    expect($$(".uc-relation-line", cards[0]).map((row) => [...row.querySelectorAll(".uc-relation-end"), row.querySelector(".uc-relation-type > span:nth-child(2)")].map((el) => el.textContent))).toEqual([["Maria", "Jon", "is partner of"], ["Maria", "Leo", "is parent of"], ["Maria", "Household liability policy", "holds"]]);
    expect(text($(".uc-relation-note", cards[0]))).toBe("Primary caregiver");
    const members = $$(".uc-cst-members .uc-participant", cards[0]);
    expect(members.map((m) => $(".uc-participant-name", m).textContent)).toEqual(["Maria", "Jon", "Leo", "Household liability policy"]);
    expect($(".uc-avatar", members[2]).dataset.kind).toBe("entity");
    expect(text($(".uc-participant-type", members[2]))).toBe("Child");
    expect($(".uc-kind", members[0]).getAttribute("aria-label")).toBe("Human");
  });

  it("an id that is not in the pool is a dashed warning card and counts in the section line", () => {
    render();
    const unknown = $(".uc-cst.is-unknown");
    expect(text(unknown)).toContain("three-generations");
    expect(text(unknown)).toContain("Not in the world pool. Create the constellation in World or remove it from this case.");
    expect(text($("#uc-world-h").parentElement)).toContain("3 constellations · the case holds in any of them");
  });

  it("Open in World is plain navigation to the World tab", () => {
    const onOpenWorld = vi.fn();
    const { handlers } = render();
    expect($$(".uc-h2-action").some((b) => b.textContent === "Open in World")).toBe(false);
    renderDetail(document.body.firstChild, { bundle: worldBundle, base: worldBundle, source: baseCase, variantId: null, pool: makeWorldPool(), coverageOpen: false, handlers: { ...handlers, onOpenWorld } });
    $$(".uc-h2-action").find((b) => b.textContent === "Open in World").click();
    expect(onOpenWorld).toHaveBeenCalledTimes(1);
    // a sibling of the heading in its row, not part of the heading's name
    expect($("#uc-world-h").textContent).not.toContain("Open in World");
    expect($(".uc-h2-action").parentElement).toBe($("#uc-world-h").parentElement);
  });

  it("a case without constellations has no World section", () => {
    const bare = { ...worldBundle, use_case: { ...baseCase, constellations: [] }, constellations: [] };
    render({ bundle: bare, base: bare });
    expect($("#uc-world-h")).toBeNull();
  });
});

describe("starting state", () => {
  it("lists subject, property and value with row headers; entities, personas and the system draw their own avatar", () => {
    render();
    const rows = $$(".uc-state tbody tr");
    expect(rows.map((r) => [$(".uc-subject", r).textContent.replace(/^(memory|warning)/, "").replace(/^[^A-Za-z]+/, ""), ...$$("td", r).slice(0, 2).map((td) => td.firstChild.textContent)])).toEqual([
      ["Household liability policy", "premium", "120"],
      ["Leo", "age", "17"],
      ["System", "connectivity", "online"],
      ["grandma", "lives-in-household", "true"],
    ]);
    expect($$("th[scope=row]", $(".uc-state")).length).toBe(4);
    expect($(".uc-avatar", rows[0]).dataset.kind).toBe("entity");
    expect($(".uc-avatar", rows[2]).dataset.kind).toBe("system");
  });

  it("an unknown subject is an amber row with its message under the value", () => {
    render();
    const row = $$(".uc-state tbody tr").at(-1);
    expect(row.classList.contains("has-warning")).toBe(true);
    expect(text($(".uc-state-warn", row))).toBe("grandma is neither a persona nor an entity. Add it to the world or correct the id.");
  });
});

describe("branch lanes", () => {
  it("shows every lane after its fork step, numbers the steps and says where each branch goes on", () => {
    render();
    const lanes = $$(".uc-lane");
    expect(lanes.map((l) => l.dataset.branch)).toEqual(["offline", "rise", "adult"]);
    const names = lanes.map((l) => text($(".uc-lane-title", l)));
    expect(names[0]).toContain("Branch A");
    expect(names[0]).toContain("before the first step");
    expect(names[1]).toContain("Branch 2A");
    expect(names[1]).toContain("after step 2");
    expect(names[2]).toContain("Branch 2B");
    expect($$(".uc-lane-step .uc-step-no", lanes[1]).map(text)).toEqual(["Step 2A.1 · System", "Step 2A.2 · Jon"]);
    expect($(".uc-lane-card", lanes[1]).getAttribute("aria-label")).toBe("Branch 2A, after step 2");
    expect(text($(".uc-branch-end", lanes[0]))).toContain("Continues at step 2 · Shows old and new premium");
    expect($(".uc-branch-end", lanes[2]).dataset.kind).toBe("end");
    expect(text($(".uc-branch-end", lanes[2]))).toContain("Ends: The policy renews without Leo");
    // the lane before the first step comes before step 1, the others after step 2
    const order = $$(".uc-flow > li").map((li) => li.dataset.branch ?? li.dataset.step);
    expect(order).toEqual(["offline", "open", "compare", "rise", "adult", "accept"]);
  });

  it("the main-flow rows say which branches fork and continue there, and show the step's via", () => {
    render();
    const rows = $$(".uc-step");
    const notes = rows.map((r) => $$(".uc-step-branch-note", r).map((n) => n.textContent.replace("u_turn_left", "").replace("call_split", "")));
    expect(notes).toEqual([[], ["Branch A continues here", "2 branches fork here"], ["Branch 2A continues here"]]);
    expect(text($$(".uc-step-head .uc-step-no")[2])).toBe("Step 3 · Maria · via app");
  });

  it("conditions are chips: subject.property, the operator symbol (the word is the accessible name), the value; several are joined by and", () => {
    render();
    const chip = $$(".uc-lane .uc-cond")[1];
    expect(text(chip)).toBe("policy.premium-change>0.15");
    expect(chip.getAttribute("aria-label")).toBe("policy.premium-change is greater than 0.15");
    const adult = $$(".uc-lane")[2];
    expect($$(".uc-cond", adult).map(text)).toEqual(["leo.age≥18", "leo.statusinstudent, apprentice"]);
    expect(text($(".uc-cond-and", adult))).toBe("and");
  });

  it("warnings sit at their targets: a step warning under the step, a branch warning in its lane; nothing blocks", () => {
    render();
    const cosign = $(".uc-lane-step[data-step=cosign]");
    expect(text(cosign)).toContain('"jon" is an entity');
    expect(text($(".uc-lane[data-branch=rise] .uc-lane-head"))).toContain("rejoins at a step that is not in the main flow");
    expect(text($(".uc-lane[data-branch=offline] .uc-lane-head"))).not.toContain("rejoins");
  });

  it("a branch step's target chip opens the mapping view for that step", () => {
    const { handlers } = render();
    $(".uc-lane-step[data-step=cosign] .uc-target").click();
    expect(handlers.onMap).toHaveBeenCalledWith("cosign");
  });

  it("people row and persona kinds: the kind label leads the line, the icon follows the name", () => {
    render();
    expect(text($(".uc-person-sub"))).toBe("Human · Policyholder · Channel App");
    expect($(".uc-person-name .uc-kind").getAttribute("aria-label")).toBe("Human");
  });

  it("a trait whose value equals the persona's role is left out of the line: each fact once", () => {
    const pool = makeWorldPool();
    pool.personasById = new Map(pool.personasById).set("maria", { ...pool.personasById.get("maria"), traits: { channel: "app", position: "policyholder" } });
    pool.dimensionsById = new Map(pool.dimensionsById).set("position", { id: "position", name: "Role", values: [{ id: "policyholder", label: "policyholder" }] });
    render({ pool });
    expect(text($(".uc-person-sub"))).toBe("Human · Policyholder · Channel App");
  });
});

describe("variant view", () => {
  it("shows the world, the trigger, the state and the branches as a difference against the base", () => {
    renderVariant();
    expect($$(".uc-diff-row[data-constellation]").map((r) => [r.dataset.constellation, r.dataset.change])).toEqual([["single-parent", "base"], ["two-parents", "removed"], ["three-generations", "removed"]]);
    expect(text($(".uc-diff-row[data-constellation=two-parents]"))).toContain("Jon is in no constellation of this variant");
    const trigger = $(".uc-trigger");
    expect(trigger.dataset.change).toBe("changed");
    expect(text(trigger)).toContain("vialetter");
    // only what the variant changed is struck: the via, not the text it kept
    expect(text($(".uc-step-was", trigger))).toBe("Base: via webhook");
    expect([...trigger.querySelectorAll(".uc-step-was s")].map((n) => n.textContent)).toEqual(["webhook"]);
  });

  it("starting state: changed with the struck base value, added, unset from removed_state, the rest from base", () => {
    renderVariant();
    const rows = $$(".uc-state tbody tr");
    expect(rows.map((r) => [r.dataset.key, r.dataset.change])).toEqual([["policy.premium", "changed"], ["leo.age", "removed"], ["system.connectivity", "base"], ["grandma.lives-in-household", "base"], ["maria.discount", "added"]]);
    expect(text($$("td", rows[0])[1])).toBe("98 120");
    expect($("s", $$("td", rows[0])[1]).textContent).toBe("120");
    expect(text($$("td", rows[1])[1])).toBe("Unset · base was 17");
    expect(text($("#uc-state-h").parentElement)).toContain("1 changed · 1 added · 1 unset · 2 from base");
  });

  it("object values of state entries read as JSON, never [object Object]", () => {
    const bundle = { ...worldVariantBundle, use_case: { ...worldVariantBundle.use_case, state: [{ subject: "policy", property: "limits", value: { max: 5 }, change: "changed" }] }, removed_state: [{ subject: "leo", property: "tags", value: ["a", "b"], change: "removed" }] };
    const base = { ...worldBundle, use_case: { ...baseCase, state: [{ subject: "policy", property: "limits", value: { max: 3 } }] } };
    renderVariant({ bundle, base });
    expect(text($(".uc-state tr[data-key='policy.limits'] td:nth-child(3)"))).toBe('{"max":5} {"max":3}');
    expect(text($(".uc-state tr[data-key='leo.tags'] td:nth-child(3)"))).toBe("Unset · base was a, b");
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("a branch that is empty in the base is no emptied branch in a variant; one the variant emptied is", () => {
    const emptyBase = { ...baseCase.branches[2], steps: [] };
    const base = { ...worldBundle, use_case: { ...baseCase, branches: [baseCase.branches[0], baseCase.branches[1], emptyBase] } };
    const bundle = { ...worldVariantBundle, use_case: { ...worldVariantBundle.use_case, branches: [baseCase.branches[0], { ...baseCase.branches[1], steps: [] }, { ...emptyBase }] }, removed_branches: [] };
    renderVariant({ bundle, base });
    expect($(".uc-lane-card[data-branch=adult]").dataset.change).toBe("");
    expect($(".uc-lane-card[data-branch=rise]").dataset.change).toBe("emptied");
  });

  it("a variant that only adds to the trigger shows the base whole, nothing struck, and the addition with an Added badge", () => {
    const base = { ...worldBundle, use_case: { ...baseCase, trigger: { text: "sends the renewal notice" } } };
    renderVariant({ base, bundle: { ...worldVariantBundle, use_case: { ...worldVariantBundle.use_case, trigger: { text: "sends the renewal notice", via: "letter" } } } });
    const line = $(".uc-trigger .uc-step-was");
    expect(line.querySelector("s")).toBeNull();
    expect(text(line)).toContain("Base: sends the renewal notice");
    expect(text(line)).toContain("Added via letter");
    expect($(".uc-diff[data-kind=added]", line)).not.toBeNull();
    expect(text(line)).not.toContain("no trigger");
  });

  it("a variant trigger that drops what the base said strikes it", () => {
    renderVariant({ bundle: { ...worldVariantBundle, use_case: { ...worldVariantBundle.use_case, trigger: { text: "" } } } });
    expect($(".uc-trigger .uc-step-was s")).not.toBeNull();
  });

  it("a branch step's own warnings and its mapping note stay under its compact row", () => {
    const bundle = { ...worldVariantBundle, warnings: [...worldVariantBundle.warnings, { kind: "entity_as_actor", target: "use_case:review-premium#single/cosign", message: "jon is an entity" }], screens: [{ screen: "options", exists: false, mappings: [{ step: "cosign", scope: "screen", stale: true, branch: "rise" }] }] };
    renderVariant({ bundle });
    const row = $(".uc-lane-compact[data-step=cosign]");
    expect(text(row)).toContain("jon is an entity");
    expect(text(row)).toContain("not found");
  });

  it("the Base chip counts the branches; a variant's branch cards list compact steps; the variant table draws names only", () => {
    renderVariant();
    expect(text($(".uc-variant-chip[aria-pressed=false] .uc-variant-meta"))).toBe("3 steps · 3 branches");
    const card = $(".uc-lane-card[data-branch=rise]");
    expect(card.classList.contains("is-compact")).toBe(true);
    expect($$(".uc-lane-compact", card).map(text)).toEqual(["2A.1SystemOffers a lower cover", "2A.2JonCo-signs"]);
    expect($(".uc-target", card)).toBeNull();
    expect(text($(".uc-lane-where", card))).toBe("after step 2 · continues at step 3");
    expect($(".uc-state .uc-avatar")).toBeNull();
    render();
    expect($(".uc-state .uc-avatar")).not.toBeNull();
  });

  it("an emptied branch says how many steps the variant took out", () => {
    const wide = { ...baseCase.branches[2], steps: [...baseCase.branches[2].steps, { id: "more", actor: "system", action: "More", target: { screen: "ends" } }] };
    const base = { ...worldBundle, use_case: { ...baseCase, branches: [baseCase.branches[0], baseCase.branches[1], wide] } };
    renderVariant({ base });
    expect(text($(".uc-lane-card[data-branch=adult] .uc-warn"))).toContain("removes all 2 steps of the branch (2B.1 to 2B.2)");
    renderVariant();
    expect(text($(".uc-lane-card[data-branch=adult] .uc-warn"))).toContain("removes the only step of the branch (2B.1)");
  });

  it("the visible text says artisign in lower case", () => {
    render();
    expect(document.body.textContent).not.toContain("Artisign");
    expect(text($(".uc-flow").parentElement)).toContain("never chosen by artisign");
  });

  it("an inherited row keeps showing and a variant repeats no base warning", () => {
    renderVariant();
    const row = $(".uc-state tr[data-key='grandma.lives-in-household']");
    expect(row).not.toBeNull();
    expect(row.classList.contains("has-warning")).toBe(false);
    expect($(".uc-state-warn")).toBeNull();
    expect(document.body.textContent).not.toContain("not a member of any of the constellations");
  });

  it("branches: changed with the base condition, emptied with its message, removed as a ghost row; the summary counts them", () => {
    renderVariant();
    expect(text($("#uc-branches-h").parentElement)).toContain("Main flow unchanged · 1 changed · 1 removed · 1 emptied");
    const changed = $(".uc-lane-card[data-branch=rise]");
    expect(changed.dataset.change).toBe("changed");
    expect(text($(".uc-lane-base", changed))).toBe("base 0.15");
    expect(text($(".uc-lane-card[data-branch=adult]"))).toContain("This variant removes the only step of the branch (2B.1).");
    expect($(".uc-lane-card[data-branch=adult]").dataset.change).toBe("emptied");
    expect(text($(".uc-lane-card[data-branch=adult]"))).not.toContain("has no steps"); // the tool's line would repeat it
    const gone = $(".uc-diff-row[data-branch=offline]");
    expect(gone.dataset.change).toBe("removed");
    expect(text(gone)).toContain("Branch A · Device is offline");
    expect($(".uc-flow .uc-lane")).toBeNull(); // the lanes are the Branches section's in a variant
  });

  it("applies-when uses trait chips and says it is a world trait; the legend gains Emptied", () => {
    renderVariant();
    const panel = $(".uc-variant-panel");
    expect(text($(".uc-applies .uc-trait", panel))).toBe("HouseholdSingle parent");
    expect(text($(".uc-applies", panel))).toContain("a world trait · matches 1 constellation");
    expect($$(".uc-legend .uc-diff", panel).map((d) => d.dataset.kind)).toEqual(["changed", "added", "removed", "emptied", "base"]);
  });

  it("the variant chip counts the trigger, the state entries, the constellation difference and the branch ops", () => {
    renderVariant();
    // trigger 1 + state 3 + constellations (two-parents and three-generations dropped) 2 + ops 2
    expect(text($(".uc-variant-chip[aria-pressed=true] .uc-variant-meta"))).toBe("8 changes");
  });

  it("coverage groups its columns: World · constellations, then Personas", () => {
    const suggest = { coverage: [{ dimension: "household", covered: ["two-parents", "single-parent"], uncovered: ["blended"] }, { dimension: "channel", covered: ["app"], uncovered: ["letter"] }] };
    renderVariant({ suggest });
    const groups = $$(".uc-matrix .uc-matrix-scope").map((g) => [g.dataset.scope, g.getAttribute("colspan")]);
    expect(groups).toEqual([["constellations", "3"], ["personas", "2"]]);
    expect($$(".uc-matrix .uc-matrix-dim").map(text)).toEqual(["Household", "Channel"]);
    expect($$(".uc-matrix th.is-gap").map((th) => th.title)).toEqual(["Blended family: not covered", "Letter: not covered"]);
  });
});
