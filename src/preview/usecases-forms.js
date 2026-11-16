// Use Cases tab — the create/edit dialog of a use case: title, group, status, tags, personas, trigger / goal /
// outcome, inputs and outputs with example values, steps with a target picker (screen / element / none) and before/after
// data, and variants (title, id, when, plus the remaining overrides as JSON). Saved through set_use_cases (the MCP tool);
// reference problems are warnings, shown live in the footer and never blocking. The pure parts (draft <-> payload, the
// warnings) are exported for the tests.

import { h, icon, fill } from "./usecases-dom.js";
import { createDialog, field, textInput, textArea, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { segmented, avatar } from "./usecases-parts.js";
import { openMenu } from "./usecases-menu.js";
import {
  STATUSES,
  STATUS_LABELS,
  slugify,
  uniqueId,
  isValidId,
  formatExample,
  parseExample,
  parseOrKeep,
  undeclaredExampleKeys,
  avatarOf,
  actorName,
  warningSummary,
} from "./usecases-data.js";

// --- Draft <-> payload (pure) ---------------------------------------------------------------------------------------

const VARIANT_BASE_KEYS = ["id", "title", "description", "when"];

/** The editable draft of a stored use case (or an empty one): every field is text, ready to bind to an input. */
export function draftFromSource(source) {
  const s = source ?? {};
  // `orig` keeps the stored object: an example the user does not touch is saved exactly as it was, never re-read from text.
  const io = (list, sideKey) => (list ?? []).map((item) => ({ object: item.object, side: item[sideKey] ?? "", example: formatExample(item.example), orig: item.example }));
  return {
    title: s.title ?? "",
    group: s.group ?? "",
    status: s.status ?? "draft",
    tags: (s.tags ?? []).join(", "),
    personas: [...(s.personas ?? [])],
    trigger: s.trigger ?? "",
    goal: s.goal ?? "",
    outcome: s.outcome ?? "",
    inputs: io(s.inputs, "source"),
    outputs: io(s.outputs, "target"),
    steps: (s.steps ?? []).map((step) => ({
      id: step.id,
      actor: step.actor,
      action: step.action,
      kind: step.target ? (step.target.node ? "element" : "screen") : "none",
      screen: step.target?.screen ?? "",
      node: step.target?.node ?? "",
      note: step.note,
      data: (step.data ?? []).map((d) => ({ object: d.object, before: formatExample(d.before), after: formatExample(d.after), origBefore: d.before, origAfter: d.after })),
    })),
    variants: (s.variants ?? []).map((variant) => {
      const rest = Object.fromEntries(Object.entries(variant).filter(([key]) => !VARIANT_BASE_KEYS.includes(key)));
      return { id: variant.id, title: variant.title, description: variant.description ?? "", when: { ...variant.when }, rest: Object.keys(rest).length === 0 ? "" : JSON.stringify(rest, null, 2) };
    }),
  };
}

function parseIo(list, sideKey, label, errors) {
  // The number is the row's position in the unfiltered list, the one aria-label and the remove button show.
  return list
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.object !== "")
    .map(({ row, index }) => {
      const parsed = parseOrKeep(row.example, row.orig);
      if (!parsed.ok) errors.push(`${label} ${index + 1}: ${parsed.error}`);
      else if (Object.keys(parsed.value).length === 0) errors.push(`${label} ${index + 1}: the example needs at least one key.`);
      return { object: row.object, ...(row.side.trim() ? { [sideKey]: row.side.trim() } : {}), example: parsed.ok ? parsed.value : {} };
    });
}

/**
 * The set_use_cases entity for a draft. `source` is the stored case when editing: cleared optional fields become null (the tool's
 * "remove this key"), `variants` is only sent when it changed. Returns { errors } when the draft cannot be sent at all.
 */
