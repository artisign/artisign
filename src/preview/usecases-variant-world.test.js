// A variant's world parts (CHR-1154): the step-id namespace follows the variant's own changes (N1), branch changes are built and
// checked against the flow as the resolver sees it, and reference problems are warnings that never block.
import { describe, it, expect } from "vitest";
import { draftFromSource, buildPayload } from "./usecases-forms.js";
import { variantDraft, buildVariant, variantWarnings, modelBefore, placesIn, branchLabels } from "./usecases-variant-edit.js";
import { rawUseCase, makePool } from "./usecases.test-helper.js";

const source = {
  ...rawUseCase,
  variants: [],
  state: [{ subject: "copy", property: "status", value: "available" }],
  branches: [
    { id: "offline", title: "Offline", when: [{ subject: "system", property: "connectivity", value: "offline" }], steps: [{ id: "show-offline", actor: "system", action: "Shows the saved state" }], rejoin: "tap" },
    { id: "limit", title: "Limit reached", from: "pick", when: [{ subject: "dana", property: "open", op: "gte", value: 5 }], steps: [{ id: "show-limit", actor: "system", action: "Explains" }, { id: "ask", actor: "dana", action: "Asks" }], outcome: "none" },
  ],
};
const base = draftFromSource(source);
const stepOf = (id, action = "Later") => ({ id, actor: "system", action });
const variant = (steps, extra = {}) => variantDraft({ id: "v", title: "V", when: { size: ["small"] }, steps, ...extra });
const build = (v) => buildVariant(v, 0, { baseSteps: base.steps, baseBranches: base.branches, usedStepIds: new Set(), variantIds: new Set() });

describe("the step-id namespace follows the variant's own changes (N1)", () => {
  it("a step id the variant removed is free again, in the main flow and in a branch", () => {
    expect(build(variant([{ op: "remove", step_id: "pick" }, { op: "append", step: stepOf("pick") }])).errors).toEqual([]);
    expect(build(variant([{ op: "remove", step_id: "show-limit" }, { op: "append", step: stepOf("show-limit") }])).errors).toEqual([]);
  });

  it("an id of a branch the variant removed is free again; while the branch is there it is taken, said with its place", () => {
    expect(build(variant([{ op: "append", step: stepOf("show-offline") }])).errors).toEqual(['Variant "V", change 1: show-offline is already step A.1 of branch A. Give the new step another id.']);
    expect(build(variant([{ op: "remove_branch", branch_id: "offline" }, { op: "append", step: stepOf("show-offline") }])).errors).toEqual([]);
    expect(build(variant([{ op: "append", step: stepOf("show-limit") }])).errors[0]).toContain("step 2A.1 of branch 2A");
  });

  it("a replaced branch gives its step ids back to the new branch; the new ids are taken afterwards", () => {
    const replaceOffline = { op: "replace_branch", branch_id: "offline", branch: { id: "offline", title: "Offline", when: [{ subject: "system", property: "connectivity", value: "offline" }], steps: [{ id: "show-offline", actor: "system", action: "Again" }, stepOf("extra")] } };
    expect(build(variant([replaceOffline])).errors).toEqual([]);
    expect(build(variant([replaceOffline, { op: "append", step: stepOf("extra") }])).errors[0]).toContain("extra is already step A.2 of branch A");
  });

  it("an added branch may not reuse a step id of the flow or a branch id of the case", () => {
    const added = (id, stepId) => ({ op: "add_branch", branch: { id, title: "New", when: [{ subject: "a", property: "b", value: 1 }], steps: [stepOf(stepId)] } });
    expect(build(variant([added("fresh", "brand-new")])).errors).toEqual([]);
    expect(build(variant([added("fresh", "tap")])).errors[0]).toContain("tap is already step 1 of the main flow");
    expect(build(variant([added("offline", "brand-new")])).errors[0]).toContain("offline is already a branch of this case");
    expect(build(variant([{ op: "remove_branch", branch_id: "offline" }, added("offline", "show-offline")])).errors).toEqual([]);
  });

  it("the model before a change lists what the earlier changes left", () => {
    const v = variant([{ op: "remove_branch", branch_id: "offline" }, { op: "append", step: stepOf("late"), branch: "limit" }]);
    const model = modelBefore({ steps: base.steps, branches: base.branches }, v, 2);
    expect(model.branches.map((b) => b.id)).toEqual(["limit"]);
    expect(model.branches[0].steps.map((s) => s.id)).toEqual(["show-limit", "ask", "late"]);
    expect([...placesIn(model).keys()]).toEqual(["tap", "pick", "notify", "show-limit", "ask", "late"]);
    expect(branchLabels(model)).toEqual(["2A"]);
  });
});

