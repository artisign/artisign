// The pure logic of the world model views: conditions, branch numbering, the warning grammar, the variant differences and the
// constellation-aware coverage matrix. Neutral insurance fixtures.
import { describe, it, expect } from "vitest";
import { conditionParts, numberBranches, flowSequence, forkText, branchEnd, warningsByTarget, stateRows, stateSummary, constellationRows, orphanText, whenWas, participant, triggerBaseParts, branchLetter, lanesAtStep, matchingConstellations, whenScopeText } from "./usecases-world-data.js";
import { coverageMatrix, variantChangeCount } from "./usecases-data.js";
import { baseCase, constellations, dimensions, personas, entities, worldBundle, makeWorldPool } from "./usecases-world.test-helper.js";

describe("conditions", () => {
  it("shows subject.property, the operator symbol with its word, and the value as text", () => {
    expect(conditionParts({ subject: "policy", property: "premium-change", op: "gt", value: 0.15 })).toEqual({ key: "policy.premium-change", symbol: ">", word: "is greater than", value: "0.15" });
    expect(conditionParts({ subject: "leo", property: "status", op: "in", value: ["student", "apprentice"] })).toMatchObject({ symbol: "in", value: "student, apprentice" });
    expect(conditionParts({ subject: "system", property: "connectivity", value: "offline" })).toMatchObject({ symbol: "=", word: "equals" });
    expect(conditionParts({ subject: "jon", property: "consent", value: true }).value).toBe("true");
  });
});

