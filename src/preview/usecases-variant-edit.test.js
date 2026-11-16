// The pure parts of the structured variant editor: variant draft <-> payload, the flow a change sees, the persona rule of the
// actor swaps (spec §4) and the validation of step changes (spec §6).
import { describe, it, expect } from "vitest";
import { draftFromSource, buildPayload, draftWarnings } from "./usecases-forms.js";
import { variantDraft, blankVariant, buildVariant, flowBefore, inheritedPersonas, actorsMap, variantWarnings, emptyStep } from "./usecases-variant-edit.js";
import { makePool, rawUseCase } from "./usecases.test-helper.js";

const baseSteps = draftFromSource(rawUseCase).steps; // tap (dana), pick (dana), notify (system)

function build(variant, steps = baseSteps) {
  return buildVariant(variant, 0, { baseSteps: steps, usedStepIds: new Set(steps.map((s) => s.id)), variantIds: new Set() });
}

describe("variant draft <-> payload", () => {
  it("round-trips every stored variant exactly, including a stored empty steps list", () => {
    const stored = [
      ...rawUseCase.variants,
      { id: "everything", title: "All keys", description: "d", when: { size: ["large"] }, trigger: "t", goal: "g", outcome: "o", personas: ["dex"], actors: { dana: "dex", system: "dana" }, inputs: rawUseCase.inputs, outputs: rawUseCase.outputs, steps: [{ op: "insert_after", step_id: "tap", step: { id: "x", actor: "dex", action: "Waits", note: "n", data: [{ object: "mapping", before: {}, after: { status: "ready" } }] } }, { op: "append", step: { id: "y", actor: "system", action: "Ends" } }] },
    ];
    for (const variant of stored) {
      const { out, errors } = build(variantDraft(variant));
      expect(errors).toEqual([]);
      expect(out).toEqual(variant);
    }
  });

  it("an optional key exists only while it is overridden: use base drops the key, never sends null", () => {
    const draft = variantDraft(rawUseCase.variants[0]);
    delete draft.overrides.personas;
    delete draft.overrides.outputs;
    const { out } = build(draft);
    expect("personas" in out).toBe(false);
    expect("outputs" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("null");
  });

  it("an override starts from the base and is sent as typed (text trimmed, examples parsed)", () => {
    const draft = blankVariant();
    Object.assign(draft, { title: "Quick", when: { size: ["small"] } });
    draft.overrides.trigger = "  The user is in a hurry ";
    draft.overrides.inputs = [{ object: "mapping", side: "list", example: "status: draft" }];
    const { out, errors } = build(draft);
    expect(errors).toEqual([]);
    expect(out).toMatchObject({ trigger: "The user is in a hurry", inputs: [{ object: "mapping", source: "list", example: { status: "draft" } }] });
  });

  it("an overridden inputs or outputs list follows the base rules: at least one row, each with an example", () => {
    const draft = blankVariant();
    Object.assign(draft, { title: "Quick", when: { size: ["small"] } });
    draft.overrides.outputs = [];
    expect(build(draft).errors).toEqual(['Variant "Quick": an overridden outputs list needs at least one output with an example.']);
    draft.overrides.outputs = [{ object: "mapping", side: "", example: "" }];
    expect(build(draft).errors).toEqual(['Variant "Quick" output 1: the example needs at least one key.']);
  });

  it("title and condition are required, as before", () => {
    expect(build(blankVariant()).errors).toEqual(["Variant 1 needs a title.", 'Variant "variant-1" needs a condition (when).']);
  });

  it("the actors map is written from complete rows only", () => {
    expect(actorsMap([{ from: "dana", to: "dex" }, { from: "", to: "dex" }, { from: "system", to: "" }])).toEqual({ dana: "dex" });
    const draft = variantDraft({ id: "v", title: "V", when: { size: ["small"] }, actors: { dana: "dex" } });
    draft.swaps.push({ from: "system", to: "" });
    expect(build(draft).out.actors).toEqual({ dana: "dex" });
    draft.swaps = [];
    expect("actors" in build(draft).out).toBe(false);
  });
});

describe("the flow a change sees", () => {
  it("starts from the base steps with the swaps applied once (not chained), then follows the earlier changes", () => {
    const variant = variantDraft({ id: "v", title: "V", when: { size: ["small"] }, actors: { dana: "dex", dex: "sol" }, steps: [{ op: "append", step: { id: "late", actor: "dex", action: "Late" } }, { op: "remove", step_id: "pick" }] });
    expect(flowBefore(baseSteps, variant, 0).map((e) => [e.id, e.actor, e.baseActor])).toEqual([["tap", "dex", "dana"], ["pick", "dex", "dana"], ["notify", "system", "system"]]);
    expect(flowBefore(baseSteps, variant, 1).map((e) => e.id)).toEqual(["tap", "pick", "notify", "late"]);
    expect(flowBefore(baseSteps, variant, 2).map((e) => e.id)).toEqual(["tap", "notify", "late"]);
  });

  it("a change naming a step that is not there is skipped, as the resolver does", () => {
    const variant = variantDraft({ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "replace", step_id: "gone", step: { id: "z", actor: "dana", action: "Z" } }, { op: "remove", step_id: "tap" }] });
    expect(flowBefore(baseSteps, variant, 2).map((e) => e.id)).toEqual(["pick", "notify"]);
  });
});