describe("branch changes are built from their drafts", () => {
  const added = { id: "hold", title: "Hold", from: "tap", when: [{ subject: "dana", property: "holds", op: "gte", value: 1 }], steps: [{ id: "show-hold", actor: "system", action: "Shows the hold" }], rejoin: "pick" };

  it("add, replace and remove come back as the stored ops; a replace keeps its id", () => {
    const ops = [{ op: "add_branch", branch: added }, { op: "replace_branch", branch_id: "limit", branch: { ...source.branches[1], title: "Limit" } }, { op: "remove_branch", branch_id: "offline" }, { op: "append", step: stepOf("late"), branch: "limit" }];
    const { out, errors } = build(variant(ops));
    expect(errors).toEqual([]);
    expect(out.steps).toEqual(ops);
  });

  it("a replace_branch keeps the id of the branch it names, whatever the draft says (spec §4: a rename is remove + add)", () => {
    const v = variant([{ op: "replace_branch", branch_id: "limit", branch: { ...source.branches[1], id: "other" } }]);
    expect(build(v).out.steps[0]).toMatchObject({ op: "replace_branch", branch_id: "limit", branch: { id: "limit" } });
  });

  it("a branch change that names no branch is an error until the row was left; a blank new branch is an error that says why", () => {
    const v = variant([{ op: "remove_branch", branch_id: "offline" }]);
    v.ops[0].branchId = "";
    expect(build(v).errors).toEqual(['Variant "V", change 1: pick the branch it changes.']);
    expect(build(v).fieldErrors[0]).toMatchObject({ path: "variant.0.op.0.pick", untilTouched: true });
    const blank = variant([{ op: "add_branch", branch: added }]);
    blank.ops[0].branch.title = "";
    expect(build(blank).errors[0]).toBe('Variant "V", change 1: The branch needs a title.');
  });

  it("changing the op type drops the keys the new type does not allow (D1): an append's branch never lands on a replace", () => {
    const v = variant([{ op: "append", step: stepOf("late"), branch: "limit" }]);
    v.ops[0].op = "replace";
    v.ops[0].stepId = "pick";
    v.ops[0].branchId = ""; // what the editor does when the kind changes
    const { out } = build(v);
    expect(out.steps[0]).not.toHaveProperty("branch");
    expect(out.steps[0]).toMatchObject({ op: "replace", step_id: "pick" });
    // and a step op never carries a branch id by accident, even if a draft still holds one
    const stray = variant([{ op: "replace", step_id: "pick", step: stepOf("pick") }]);
    stray.ops[0].branchId = "limit";
    expect(build(stray).out.steps[0]).not.toHaveProperty("branch");
  });
});

describe("state and constellations of a variant", () => {
  it("state rows merge by key: changed, added and unset entries are written as the tool takes them", () => {
    const v = variant([], { state: [{ subject: "copy", property: "status", value: "overdue" }, { subject: "ana", property: "fee", value: 2 }, { subject: "copy", property: "shelf", unset: true }], constellations: ["staff"] });
    const { out, errors } = build(v);
    expect(errors).toEqual([]);
    expect(out.state).toEqual([{ subject: "copy", property: "status", value: "overdue" }, { subject: "ana", property: "fee", value: 2 }, { subject: "copy", property: "shelf", unset: true }]);
    expect(out.constellations).toEqual(["staff"]);
  });

  it("two state rows with one key in a variant are a shape error naming the second", () => {
    const v = variant([], { state: [{ subject: "copy", property: "status", value: "a" }, { subject: "copy", property: "status", value: "b" }] });
    const { errors, fieldErrors } = build(v);
    expect(errors).toEqual(['Variant "V" state 2: copy · status is already set above. Change that row instead.']);
    expect(fieldErrors[0].path).toBe("variant.0.state.1.property");
  });

  it("an override with an empty constellation list stays: the variant holds in no starting world", () => {
    expect(build(variant([], { constellations: [] })).out.constellations).toEqual([]);
  });

  it("an unset that names a key the base lacks is a warning, never an error", () => {
    const v = variant([], { state: [{ subject: "copy", property: "shelf", unset: true }, { subject: "copy", property: "status", unset: true }] });
    expect(build(v).errors).toEqual([]);
    const warnings = variantWarnings({ variant: v, index: 0, baseSteps: base.steps, baseBranches: base.branches, baseState: base.state, pool: makePool() });
    expect(warnings).toEqual([{ path: "variant.0.state.0", message: "copy · shelf is not in the base state, so there is nothing to unset." }]);
  });
});

