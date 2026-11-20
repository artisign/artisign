// Use Cases tab — the structured variant editor of the use-case dialog (CHR-1109, design CHR-1103). A variant is a difference
// against the base: Overrides (trigger, goal, outcome, personas, inputs, outputs: present = overridden, "Use base" removes the key,
// never `null`), Actor swaps (the `actors` map) and Step changes (the ordered replace / insert_after / remove / append ops, each
// with the full step editor). The pure parts (variant draft <-> payload object, the flow a change sees, validation) come first and
// are exported for the tests; the DOM part (createVariantEditor) last.

import { h, icon, fill } from "./usecases-dom.js";
import { field, textInput, textArea, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { segmented, avatar, diffBadge } from "./usecases-parts.js";
import { openMenu } from "./usecases-menu.js";
import { createReorder, renumberRow } from "./usecases-reorder.js";
import { triggerText, slugify, uniqueId, isValidId, formatExample, parseOrKeep, avatarOf, actorName, plural } from "./usecases-data.js";
import { numberBranches } from "./usecases-world-data.js";
import { triggerShape, blankTriggerShape, buildTrigger, stateDraft, buildState, branchDraft, buildBranch, blankBranch } from "./usecases-world-edit.js";
import { openBranchDialog, cloneBranchDraft } from "./usecases-forms-branch.js";
import { createTriggerEditor, constellationChips } from "./usecases-forms-case-world.js";
import { stateRows } from "./usecases-forms-rows.js";

// --- Draft <-> payload (pure) ---------------------------------------------------------------------------------------

const TEXT_OVERRIDES = [
  ["trigger", "Trigger"],
  ["goal", "Goal"],
  ["outcome", "Outcome"],
];

/** A text as it is written: untouched since it was stored it stays byte-for-byte, a field the user edited is trimmed. `orig` is undefined for a new one. */
const written = (value, orig) => (value === orig ? value : value.trim());

/**
 * The keys of a stored object the editor does not manage, copied as they are. They are written back untouched, so a key the
 * editor does not know (a variant's `state` or `constellations`, a step's `via`, an op's `branch`) survives every save.
 */
function unmanaged(stored, managed) {
  return Object.fromEntries(Object.entries(stored).filter(([key]) => !managed.includes(key)));
}

const STEP_KEYS = ["id", "actor", "action", "target", "data", "note", "via"];
const OP_KEYS = ["op", "step_id", "step", "branch", "branch_id"];
const VARIANT_KEYS = ["id", "title", "description", "when", "personas", "constellations", "state", "actors", "trigger", "goal", "outcome", "inputs", "outputs", "steps"];

/** The draft rows of an inputs / outputs list. `orig` keeps the stored example: one the user does not touch is saved exactly as it was. */
export function ioDraft(list, sideKey) {
  return (list ?? []).map((item) => ({ object: item.object, side: item[sideKey] ?? "", example: formatExample(item.example), orig: item.example, origSide: item[sideKey] ?? "" }));
}

/** The editable draft of a stored step: every field is text, ready to bind to an input. */
export function stepDraft(step) {
  return {
    id: step.id,
    actor: step.actor,
    action: step.action,
    origAction: step.action,
    kind: step.target ? (step.target.node ? "element" : "screen") : "none",
    screen: step.target?.screen ?? "",
    node: step.target?.node ?? "",
    note: step.note,
    via: step.via ?? "",
    origVia: step.via ?? "",
    data: (step.data ?? []).map((d) => ({ object: d.object, before: formatExample(d.before), after: formatExample(d.after), origBefore: d.before, origAfter: d.after })),
    extra: unmanaged(step, STEP_KEYS),
  };
}

export function emptyStep(actor = "system") {
  return { id: "", actor, action: "", kind: "screen", screen: "", node: "", via: "", origVia: "", data: [] };
}

/** A step body nothing was typed into yet (what Insert after / Append start with). */
export function isUntouched(step) {
  return step.action.trim() === "" && step.data.length === 0 && step.screen.trim() === "" && step.node.trim() === "" && !step.note;
}

function cloneStep(step) {
  return { ...step, data: step.data.map((d) => ({ ...d })) };
}

/** A new variant: nothing overridden, no swaps, no changes, no state rows. */
export function blankVariant() {
  return { id: "", title: "", description: "", when: {}, overrides: {}, swaps: [], ops: [], state: [], hadState: false, triggerShape: blankTriggerShape(), extra: {} };
}

/** The draft of a stored branch op: the branch ops carry their branch as an editable draft, a step op its step, an append its branch id. */
function opDraft(op) {
  const extra = unmanaged(op, OP_KEYS);
  if (op.op === "add_branch") return { op: "add_branch", stepId: "", step: null, branchId: "", branch: branchDraft(op.branch), extra };
  if (op.op === "replace_branch") return { op: "replace_branch", stepId: "", step: null, branchId: op.branch_id, branch: branchDraft(op.branch), extra };
  if (op.op === "remove_branch") return { op: "remove_branch", stepId: "", step: null, branchId: op.branch_id, branch: null, extra };
  return { op: op.op, stepId: op.step_id ?? "", step: op.step ? stepDraft(op.step) : null, branchId: op.branch ?? "", branch: null, extra };
}

/** The draft of a stored variant. An optional key that is present becomes an override; absent keys stay absent. */
export function variantDraft(variant) {
  const overrides = {};
  for (const [key] of TEXT_OVERRIDES) if (variant[key] !== undefined) overrides[key] = key === "trigger" ? triggerText(variant[key]) : variant[key];
  const origOverrides = { ...overrides };
  // A structured trigger override keeps its shape (actor / via / state / at) in `triggerShape`; `origTrigger` is what was stored.
  const origTrigger = variant.trigger;
  if (variant.personas !== undefined) overrides.personas = [...variant.personas];
  if (variant.constellations !== undefined) overrides.constellations = [...variant.constellations];
  if (variant.inputs !== undefined) overrides.inputs = ioDraft(variant.inputs, "source");
  if (variant.outputs !== undefined) overrides.outputs = ioDraft(variant.outputs, "target");
  return {
    id: variant.id,
    title: variant.title,
    origTitle: variant.title,
    description: variant.description ?? "",
    origDescription: variant.description ?? "",
    when: { ...variant.when },
    // A key stored empty (`steps: []`, `actors: {}`, `state: []`) stays empty while it is empty; one the user emptied is removed.
    hadSteps: variant.steps !== undefined && variant.steps.length === 0,
    hadActors: variant.actors !== undefined && Object.keys(variant.actors).length === 0,
    hadState: variant.state !== undefined && variant.state.length === 0,
    extra: unmanaged(variant, VARIANT_KEYS),
    overrides,
    origTrigger,
    triggerShape: triggerShape(variant.trigger),
    origOverrides, // the stored override texts: an untouched one is written back as it is, an edited one is trimmed
    swaps: Object.entries(variant.actors ?? {}).map(([from, to]) => ({ from, to })),
    state: (variant.state ?? []).map(stateDraft),
    ops: (variant.steps ?? []).map(opDraft),
  };
}

/** The input / output rows as a payload list; problems go to `errors`. The number is the row's position, as the aria-labels show it. */
export function parseIo(list, sideKey, label, errors) {
  return list
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.object !== "")
    .map(({ row, index }) => {
      const parsed = parseOrKeep(row.example, row.orig);
      if (!parsed.ok) errors.push(`${label} ${index + 1}: ${parsed.error}`);
      else if (Object.keys(parsed.value).length === 0) errors.push(`${label} ${index + 1}: the example needs at least one key.`);
      return { object: row.object, ...(written(row.side, row.origSide) !== "" ? { [sideKey]: written(row.side, row.origSide) } : {}), example: parsed.ok ? parsed.value : {} };
    });
}

/** One step as a payload object (a base step or the step of a change); `label` prefixes problems with its data changes. */
export function buildStepObject(step, id, label, errors) {
  const out = { ...step.extra, id, actor: step.actor || "system", action: written(step.action, step.origAction) };
  if (step.kind !== "none" && step.screen.trim() !== "") out.target = { screen: step.screen.trim(), ...(step.kind === "element" && step.node.trim() !== "" ? { node: step.node.trim() } : {}) };
  const data = step.data
    .filter((d) => d.object !== "")
    .map((d) => {
      const before = parseOrKeep(d.before, d.origBefore);
      const after = parseOrKeep(d.after, d.origAfter);
      if (!before.ok) errors.push(`${label} data (before): ${before.error}`);
      if (!after.ok) errors.push(`${label} data (after): ${after.error}`);
      // An empty stored `{}` reads as empty text and stays `{}` (spec §3.4 allows it); text the user cleared is dropped.
      const keeps = (text, orig) => text.trim() !== "" || (orig !== null && typeof orig === "object" && Object.keys(orig).length === 0);
      return { object: d.object, ...(keeps(d.before, d.origBefore) && before.ok ? { before: before.value } : {}), ...(keeps(d.after, d.origAfter) && after.ok ? { after: after.value } : {}) };
    });
  if (data.length > 0) out.data = data;
  if (step.note) out.note = step.note;
  const via = written(step.via ?? "", step.origVia ?? "");
  if (via !== "") out.via = via;
  return out;
}