describe("branch numbering", () => {
  it("numbers by fork step and letter, letters restart per fork, no fork number before the first step", () => {
    const numbered = numberBranches(baseCase);
    expect(numbered.map((e) => e.label)).toEqual(["A", "2A", "2B"]);
    expect(numbered.map((e) => forkText(e, baseCase.steps))).toEqual(["before the first step · another starting state", "after step 2", "after step 2"]);
  });

  it("a fork that is not a main-flow step leads, numbered with a question mark", () => {
    const [entry] = numberBranches({ steps: baseCase.steps, branches: [{ id: "x", title: "X", from: "gone", when: [], steps: [] }] });
    expect(entry).toMatchObject({ label: "?A", dangling: true, forkIndex: null });
  });

  it("says where a branch goes on: continues at a step, ends the case (with its outcome), or a rejoin that is not a step", () => {
    const [offline, , adult] = baseCase.branches;
    expect(branchEnd(offline, baseCase.steps)).toEqual({ kind: "rejoin", text: "Continues at step 2 · Shows old and new premium" });
    expect(branchEnd(adult, baseCase.steps)).toEqual({ kind: "end", text: "Ends: The policy renews without Leo" });
    expect(branchEnd({ ...adult, outcome: undefined }, baseCase.steps).text).toBe("Ends the case");
    expect(branchEnd({ ...offline, rejoin: "gone" }, baseCase.steps).kind).toBe("warning");
  });

  it("every dangling fork shares one letter group, and letters continue after Z instead of wrapping", () => {
    const dangling = (id, from) => ({ id, title: id, from, when: [], steps: [] });
    const labels = numberBranches({ steps: baseCase.steps, branches: [dangling("a", "gone"), dangling("b", "other")] }).map((e) => e.label);
    expect(labels).toEqual(["?A", "?B"]);
    const many = Array.from({ length: 28 }, (_, i) => dangling(`b${i}`, "compare"));
    const letters = numberBranches({ steps: baseCase.steps, branches: many }).map((e) => e.label);
    expect(letters[25]).toBe("2Z");
    expect(letters[26]).toBe("2AA");
    expect(new Set(letters).size).toBe(28);
    expect([0, 25, 26, 27, 51, 52].map(branchLetter)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA"]);
  });

  it("lanesAtStep is the one placement rule: top for no or dangling fork, else after the fork step", () => {
    const numbered = numberBranches({ steps: baseCase.steps, branches: [...baseCase.branches, { id: "x", title: "x", from: "gone", when: [], steps: [] }] });
    expect(lanesAtStep(numbered, null).map((e) => e.branch.id)).toEqual(["offline", "x"]);
    expect(lanesAtStep(numbered, "compare").map((e) => e.branch.id)).toEqual(["rise", "adult"]);
    expect(lanesAtStep(numbered, "open")).toEqual([]);
  });

  it("flowSequence puts the leading branches first and each branch after its fork step", () => {
    expect(flowSequence(baseCase.steps, baseCase.branches).map((i) => i.number)).toEqual(["A.1", 1, 2, "2A.1", "2A.2", "2B.1", 3]);
  });
});

describe("warnings by target", () => {
  const w = warningsByTarget(
    [
      { kind: "a", target: "use_case:c" },
      { kind: "b", target: "use_case:c/trigger" },
      { kind: "c", target: "use_case:c/trigger/state:x.y" },
      { kind: "d", target: "use_case:c/state:leo.age" },
      { kind: "e", target: "use_case:c/branch:rise" },
      { kind: "f", target: "use_case:c/branch:rise/state:policy.premium" },
      { kind: "g", target: "use_case:c/constellation:cst" },
      { kind: "h", target: "use_case:c/cosign" },
      { kind: "i", target: "use_case:c#v/branch:rise" },
      { kind: "j", target: "persona:maria" },
      { kind: "k", target: "use_case:other/open" },
    ],
    "c",
    null,
  );
  it("sorts a base view's warnings to the case, trigger, state, branch, constellation and step; others never leak in", () => {
    expect(w.case.map((x) => x.kind)).toEqual(["a"]);
    expect(w.trigger.map((x) => x.kind)).toEqual(["b"]);
    expect(w.triggerState.get("x.y")).toHaveLength(1);
    expect(w.state.get("leo.age")).toHaveLength(1);
    expect(w.branch.get("rise").map((x) => x.kind)).toEqual(["e"]);
    expect(w.branchState.get("rise/policy.premium")).toHaveLength(1);
    expect(w.constellation.get("cst")).toHaveLength(1);
    expect(w.step.get("cosign")).toHaveLength(1);
    expect(w.step.has("open")).toBe(false);
    expect(w.pool.get("persona:maria")).toHaveLength(1);
  });
  it("a variant view reads only the targets of that variant", () => {
    const v = warningsByTarget([{ kind: "i", target: "use_case:c#v/branch:rise" }, { kind: "e", target: "use_case:c/branch:rise" }], "c", "v");
    expect(v.branch.get("rise").map((x) => x.kind)).toEqual(["i"]);
  });
});

describe("participants", () => {
  const ctx = { bundle: { personas, entities }, pool: makeWorldPool() };
  it("resolves personas, entities, the system and unknown ids; a persona wins on a shared id", () => {
    expect(participant("maria", ctx)).toMatchObject({ kind: "persona", name: "Maria" });
    expect(participant("leo", ctx)).toMatchObject({ kind: "entity", name: "Leo", type: "Child" });
    expect(participant("system", ctx)).toMatchObject({ kind: "system", name: "System" });
    expect(participant("grandma", ctx)).toMatchObject({ kind: "unknown", name: "grandma" });
    expect(participant("maria", { bundle: { personas, entities: [{ id: "maria", name: "Maria the policy" }] }, pool: makeWorldPool() }).kind).toBe("persona");
  });
});

describe("variant differences", () => {
  it("state rows: changed with the base entry, added, from base, and the unset ones after", () => {
    const rows = stateRows({ state: [{ subject: "a", property: "p", value: 2, change: "changed" }, { subject: "b", property: "q", value: 1 }, { subject: "c", property: "r", value: 3, change: "added" }], removedState: [{ subject: "d", property: "s", value: 4, change: "removed" }], baseState: [{ subject: "a", property: "p", value: 1 }, { subject: "d", property: "s", value: 4 }], variantSelected: true });
    expect(rows.map((r) => r.change)).toEqual(["changed", "removed", "base", "added"]);
    expect(rows[0].was.value).toBe(1);
    expect(stateSummary(rows)).toBe("1 changed · 1 added · 1 unset · 1 from base");
    expect(stateRows({ state: [{ subject: "a", property: "p", value: 1 }], variantSelected: false })[0].change).toBeNull();
  });

  it("an unset row stands right after the base entry that preceded it, at the top when none of those is shown", () => {
    const baseState = [{ subject: "a", property: "p", value: 1 }, { subject: "b", property: "q", value: 2 }, { subject: "c", property: "r", value: 3 }, { subject: "d", property: "s", value: 4 }];
    const gone = (e) => ({ ...e, change: "removed" });
    const rows = stateRows({ state: [baseState[0], baseState[2], baseState[3]], removedState: [gone(baseState[1])], baseState, variantSelected: true });
    expect(rows.map((r) => [r.entry.subject, r.change])).toEqual([["a", "base"], ["b", "removed"], ["c", "base"], ["d", "base"]]);
    const first = stateRows({ state: [baseState[1]], removedState: [gone(baseState[0])], baseState, variantSelected: true });
    expect(first.map((r) => r.entry.subject)).toEqual(["a", "b"]);
    const both = stateRows({ state: [baseState[3]], removedState: [gone(baseState[1]), gone(baseState[2])], baseState, variantSelected: true });
    expect(both.map((r) => r.entry.subject)).toEqual(["b", "c", "d"]);
  });

  it("constellation rows: kept from base, added, removed with the members only the removed one had", () => {
    const byId = new Map(constellations.map((c) => [c.id, c]));
    const bundle = { personas, entities };
    const rows = constellationRows({ variantIds: ["single-parent", "new-one"], baseIds: ["two-parents", "single-parent"], byId, bundle, pool: makeWorldPool() });
    expect(rows.map((r) => [r.id, r.change])).toEqual([["single-parent", "base"], ["new-one", "added"], ["two-parents", "removed"]]);
    expect(rows[2].orphans).toEqual(["Jon"]);
    expect(orphanText(["Jon"])).toBe("Jon is in no constellation of this variant");
    expect(orphanText(["A", "B", "C", "D"])).toBe("A, B, C and 1 more are in no constellation of this variant");
  });

  it("a changed branch names the base conditions it no longer has", () => {
    const base = baseCase.branches[1];
    const changed = { ...base, when: [{ subject: "policy", property: "premium-change", op: "gt", value: 0.1 }] };
    expect(whenWas(changed, base)).toEqual(base.when);
    expect(whenWas(base, base)).toBeNull();
  });

  it("the change count adds the trigger, each state entry and the constellations a variant adds or drops", () => {
    const variant = { trigger: "t", state: [{}, {}], constellations: ["a", "c"], steps: [{}] };
    expect(variantChangeCount(variant, [], { constellations: ["a", "b"] })).toBe(1 + 2 + 2 + 1);
    expect(variantChangeCount({ constellations: ["a"] }, [], { constellations: ["a"] })).toBe(0);
    expect(variantChangeCount({ steps: [{}, {}], outputs: [] })).toBe(3);
  });

  it("the base trigger line strikes only the parts the variant changed", () => {
    const base = { text: "Sends the notice", actor: "insurer", via: "webhook" };
    const kinds = (a, b) => triggerBaseParts(a, b).map((p) => [p.label, p.value, p.kind]);
    expect(kinds(base, { text: "Sends the notice", actor: "insurer", via: "letter" })).toEqual([["", "Sends the notice", "same"], ["actor", "insurer", "same"], ["via", "webhook", "changed"]]);
    expect(kinds(base, { text: "Sends it", actor: "jon" })).toEqual([["", "Sends the notice", "changed"], ["actor", "insurer", "changed"], ["via", "webhook", "removed"]]);
    // only added: the base is whole and nothing of it is struck
    expect(kinds({ text: "Plain" }, { text: "Plain", via: "app" })).toEqual([["", "Plain", "same"], ["via", "app", "added"]]);
    expect(kinds("Plain", { text: "Plain", actor: "jon" })).toEqual([["", "Plain", "same"], ["actor", "jon", "added"]]);
    // dropped altogether, and none at all
    expect(kinds(base, undefined).map((p) => p[2])).toEqual(["removed", "removed", "removed"]);
    expect(kinds(undefined, undefined)).toEqual([["", "no trigger", "same"]]);
  });

  it("a condition that only changes its operator or value is a changed `when` part, not the same", () => {
    const when = (op, value) => ({ text: "Premium", state: [{ subject: "policy", property: "premium", op, value }] });
    const kind = (a, b) => triggerBaseParts(a, b).find((p) => p.label === "when").kind;
    expect(kind(when("gt", 100), when("gt", 200))).toBe("changed");
    expect(kind(when("gt", 100), when("gte", 100))).toBe("changed");
    expect(kind(when("gt", 100), when("gt", 100))).toBe("same");
  });

  it("applies-when: the scope of the dimensions and the constellations that match", () => {
    const byId = new Map(dimensions.map((d) => [d.id, d]));
    expect(whenScopeText({ household: ["single-parent"] }, byId)).toBe("a world trait");
    expect(whenScopeText({ channel: ["app"] }, byId)).toBe("a persona trait");
    expect(whenScopeText({ channel: ["app"], household: ["x"] }, byId)).toBe("world and persona traits");
    expect(matchingConstellations({ household: ["single-parent"] }, constellations, byId).map((c) => c.id)).toEqual(["single-parent"]);
    expect(matchingConstellations({ channel: ["app"] }, constellations, byId)).toEqual([]);
  });
});

describe("coverage with constellations", () => {
  const variants = [{ id: "single", title: "Single parent", when: { household: ["single-parent"] } }];
  const used = new Map([["household", new Set(["two-parents", "single-parent", "blended"])]]);

  it("puts constellation dimensions in their own group, judged on the constellations of the base case", () => {
    const matrix = coverageMatrix({ dimensions, pool: personas, basePersonas: [personas[0]], variants, baseConstellations: constellations, usedValues: used });
    expect(matrix.columns.map((c) => [c.dimension, c.scope])).toEqual([["household", "constellations"], ["channel", "personas"]]);
    expect(matrix.columns[0].values.map((v) => [v.value, v.gap])).toEqual([["two-parents", false], ["single-parent", false], ["blended", true]]);
    expect(matrix.rows[0].dims.household.marks).toEqual(new Set(["two-parents", "single-parent"]));
    expect(matrix.rows[1].dims.household.marks).toEqual(new Set(["single-parent"]));
    expect(matrix.rows[1].dims.channel).toEqual({ any: true });
  });

  it("without constellations in the case the world dimensions are no columns", () => {
    expect(coverageMatrix({ dimensions, pool: personas, basePersonas: [], variants, baseConstellations: [], usedValues: used }).columns.map((c) => c.dimension)).toEqual(["channel"]);
    expect(coverageMatrix({ dimensions, pool: personas, basePersonas: [], variants }).columns.map((c) => c.dimension)).toEqual(["channel"]);
  });

  it("the tool's uncovered list decides the gaps when given", () => {
    const matrix = coverageMatrix({ dimensions, pool: personas, basePersonas: [personas[0]], variants, baseConstellations: constellations, usedValues: used, uncovered: [{ dimension: "household", uncovered: ["single-parent"] }] });
    expect(matrix.columns[0].values.find((v) => v.value === "single-parent").gap).toBe(true);
    expect(matrix.gaps).toBe(1);
  });
});

describe("bundle sanity", () => {
  it("the world fixture resolves every relationship end", () => {
    const ctx = { bundle: worldBundle, pool: makeWorldPool() };
    for (const c of constellations) for (const r of c.relationships) for (const id of [r.from, r.to]) expect(participant(id, ctx).kind).not.toBe("unknown");
  });
});