describe("variant warnings (never blocking)", () => {
  const warn = (steps) => variantWarnings({ variant: variant(steps), index: 0, baseSteps: base.steps, baseBranches: base.branches, baseState: [], pool: makePool() });

  it("a change that leaves a branch without steps is branch_empty, said once at the change", () => {
    const warnings = warn([{ op: "remove", step_id: "show-offline" }, { op: "append", step: stepOf("x") }]);
    expect(warnings).toEqual([{ path: "variant.0.op.0.step", message: "Branch A has no steps left in this variant. Remove the branch too, or keep a step." }]);
  });

  it("a change that names a missing step or branch is skipped with a warning", () => {
    expect(warn([{ op: "remove_branch", branch_id: "ghost" }])[0].message).toContain("Branch ghost is not a branch of the case at this point");
    expect(warn([{ op: "remove_branch", branch_id: "offline" }, { op: "replace", step_id: "show-offline", step: stepOf("show-offline") }])[0].message).toContain("show-offline is not a step of the flow at this point");
    expect(warn([{ op: "append", step: stepOf("x"), branch: "ghost" }])[0].path).toBe("variant.0.op.0.step");
  });

  it("an op on a branch step is neither missing nor skipped", () => {
    expect(warn([{ op: "replace", step_id: "ask", step: stepOf("ask") }])).toEqual([]);
  });
});

describe("the whole case", () => {
  it("an untouched case with branches, state and variant branch ops sends none of them", () => {
    const stored = { ...source, variants: [{ id: "v", title: "V", when: { size: ["small"] }, constellations: ["a"], state: [{ subject: "copy", property: "status", value: "x" }], steps: [{ op: "remove_branch", branch_id: "offline" }] }] };
    const payload = buildPayload({ id: stored.id, draft: draftFromSource(stored), source: stored }).payload;
    for (const key of ["branches", "state", "constellations", "variants"]) expect(payload).not.toHaveProperty(key);
  });

  it("an edited branch list sends the whole list; removing the last one sends null", () => {
    const draft = draftFromSource(source);
    draft.branches[0].title = "Offline mode";
    const sent = buildPayload({ id: source.id, draft, source }).payload;
    expect(sent.branches.map((b) => b.title)).toEqual(["Offline mode", "Limit reached"]);
    expect(sent.branches[1]).toEqual(source.branches[1]);
    draft.branches = [];
    expect(buildPayload({ id: source.id, draft, source }).payload.branches).toBeNull();
  });

  it("a branch step that reuses a main-flow step id blocks the save with the place", () => {
    const draft = draftFromSource(source);
    draft.branches[0].steps[0].id = "pick";
    const built = buildPayload({ id: source.id, draft, source });
    expect(built.errors[0]).toContain("pick is already step 2 of the main flow");
  });

  it("state rows: a duplicate key blocks, an emptied list removes the key", () => {
    const draft = draftFromSource(source);
    draft.state.push({ ...draft.state[0] });
    expect(buildPayload({ id: source.id, draft, source }).errors[0]).toMatch(/is already set above/);
    draft.state = [];
    expect(buildPayload({ id: source.id, draft, source }).payload.state).toBeNull();
  });
});

