// Keys the preview editor does not manage (a variant's `state` and `constellations`, a step's `via`, an op's `branch`, a case's
// `state` and `constellations`) are written back untouched: a save must never drop data it does not know.
import { describe, it, expect } from "vitest";
import { draftFromSource, buildPayload } from "./usecases-forms.js";
import { rawUseCase } from "./usecases.test-helper.js";

const variantState = [{ subject: "copy-42", property: "status", value: "overdue" }, { subject: "ana", property: "open-loans", unset: true }];
const stored = {
  ...rawUseCase,
  constellations: ["ana-and-copy"],
  state: [{ subject: "copy-42", property: "status", value: "available" }],
  steps: [{ ...rawUseCase.steps[0], via: "scanner" }, ...rawUseCase.steps.slice(1)],
  variants: [
    {
      ...rawUseCase.variants[0],
      constellations: ["staff-world"],
      state: variantState,
      steps: [
        { op: "append", step: { id: "later", actor: "dex", action: "Later", via: "webhook" }, branch: "limit" },
        { op: "replace", step_id: "pick", step: { id: "pick", actor: "dex", action: "Picks", via: "email" }, extra_flag: true },
        { op: "remove", step_id: "notify", branch: "limit" },
      ],
    },
    { ...rawUseCase.variants[1], constellations: [], state: [{ subject: "a", property: "b", value: null }] },
  ],
};

function saved(edit) {
  const draft = draftFromSource(stored);
  edit(draft);
  const { payload, errors } = buildPayload({ id: stored.id, draft, source: stored });
  expect(errors).toBeUndefined();
  // set_use_cases merges at the top level: given keys replace, others stay.
  const { id, ...source } = stored;
  return { ...source, ...Object.fromEntries(Object.entries({ ...payload, id }).filter(([, v]) => v !== null)) };
}

describe("a save keeps what the editor does not manage", () => {
  it("a title-only edit keeps every variant key, including state, constellations and op extras", () => {
    const after = saved((draft) => {
      draft.title = "A new title";
      draft.variants[0].title = "Renamed variant";
    });
    expect(after.title).toBe("A new title");
    expect(after.variants[0]).toEqual({ ...stored.variants[0], title: "Renamed variant" });
    expect(after.variants[1]).toEqual(stored.variants[1]);
  });

  it("an untouched edit sends no variants at all", () => {
    expect(buildPayload({ id: stored.id, draft: draftFromSource(stored), source: stored }).payload.variants).toBeUndefined();
  });

  it("the case keeps its state and constellations (they are not in the payload, so the merge leaves them)", () => {
    const after = saved((draft) => {
      draft.title = "Only the title";
    });
    expect(after.state).toEqual(stored.state);
    expect(after.constellations).toEqual(stored.constellations);
  });

  it("a base step keeps an unknown key such as via", () => {
    const after = saved((draft) => {
      draft.steps[0].action = "Taps the step again";
    });
    expect(after.steps[0]).toMatchObject({ id: "tap", action: "Taps the step again", via: "scanner" });
  });

  it("a variant step and an op keep unknown keys when the variant is edited", () => {
    const after = saved((draft) => {
      draft.variants[0].ops[1].step.action = "Picks someone else";
    });
    expect(after.variants[0].steps[0]).toEqual(stored.variants[0].steps[0]);
    expect(after.variants[0].steps[1]).toEqual({ op: "replace", step_id: "pick", step: { id: "pick", actor: "dex", action: "Picks someone else", via: "email" }, extra_flag: true });
    expect(after.variants[0].steps[2]).toEqual(stored.variants[0].steps[2]);
    expect(after.variants[0].state).toEqual(variantState);
  });
});
