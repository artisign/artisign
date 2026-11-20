// Branches (ADR-011) in the preview editors: an untouched case sends no `branches` (the merge in set_use_cases leaves them), and a
// variant's branch ops (no step_id) are written back as stored while nothing about them was edited, so such a case can still be saved.
import { describe, it, expect } from "vitest";
import { draftFromSource, buildPayload } from "./usecases-forms.js";
import { rawUseCase } from "./usecases.test-helper.js";

const branchOps = [
  { op: "add_branch", branch: { id: "hold", title: "Hold", from: "tap", when: [{ subject: "ana", property: "holds", op: "gte", value: 1 }], steps: [{ id: "show-hold", actor: "system", action: "Shows the hold" }], rejoin: "pick", extra: 1 } },
  { op: "replace_branch", branch_id: "limit", branch: { id: "limit", title: "Limit", when: [{ subject: "ana", property: "open-loans", value: 9 }], steps: [{ id: "show-limit", actor: "system", action: "Explains" }], outcome: "none" } },
  { op: "remove_branch", branch_id: "offline" },
  { op: "append", step: { id: "late", actor: "dex", action: "Later" }, branch: "limit" },
];
const stored = {
  ...rawUseCase,
  branches: [{ id: "limit", title: "Limit", from: "tap", when: [{ subject: "ana", property: "open-loans", value: 5 }], steps: [{ id: "base-limit", actor: "system", action: "Explains the limit" }] }],
  variants: [{ ...rawUseCase.variants[0], steps: [...(rawUseCase.variants[0].steps ?? []), ...branchOps] }, rawUseCase.variants[1]],
};
const firstBranchOp = (rawUseCase.variants[0].steps ?? []).length;

function saved(edit) {
  const draft = draftFromSource(stored);
  edit(draft);
  const built = buildPayload({ id: stored.id, draft, source: stored });
  expect(built.errors).toBeUndefined();
  const { id, ...source } = stored;
  return { payload: built.payload, after: { ...source, ...Object.fromEntries(Object.entries({ ...built.payload, id }).filter(([, v]) => v !== null)) } };
}

describe("a save keeps branches", () => {
  it("a title-only edit keeps the case's branches and sends none", () => {
    const { payload, after } = saved((draft) => {
      draft.title = "A new title";
    });
    expect(payload).not.toHaveProperty("branches");
    expect(payload).not.toHaveProperty("variants"); // nothing about the variants changed
    expect(after.branches).toEqual(stored.branches);
  });

  it("a variant with branch ops can be saved: the ops come back as stored, in order", () => {
    const { after } = saved((draft) => {
      draft.variants[0].title = "Renamed variant";
    });
    expect(after.variants[0].title).toBe("Renamed variant");
    expect(after.variants[0].steps.slice(firstBranchOp)).toEqual(branchOps);
  });

  it("editing a step change of that variant leaves the branch ops untouched", () => {
    const { after } = saved((draft) => {
      draft.variants[0].ops[0].step.action = "Picks someone else";
    });
    expect(after.variants[0].steps.slice(firstBranchOp)).toEqual(branchOps);
  });

  it("a branch op needs no step_id and blocks nothing; the ids of branch steps stay taken for generated ids", () => {
    const draft = draftFromSource(stored);
    const rows = draft.variants[0].ops.slice(firstBranchOp, firstBranchOp + 3);
    expect(rows.map((op) => [op.op, op.stepId, op.step])).toEqual([["add_branch", "", null], ["replace_branch", "", null], ["remove_branch", "", null]]);
    expect(draft.branches.flatMap((b) => b.steps.map((s) => s.id))).toEqual(["base-limit"]);
    draft.steps.push({ ...draft.steps[0], id: "", action: "base limit" });
    const built = buildPayload({ id: stored.id, draft, source: stored });
    expect(built.errors).toBeUndefined();
    const ids = built.payload.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