describe("generated step ids across new branches (PR #191)", () => {
  it("two new branches with the same step action get different ids", () => {
    const draft = draftFromSource({ ...source, branches: [] });
    const mk = (title) => ({ id: title, origId: "", title, origTitle: title, from: "", when: [{ subject: "a", property: "p", op: "eq", hadOp: false, value: "1", orig: undefined, origText: undefined, origOp: undefined }], steps: [{ id: "", actor: "system", action: "Shows the error", origAction: "", kind: "none", screen: "", node: "", via: "", origVia: "", data: [], extra: {} }], ends: true, rejoin: "", outcome: "", origOutcome: "", extra: {} });
    draft.branches = [mk("one"), mk("two")];
    const built = buildPayload({ id: source.id, draft, source: { ...source, branches: undefined } });
    expect(built.errors).toBeUndefined();
    const ids = built.payload.branches.flatMap((b) => b.steps.map((s) => s.id));
    expect(new Set(ids).size).toBe(2);
  });
});

describe("generated branch step ids and the variants (PR #191, B1)", () => {
  const newBranch = (title, action) => ({ id: "", origId: "", title, origTitle: title, from: "", when: [{ subject: "a", property: "p", op: "eq", hadOp: false, value: "1", orig: undefined, origText: undefined, origOp: undefined }], steps: [{ id: "", actor: "system", action, origAction: "", kind: "none", screen: "", node: "", via: "", origVia: "", data: [], extra: {} }], ends: true, rejoin: "", outcome: "", origOutcome: "", extra: {} });
  const idsOf = (payload) => [...payload.steps.map((s) => s.id), ...(payload.branches ?? []).flatMap((b) => b.steps.map((s) => s.id)), ...(payload.variants ?? []).flatMap((v) => (v.steps ?? []).flatMap((op) => [op.step?.id, ...(op.branch?.steps ?? []).map((s) => s.id)])), ].filter(Boolean);

  it("a new branch step named like a step a stored variant writes gets another id", () => {
    const stored = { ...source, branches: [], variants: [{ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "append", step: { id: "show-limit", actor: "system", action: "Shows the limit" } }] }] };
    const draft = draftFromSource(stored);
    draft.branches = [newBranch("Limit", "Show limit")];
    const built = buildPayload({ id: stored.id, draft, source: stored });
    expect(built.errors).toBeUndefined();
    expect(built.payload.branches[0].steps[0].id).toBe("show-limit-2"); // "show-limit" is the variant's (the variants are not resent: unchanged)
  });

  it("a new branch step and a new variant step with the same action get different ids, and the variant sees the built branch", () => {
    const stored = { ...source, branches: [], variants: [] };
    const draft = draftFromSource(stored);
    draft.branches = [newBranch("Failure", "Retry")];
    const v = variantDraft({ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "append", step: { id: "", actor: "system", action: "Retry" } }, { op: "append", step: { id: "x", actor: "system", action: "In branch" }, branch: "failure" }] });
    draft.variants = [v];
    const built = buildPayload({ id: stored.id, draft, source: stored });
    expect(built.errors).toBeUndefined(); // the append to branch "failure" finds the branch the case dialog just named
    const ids = idsOf(built.payload);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["retry", "retry-2"]));
  });
});

describe("saved empty values stay as stored (PR #191, N1)", () => {
  it("a stored branch outcome of '' does not resend the branch list", () => {
    const stored = { ...source, branches: [{ ...source.branches[0], outcome: "" }] };
    expect(buildPayload({ id: stored.id, draft: draftFromSource(stored), source: stored }).payload).not.toHaveProperty("branches");
  });
});

describe("generated ids inside one variant (PR #191, N4)", () => {
  it("a step a later change generates does not repeat the id add_branch generated for the same action", () => {
    const v = variant([
      { op: "add_branch", branch: { id: "failure", title: "Failure", when: [{ subject: "a", property: "p", value: 1 }], steps: [{ id: "", actor: "system", action: "Retry" }] } },
      { op: "append", step: { id: "", actor: "system", action: "Retry" } },
    ]);
    const { out, errors } = build(v);
    expect(errors).toEqual([]);
    const ids = [out.steps[0].branch.steps[0].id, out.steps[1].step.id];
    expect(ids).toEqual(["retry", "retry-2"]);
  });
});