/** The ids the changes of all variants write by hand: a generated id must not collide with them. */
export function variantStepIds(variants) {
  return variants.flatMap((variant) => variant.ops.filter((op) => op.op !== "remove").flatMap((op) => (op.branch ? op.branch.steps.map((step) => step.id) : [op.step?.id])).filter(Boolean));
}

/** Every step id that lives in a branch: those of the case's branches and those of the branch ops of any variant. */
export function allBranchStepIds(draft) {
  return new Set([...(draft.branches ?? []).flatMap((branch) => branch.steps.map((step) => step.id)), ...(draft.branchStepIds ?? []), ...draft.variants.flatMap((variant) => variant.ops.flatMap((op) => (op.branch ? op.branch.steps.map((step) => step.id) : [])))].filter(Boolean));
}

/** A one-line description of a branch op, for its row: "Add branch 3A · Discount ends (1 step)". */
export function branchOpSummary(op, label = "") {
  if (op.op === "remove_branch") return `Remove branch ${op.branchId}`;
  const steps = op.branch?.steps?.length ?? 0;
  const what = `${label ? `${label} · ` : ""}${op.branch?.title || op.branch?.id || "new branch"} (${steps} ${steps === 1 ? "step" : "steps"})`;
  return op.op === "add_branch" ? `Add branch ${what}` : `Replace branch ${op.branchId} with ${what}`;
}

/** The swaps as the stored `actors` map (complete rows only; a later row wins over an earlier one with the same "from"). */
export function actorsMap(swaps) {
  return Object.fromEntries(swaps.filter((swap) => swap.from !== "" && swap.to !== "").map((swap) => [swap.from, swap.to]));
}

/**
 * The flow a variant's changes start from: the base steps, each already carrying the actor the swaps give it (applied once, not
 * chained; spec §4). An entry keeps its `baseActor` for the struck line of a removed step.
 */
export function baseFlow(baseSteps, swaps) {
  const map = actorsMap(swaps);
  return baseSteps.map((step) => ({ id: step.id, baseActor: step.actor, actor: Object.hasOwn(map, step.actor) ? map[step.actor] : step.actor, action: step.action, step }));
}

function entryOf(step) {
  return { id: step.id, baseActor: step.actor, actor: step.actor, action: step.action, step };
}

/** A branch as the flow model holds it: its id, title, fork step and the steps as flow entries. `draft` may be a branch draft or a built branch. */
function branchEntry(draft) {
  return { id: draft.id, title: draft.title, from: draft.from === "" ? undefined : draft.from, steps: draft.steps.map(entryOf), source: draft };
}

/**
 * The flow a variant's changes start from: the base steps and the base branches, each step already carrying the actor the swaps give
 * it (applied once, not chained; spec §4). `base` is `{ steps, branches }` of the dialog's draft.
 */
export function baseModel(base, swaps) {
  const map = actorsMap(swaps);
  const swapped = (step) => ({ id: step.id, baseActor: step.actor, actor: Object.hasOwn(map, step.actor) ? map[step.actor] : step.actor, action: step.action, step });
  return { main: base.steps.map(swapped), branches: (base.branches ?? []).map((branch) => ({ id: branch.id, title: branch.title, from: branch.from === "" ? undefined : branch.from, steps: branch.steps.map(swapped), source: branch })) };
}

/** Where a step id lives: the main flow or one branch (step ids are one namespace, spec §2). */
function locateStep(model, stepId) {
  const at = model.main.findIndex((entry) => entry.id === stepId);
  if (at >= 0) return { list: model.main, index: at };
  for (const branch of model.branches) {
    const index = branch.steps.findIndex((entry) => entry.id === stepId);
    if (index >= 0) return { list: branch.steps, index, branch };
  }
  return null;
}

/**
 * Applies one change to the model the way the resolver does; a change naming a step or branch that is not there is skipped.
 * `step` is the step the change writes (a draft or a built step). Returns whether it applied.
 */
function applyOp(model, op, step = op.step) {
  if (op.op === "add_branch") {
    if (!op.branch || (op.branch.id !== "" && model.branches.some((b) => b.id === op.branch.id))) return false;
    model.branches.push(branchEntry(op.branch));
    return true;
  }
  if (op.op === "replace_branch") {
    const at = model.branches.findIndex((b) => b.id === op.branchId);
    if (at < 0 || !op.branch) return false;
    model.branches[at] = branchEntry({ ...op.branch, id: op.branchId });
    return true;
  }
  if (op.op === "remove_branch") {
    const at = model.branches.findIndex((b) => b.id === op.branchId);
    if (at < 0) return false;
    model.branches.splice(at, 1);
    return true;
  }
  if (op.op === "append") {
    const list = op.branchId === "" || op.branchId === undefined ? model.main : model.branches.find((b) => b.id === op.branchId)?.steps;
    if (!list) return false;
    list.push(entryOf(step));
    return true;
  }
  const found = op.stepId === "" ? null : locateStep(model, op.stepId);
  if (!found) return false;
  if (op.op === "remove") found.list.splice(found.index, 1);
  else if (op.op === "replace") found.list[found.index] = entryOf(step);
  else found.list.splice(found.index + 1, 0, entryOf(step));
  return true;
}

/** The model as it stands before change `count` (0-based): every flow entry the later changes can name. */
export function modelBefore(base, variant, count) {
  const model = baseModel(base, variant.swaps);
  variant.ops.slice(0, count).forEach((op) => {
    if ((op.op === "replace" || op.op === "insert_after" || op.op === "append") && !op.step) return;
    applyOp(model, op);
  });
  return model;
}

/** The main flow as it stands before change `count`: what a step select lists first. */
export function flowBefore(baseSteps, variant, count) {
  return modelBefore({ steps: baseSteps, branches: [] }, variant, count).main;
}

/**
 * Every step id of the model with the place it lives in ("step 3 of the main flow", "step 2B.1 of branch 2B"), the steps of
 * `ignoreBranch` left out (a replaced branch gives its ids back).
 */
export function placesIn(model, ignoreBranch = null) {
  const places = new Map();
  model.main.forEach((entry, i) => {
    if (entry.id !== "" && !places.has(entry.id)) places.set(entry.id, `step ${i + 1} of the main flow`);
  });
  const numbered = numberBranches({ steps: model.main.map((entry) => ({ id: entry.id })), branches: model.branches.map((branch) => ({ id: branch.id, from: branch.from })) });
  numbered.forEach(({ label }, k) => {
    const branch = model.branches[k];
    if (branch.id === ignoreBranch) return;
    branch.steps.forEach((entry, i) => {
      if (entry.id !== "" && !places.has(entry.id)) places.set(entry.id, `step ${label}.${i + 1} of branch ${label}`);
    });
  });
  return places;
}

/** The design number of each branch of the model (2A, A, …), in the model's order. */
export function branchLabels(model) {
  return numberBranches({ steps: model.main.map((entry) => ({ id: entry.id })), branches: model.branches.map((branch) => ({ id: branch.id, from: branch.from })) }).map((entry) => entry.label);
}

/**
 * The personas an inherited Personas row shows once the swaps are applied (spec §4): a persona that is a key takes its value, the
 * value "system" drops it, duplicates collapse, order is kept. `swapped` maps a persona to the ones that became it; `dropped` lists
 * the personas the swaps removed.
 */
export function inheritedPersonas(basePersonas, swaps) {
  const map = actorsMap(swaps);
  const ids = [];
  const swapped = new Map();
  const dropped = [];
  for (const persona of basePersonas) {
    const to = Object.hasOwn(map, persona) && map[persona] !== persona ? map[persona] : persona;
    if (to === "system") {
      dropped.push(persona);
      continue;
    }
    if (to !== persona) swapped.set(to, [...(swapped.get(to) ?? []), persona]);
    if (!ids.includes(to)) ids.push(to);
  }
  return { ids, swapped, dropped };
}