describe("personas after actor swaps (spec §4)", () => {
  const swaps = (map) => Object.entries(map).map(([from, to]) => ({ from, to }));
  it("a persona that is a key takes its value; a value System drops it; duplicates collapse; order is kept", () => {
    expect(inheritedPersonas(["dana", "dex"], swaps({ dana: "sol" }))).toMatchObject({ ids: ["sol", "dex"] });
    expect(inheritedPersonas(["dana", "dex"], swaps({ dana: "dex" })).ids).toEqual(["dex"]);
    const toSystem = inheritedPersonas(["dana"], swaps({ dana: "system" }));
    expect(toSystem.ids).toEqual([]);
    expect(toSystem.dropped).toEqual(["dana"]);
  });

  it("a swap from System changes steps only and a→a is ignored; the list never holds System", () => {
    expect(inheritedPersonas(["dana"], swaps({ system: "dex" })).ids).toEqual(["dana"]);
    expect(inheritedPersonas(["dana"], swaps({ dana: "dana" })).ids).toEqual(["dana"]);
    expect(inheritedPersonas([], swaps({ system: "dex" })).ids).toEqual([]);
  });

  it("reports who became whom, for the 'Dex (Dana, swapped below)' text", () => {
    expect([...inheritedPersonas(["dana"], swaps({ dana: "dex" })).swapped]).toEqual([["dex", ["dana"]]]);
  });
});

