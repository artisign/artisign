// Use Cases tab — the create/edit dialog of a use case: title, group, status, tags, personas, trigger / goal /
// outcome, inputs and outputs with example values, steps with a target picker (screen / element / none) and before/after
// data, and variants (title, id, when, overrides, actor swaps and step changes, see usecases-variant-edit.js). Saved through set_use_cases (the MCP tool);
// reference problems are warnings, shown live in the footer and never blocking. The pure parts (draft <-> payload, the
// warnings) are exported for the tests.

import { h, icon, fill } from "./usecases-dom.js";
import { createDialog, field, textInput, textArea, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { segmented, avatar } from "./usecases-parts.js";
import { openMenu } from "./usecases-menu.js";
import { createVariantEditor, emptyStep, touchScope, variantDraft, ioDraft, stepDraft, parseIo, buildStepObject, buildVariant, variantStepIds, allBranchStepIds, variantWarnings, showFieldErrors, baseModel, placesIn } from "./usecases-variant-edit.js";
import { createTriggerEditor, constellationChips, createBranchList } from "./usecases-forms-case-world.js";
import { stateRows, participantName, entitiesOf } from "./usecases-forms-rows.js";
import { triggerShape, buildTrigger, stateDraft, buildState, branchDraft, buildBranch, canonical, participantWarning } from "./usecases-world-edit.js";
import { createReorder, renumberRow } from "./usecases-reorder.js";
import {
  triggerText,
  STATUSES,
  STATUS_LABELS,
  slugify,
  uniqueId,
  isValidId,
  parseExample,
  undeclaredExampleKeys,
  avatarOf,
  actorName,
  warningSummary,
} from "./usecases-data.js";

// --- Draft <-> payload (pure) ---------------------------------------------------------------------------------------

/** The editable draft of a stored use case (or an empty one): every field is text, ready to bind to an input. */
export function draftFromSource(source) {
  const s = source ?? {};
  return {
    title: s.title ?? "",
    group: s.group ?? "",
    status: s.status ?? "draft",
    tags: (s.tags ?? []).join(", "),
    personas: [...(s.personas ?? [])],
    // `trigger` is the trigger's text in every form; its other parts (actor, via, conditions, at) are `triggerShape` (see buildTrigger).
    trigger: triggerText(s.trigger),
    triggerShape: triggerShape(s.trigger),
    constellations: [...(s.constellations ?? [])],
    state: (s.state ?? []).map(stateDraft),
    branches: (s.branches ?? []).map(branchDraft),
    goal: s.goal ?? "",
    outcome: s.outcome ?? "",
    // `orig` keeps the stored object: an example the user does not touch is saved exactly as it was, never re-read from text.
    inputs: ioDraft(s.inputs, "source"),
    outputs: ioDraft(s.outputs, "target"),
    steps: (s.steps ?? []).map(stepDraft),
    variants: (s.variants ?? []).map(variantDraft),
  };
}

/**
 * The set_use_cases entity for a draft. `source` is the stored case when editing: cleared optional fields become null (the tool's
 * "remove this key"), `variants`, `state`, `constellations` and `branches` are only sent when they changed. `nameOf` names a participant
 * for the messages. Returns { errors } when the draft cannot be sent at all.
 */
export function buildPayload({ id, draft, source, nameOf = (participant) => participant }) {
  const errors = [];
  if (draft.title.trim() === "") errors.push("A title is required.");
  if (!isValidId(id)) errors.push("The id must be lowercase kebab-case (a-z, 0-9, -).");
  const inputs = parseIo(draft.inputs, "source", "Input", errors);
  const outputs = parseIo(draft.outputs, "target", "Output", errors);
  if (inputs.length === 0) errors.push("Add at least one input with an example.");
  if (outputs.length === 0) errors.push("Add at least one output with an example.");

  // Generated ids must not collide with ANY id the case already has: every step, every branch step, every variant, and the steps variants add.
  const usedStepIds = new Set([...draft.steps.map((s) => s.id).filter(Boolean), ...allBranchStepIds(draft), ...variantStepIds(draft.variants)]);
  const fieldErrors = [];
  const steps = draft.steps.map((step, index) => {
    const stepId = step.id || uniqueId(slugify(step.action) || `step-${index + 1}`, usedStepIds);
    usedStepIds.add(stepId);
    if (step.action.trim() === "") {
      errors.push(`Step ${index + 1} needs an action.`);
      fieldErrors.push({ path: `step.${index}.action`, message: "The step needs an action.", untilTouched: true });
    }
    return buildStepObject(step, stepId, `Step ${index + 1}`, errors);
  });

  const trigger = buildTrigger({ text: draft.trigger, origText: triggerText(source?.trigger), shape: draft.triggerShape, orig: source?.trigger }, { path: "trigger", label: "Trigger", errors, fieldErrors });
  const state = buildState(draft.state, { path: "state", label: "Starting state", errors, fieldErrors, nameOf });

  // The base flow with its generated ids, as the variants and the branches see it.
  const baseSteps = draft.steps.map((step, i) => ({ ...step, id: steps[i].id }));
  const branchIds = new Set(draft.branches.map((b) => b.id).filter(Boolean));
  const branches = draft.branches.map((branch, index) => {
    const others = draft.branches.filter((b) => b !== branch);
    const problems = [];
    const built = buildBranch(branch, { taken: placesIn(baseModel({ steps: baseSteps, branches: others }, []), null), ids: branchIds, errors: problems, fieldErrors: [], label: `Branch ${index + 1}`, lockId: branch.id !== "" });
    if (problems.length > 0) {
      errors.push(`Branch ${built.title || built.id}: ${problems[0]}`);
      fieldErrors.push({ path: `branch.${index}`, message: problems[0] });
    }
    return built;
  });

  const variantIds = new Set(draft.variants.map((v) => v.id).filter(Boolean));
  const variants = draft.variants.map((variant, index) => {
    const built = buildVariant(variant, index, { baseSteps, baseBranches: draft.branches, usedStepIds, variantIds, nameOf });
    errors.push(...built.errors);
    fieldErrors.push(...built.fieldErrors);
    return built.out;
  });

  if (errors.length > 0) return { errors, fieldErrors };

  const text = (value) => (value.trim() === "" ? undefined : value.trim());
  const tags = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
  const optional = (key, value, had) => (value !== undefined ? { [key]: value } : had ? { [key]: null } : {});
  const payload = {
    id,
    title: draft.title.trim(),
    status: draft.status,
    personas: draft.personas,
    inputs,
    outputs,
    steps,
    ...optional("group", text(draft.group), source?.group !== undefined),
    ...optional("tags", tags.length > 0 ? tags : undefined, source?.tags !== undefined),
    ...optional("trigger", trigger, source?.trigger !== undefined),
    ...optional("goal", text(draft.goal), source?.goal !== undefined),
    ...optional("outcome", text(draft.outcome), source?.outcome !== undefined),
  };
  // A list is sent only when it changed (a save never rewrites what it did not touch); emptied, it removes the key.
  const sendList = (key, list) => {
    if (canonical(list) === canonical(source?.[key] ?? [])) return;
    if (list.length > 0) payload[key] = list;
    else if (source?.[key] !== undefined) payload[key] = null;
  };
  sendList("constellations", draft.constellations);
  sendList("state", state);
  sendList("branches", branches);
  sendList("variants", variants);
  return { payload };
}

/**
 * Reference problems of a draft (warnings, never blocking): an example key the data object does not declare, an unknown persona
 * or actor, a target screen / element that does not exist. `nodes` maps a screen to its node ids once loaded.
 */
export function draftWarnings({ draft, pool, screens, nodes }) {
  const warnings = [];
  const screenSet = new Set(screens);
  const check = (where, objectId, text) => {
    const parsed = parseExample(text);
    if (!parsed.ok || !objectId) return;
    const object = pool.objectsById.get(objectId);
    if (!object) return warnings.push({ path: where, message: `Data object ${objectId} does not exist.` });
    for (const key of undeclaredExampleKeys(object, parsed.value)) warnings.push({ path: where, message: `${key} is not a field of ${object.name}.` });
  };
  draft.inputs.forEach((row, i) => check(`input.${i}`, row.object, row.example));
  draft.outputs.forEach((row, i) => check(`output.${i}`, row.object, row.example));
  for (const id of draft.personas) if (!pool.personasById.has(id)) warnings.push({ path: `persona.${id}`, message: `Persona ${id} does not exist.` });
  draft.steps.forEach((step, i) => {
    if (step.actor !== "system" && step.actor !== "" && !pool.personasById.has(step.actor)) warnings.push({ path: `step.${i}.actor`, message: `Persona ${step.actor} does not exist.` });
    if (step.kind !== "none" && step.screen.trim() !== "") {
      if (!screenSet.has(step.screen.trim())) warnings.push({ path: `step.${i}.screen`, message: "This screen no longer exists. Pick another one." });
      else if (step.kind === "element" && step.node.trim() !== "" && nodes[step.screen.trim()] && !nodes[step.screen.trim()].includes(step.node.trim())) warnings.push({ path: `step.${i}.node`, message: `${step.node.trim()} is not an element of ${step.screen.trim()}.` });
    }
    step.data.forEach((d, j) => {
      check(`step.${i}.data.${j}.before`, d.object, d.before);
      check(`step.${i}.data.${j}.after`, d.object, d.after);
    });
  });
  // The world: a trigger actor, a constellation, a state or condition subject, a branch fork that does not exist (spec §6, warnings only).
  const ends = { personasById: pool.personasById ?? new Map(), entitiesById: new Map(entitiesOf(pool).map((e) => [e.id, e])) };
  const known = new Set((pool.world?.constellations ?? []).map((c) => c.id));
  const subjectWarnings = (rows, path) => rows.forEach((row, j) => {
    const message = participantWarning(row.subject, ends);
    if (message) warnings.push({ path: `${path}.${j}.subject`, message });
  });
  const { triggerShape: shape } = draft;
  if (shape.kind === "action" && shape.actor !== "" && !ends.personasById.has(shape.actor)) warnings.push({ path: "trigger.actor", message: `Persona ${shape.actor} does not exist.` });
  if (shape.kind === "state") subjectWarnings(shape.conditions, "trigger.state");
  for (const id of draft.constellations) if (!known.has(id)) warnings.push({ path: `constellation.${id}`, message: `${id} is not in the world pool. Create it in World or remove it here.` });
  subjectWarnings(draft.state, "state");
  const mainIds = new Set(draft.steps.map((s) => s.id).filter(Boolean));
  draft.branches.forEach((branch, i) => {
    const problems = [];
    if (branch.from !== "" && !mainIds.has(branch.from)) problems.push(`it forks after ${branch.from}, which is not a main-flow step, so it runs before the first step`);
    if (!branch.ends && branch.rejoin !== "" && !mainIds.has(branch.rejoin)) problems.push(`it continues at ${branch.rejoin}, which is not a main-flow step`);
    for (const row of branch.when) {
      const message = participantWarning(row.subject, ends);
      if (message) problems.push(message.replace(/\.$/, ""));
    }
    if (problems.length > 0) warnings.push({ path: `branch.${i}`, message: `${branch.title || branch.id}: ${problems.join("; ")}.` });
  });
  const nameOf = (id) => participantName(pool, id);
  draft.variants.forEach((variant, index) => {
    warnings.push(...variantWarnings({ variant, index, baseSteps: draft.steps, baseBranches: draft.branches, baseState: draft.state, pool, nameOf }));
    for (const id of variant.overrides.constellations ?? []) if (!known.has(id)) warnings.push({ path: `variant.${index}.constellation.${id}`, message: `${id} is not in the world pool. Create it in World or remove it here.` });
    subjectWarnings(variant.state, `variant.${index}.state`);
    if (variant.overrides.trigger !== undefined && variant.triggerShape.kind === "action" && variant.triggerShape.actor !== "" && !ends.personasById.has(variant.triggerShape.actor)) warnings.push({ path: `variant.${index}.trigger.actor`, message: `Persona ${variant.triggerShape.actor} does not exist.` });
  });
  return warnings;
}

// --- The dialog -------------------------------------------------------------------------------------------------------

/**
 * @param {{
 *   mode: "new" | "edit",
 *   source: Record<string, any> | null,
 *   pool: () => { personas: any[], personasById: Map<string, any>, dimensions: any[], dimensionsById: Map<string, any>, objects: any[], objectsById: Map<string, any> },
 *   screens: () => string[],
 *   groups: () => string[],
 *   takenIds: () => Set<string>,
 *   loadNodes: (screen: string) => Promise<string[]>,
 *   save: (payload: Record<string, any>) => Promise<{ ok: true, data: any } | { ok: false, message: string }>,
 *   newObject: () => Promise<void>,
 *   focus?: { step?: string, variants?: boolean },
 *   initialDraft?: Record<string, any>,
 * }} options
 * @returns {Promise<{ id: string, data: any } | null>} the saved id with the tool response, or null when closed without saving
 */
export async function openUseCaseDialog(options) {
  const { mode, source, loadNodes } = options;
  const draft = options.initialDraft ?? draftFromSource(source);
  const dialog = createDialog({ title: mode === "new" ? "New use case" : "Edit use case", chip: source?.id, wide: true });
  let id = source?.id ?? "";
  let idTouched = mode === "edit";
  const nodes = {};
  const nodeRequests = new Map();
  let saving = false;
  let result = null;

  const ensureNodes = (screen) => {
    if (!screen || nodeRequests.has(screen)) return nodeRequests.get(screen);
    const request = loadNodes(screen).then((list) => {
      nodes[screen] = list;
      refreshWarnings();
      return list;
    }).catch(() => []);
    nodeRequests.set(screen, request);
    return request;
  };

  let variantEditor = null;
  let branchList = null;
  // The variant editor reads the base (its "From base" values, the step lists) and the branch list reads the steps it forks from, so a base edit tells them to re-read.
  const markDirty = () => {
    touch();
    variantEditor?.syncBase();
    branchList?.redraw(true);
  };
  const touch = () => {
    dialog.setDirty(true);
    refreshWarnings();
  };

  // --- Basics -------------------------------------------------------------------------------------------------
  const titleInput = textInput({ value: draft.title, autofocus: true, placeholder: "Map a step to a screen element", onInput: (value) => { draft.title = value; if (!idTouched) { id = uniqueId(slugify(value), options.takenIds()); idInput.value = id; } markDirty(); } });
  const groupListId = nextId("uc-groups");
  const groupInput = textInput({ value: draft.group, list: groupListId, placeholder: "mapping/elements", onInput: (value) => { draft.group = value; markDirty(); } });
  const groupList = h("datalist", { id: groupListId }, options.groups().map((g) => h("option", { value: g })));
  const idInput = textInput({ value: id, mono: true, readonly: mode === "edit", placeholder: "derived from the title", onInput: (value) => { id = value; idTouched = true; markDirty(); } });
  const statusControl = segmented({ label: "Status", name: "status", value: draft.status, options: STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })), onChange: (value) => { draft.status = value; markDirty(); } });
  const tagsInput = textInput({ value: draft.tags, placeholder: "mapping, design", onInput: (value) => { draft.tags = value; markDirty(); } });

  // --- Personas -----------------------------------------------------------------------------------------------
  const personaRow = h("div", { class: "uc-chip-row" });
  const addPersonaButton = h("button", { type: "button", class: "uc-link-btn", "aria-haspopup": "menu", "aria-expanded": "false" }, icon("add"), "Add persona");
  const drawPersonas = () => {
    const pool = options.pool();
    personaRow.replaceChildren(
      ...draft.personas.map((pid) =>
        h("span", { class: "uc-person-chip", dataset: { persona: pid } }, avatar(avatarOf(pid, pool.personasById), "sm"), actorName(pid, pool.personasById), removeButton(`Remove ${actorName(pid, pool.personasById)}`, () => { draft.personas = draft.personas.filter((x) => x !== pid); markDirty(); drawPersonas(); })),
      ),
      addPersonaButton,
    );
  };
  addPersonaButton.addEventListener("click", () => {
    const pool = options.pool();
    const items = pool.personas.filter((p) => !draft.personas.includes(p.id)).map((p) => ({ value: p.id, label: p.name, leading: avatar(avatarOf(p.id, pool.personasById), "sm") }));
    openMenu({ anchor: addPersonaButton, label: "Personas", items, filterable: true, emptyText: "Every persona is already added.", onPick: (value) => { draft.personas.push(value); markDirty(); drawPersonas(); } });
  });

  const storyArea = (key, label) => field(label, textArea({ value: draft[key], rows: 3, onInput: (value) => { draft[key] = value; markDirty(); } }));

  // --- Inputs and outputs -------------------------------------------------------------------------------------
  const ioBox = h("div", { class: "uc-io-edit" });
  const objectOptions = () => [{ value: "", label: "Data object…" }, ...options.pool().objects.map((o) => ({ value: o.id, label: o.name }))];
  const drawIo = (focusLast = null) => {
    ioBox.replaceChildren();
    const rows = [...draft.inputs.map((row, index) => ({ row, index, kind: "inputs" })), ...draft.outputs.map((row, index) => ({ row, index, kind: "outputs" }))];
    for (const { row, index, kind } of rows) {
      const sideLabel = kind === "inputs" ? "From" : "To";
      const exampleInput = textInput({ value: row.example, mono: true, placeholder: "status: ready", ariaLabel: `${kind === "inputs" ? "Input" : "Output"} ${index + 1} example`, onInput: (value) => { row.example = value; markDirty(); } });
      exampleInput.dataset.path = `${kind === "inputs" ? "input" : "output"}.${index}`;
      const warn = h("p", { class: "uc-field-warn", id: nextId("uc-warn"), hidden: true, dataset: { path: `${kind === "inputs" ? "input" : "output"}.${index}` } });
      exampleInput.setAttribute("aria-describedby", warn.id);
      ioBox.append(
        h(
          "div",
          { class: "uc-io-row" },
          h("span", { class: "uc-io-kind" }, kind === "inputs" ? "In" : "Out"),
          selectInput({ options: objectOptions(), value: row.object, ariaLabel: "Data object", onChange: (value) => { row.object = value; markDirty(); } }),
          textInput({ value: row.side, placeholder: "Use case editor", ariaLabel: sideLabel, onInput: (value) => { row.side = value; markDirty(); } }),
          exampleInput,
          removeButton(`Remove ${kind === "inputs" ? "input" : "output"} ${index + 1}`, () => { draft[kind].splice(index, 1); markDirty(); drawIo(); }),
          warn,
        ),
      );
    }
    ioBox.append(
      h(
        "div",
        { class: "uc-io-add" },
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.inputs.push({ object: "", side: "", example: "" }); markDirty(); drawIo("inputs"); } }, icon("add"), "Input"),
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.outputs.push({ object: "", side: "", example: "" }); markDirty(); drawIo("outputs"); } }, icon("add"), "Output"),
        h("button", { type: "button", class: "uc-link-btn", onClick: async () => { await options.newObject(); drawIo(); drawSteps(); } }, icon("data_object"), "New data object"),
      ),
    );
    if (focusLast) {
      const list = ioBox.querySelectorAll(`input[data-path^="${focusLast === "inputs" ? "input" : "output"}."]`);
      list[list.length - 1]?.closest(".uc-io-row")?.querySelector("select")?.focus();
    }
  };

  // --- Steps --------------------------------------------------------------------------------------------------
  const stepsBox = h("div", { class: "uc-steps-edit" });
  const actorOptions = (current) => {
    const pool = options.pool();
    const used = new Set([...draft.personas, current].filter(Boolean));
    const personas = pool.personas.filter((p) => !p.generated || used.has(p.id));
    return [{ value: "system", label: "System" }, ...personas.map((p) => ({ value: p.id, label: p.name }))];
  };
  // Rows are moved in the DOM, not redrawn: the draft array follows (`onReorder`) and the "Step N" labels are rewritten (`onMoved`).
  let quiet = false; // the variant editor redraws while a base move already runs its own warning pass
  const relabelRows = () => {
    stepsBox.querySelectorAll(":scope > .uc-step-edit").forEach((row, i) => {
      row.dataset.index = String(i);
      row.querySelector(".uc-step-edit-no").textContent = String(i + 1);
      renumberRow(row, i, { label: /^(Step |Remove step )\d+/, path: /^(step\.)\d+/ });
      row.querySelector(".uc-drag-handle")?.relabel();
      row.querySelector("[aria-haspopup='menu']")?.relabel();
    });
    // The variant editor lists the base steps (its step selects, "From base" values): it follows every move, with one warning pass in all.
    quiet = true;
    variantEditor?.syncBase();
    branchList?.redraw(true);
    quiet = false;
    refreshWarnings();
  };
  const reorder = createReorder({
    list: stepsBox,
    rowSelector: ".uc-step-edit",
    nameOf: (row, i) => draft.steps[i]?.action?.trim() || `Step ${i + 1}`,
    onReorder: (from, to) => { draft.steps.splice(to, 0, draft.steps.splice(from, 1)[0]); },
    onMoved: relabelRows,
    onCommit: () => dialog.setDirty(true), // relabelRows already synced the variants and refreshed the warnings for this move
  });
  const drawSteps = (focusIndex = null) => {
    stepsBox.replaceChildren();
    draft.steps.forEach((step, index) => {
      const at = () => draft.steps.indexOf(step); // the row may have been moved since it was drawn; inner parts drawn later ask for the current position
      const screenListId = nextId("uc-screens");
      const nodeListId = nextId("uc-nodes");
      const nodeList = h("datalist", { id: nodeListId });
      const fillNodes = (screen) => ensureNodes(screen)?.then((list) => nodeList.replaceChildren(...(list ?? []).slice(0, 400).map((n) => h("option", { value: n }, n))));
      const warnScreen = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${at()}.screen` } });
      const warnNode = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${at()}.node` } });
      const screenInput = textInput({ value: step.screen, list: screenListId, placeholder: "screen", mono: true, ariaLabel: `Step ${at() + 1} screen`, onInput: (value) => { step.screen = value; markDirty(); if (options.screens().includes(value.trim())) fillNodes(value.trim()); } });
      const nodeInput = textInput({ value: step.node, list: nodeListId, placeholder: "element id", mono: true, ariaLabel: `Step ${at() + 1} element`, onInput: (value) => { step.node = value; markDirty(); } });
      const viaInput = textInput({ value: step.via ?? "", placeholder: "Via", ariaLabel: `Step ${at() + 1} via`, onInput: (value) => { step.via = value; markDirty(); } });
      screenInput.dataset.path = `step.${at()}.screen`;
      nodeInput.dataset.path = `step.${at()}.node`;
      const targetRow = h("div", { class: "uc-target-edit" });
      const drawTarget = () => {
        fill(targetRow,
          segmented({ label: `Step ${at() + 1} target`, name: `kind-${at()}`, value: step.kind, options: [{ value: "screen", label: "Screen" }, { value: "element", label: "Element" }, { value: "none", label: "None" }], onChange: (value) => { step.kind = value; markDirty(); drawTarget(); } }),
          step.kind !== "none" ? screenInput : null,
          step.kind === "element" ? nodeInput : null,
          step.kind !== "none" ? h("datalist", { id: screenListId }, options.screens().map((s) => h("option", { value: s }))) : null,
          step.kind === "element" ? nodeList : null,
          viaInput,
        );
      };
      drawTarget();
      if (step.kind === "element" && options.screens().includes(step.screen)) fillNodes(step.screen);

      const dataBox = h("div", { class: "uc-step-data-edit" });
      const drawData = () => {
        dataBox.replaceChildren(
          ...step.data.map((d, j) => {
            const warn = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${at()}.data.${j}.after` } });
            const beforeWarn = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${at()}.data.${j}.before` } });
            return h(
              "div",
              { class: "uc-data-edit" },
              selectInput({ options: objectOptions(), value: d.object, ariaLabel: "Data object", onChange: (value) => { d.object = value; markDirty(); } }),
              textInput({ value: d.before, mono: true, placeholder: "status: draft", ariaLabel: `Step ${at() + 1} data ${j + 1} before`, onInput: (value) => { d.before = value; markDirty(); } }),
              icon("arrow_forward", "uc-data-arrow"),
              textInput({ value: d.after, mono: true, placeholder: "status: ready", ariaLabel: `Step ${at() + 1} data ${j + 1} after`, onInput: (value) => { d.after = value; markDirty(); } }),
              removeButton("Remove data change", () => { step.data.splice(j, 1); markDirty(); drawData(); }),
              beforeWarn,
              warn,
            );
          }),
          h("button", { type: "button", class: "uc-link-btn", onClick: () => { step.data.push({ object: "", before: "", after: "" }); markDirty(); drawData(); } }, icon("add"), "Data change"),
        );
      };
      drawData();

      const actionHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `step.${index}.action` } });
      const actionInput = textInput({ value: step.action, placeholder: "What happens", ariaLabel: `Step ${index + 1} action`, onInput: (value) => { step.action = value; markDirty(); } });
      actionInput.dataset.errorPath = `step.${index}.action`;
      actionInput.dataset.hint = actionHint.id;
      let rowEl;
      rowEl = h(
          "div",
          { class: "uc-step-edit", dataset: { index: String(index), step: step.id ?? "" } },
          h("div", { class: "uc-step-edit-top" }, reorder.handle(() => rowEl), h("span", { class: "uc-step-edit-no" }, String(index + 1)), selectInput({ options: actorOptions(step.actor), value: step.actor || "system", ariaLabel: `Step ${index + 1} actor`, onChange: (value) => { step.actor = value; markDirty(); } }), actionInput, h("span", { class: "uc-step-edit-tools" }, reorder.moreButton(() => rowEl), removeButton(`Remove step ${index + 1}`, () => { draft.steps.splice(draft.steps.indexOf(step), 1); markDirty(); drawSteps(); }))),
          actionHint,
          targetRow,
          warnScreen,
          warnNode,
          dataBox,
          reorder.keyHint(),
        );
      touchScope(rowEl, step, refreshWarnings);
      stepsBox.append(rowEl);
      rowEl.querySelector("[aria-haspopup='menu']").relabel();
      rowEl.querySelector(".uc-drag-handle").relabel();
    });
    stepsBox.append(h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.steps.push(emptyStep(draft.personas[0] ?? "system")); markDirty(); drawSteps(draft.steps.length - 1); } }, icon("add"), "Step"));
    if (focusIndex !== null) stepsBox.querySelectorAll(".uc-step-edit")[focusIndex]?.querySelector("input")?.focus();
    refreshWarnings(); // redrawn fields start without their hints and error states
  };

  // --- The world: trigger, constellations, starting state, branches (CHR-1154) ------------------------------------------
  const nameOf = (participant) => participantName(options.pool(), participant);
  const refreshAfterDraw = () => { if (ready) refreshWarnings(); }; // the editors draw before the footer exists
  let ready = false;
  const triggerEditor = createTriggerEditor({ read: () => draft.trigger, write: (value) => { draft.trigger = value; }, shape: draft.triggerShape, pool: options.pool, actorOptions, path: "trigger", label: "Trigger", markDirty, refresh: refreshAfterDraw });
  const constellations = constellationChips({ list: draft.constellations, pool: options.pool, path: "constellation", markDirty });
  const stateEditor = stateRows({ rows: draft.state, pool: options.pool, path: "state", label: "State row", markDirty, refresh: refreshAfterDraw });
  branchList = createBranchList({ draft, pool: options.pool, screens: options.screens, actorOptions, ensureNodes, markDirty, refresh: refreshAfterDraw });
  branchList.redraw();

  // --- Variants (usecases-variant-edit.js) -----------------------------------------------------------------------
  variantEditor = createVariantEditor({ draft, pool: options.pool, screens: options.screens, ensureNodes, objectOptions, actorOptions, markDirty: touch, setDirty: () => dialog.setDirty(true), refresh: () => { if (!quiet) refreshWarnings(); } });
  const variantsBox = variantEditor.el;

  // --- Footer: warnings, the one hard requirement, Save ---------------------------------------------------------
  let currentWarnings = [];
  function refreshWarnings() {
    currentWarnings = draftWarnings({ draft, pool: options.pool(), screens: options.screens(), nodes });
    for (const el of dialog.body.querySelectorAll(".uc-field-warn")) {
      const found = currentWarnings.filter((w) => w.path === el.dataset.path);
      el.hidden = found.length === 0;
      el.textContent = found.map((w) => w.message).join(" ");
    }
    for (const el of dialog.body.querySelectorAll("[data-path]")) {
      if (el.classList.contains("uc-field-warn")) continue;
      el.classList.toggle("is-warning", currentWarnings.some((w) => w.path === el.dataset.path));
    }
    const built = buildPayload({ id: id || uniqueId(slugify(draft.title), options.takenIds()), draft, source, nameOf });
    showFieldErrors(dialog.body, built.fieldErrors ?? []);
    saveButton.disabled = saving || Boolean(built.errors);
    dialog.setMessage(built.errors ? built.errors[0] : warningSummary(currentWarnings), built.errors ? "error" : "warning");
  }

  const saveButton = h("button", { type: "button", class: "chrome-btn chrome-btn--primary", onClick: save }, mode === "new" ? "Create use case" : "Save use case");
  async function save() {
    let finalId = id || uniqueId(slugify(draft.title), options.takenIds());
    saving = true;
    saveButton.disabled = true;
    if (mode === "new") {
      // set_use_cases upserts: a "new" case whose id exists would overwrite it, so ask the daemon (the list only holds the pages loaded so far).
      const taken = async (candidate) => options.takenIds().has(candidate) || (options.exists ? await options.exists(candidate) : false);
      const base = finalId;
      // A derived id steps around taken ones; one typed by hand is refused.
      for (let n = 2; !idTouched && n < 50 && (await taken(finalId)); n++) finalId = `${base.slice(0, 76)}-${n}`;
      if (await taken(finalId)) {
        saving = false;
        saveButton.disabled = false;
        dialog.setMessage(`The id ${finalId} is already taken.`, "error");
        return;
      }
    }
    const built = buildPayload({ id: finalId, draft, source, nameOf });
    if (built.errors) {
      saving = false;
      saveButton.disabled = false;
      return;
    }
    const response = await options.save(built.payload);
    saving = false;
    if (!response.ok) {
      saveButton.disabled = false;
      dialog.setMessage(response.message, "error");
      return;
    }
    result = { id: finalId, data: response.data };
    dialog.setDirty(false);
    dialog.close(result);
  }

  dialog.body.append(
    h("div", { class: "uc-form" },
      field("Title", titleInput),
      h("div", { class: "uc-form-row" }, field("Group", groupInput), groupList, field("ID", idInput, { hint: mode === "edit" ? "fixed once used" : undefined })),
      h("div", { class: "uc-form-row" }, field("Status", statusControl), field("Tags", tagsInput, { hint: "comma separated" })),
      h("div", { class: "uc-field" }, h("span", { class: "uc-label" }, "Personas"), personaRow),
      triggerEditor.el,
      h("div", { class: "uc-form-row" }, storyArea("goal", "Goal"), storyArea("outcome", "Outcome")),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "World"), constellations.el, h("p", { class: "uc-form-note" }, "The case holds in any of these constellations. Every actor and state subject should be a member of at least one.")),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Starting state", h("span", { class: "uc-label-hint" }, " · values at the start of the case")), stateEditor.el),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Inputs and outputs", h("span", { class: "uc-label-hint" }, " · at least one of each, each with an example")), ioBox),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Steps", h("span", { class: "uc-form-h-hint" }, " · drag a handle to reorder, or focus it and press Space")), stepsBox, reorder.live),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Branches", h("span", { class: "uc-label-hint" }, " · alternative paths that fork from a step")), branchList.el),
      h("section", { class: "uc-form-section", id: "uc-variants-section" }, h("h2", { class: "uc-form-h" }, "Variants", h("span", { class: "uc-label-hint" }, " · shown as a difference against the base")), variantsBox),
    ),
  );
  dialog.setActions([{ label: "Cancel", onClick: () => dialog.requestClose() }, saveButton]);
  drawPersonas();
  drawIo();
  drawSteps();
  variantEditor.draw();
  for (const step of draft.steps) if (step.kind !== "none" && options.screens().includes(step.screen)) ensureNodes(step.screen);
  const closed = dialog.open();
  ready = true;
  refreshWarnings();
  if (options.focus?.variantId) {
    const at = draft.variants.findIndex((v) => v.id === options.focus.variantId);
    const card = variantEditor.cards()[at];
    card?.scrollIntoView?.({ block: "center" });
    card?.querySelector("input")?.focus();
  } else if (options.focus?.variants) {
    dialog.el.querySelector("#uc-variants-section")?.scrollIntoView?.({ block: "start" });
    variantEditor.cards()[draft.variants.length - 1]?.querySelector("input")?.focus();
  } else if (options.focus?.step) {
    const index = draft.steps.findIndex((s) => s.id === options.focus.step);
    const row = stepsBox.querySelectorAll(".uc-step-edit")[index];
    row?.scrollIntoView?.({ block: "center" });
    row?.querySelector("input[list]")?.focus();
  }
  await closed;
  return result;
}