/**
 * One variant as its payload object, with the problems that block Save. `baseSteps` / `baseBranches` / `baseState` are the draft's base
 * parts, `usedStepIds` the ids a generated step id must avoid. A step id the variant itself freed (a step or branch it removed) is
 * free again for its later changes: the check follows the flow as the resolver builds it, change by change (spec §4, §6). `errors`
 * are the messages (the footer shows the first), `fieldErrors` the ones that belong to a field (`path`), shown under it.
 */
export function buildVariant(variant, index, { baseSteps, baseBranches = [], usedStepIds, variantIds, nameOf = (id) => id }) {
  const errors = [];
  const fieldErrors = [];
  const vid = variant.id || uniqueId(slugify(variant.title) || `variant-${index + 1}`, variantIds);
  variantIds.add(vid);
  const name = variant.title || vid;
  if (variant.title.trim() === "") errors.push(`Variant ${index + 1} needs a title.`);
  if (Object.keys(variant.when).length === 0) errors.push(`Variant "${name}" needs a condition (when).`);
  const out = { ...variant.extra, id: vid, title: written(variant.title, variant.origTitle), ...(written(variant.description, variant.origDescription) !== "" ? { description: written(variant.description, variant.origDescription) } : {}), when: variant.when };

  const { overrides } = variant;
  // A stored value the user did not touch is written back exactly as it is; one they edited is trimmed (`written`). An override that is empty is an error, not a silent removal.
  for (const [key, label] of TEXT_OVERRIDES) {
    if (overrides[key] === undefined) continue;
    if (key === "trigger") {
      // The trigger override replaces the trigger whole. Text only and empty is an empty override; a structured one (actor, conditions) keeps its structure when its text is cleared.
      const value = buildTrigger({ text: overrides.trigger, origText: variant.origOverrides?.trigger, shape: variant.triggerShape, orig: variant.origTrigger }, { path: `variant.${index}.trigger`, label: `Variant "${name}" trigger`, errors, fieldErrors });
      if (value === undefined) {
        errors.push(`Variant "${name}": the trigger override is empty.`);
        fieldErrors.push({ path: `variant.${index}.override.trigger`, message: "The trigger override is empty. Enter text or use the base." });
      } else out.trigger = value;
      continue;
    }
    out[key] = written(overrides[key], variant.origOverrides?.[key]);
    if (overrides[key].trim() === "") {
      errors.push(`Variant "${name}": the ${label.toLowerCase()} override is empty.`);
      fieldErrors.push({ path: `variant.${index}.override.${key}`, message: `The ${label.toLowerCase()} override is empty. Enter text or use the base.` });
    }
  }
  if (overrides.personas !== undefined) out.personas = [...overrides.personas];
  if (overrides.constellations !== undefined) out.constellations = [...overrides.constellations];
  const state = buildState(variant.state, { path: `variant.${index}.state`, label: `Variant "${name}" state`, errors, fieldErrors, nameOf });
  if (state.length > 0 || variant.hadState) out.state = state;
  const actors = actorsMap(variant.swaps);
  // A stored empty `actors: {}` stays, like `steps: []`.
  if (Object.keys(actors).length > 0 || variant.hadActors) out.actors = actors;
  variant.swaps.forEach((swap, j) => {
    if (swap.from === "" || swap.to === "") {
      errors.push(`Variant "${name}", swap ${j + 1}: pick both actors.`);
      fieldErrors.push({ path: `variant.${index}.swap.${j}`, message: "Pick both actors.", untilTouched: true }); // a swap row just added is not an error until the user leaves it
    } else if (swap.from === swap.to) {
      errors.push(`Variant "${name}", swap ${j + 1}: pick two different actors.`);
      fieldErrors.push({ path: `variant.${index}.swap.${j}`, message: "Pick two different actors." });
    }
  });
  for (const [key, sideKey, label] of [["inputs", "source", "input"], ["outputs", "target", "output"]]) {
    if (overrides[key] === undefined) continue;
    const rows = parseIo(overrides[key], sideKey, `Variant "${name}" ${label}`, errors);
    if (rows.length === 0) errors.push(`Variant "${name}": an overridden ${key} list needs at least one ${label} with an example.`);
    out[key] = rows;
  }

  const model = baseModel({ steps: baseSteps, branches: baseBranches }, variant.swaps);
  const ops = [];
  variant.ops.forEach((op, i) => {
    const where = `Variant "${name}", change ${i + 1}`;
    const path = `variant.${index}.op.${i}`;
    const pick = (what) => {
      errors.push(`${where}: pick the ${what} it changes.`);
      fieldErrors.push({ path: `${path}.pick`, message: `Pick the ${what} this change applies to.`, untilTouched: true });
    };
    if (op.op === "add_branch" || op.op === "replace_branch" || op.op === "remove_branch") {
      if (op.op !== "add_branch" && (op.branchId ?? "") === "") pick("branch");
      if (op.op === "remove_branch") {
        ops.push({ ...op.extra, op: "remove_branch", branch_id: op.branchId });
        applyOp(model, op);
        return;
      }
      const replaced = op.op === "replace_branch" ? model.branches.find((b) => b.id === op.branchId) : undefined;
      const problems = [];
      const built = buildBranch(op.branch ?? blankBranch(), { taken: placesIn(model, replaced?.id), ids: new Set(model.branches.filter((b) => b !== replaced).map((b) => b.id)), errors: problems, fieldErrors: [], label: "The branch", lockId: op.op === "replace_branch" });
      if (op.op === "add_branch" && model.branches.some((b) => b.id === built.id)) problems.push(`${built.id} is already a branch of this case. Give the new branch another id.`);
      if (problems.length > 0) {
        errors.push(`${where}: ${problems[0]}`);
        fieldErrors.push({ path: `${path}.edit`, message: problems[0], untilTouched: true });
      }
      ops.push(op.op === "add_branch" ? { ...op.extra, op: "add_branch", branch: built } : { ...op.extra, op: "replace_branch", branch_id: op.branchId, branch: { ...built, id: op.branchId } });
      applyOp(model, { ...op, branch: { id: op.op === "replace_branch" ? op.branchId : built.id, title: built.title, from: built.from ?? "", steps: built.steps } });
      return;
    }
    if (op.op !== "append" && op.stepId === "") pick("step");
    if (op.op === "remove") {
      applyOp(model, op);
      ops.push({ ...op.extra, op: "remove", step_id: op.stepId });
      return;
    }
    const step = op.step ?? emptyStep();
    if (step.action.trim() === "") {
      errors.push(`${where}: the step needs an action.`);
      fieldErrors.push({ path: `${path}.action`, message: "The step needs an action.", untilTouched: true });
    }
    const typed = step.id.trim();
    const id = typed || uniqueId(slugify(step.action) || `step-${i + 1}`, usedStepIds);
    usedStepIds.add(id);
    if (typed !== "" && !isValidId(typed)) {
      const message = `${typed} is not a valid id. Use lowercase letters, digits and dashes.`;
      errors.push(`${where}: ${message}`);
      fieldErrors.push({ path: `${path}.id`, message });
    }
    // The effective flow must not hold a second step with this id, in the main flow or in any branch (one namespace, spec §2 and §6);
    // a replace may keep the id of the step it replaces. What this variant removed earlier is gone from the model, so it is free again.
    const applies = op.op === "append" ? (op.branchId ?? "") === "" || model.branches.some((b) => b.id === op.branchId) : locateStep(model, op.stepId) !== null;
    const places = placesIn(model);
    if (applies && id !== (op.op === "replace" ? op.stepId : undefined) && places.has(id)) {
      const message = `${id} is already ${places.get(id)}. Give the new step another id.`;
      errors.push(`${where}: ${message}`);
      fieldErrors.push({ path: `${path}.id`, message });
    }
    const built = buildStepObject(step, id, where, errors);
    applyOp(model, op, built);
    ops.push(op.op === "append" ? { ...op.extra, op: "append", step: built, ...((op.branchId ?? "") !== "" ? { branch: op.branchId } : {}) } : { ...op.extra, op: op.op, step_id: op.stepId, step: built });
  });
  if (ops.length > 0 || variant.hadSteps) out.steps = ops;
  return { out, errors, fieldErrors };
}

/**
 * Reference problems of one variant (warnings, never blocking): a change naming a step or branch that is not in the flow at that
 * point, a change that leaves a branch without steps (`branch_empty`), an unset that names a key the base state lacks
 * (`variant_state_missing`), an unknown persona in a swap.
 */