describe("validation of step changes", () => {
  const variant = (steps) => variantDraft({ id: "v", title: "V", when: { size: ["small"] }, steps });
  const step = (over) => ({ id: "x", actor: "dana", action: "Does it", ...over });

  it("a change without its step, and a step without an action, block Save", () => {
    const draft = blankVariant();
    Object.assign(draft, { title: "V", when: { size: ["small"] } });
    draft.ops = [{ op: "replace", stepId: "", step: null }, { op: "insert_after", stepId: "tap", step: emptyStep() }, { op: "remove", stepId: "" }];
    expect(build(draft).errors).toEqual(['Variant "V", change 1: pick the step it changes.', 'Variant "V", change 1: the step needs an action.', 'Variant "V", change 2: the step needs an action.', 'Variant "V", change 3: pick the step it changes.']);
  });

  it("a second step with an id the flow already has is a shape error, with a field-level message; a replace may keep its own id", () => {
    const duplicate = build(variant([{ op: "insert_after", step_id: "tap", step: step({ id: "pick" }) }]));
    expect(duplicate.errors).toEqual(['Variant "V", change 1: pick is already a step in this flow.']);
    expect(duplicate.fieldErrors).toEqual([{ path: "variant.0.op.0.id", message: "pick is already a step in this flow. Give the new step another id." }]);
    expect(build(variant([{ op: "replace", step_id: "pick", step: step({ id: "pick" }) }])).errors).toEqual([]);
    expect(build(variant([{ op: "replace", step_id: "pick", step: step({ id: "tap" }) }])).errors).toEqual(['Variant "V", change 1: tap is already a step in this flow.']);
  });

  it("a replace may take an id a change above removed, and an append sees steps added above", () => {
    expect(build(variant([{ op: "remove", step_id: "pick" }, { op: "append", step: step({ id: "pick" }) }])).errors).toEqual([]);
    expect(build(variant([{ op: "append", step: step({ id: "late" }) }, { op: "append", step: step({ id: "late" }) }])).errors).toHaveLength(1);
  });

  it("an id that is not kebab-case is refused; an empty one is generated and never collides", () => {
    expect(build(variant([{ op: "append", step: step({ id: "Not Valid" }) }])).errors[0]).toContain("is not a valid id");
    const out = build(variant([{ op: "append", step: step({ id: "", action: "Pick" }) }])).out;
    expect(out.steps[0].step.id).toBe("pick-2");
  });

  it("a Replace keeps the base step's whole body (the draft is the step), written as a full step", () => {
    const draft = variantDraft({ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "replace", step_id: "pick", step: rawUseCase.steps[1] }] });
    expect(build(draft).out.steps).toEqual([{ op: "replace", step_id: "pick", step: rawUseCase.steps[1] }]);
  });

  it("whole-case payload: field errors travel with the errors and the variant lands in the payload", () => {
    const draft = draftFromSource(rawUseCase);
    draft.variants[1].ops = [{ op: "append", step: { ...emptyStep(), id: "tap", action: "Again" } }];
    const built = buildPayload({ id: "map-step", draft, source: rawUseCase });
    expect(built.errors).toEqual(['Variant "Large project", change 1: tap is already a step in this flow.']);
    expect(built.fieldErrors[0].path).toBe("variant.1.op.0.id");
    draft.variants[1].ops[0].step.id = "again";
    expect(buildPayload({ id: "map-step", draft, source: rawUseCase }).payload.variants[1].steps).toEqual([{ op: "append", step: { id: "again", actor: "system", action: "Again" } }]);
  });
});

describe("warnings (never blocking)", () => {
  const pool = makePool();
  it("a change pointing at a step that is not in the flow at that point, an unknown persona in a swap", () => {
    const variant = variantDraft({ id: "v", title: "V", when: { size: ["small"] }, actors: { dana: "ghost" }, steps: [{ op: "replace", step_id: "save", step: { id: "save", actor: "dana", action: "Saves" } }, { op: "remove", step_id: "tap" }, { op: "remove", step_id: "tap" }] });
    const warnings = variantWarnings({ variant, index: 2, baseSteps, pool });
    expect(warnings).toEqual([
      { path: "variant.2.op.0.step", message: "save is not a step of the flow at this point. This change is skipped; you can still save." },
      { path: "variant.2.op.2.step", message: "tap is not a step of the flow at this point. This change is skipped; you can still save." },
      { path: "variant.2.swap.0.to", message: "Persona ghost does not exist." },
    ]);
  });

  it("flow into the dialog's warning list", () => {
    const draft = draftFromSource(rawUseCase);
    draft.variants[1].ops = [{ op: "remove", stepId: "nope", step: null }];
    const warnings = draftWarnings({ draft, pool, screens: ["editor", "picker"], nodes: {} });
    expect(warnings.some((w) => w.path === "variant.1.op.0.step")).toBe(true);
  });
});