export function buildPayload({ id, draft, source }) {
  const errors = [];
  if (draft.title.trim() === "") errors.push("A title is required.");
  if (!isValidId(id)) errors.push("The id must be lowercase kebab-case (a-z, 0-9, -).");
  const inputs = parseIo(draft.inputs, "source", "Input", errors);
  const outputs = parseIo(draft.outputs, "target", "Output", errors);
  if (inputs.length === 0) errors.push("Add at least one input with an example.");
  if (outputs.length === 0) errors.push("Add at least one output with an example.");

  // Generated ids must not collide with ANY id the case already has: every step, every variant, and the steps variants add.
  const variantStepIds = draft.variants.flatMap((variant) => {
    try {
      const ops = variant.rest.trim() === "" ? [] : (JSON.parse(variant.rest).steps ?? []);
      return ops.map((op) => op?.step?.id).filter(Boolean);
    } catch {
      return [];
    }
  });
  const usedStepIds = new Set([...draft.steps.map((s) => s.id).filter(Boolean), ...variantStepIds]);
  const steps = draft.steps.map((step, index) => {
    const stepId = step.id || uniqueId(slugify(step.action) || `step-${index + 1}`, usedStepIds);
    usedStepIds.add(stepId);
    const out = { id: stepId, actor: step.actor || "system", action: step.action.trim() };
    if (out.action === "") errors.push(`Step ${index + 1} needs an action.`);
    if (step.kind !== "none" && step.screen.trim() !== "") out.target = { screen: step.screen.trim(), ...(step.kind === "element" && step.node.trim() !== "" ? { node: step.node.trim() } : {}) };
    const data = step.data
      .filter((d) => d.object !== "")
      .map((d) => {
        const before = parseOrKeep(d.before, d.origBefore);
        const after = parseOrKeep(d.after, d.origAfter);
        if (!before.ok) errors.push(`Step ${index + 1} data (before): ${before.error}`);
        if (!after.ok) errors.push(`Step ${index + 1} data (after): ${after.error}`);
        return { object: d.object, ...(d.before.trim() !== "" && before.ok ? { before: before.value } : {}), ...(d.after.trim() !== "" && after.ok ? { after: after.value } : {}) };
      });
    if (data.length > 0) out.data = data;
    if (step.note) out.note = step.note;
    return out;
  });

  const variantIds = new Set(draft.variants.map((v) => v.id).filter(Boolean));
  const variants = draft.variants.map((variant, index) => {
    const vid = variant.id || uniqueId(slugify(variant.title) || `variant-${index + 1}`, variantIds);
    variantIds.add(vid);
    let rest = {};
    if (variant.rest.trim() !== "") {
      try {
        rest = JSON.parse(variant.rest);
        if (rest === null || typeof rest !== "object" || Array.isArray(rest)) throw new Error("not an object");
      } catch {
        errors.push(`Variant "${variant.title || vid}": the overrides are not a JSON object.`);
        rest = {};
      }
    }
    if (variant.title.trim() === "") errors.push(`Variant ${index + 1} needs a title.`);
    if (Object.keys(variant.when).length === 0) errors.push(`Variant "${variant.title || vid}" needs a condition (when).`);
    const out = { id: vid, title: variant.title.trim(), ...(variant.description.trim() ? { description: variant.description.trim() } : {}), when: variant.when, ...rest };
    return out;
  });

  if (errors.length > 0) return { errors };

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
    ...optional("trigger", text(draft.trigger), source?.trigger !== undefined),
    ...optional("goal", text(draft.goal), source?.goal !== undefined),
    ...optional("outcome", text(draft.outcome), source?.outcome !== undefined),
  };
  const before = JSON.stringify(source?.variants ?? []);
  if (JSON.stringify(variants) !== before) {
    if (variants.length > 0) payload.variants = variants;
    else if (source?.variants !== undefined) payload.variants = null;
  }
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

  const markDirty = () => {
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
      const exampleInput = textInput({ value: row.example, mono: true, placeholder: "screen: usecases-detail, node: btn-mapping", ariaLabel: `${kind === "inputs" ? "Input" : "Output"} ${index + 1} example`, onInput: (value) => { row.example = value; markDirty(); } });
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
  const drawSteps = (focusIndex = null) => {
    stepsBox.replaceChildren();
    draft.steps.forEach((step, index) => {
      const screenListId = nextId("uc-screens");
      const nodeListId = nextId("uc-nodes");
      const nodeList = h("datalist", { id: nodeListId });
      const fillNodes = (screen) => ensureNodes(screen)?.then((list) => nodeList.replaceChildren(...(list ?? []).slice(0, 400).map((n) => h("option", { value: n }, n))));
      const warnScreen = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${index}.screen` } });
      const warnNode = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${index}.node` } });
      const screenInput = textInput({ value: step.screen, list: screenListId, placeholder: "screen", mono: true, ariaLabel: `Step ${index + 1} screen`, onInput: (value) => { step.screen = value; markDirty(); if (options.screens().includes(value.trim())) fillNodes(value.trim()); } });
      const nodeInput = textInput({ value: step.node, list: nodeListId, placeholder: "element id", mono: true, ariaLabel: `Step ${index + 1} element`, onInput: (value) => { step.node = value; markDirty(); } });
      screenInput.dataset.path = `step.${index}.screen`;
      nodeInput.dataset.path = `step.${index}.node`;
      const targetRow = h("div", { class: "uc-target-edit" });
      const drawTarget = () => {
        fill(targetRow,
          segmented({ label: `Step ${index + 1} target`, name: `kind-${index}`, value: step.kind, options: [{ value: "screen", label: "Screen" }, { value: "element", label: "Element" }, { value: "none", label: "None" }], onChange: (value) => { step.kind = value; markDirty(); drawTarget(); } }),
          step.kind !== "none" ? screenInput : null,
          step.kind === "element" ? nodeInput : null,
          step.kind !== "none" ? h("datalist", { id: screenListId }, options.screens().map((s) => h("option", { value: s }))) : null,
          step.kind === "element" ? nodeList : null,
        );
      };
      drawTarget();
      if (step.kind === "element" && options.screens().includes(step.screen)) fillNodes(step.screen);

      const dataBox = h("div", { class: "uc-step-data-edit" });
      const drawData = () => {
        dataBox.replaceChildren(
          ...step.data.map((d, j) => {
            const warn = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${index}.data.${j}.after` } });
            const beforeWarn = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `step.${index}.data.${j}.before` } });
            return h(
              "div",
              { class: "uc-data-edit" },
              selectInput({ options: objectOptions(), value: d.object, ariaLabel: "Data object", onChange: (value) => { d.object = value; markDirty(); } }),
              textInput({ value: d.before, mono: true, placeholder: "scope: screen", ariaLabel: `Step ${index + 1} data ${j + 1} before`, onInput: (value) => { d.before = value; markDirty(); } }),
              icon("arrow_forward", "uc-data-arrow"),
              textInput({ value: d.after, mono: true, placeholder: "node: btn-mapping, scope: element", ariaLabel: `Step ${index + 1} data ${j + 1} after`, onInput: (value) => { d.after = value; markDirty(); } }),
              removeButton("Remove data change", () => { step.data.splice(j, 1); markDirty(); drawData(); }),
              beforeWarn,
              warn,
            );
          }),
          h("button", { type: "button", class: "uc-link-btn", onClick: () => { step.data.push({ object: "", before: "", after: "" }); markDirty(); drawData(); } }, icon("add"), "Data change"),
        );
      };
      drawData();

      const move = (delta) => {
        const to = index + delta;
        if (to < 0 || to >= draft.steps.length) return;
        [draft.steps[index], draft.steps[to]] = [draft.steps[to], draft.steps[index]];
        markDirty();
        drawSteps(to);
      };
      const actionInput = textInput({ value: step.action, placeholder: "What happens", ariaLabel: `Step ${index + 1} action`, onInput: (value) => { step.action = value; markDirty(); } });
      stepsBox.append(
        h(
          "div",
          { class: "uc-step-edit", dataset: { index: String(index), step: step.id ?? "" } },
          h("div", { class: "uc-step-edit-top" }, h("span", { class: "uc-step-edit-no" }, String(index + 1)), selectInput({ options: actorOptions(step.actor), value: step.actor || "system", ariaLabel: `Step ${index + 1} actor`, onChange: (value) => { step.actor = value; markDirty(); } }), actionInput, h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": `Move step ${index + 1} up`, title: "Move up", disabled: index === 0, onClick: () => move(-1) }, icon("arrow_upward")), h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": `Move step ${index + 1} down`, title: "Move down", disabled: index === draft.steps.length - 1, onClick: () => move(1) }, icon("arrow_downward")), removeButton(`Remove step ${index + 1}`, () => { draft.steps.splice(index, 1); markDirty(); drawSteps(); })),
          targetRow,
          warnScreen,
          warnNode,
          dataBox,
        ),
      );
    });
    stepsBox.append(h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.steps.push({ id: "", actor: draft.personas[0] ?? "system", action: "", kind: "screen", screen: "", node: "", data: [] }); markDirty(); drawSteps(draft.steps.length - 1); } }, icon("add"), "Step"));
    if (focusIndex !== null) stepsBox.querySelectorAll(".uc-step-edit")[focusIndex]?.querySelector("input")?.focus();
  };

  // --- Variants -----------------------------------------------------------------------------------------------
  const variantsBox = h("div", { class: "uc-variants-edit" });
  const drawVariants = (focusIndex = null) => {
    const pool = options.pool();
    variantsBox.replaceChildren();
    draft.variants.forEach((variant, index) => {
      const whenBox = h("div", { class: "uc-when-edit" });
      const drawWhen = () => {
        fill(whenBox,
          ...pool.dimensions.map((dimension) =>
            h(
              "div",
              { class: "uc-when-dim-edit" },
              h("span", { class: "uc-when-dim" }, dimension.label),
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
      const titleField = textInput({ value: variant.title, placeholder: "Large project: map from the list", ariaLabel: `Variant ${index + 1} title`, onInput: (value) => { variant.title = value; markDirty(); } });
      variantsBox.append(
        h(
          "div",
          { class: "uc-variant-edit", dataset: { index: String(index) } },
          h("div", { class: "uc-variant-edit-top" }, field("Title", titleField), field("ID", textInput({ value: variant.id, mono: true, readonly: Boolean(variant.id), placeholder: "from the title", onInput: (value) => { variant.id = value; markDirty(); } })), removeButton(`Remove variant ${index + 1}`, () => { draft.variants.splice(index, 1); markDirty(); drawVariants(); })),
          field("Description", textInput({ value: variant.description, ariaLabel: `Variant ${index + 1} description`, onInput: (value) => { variant.description = value; markDirty(); } })),
          field("Applies when", whenBox, { hint: "any of the chosen values per dimension; every listed dimension must match" }),
          field("Other overrides (JSON)", textArea({ value: variant.rest, rows: 5, placeholder: '{ "steps": [ { "op": "replace", "step_id": "…", "step": { … } } ], "outputs": [ … ] }', onInput: (value) => { variant.rest = value; markDirty(); } }), { hint: "personas, trigger, goal, outcome, inputs, outputs, steps (replace | insert_after | remove | append)" }),
        ),
      );
    });
    variantsBox.append(h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.variants.push({ id: "", title: "", description: "", when: {}, rest: "" }); markDirty(); drawVariants(draft.variants.length - 1); } }, icon("add"), "Variant"));
    if (focusIndex !== null) variantsBox.querySelectorAll(".uc-variant-edit")[focusIndex]?.querySelector("input")?.focus();
  };

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
    const built = buildPayload({ id: id || uniqueId(slugify(draft.title), options.takenIds()), draft, source });
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
    const built = buildPayload({ id: finalId, draft, source });
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
      h("div", { class: "uc-form-row is-three" }, storyArea("trigger", "Trigger"), storyArea("goal", "Goal"), storyArea("outcome", "Outcome")),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Inputs and outputs", h("span", { class: "uc-label-hint" }, " · at least one of each, each with an example")), ioBox),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Steps"), stepsBox),
      h("section", { class: "uc-form-section", id: "uc-variants-section" }, h("h2", { class: "uc-form-h" }, "Variants", h("span", { class: "uc-label-hint" }, " · shown as a difference against the base")), variantsBox),
    ),
  );
  dialog.setActions([{ label: "Cancel", onClick: () => dialog.requestClose() }, saveButton]);
  drawPersonas();
  drawIo();
  drawSteps();
  drawVariants();
  for (const step of draft.steps) if (step.kind !== "none" && options.screens().includes(step.screen)) ensureNodes(step.screen);
  const closed = dialog.open();
  refreshWarnings();
  if (options.focus?.variantId) {
    const at = draft.variants.findIndex((v) => v.id === options.focus.variantId);
    const card = variantsBox.querySelectorAll(".uc-variant-edit")[at];
    card?.scrollIntoView?.({ block: "center" });
    card?.querySelector("textarea")?.focus();
  } else if (options.focus?.variants) {
    dialog.el.querySelector("#uc-variants-section")?.scrollIntoView?.({ block: "start" });
    variantsBox.querySelectorAll(".uc-variant-edit")[draft.variants.length - 1]?.querySelector("input")?.focus();
  } else if (options.focus?.step) {
    const index = draft.steps.findIndex((s) => s.id === options.focus.step);
    const row = stepsBox.querySelectorAll(".uc-step-edit")[index];
    row?.scrollIntoView?.({ block: "center" });
    row?.querySelector("input[list]")?.focus();
  }
  await closed;
  return result;
}