export function variantWarnings({ variant, index, baseSteps, baseBranches = [], baseState = [], pool, nameOf = (id) => id }) {
  const warnings = [];
  const model = baseModel({ steps: baseSteps, branches: baseBranches }, variant.swaps);
  const warned = new Set();
  variant.ops.forEach((op, i) => {
    const path = `variant.${index}.op.${i}.step`;
    const isBranchOp = op.op === "add_branch" || op.op === "replace_branch" || op.op === "remove_branch";
    const branchNamed = op.op === "replace_branch" || op.op === "remove_branch" || (op.op === "append" && (op.branchId ?? "") !== "");
    if (branchNamed && (op.branchId ?? "") !== "" && !model.branches.some((b) => b.id === op.branchId)) {
      warnings.push({ path, message: `Branch ${op.branchId} is not a branch of the case at this point. This change is skipped; you can still save.` });
      return;
    }
    if (!isBranchOp && op.op !== "append" && op.stepId !== "" && !locateStep(model, op.stepId)) {
      warnings.push({ path, message: `${op.stepId} is not a step of the flow at this point. This change is skipped; you can still save.` });
      return;
    }
    if ((op.op === "replace" || op.op === "insert_after" || op.op === "append") && !op.step) return;
    applyOp(model, op);
    const labels = branchLabels(model);
    model.branches.forEach((branch, k) => {
      if (branch.steps.length > 0 || warned.has(branch.id)) return;
      warned.add(branch.id);
      warnings.push({ path, message: `Branch ${labels[k]} has no steps left in this variant. Remove the branch too, or keep a step.` });
    });
  });
  variant.state.forEach((row, j) => {
    if (row.unset && row.subject !== "" && row.property.trim() !== "" && !baseState.some((entry) => entry.subject === row.subject && entry.property.trim() === row.property.trim())) {
      warnings.push({ path: `variant.${index}.state.${j}`, message: `${nameOf(row.subject)} · ${row.property.trim()} is not in the base state, so there is nothing to unset.` });
    }
  });
  variant.swaps.forEach((swap, j) => {
    for (const side of ["from", "to"]) {
      const value = swap[side];
      if (value !== "" && value !== "system" && !pool.personasById.has(value)) warnings.push({ path: `variant.${index}.swap.${j}.${side}`, message: `Persona ${value} does not exist.` });
    }
  });
  return warnings;
}

/**
 * Shows the field errors of the last build: the hint under the field, the red border, and `aria-invalid` on the field. A hint
 * (`data-hint` on the field names its element) is listed in `aria-describedby` only while it is shown, because text a field
 * points to is announced even when it is hidden (modern-web-guidance `accessible-error-announcement`). The dialog footer is the
 * one polite live region (`role="status"`) that announces the first error.
 */
export function showFieldErrors(root, fieldErrors) {
  // An error marked `untilTouched` waits until the user has left its row (`[data-touch-scope]` gets `data-touched`); Save stays blocked meanwhile.
  const shownFor = (el, e) => !e.untilTouched || el.closest("[data-touch-scope]")?.dataset.touched === "true";
  for (const hint of root.querySelectorAll(".uc-field-error")) {
    const found = fieldErrors.filter((e) => e.path === hint.dataset.path && shownFor(hint, e));
    hint.hidden = found.length === 0;
    hint.textContent = found.map((e) => e.message).join(" ");
  }
  for (const el of root.querySelectorAll("[data-error-path]")) {
    const bad = fieldErrors.some((e) => e.path === el.dataset.errorPath && shownFor(el, e));
    el.classList.toggle("is-error", bad);
    el.setAttribute("aria-invalid", bad ? "true" : "false");
  }
  for (const el of root.querySelectorAll("[data-hint]")) {
    const shown = el.dataset.hint.split(" ").filter((id) => {
      const hint = root.querySelector(`[id="${id}"]`);
      return hint && !hint.hidden;
    });
    if (shown.length > 0) el.setAttribute("aria-describedby", shown.join(" "));
    else el.removeAttribute("aria-describedby");
  }
}

/** Marks a row (`[data-touch-scope]`) as left once focus moves out of it, so its `untilTouched` errors show; `model.touched` keeps that across redraws. */
export function touchScope(el, model, refresh) {
  el.dataset.touchScope = "";
  if (model.touched) el.dataset.touched = "true";
  const leave = () => {
    if (model.touched) return;
    model.touched = true;
    el.dataset.touched = "true";
    refresh();
  };
  /** The row's menu took the focus: the row counts as left once the menu is gone and the focus did not come back to the row (or another menu). */
  const watchMenu = (menu) => {
    const check = () => setTimeout(() => {
      if (!el.contains(document.activeElement) && !document.activeElement?.closest?.("[role=menu]")) leave();
    }, 0);
    menu.addEventListener("focusout", check, { once: true });
    if (menu.parentNode) {
      const observer = new MutationObserver(() => {
        if (menu.isConnected) return;
        observer.disconnect();
        check();
      });
      observer.observe(menu.parentNode, { childList: true });
    }
  };
  el.addEventListener("focusout", (event) => {
    if (el.contains(event.relatedTarget) || model.touched) return;
    const menu = event.relatedTarget?.closest?.("[role=menu]");
    if (menu) return watchMenu(menu);
    // A focused node that a redraw took out of the page is not a leave.
    if (event.relatedTarget === null && !event.target.isConnected) return;
    leave();
  });
}

// --- The editor (DOM) -------------------------------------------------------------------------------------------------

const OP_LABELS = { replace: "Replace", insert_after: "Insert after", remove: "Remove", append: "Append", add_branch: "Add branch", replace_branch: "Replace branch", remove_branch: "Remove branch" };
const BRANCH_KINDS = ["add_branch", "replace_branch", "remove_branch"];

/**
 * @param {{
 *   draft: Record<string, any>,
 *   pool: () => any,
 *   screens: () => string[],
 *   ensureNodes: (screen: string) => Promise<string[]> | undefined,
 *   objectOptions: () => { value: string, label: string }[],
 *   actorOptions: (current: string) => { value: string, label: string }[],
 *   markDirty: () => void,
 *   setDirty: () => void, // marks the form dirty without a warning pass (a move already did one)
 *   refresh: () => void, // re-runs the dialog's warning / error pass; called after every redraw, because a redrawn field starts without its hint
 * }} env `draft` is the dialog's draft: the editor reads the base fields from it live and edits `draft.variants` in place.
 * @returns {{ el: HTMLElement, draw: (focusIndex?: number | null) => void, cards: () => HTMLElement[] }}
 */
export function createVariantEditor(env) {
  const { draft, markDirty } = env;
  const box = h("div", { class: "uc-variants-edit" });
  // One per drawn variant: re-reads the base (a base edit changes "From base" values, the step lists and the struck line).
  let syncers = [];

  const baseSteps = () => draft.steps;
  const objectName = (id) => env.pool().objectsById.get(id)?.name ?? id;

  /** A step's own fields: id, actor, action, target, data changes. Used by the three change kinds that carry a step. */
  function stepBody(step, variantIndex, opIndexOf, onEdit) {
    // The change may be moved after this was drawn: parts drawn later (a target switch, a new data change) ask for its position then.
    const path = `variant.${variantIndex}.op.${opIndexOf()}`;
    const label = () => `Variant ${variantIndex + 1} change ${opIndexOf() + 1}`;
    const screenListId = nextId("uc-screens");
    const nodeListId = nextId("uc-nodes");
    const nodeList = h("datalist", { id: nodeListId });
    const fillNodes = (screen) => env.ensureNodes(screen)?.then((list) => nodeList.replaceChildren(...(list ?? []).slice(0, 400).map((n) => h("option", { value: n }, n))));
    const idHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `${path}.id` } });
    const idInput = textInput({ value: step.id, mono: true, placeholder: "step id", ariaLabel: `${label()} step id`, onInput: (value) => { step.id = value; markDirty(); onEdit(); } });
    idInput.dataset.errorPath = `${path}.id`;
    idInput.dataset.hint = idHint.id;
    const actionHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `${path}.action` } });
    const actionInput = textInput({ value: step.action, placeholder: "What happens", ariaLabel: `${label()} action`, onInput: (value) => { step.action = value; markDirty(); onEdit(); } });
    actionInput.dataset.errorPath = `${path}.action`;
    actionInput.dataset.hint = actionHint.id;
    const screenInput = textInput({ value: step.screen, list: screenListId, placeholder: "screen", mono: true, ariaLabel: `${label()} screen`, onInput: (value) => { step.screen = value; markDirty(); if (env.screens().includes(value.trim())) fillNodes(value.trim()); } });
    const nodeInput = textInput({ value: step.node, list: nodeListId, placeholder: "element id", mono: true, ariaLabel: `${label()} element`, onInput: (value) => { step.node = value; markDirty(); } });
    const targetRow = h("div", { class: "uc-target-edit" });
    const drawTarget = () => {
      fill(targetRow,
        segmented({ label: `${label()} target`, name: nextId("uc-kind"), value: step.kind, options: [{ value: "screen", label: "Screen" }, { value: "element", label: "Element" }, { value: "none", label: "None" }], onChange: (value) => { step.kind = value; markDirty(); drawTarget(); } }),
        step.kind !== "none" ? screenInput : null,
        step.kind === "element" ? nodeInput : null,
        step.kind !== "none" ? h("datalist", { id: screenListId }, env.screens().map((s) => h("option", { value: s }))) : null,
        step.kind === "element" ? nodeList : null,
      );
    };
    drawTarget();
    if (step.kind === "element" && env.screens().includes(step.screen)) fillNodes(step.screen);

    const dataBox = h("div", { class: "uc-step-data-edit" });
    const drawData = () => {
      dataBox.replaceChildren(
        ...step.data.map((d, j) =>
          h(
            "div",
            { class: "uc-data-edit" },
            selectInput({ options: env.objectOptions(), value: d.object, ariaLabel: "Data object", onChange: (value) => { d.object = value; markDirty(); } }),
            textInput({ value: d.before, mono: true, placeholder: "status: draft", ariaLabel: `${label()} data ${j + 1} before`, onInput: (value) => { d.before = value; markDirty(); } }),
            icon("arrow_forward", "uc-data-arrow"),
            textInput({ value: d.after, mono: true, placeholder: "status: ready", ariaLabel: `${label()} data ${j + 1} after`, onInput: (value) => { d.after = value; markDirty(); } }),
            removeButton("Remove data change", () => { step.data.splice(j, 1); markDirty(); drawData(); }),
          ),
        ),
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { step.data.push({ object: "", before: "", after: "" }); markDirty(); drawData(); } }, icon("add"), "Data change"),
      );
    };
    drawData();
    return h(
      "div",
      { class: "uc-op-body" },
      h("div", { class: "uc-op-fields" }, idInput, selectInput({ options: env.actorOptions(step.actor), value: step.actor || "system", ariaLabel: `${label()} actor`, onChange: (value) => { step.actor = value; markDirty(); } }), actionInput),
      idHint,
      actionHint,
      targetRow,
      dataBox,
    );
  }

  function draw(focusIndex = null) {
    box.replaceChildren();
    syncers = [];
    draft.variants.forEach((variant, index) => box.append(drawVariant(variant, index)));
    box.append(h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.variants.push(blankVariant()); markDirty(); draw(draft.variants.length - 1); } }, icon("add"), "Variant"));
    if (focusIndex !== null) box.querySelectorAll(".uc-variant-edit")[focusIndex]?.querySelector("input")?.focus();
    env.refresh();
  }

  function drawVariant(variant, index) {
    const pool = env.pool();
    const n = index + 1;
    const whenBox = h("div", { class: "uc-when-edit" });
    const drawWhen = () => {
      fill(whenBox,
        ...[...pool.dimensions].sort((a, b) => Number((a.scope ?? "personas") === "personas") - Number((b.scope ?? "personas") === "personas")).map((dimension) =>
          h(
            "div",
            { class: "uc-when-dim-edit" },
            h("span", { class: "uc-when-dim" }, dimension.label, h("span", { class: "uc-when-scope" }, (dimension.scope ?? "personas") === "constellations" ? " world" : " personas")),
            dimension.values.map((value) => {
              const on = (variant.when[dimension.id] ?? []).includes(value.id);
              return h("button", { type: "button", class: "uc-value-toggle", "aria-pressed": on ? "true" : "false", onClick: () => {
                const next = new Set(variant.when[dimension.id] ?? []);
                if (next.has(value.id)) next.delete(value.id);
                else next.add(value.id);
                if (next.size === 0) delete variant.when[dimension.id];
                else variant.when[dimension.id] = [...next];
                markDirty();
                drawWhen();
              } }, value.label);
            }),
          ),
        ),
        pool.dimensions.length === 0 ? h("p", { class: "uc-muted" }, "Add dimensions in the Personas view to describe when a variant applies.") : null,
      );
    };
    drawWhen();

    // --- Overrides ---
    const rows = {};
    const overrideGrid = h("div", { class: "uc-override-grid" });
    const inherited = (text, key, label) => {
      const button = h("button", { type: "button", class: "chrome-btn chrome-btn--ghost chrome-btn--compact", "aria-label": `Override ${label.toLowerCase()}`, onClick: () => override(key) }, "Override");
      return h("div", { class: "uc-inherited" }, h("span", { class: "uc-inherited-from" }, "From base"), h("span", { class: "uc-inherited-value", title: text }, text), button);
    };
    const useBase = (key, label) => h("button", { type: "button", class: "chrome-btn chrome-btn--ghost chrome-btn--compact", "aria-label": `Use base ${label.toLowerCase()}`, onClick: () => { delete variant.overrides[key]; markDirty(); drawRow(key, "override"); } }, "Use base");
    const baseText = (value) => (value.trim() === "" ? "none" : value);
    const ioSummary = (list) => {
      const filled = list.filter((row) => row.object !== "");
      return filled.length === 0 ? "none" : filled.map((row) => `${objectName(row.object)} · ${row.example}`).join("; ");
    };
    const personaText = () => {
      const { ids, swapped, dropped } = inheritedPersonas(draft.personas, variant.swaps);
      const name = (id) => actorName(id, pool.personasById);
      if (ids.length === 0) return dropped.length === 0 ? "none" : `none (${dropped.map(name).join(", ")} ${dropped.length === 1 ? "is" : "are"} swapped to System)`;
      return ids.map((id) => (swapped.has(id) ? `${name(id)} (${swapped.get(id).map(name).join(", ")}, swapped below)` : name(id))).join(", ");
    };

    const personaEditor = () => {
      const chips = h("div", { class: "uc-chip-row" });
      const add = h("button", { type: "button", class: "uc-link-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": `Add persona to variant ${n}` }, icon("add"), "Add persona");
      const list = variant.overrides.personas;
      const drawChips = () => {
        chips.replaceChildren(
          ...list.map((pid) => h("span", { class: "uc-person-chip", dataset: { persona: pid } }, avatar(avatarOf(pid, pool.personasById), "sm"), actorName(pid, pool.personasById), removeButton(`Remove ${actorName(pid, pool.personasById)} from variant ${n}`, () => { list.splice(list.indexOf(pid), 1); markDirty(); drawChips(); }))),
          add,
        );
      };
      add.addEventListener("click", () => {
        const items = pool.personas.filter((p) => !list.includes(p.id)).map((p) => ({ value: p.id, label: p.name, leading: avatar(avatarOf(p.id, pool.personasById), "sm") }));
        openMenu({ anchor: add, label: "Personas", items, filterable: true, emptyText: "Every persona is already added.", onPick: (value) => { list.push(value); markDirty(); drawChips(); } });
      });
      drawChips();
      return chips;
    };

    const ioEditor = (key, sideKey, useBaseButton) => {
      const kindLabel = key === "inputs" ? "Input" : "Output";
      const list = variant.overrides[key];
      const wrap = h("div", { class: "uc-io-edit" });
      const drawIo = (focusLast = false) => {
        wrap.replaceChildren(
          ...list.map((row, i) =>
            h(
              "div",
              { class: "uc-io-row" },
              h("span", { class: "uc-io-kind" }, key === "inputs" ? "In" : "Out"),
              selectInput({ options: env.objectOptions(), value: row.object, ariaLabel: "Data object", onChange: (value) => { row.object = value; markDirty(); } }),
              textInput({ value: row.side, placeholder: key === "inputs" ? "From" : "To", ariaLabel: `Variant ${n} ${kindLabel.toLowerCase()} ${i + 1} ${sideKey === "source" ? "from" : "to"}`, onInput: (value) => { row.side = value; markDirty(); } }),
              textInput({ value: row.example, mono: true, placeholder: "status: ready", ariaLabel: `Variant ${n} ${kindLabel.toLowerCase()} ${i + 1} example`, onInput: (value) => { row.example = value; markDirty(); } }),
              removeButton(`Remove ${kindLabel.toLowerCase()} ${i + 1} of variant ${n}`, () => { list.splice(i, 1); markDirty(); drawIo(); }),
            ),
          ),
          h("div", { class: "uc-io-add" }, h("button", { type: "button", class: "uc-link-btn", onClick: () => { list.push({ object: "", side: "", example: "" }); markDirty(); drawIo(true); } }, icon("add"), kindLabel), useBaseButton),
        );
        if (focusLast) [...wrap.querySelectorAll(".uc-io-row")].at(-1)?.querySelector("select")?.focus();
      };
      drawIo();
      return wrap;
    };

    const triggerSummary = () => {
      const shape = draft.triggerShape;
      const text = baseText(draft.trigger);
      if (shape.kind === "action" && shape.actor !== "") return `${actorName(shape.actor, pool.personasById)} · ${text}${shape.via.trim() !== "" ? ` · via ${shape.via.trim()}` : ""}`;
      if (shape.kind === "state") return `${text}${shape.conditions.length > 0 ? ` · ${plural(shape.conditions.length, "condition")}` : ""}${shape.at.trim() !== "" ? ` · from ${shape.at.trim()}` : ""}`;
      return text;
    };
    const constellationText = () => {
      const known = new Map((pool.world?.constellations ?? []).map((c) => [c.id, c.name]));
      return draft.constellations.length === 0 ? "none" : draft.constellations.map((id) => known.get(id) ?? id).join(", ");
    };
    const ROWS = [
      ...TEXT_OVERRIDES.map(([key, label]) => ({ key, label, baseText: key === "trigger" ? triggerSummary : () => baseText(draft[key]) })),
      { key: "personas", label: "Personas", baseText: personaText },
      { key: "constellations", label: "Constellations", baseText: constellationText },
      { key: "inputs", label: "Inputs", baseText: () => ioSummary(draft.inputs) },
      { key: "outputs", label: "Outputs", baseText: () => ioSummary(draft.outputs) },
    ];

    function editorFor(spec) {
      if (spec.key === "trigger") {
        // The variant replaces the trigger whole: overriding one part writes the complete trigger object (the base copied in, then edited).
        const emptyHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `variant.${index}.override.trigger` } });
        const editor = createTriggerEditor({ read: () => variant.overrides.trigger, write: (value) => { variant.overrides.trigger = value; }, shape: variant.triggerShape, pool: env.pool, actorOptions: env.actorOptions, path: `variant.${index}.trigger`, label: `Variant ${n} trigger`, markDirty, refresh: env.refresh, empty: { path: `variant.${index}.override.trigger`, hint: emptyHint } });
        return h("div", { class: "uc-override-edit" }, editor.el, emptyHint);
      }
      if (spec.key === "constellations") return constellationChips({ list: variant.overrides.constellations, pool: env.pool, path: `variant.${index}.constellation`, markDirty, label: `variant ${n}` }).el;
      if (TEXT_OVERRIDES.some(([key]) => key === spec.key)) {
        const hint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `variant.${index}.override.${spec.key}` } });
        const area = textArea({ value: variant.overrides[spec.key], rows: 2, ariaLabel: `Variant ${n} ${spec.label.toLowerCase()}`, onInput: (value) => { variant.overrides[spec.key] = value; markDirty(); } });
        area.dataset.errorPath = `variant.${index}.override.${spec.key}`;
        area.dataset.hint = hint.id;
        return h("div", { class: "uc-override-edit" }, area, hint);
      }
      if (spec.key === "personas") return personaEditor();
      return ioEditor(spec.key, spec.key === "inputs" ? "source" : "target", useBase(spec.key, spec.label));
    }

    /** Copies what the base holds into the new override (an override starts as the base value), then shows its editor. */
    function override(key) {
      if (key === "trigger") {
        variant.overrides.trigger = draft.trigger;
        variant.triggerShape = { ...draft.triggerShape, conditions: draft.triggerShape.conditions.map((c) => ({ ...c })) };
      } else if (key === "constellations") variant.overrides.constellations = [...draft.constellations];
      else if (TEXT_OVERRIDES.some(([k]) => k === key)) variant.overrides[key] = draft[key];
      else if (key === "personas") variant.overrides.personas = inheritedPersonas(draft.personas, variant.swaps).ids;
      else variant.overrides[key] = draft[key].map((row) => ({ ...row }));
      markDirty();
      drawRow(key, "editor");
    }

    function drawRow(key, focus = null) {
      const spec = ROWS.find((row) => row.key === key);
      const overridden = variant.overrides[key] !== undefined;
      const cell = h("div", { class: "uc-override-cell" });
      if (overridden) {
        const editor = editorFor(spec);
        // Inputs / outputs carry Use base next to "+ Input" / "+ Output"; the other editors have it beside them.
        if (key === "inputs" || key === "outputs") cell.append(editor);
        else cell.append(editor, useBase(key, spec.label));
      } else cell.append(inherited(spec.baseText(), key, spec.label));
      const labelEl = h("span", { class: "uc-label" }, spec.label);
      const row = rows[key];
      const fresh = h("div", { class: "uc-override-row", dataset: { key, state: overridden ? "override" : "base" } }, labelEl, cell);
      if (row) row.replaceWith(fresh);
      rows[key] = fresh;
      if (focus === "editor") fresh.querySelector("textarea, select, .uc-link-btn")?.focus();
      else if (focus === "override") fresh.querySelector(".uc-inherited button")?.focus();
      if (row) env.refresh();
      return fresh;
    }
    for (const spec of ROWS) overrideGrid.append(drawRow(spec.key));

    // --- Actor swaps ---
    const swapBox = h("div", { class: "uc-swaps-edit" });
    const syncSwaps = () => {
      const taken = new Set(variant.swaps.map((swap) => swap.from).filter(Boolean));
      swapBox.querySelectorAll(".uc-swap-row").forEach((rowEl, j) => {
        const swap = variant.swaps[j];
        const [fromSel, toSel] = rowEl.querySelectorAll("select");
        // Both ways: a from-value appears once and is never the row's own "to"; a "to" is never the row's own "from".
        for (const option of fromSel.options) option.disabled = option.value !== "" && option.value !== swap.from && (taken.has(option.value) || option.value === swap.to);
        for (const option of toSel.options) option.disabled = option.value !== "" && option.value === swap.from;
      });
    };
    const drawSwaps = (focusLast = false) => {
      const actorChoices = (current) => [{ value: "", label: "Actor…" }, ...env.actorOptions(current)];
      fill(swapBox,
        variant.swaps.length === 0 ? h("p", { class: "uc-muted uc-var-empty" }, "None. Every inherited step keeps its base actor.") : null,
        ...variant.swaps.map((swap, j) => {
          const warn = (side) => h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `variant.${index}.swap.${j}.${side}` } });
          const same = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `variant.${index}.swap.${j}` } });
          const onSwap = (side) => (value) => { swap[side] = value; markDirty(); syncSwaps(); drawRow("personas"); };
          const fromSel = selectInput({ options: actorChoices(swap.from), value: swap.from, ariaLabel: `Variant ${n} swap ${j + 1} from`, onChange: onSwap("from") });
          const toSel = selectInput({ options: actorChoices(swap.to), value: swap.to, ariaLabel: `Variant ${n} swap ${j + 1} to`, onChange: onSwap("to") });
          fromSel.dataset.path = `variant.${index}.swap.${j}.from`;
          fromSel.dataset.errorPath = `variant.${index}.swap.${j}`;
          fromSel.dataset.hint = same.id;
          toSel.dataset.path = `variant.${index}.swap.${j}.to`;
          toSel.dataset.errorPath = `variant.${index}.swap.${j}`;
          toSel.dataset.hint = same.id;
          const swapRow = h(
            "div",
            { class: "uc-swap-row" },
            fromSel,
            icon("arrow_forward", "uc-data-arrow"),
            toSel,
            removeButton(`Remove actor swap ${j + 1} of variant ${n}`, () => { variant.swaps.splice(j, 1); markDirty(); drawSwaps(); drawRow("personas"); }),
            warn("from"),
            warn("to"),
            same,
          );
          touchScope(swapRow, swap, env.refresh);
          return swapRow;
        }),
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { variant.swaps.push({ from: "", to: "" }); markDirty(); drawSwaps(true); } }, icon("add"), "Actor swap"),
      );
      syncSwaps();
      if (focusLast) [...swapBox.querySelectorAll(".uc-swap-row")].at(-1)?.querySelector("select")?.focus();
      env.refresh();
    };
    drawSwaps();

    // --- Step and branch changes ---
    const opsBox = h("div", { class: "uc-ops-edit" });
    const baseOf = () => ({ steps: baseSteps(), branches: draft.branches });
    /** The flow before change `i`, main flow and branches: what its step select lists. */
    const modelAt = (i) => modelBefore(baseOf(), variant, i);
    const entryById = (model, id) => model.main.find((e) => e.id === id) ?? model.branches.flatMap((b) => b.steps).find((e) => e.id === id);
    const fillStepOptions = (select, op, i) => {
      const model = modelAt(i);
      const labels = branchLabels(model);
      const listed = (entries, tag) => entries.flatMap((entry, k) => (entry.id === "" ? [] : [{ value: entry.id, label: `${tag(k)} · ${entry.action || "(no action yet)"}` }]));
      const options = [{ value: "", label: "Step…" }, ...listed(model.main, (k) => String(k + 1)), ...model.branches.flatMap((branch, b) => listed(branch.steps, (k) => `${labels[b]}.${k + 1}`))];
      if (op.stepId !== "" && !options.some((o) => o.value === op.stepId)) options.push({ value: op.stepId, label: `${op.stepId} (unknown)` });
      select.replaceChildren(...options.map((o) => h("option", { value: o.value }, o.label)));
      select.value = op.stepId;
    };
    /** A branch select (the branch a change names): every branch of the flow at that point. */
    const fillBranchOptions = (select, op, i, { none = null } = {}) => {
      const model = modelAt(i);
      const labels = branchLabels(model);
      const options = [...(none ? [{ value: "", label: none }] : [{ value: "", label: "Branch…" }]), ...model.branches.map((b, k) => ({ value: b.id, label: `${labels[k]} · ${b.title || b.id}` }))];
      if (op.branchId !== "" && !options.some((o) => o.value === op.branchId)) options.push({ value: op.branchId, label: `${op.branchId} (unknown)` });
      select.replaceChildren(...options.map((o) => h("option", { value: o.value }, o.label)));
      select.value = op.branchId;
    };
    let stepSelects = [];
    let branchSelects = [];
    /** Re-lists the flow in every change's step and branch select. Called when the changes or the base change, never on focus (that would rewrite an open select). */
    const refreshOptions = () => {
      stepSelects.forEach(({ select, op }) => fillStepOptions(select, op, variant.ops.indexOf(op)));
      branchSelects.forEach(({ select, op, none }) => fillBranchOptions(select, op, variant.ops.indexOf(op), { none }));
    };
    const removedBody = (op) => {
      const entry = entryById(modelAt(variant.ops.indexOf(op)), op.stepId);
      return [diffBadge("removed"), entry ? h("span", { class: "uc-op-struck" }, [actorName(entry.baseActor, pool.personasById), entry.action, entry.step.screen].filter(Boolean).join(" · ")) : h("span", { class: "uc-muted" }, "Pick the step to remove.")];
    };
    const opName = (i) => {
      const op = variant.ops[i];
      if (BRANCH_KINDS.includes(op?.op)) return branchOpSummary(op);
      return op?.step?.action.trim() || (op?.op === "remove" && op.stepId ? `Remove ${op.stepId}` : `Change ${i + 1}`);
    };
    // The change rows move in the DOM, not through drawOps, so focus and typed values survive. The model follows (onReorder); what
    // was drawn from a position (labels, field paths, the flow each step select lists, the struck line of a removal) is brought up to date.
    const reorder = createReorder({
      list: opsBox,
      rowSelector: ".uc-step-op",
      noun: "change",
      nameOf: (row, i) => opName(i),
      onReorder: (from, to) => { variant.ops.splice(to, 0, variant.ops.splice(from, 1)[0]); },
      onMoved: () => {
        opsBox.querySelectorAll(":scope > .uc-step-op").forEach((row, i) => {
          row.dataset.index = String(i);
          renumberRow(row, i, { label: /^(Variant \d+ change |Remove change )\d+/, path: /^(variant\.\d+\.op\.)\d+/ });
          const removed = row.querySelector(".uc-op-removed");
          if (removed) removed.replaceChildren(...removedBody(variant.ops[i]));
          row.querySelector(".uc-drag-handle")?.relabel();
          row.querySelector("[aria-haspopup='menu']")?.relabel();
        });
        refreshOptions();
        env.refresh();
      },
      onCommit: env.setDirty, // the refresh above already covers this move
    });

    /** The branch dialog's view of the flow before change `i`: the other branches, where this one sits, which step ids are taken. */
    const branchContext = (op, i) => {
      const model = modelAt(i);
      const replaced = op.op === "replace_branch" ? model.branches.find((b) => b.id === op.branchId) : undefined;
      const others = model.branches.filter((b) => b !== replaced);
      return {
        context: `in variant ${variant.title.trim() || variant.id || n}`,
        mainSteps: () => model.main.filter((e) => e.id !== "").map((e) => ({ id: e.id, action: e.action })),
        siblings: () => others.map((b) => ({ id: b.id, from: b.from })),
        position: replaced ? model.branches.indexOf(replaced) : others.length,
        taken: () => placesIn(model, replaced?.id ?? null),
        ids: () => new Set(others.map((b) => b.id)),
        pool: env.pool,
        screens: env.screens,
        actorOptions: env.actorOptions,
        ensureNodes: env.ensureNodes,
      };
    };
    async function editBranch(op, i) {
      const answer = await openBranchDialog({ ...branchContext(op, i), mode: op.op === "add_branch" ? "add" : "replace", branch: op.branch, canRemove: false });
      if (!answer || answer.removed) return;
      op.branch = answer.branch;
      markDirty();
      drawOps({ index: i });
    }
    /** The branch a replace starts from: the branch as the flow has it at that point, its steps carrying the actors the swaps give them. */
    const branchPrefill = (id, i) => {
      const entry = modelAt(i).branches.find((b) => b.id === id);
      if (!entry?.source) return null;
      const copy = cloneBranchDraft(entry.source);
      copy.id = id;
      copy.steps = entry.steps.map((e) => ({ ...cloneStep(e.step), actor: e.actor }));
      return copy;
    };
    const lastMainId = (i) => modelAt(i).main.filter((e) => e.id !== "").at(-1)?.id ?? "";

    const drawOps = (focus = null) => {
      stepSelects = [];
      branchSelects = [];
      fill(opsBox,
        variant.ops.length === 0 ? h("p", { class: "uc-muted uc-var-empty" }, `None. This variant runs the ${baseSteps().length} base steps as they are.`) : null,
        ...variant.ops.map((op, i) => {
          const at = () => variant.ops.indexOf(op);
          const label = `Variant ${n} change ${i + 1}`;
          const kindSel = selectInput({ options: Object.entries(OP_LABELS).map(([value, text]) => ({ value, label: text })), value: op.op, ariaLabel: `${label} operation`, onChange: (value) => changeKind(op, at(), value) });
          const warn = h("p", { class: "uc-field-warn", id: nextId("uc-warn"), hidden: true, dataset: { path: `variant.${index}.op.${i}.step` } });
          const pickErr = h("p", { class: "uc-field-error uc-op-hint", id: nextId("uc-err"), hidden: true, dataset: { path: `variant.${index}.op.${i}.pick` } });
          const editErr = h("p", { class: "uc-field-error uc-op-hint", id: nextId("uc-err"), hidden: true, dataset: { path: `variant.${index}.op.${i}.edit` } });
          warn.classList.add("uc-op-hint");
          let control;
          let body = null;
          if (BRANCH_KINDS.includes(op.op)) {
            // A branch change: add (the new branch), replace (pick one, then edit the whole branch), remove (pick one).
            if (op.op === "add_branch") control = h("span", { class: "uc-op-after-last" }, "a new branch");
            else {
              control = h("select", { class: "chrome-field uc-select", "aria-label": `${label} branch`, dataset: { role: "branch" } });
              fillBranchOptions(control, op, i);
              branchSelects.push({ select: control, op, none: null });
              control.dataset.errorPath = `variant.${index}.op.${i}.pick`;
              control.dataset.hint = `${pickErr.id} ${warn.id}`;
              control.addEventListener("change", () => pickBranch(op, at(), control.value));
            }
            if (op.op !== "remove_branch") {
              const text = op.branch ? `${op.branch.title.trim() || op.branch.id || "Untitled branch"} · ${plural(op.branch.steps.length, "step")}${op.branch.when.length > 0 ? ` · ${plural(op.branch.when.length, "condition")}` : ""}` : "Pick the branch to replace.";
              body = h("div", { class: "uc-op-branch" }, h("span", { class: "uc-op-branch-summary", dataset: { role: "branch-summary" } }, text), h("button", { type: "button", class: "chrome-btn chrome-btn--compact", disabled: !op.branch, "aria-label": `Edit the branch of ${label.toLowerCase()}`, onClick: () => editBranch(op, at()) }, "Edit"));
            }
          } else if (op.op === "append") {
            // Append goes to the end of the main flow, or of one branch.
            const hasBranches = modelAt(i).branches.length > 0 || op.branchId !== "";
            if (hasBranches) {
              control = h("select", { class: "chrome-field uc-select", "aria-label": `${label} branch`, dataset: { role: "append-branch" } });
              fillBranchOptions(control, op, i, { none: "to the main flow" });
              branchSelects.push({ select: control, op, none: "to the main flow" });
              control.addEventListener("change", () => { op.branchId = control.value; markDirty(); refreshOptions(); env.refresh(); });
            } else control = h("span", { class: "uc-op-after-last" }, "after the last step");
            if (op.step) body = stepBody(op.step, index, at, refreshOptions);
          } else {
            control = h("select", { class: "chrome-field uc-select", "aria-label": `${label} step`, dataset: { path: `variant.${index}.op.${i}.step`, role: "step" } });
            fillStepOptions(control, op, i);
            stepSelects.push({ select: control, op });
            control.dataset.errorPath = `variant.${index}.op.${i}.pick`;
            control.dataset.hint = `${pickErr.id} ${warn.id}`;
            control.addEventListener("change", () => pickStep(op, at(), control.value));
            if (op.op === "remove") body = h("div", { class: "uc-op-removed" }, removedBody(op));
            else if (op.step) body = stepBody(op.step, index, at, refreshOptions);
          }
          const opRow = h(
            "div",
            { class: "uc-step-op", dataset: { op: op.op, index: String(i) } },
            h("div", { class: "uc-op-top" }, reorder.handle(() => opRow), kindSel, control, h("span", { class: "uc-step-edit-tools" }, reorder.moreButton(() => opRow), removeButton(`Remove change ${i + 1} of variant ${n}`, () => { variant.ops.splice(at(), 1); markDirty(); drawOps(); }))),
            pickErr,
            editErr,
            warn,
            body,
            reorder.keyHint(),
          );
          touchScope(opRow, op, env.refresh);
          return opRow;
        }),
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { variant.ops.push({ op: "replace", stepId: "", step: null, branchId: "", branch: null, extra: {} }); markDirty(); drawOps({ index: variant.ops.length - 1 }); } }, icon("add"), "Step change"),
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { variant.ops.push({ op: "add_branch", stepId: "", step: null, branchId: "", branch: blankBranch({ from: lastMainId(variant.ops.length) }), extra: {} }); markDirty(); drawOps({ index: variant.ops.length - 1 }); } }, icon("add"), "Branch change"),
      );
      opsBox.querySelectorAll(":scope > .uc-step-op").forEach((row) => {
        row.querySelector(".uc-drag-handle").relabel();
        row.querySelector("[aria-haspopup='menu']").relabel();
      });
      if (focus) opsBox.querySelectorAll(".uc-step-op")[focus.index]?.querySelector(focus.part === "step" ? "[data-role=step]" : focus.part === "branch" ? "[data-role=branch]" : "select")?.focus();
      env.refresh();
    };
    /** A new id for a step a change adds: unique in the flow at that point and among every id the case already has. */
    const freshId = (i) => {
      const model = modelAt(i);
      const taken = new Set([...model.main.map((e) => e.id), ...model.branches.flatMap((b) => b.steps.map((e) => e.id)), ...baseSteps().map((s) => s.id), ...allBranchStepIds(draft), ...variantStepIds(draft.variants)].filter(Boolean));
      return uniqueId("new-step", taken);
    };
    const newBody = (i) => ({ ...emptyStep(draft.personas[0] ?? "system"), id: freshId(i) });
    /** The flow entry a replace starts from: its whole step (in the main flow or a branch), carrying the actor the swaps give it. */
    const prefill = (op, i) => {
      const entry = entryById(modelAt(i), op.stepId);
      return entry ? { ...cloneStep(entry.step), actor: entry.actor, prefilledId: entry.id } : null;
    };
    function pickStep(op, i, value) {
      op.stepId = value;
      // A pick fills the body from that step while nothing was typed into it; later picks keep what was typed.
      if (op.op === "replace" && (!op.step || isUntouched(op.step))) op.step = prefill(op, i);
      markDirty();
      drawOps({ index: i, part: "step" });
    }
    function pickBranch(op, i, value) {
      op.branchId = value;
      if (op.op === "replace_branch") op.branch = value === "" ? null : branchPrefill(value, i);
      markDirty();
      drawOps({ index: i, part: "branch" });
    }
    function changeKind(op, i, value) {
      const was = op.op;
      op.op = value;
      // The keys of the old kind that the new one does not allow go with it: the tool refuses a `branch` on anything but append, a `step_id` on a branch change, and so on.
      if (BRANCH_KINDS.includes(value)) {
        op.stepId = "";
        op.step = null;
        const keepsBranch = (value === "replace_branch" || value === "remove_branch") && (was === "replace_branch" || was === "remove_branch");
        if (!keepsBranch) op.branchId = "";
        if (value === "add_branch") op.branch = was === "add_branch" ? op.branch : blankBranch({ from: lastMainId(i) });
        else if (value === "replace_branch") op.branch = keepsBranch && op.branchId !== "" ? (op.branch ?? branchPrefill(op.branchId, i)) : null;
        else op.branch = null;
      } else {
        op.branch = null;
        if (value !== "append" || was !== "append") op.branchId = "";
        if (BRANCH_KINDS.includes(was)) {
          op.step = null;
          op.stepId = "";
        }
        if (value === "replace") {
          if (!op.step || isUntouched(op.step)) op.step = op.stepId !== "" ? prefill(op, i) : null;
        } else if (value === "insert_after" || value === "append") {
          if (!op.step) op.step = newBody(i);
          else if (op.step.prefilledId !== undefined && op.step.id === op.step.prefilledId) {
            // The id is still the one the Replace copied from the base: an added step with it would duplicate that step.
            op.step.id = freshId(i);
            delete op.step.prefilledId;
          }
        }
      }
      markDirty();
      drawOps({ index: i });
    }
    drawOps();
    // --- Starting state (merged into the base by subject and property) ---
    const stateEditor = stateRows({ rows: variant.state, baseRows: () => draft.state, pool: env.pool, path: `variant.${index}.state`, label: `Variant ${n} state row`, markDirty, refresh: env.refresh });
    syncers.push(() => {
      for (const spec of ROWS) if (variant.overrides[spec.key] === undefined) drawRow(spec.key);
      stateEditor.redraw();
      drawOps();
    });

    const section = (title, hint, ...children) => h("section", { class: "uc-var-section" }, h("h3", { class: "uc-var-h" }, title, h("span", { class: "uc-label-hint" }, ` · ${hint}`)), ...children);

    const titleField = textInput({ value: variant.title, placeholder: "Large project: map from the list", ariaLabel: `Variant ${n} title`, onInput: (value) => { variant.title = value; markDirty(); } });
    return h(
      "div",
      { class: "uc-variant-edit", dataset: { index: String(index) } },
      h("div", { class: "uc-variant-edit-top" }, field("Title", titleField), field("ID", textInput({ value: variant.id, mono: true, readonly: Boolean(variant.id), placeholder: "from the title", ariaLabel: `Variant ${n} id`, onInput: (value) => { variant.id = value; markDirty(); } })), removeButton(`Remove variant ${n}`, () => { draft.variants.splice(index, 1); markDirty(); draw(); })),
      field("Description", textInput({ value: variant.description, placeholder: "What is different in this variant", ariaLabel: `Variant ${n} description`, onInput: (value) => { variant.description = value; markDirty(); } })),
      field("Applies when", whenBox, { hint: "any of the chosen values per dimension; every listed dimension must match" }),
      section("Overrides", "what you do not override comes from the base", overrideGrid),
      section("Starting state", "merged into the base by subject and property", stateEditor.el),
      section("Actor swaps", "applied once to the inherited base steps, before the step changes; not chained", swapBox),
      section("Step and branch changes", "applied in order, top to bottom; drag a handle to reorder, or focus it and press Space", opsBox, h("p", { class: "uc-form-note" }, "Step changes (replace, insert after, append, remove) work on branch steps too; Append asks for the branch."), reorder.live),
    );
  }

  return { el: box, draw, syncBase: () => syncers.forEach((sync) => sync()), cards: () => [...box.querySelectorAll(".uc-variant-edit")] };
}
