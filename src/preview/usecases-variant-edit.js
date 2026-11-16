// Use Cases tab — the structured variant editor of the use-case dialog (CHR-1109, design CHR-1103). A variant is a difference
// against the base: Overrides (trigger, goal, outcome, personas, inputs, outputs: present = overridden, "Use base" removes the key,
// never `null`), Actor swaps (the `actors` map) and Step changes (the ordered replace / insert_after / remove / append ops, each
// with the full step editor). The pure parts (variant draft <-> payload object, the flow a change sees, validation) come first and
// are exported for the tests; the DOM part (createVariantEditor) last.

import { h, icon, fill } from "./usecases-dom.js";
import { field, textInput, textArea, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { segmented, avatar, diffBadge } from "./usecases-parts.js";
import { openMenu } from "./usecases-menu.js";
import { slugify, uniqueId, isValidId, formatExample, parseOrKeep, avatarOf, actorName } from "./usecases-data.js";

// --- Draft <-> payload (pure) ---------------------------------------------------------------------------------------

const TEXT_OVERRIDES = [
  ["trigger", "Trigger"],
  ["goal", "Goal"],
  ["outcome", "Outcome"],
];

/** The draft rows of an inputs / outputs list. `orig` keeps the stored example: one the user does not touch is saved exactly as it was. */
export function ioDraft(list, sideKey) {
  return (list ?? []).map((item) => ({ object: item.object, side: item[sideKey] ?? "", example: formatExample(item.example), orig: item.example }));
}

/** The editable draft of a stored step: every field is text, ready to bind to an input. */
export function stepDraft(step) {
  return {
    id: step.id,
    actor: step.actor,
    action: step.action,
    kind: step.target ? (step.target.node ? "element" : "screen") : "none",
    screen: step.target?.screen ?? "",
    node: step.target?.node ?? "",
    note: step.note,
    data: (step.data ?? []).map((d) => ({ object: d.object, before: formatExample(d.before), after: formatExample(d.after), origBefore: d.before, origAfter: d.after })),
  };
}

export function emptyStep(actor = "system") {
  return { id: "", actor, action: "", kind: "screen", screen: "", node: "", data: [] };
}

/** A step body nothing was typed into yet (what Insert after / Append start with). */
export function isUntouched(step) {
  return step.action.trim() === "" && step.data.length === 0 && step.screen.trim() === "" && step.node.trim() === "" && !step.note;
}

function cloneStep(step) {
  return { ...step, data: step.data.map((d) => ({ ...d })) };
}

/** A new variant: nothing overridden, no swaps, no changes. */
export function blankVariant() {
  return { id: "", title: "", description: "", when: {}, overrides: {}, swaps: [], ops: [] };
}

/** The draft of a stored variant. An optional key that is present becomes an override; absent keys stay absent. */
export function variantDraft(variant) {
  const overrides = {};
  for (const [key] of TEXT_OVERRIDES) if (variant[key] !== undefined) overrides[key] = variant[key];
  if (variant.personas !== undefined) overrides.personas = [...variant.personas];
  if (variant.inputs !== undefined) overrides.inputs = ioDraft(variant.inputs, "source");
  if (variant.outputs !== undefined) overrides.outputs = ioDraft(variant.outputs, "target");
  return {
    id: variant.id,
    title: variant.title,
    description: variant.description ?? "",
    when: { ...variant.when },
    // A stored empty `steps: []` stays (a file is saved exactly as it was when nothing changed).
    hadSteps: variant.steps !== undefined,
    hadActors: variant.actors !== undefined,
    overrides,
    swaps: Object.entries(variant.actors ?? {}).map(([from, to]) => ({ from, to })),
    ops: (variant.steps ?? []).map((op) => ({ op: op.op, stepId: op.step_id ?? "", step: op.step ? stepDraft(op.step) : null })),
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
      return { object: row.object, ...(row.side.trim() ? { [sideKey]: row.side.trim() } : {}), example: parsed.ok ? parsed.value : {} };
    });
}

/** One step as a payload object (a base step or the step of a change); `label` prefixes problems with its data changes. */
export function buildStepObject(step, id, label, errors) {
  const out = { id, actor: step.actor || "system", action: step.action.trim() };
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
  return out;
}

/** The ids the changes of all variants write by hand: a generated id must not collide with them. */
export function variantStepIds(variants) {
  return variants.flatMap((variant) => variant.ops.filter((op) => op.op !== "remove").map((op) => op.step?.id).filter(Boolean));
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

/** Applies one change to a flow the way the resolver does; a change naming a step that is not there is skipped. Returns whether it applied. */
function applyOp(flow, op, step) {
  if (op.op === "append") {
    flow.push(entryOf(step));
    return true;
  }
  const at = op.stepId === "" ? -1 : flow.findIndex((entry) => entry.id === op.stepId);
  if (at < 0) return false;
  if (op.op === "remove") flow.splice(at, 1);
  else if (op.op === "replace") flow[at] = entryOf(step);
  else flow.splice(at + 1, 0, entryOf(step));
  return true;
}

/** The flow as it stands before change `count` (0-based): what its step select lists. */
export function flowBefore(baseSteps, variant, count) {
  const flow = baseFlow(baseSteps, variant.swaps);
  variant.ops.slice(0, count).forEach((op) => {
    if (op.op !== "remove" && !op.step) return;
    applyOp(flow, op, op.step);
  });
  return flow;
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
 * One variant as its payload object, with the problems that block Save. `baseSteps` are the draft's base steps, `usedStepIds` the ids
 * a generated step id must avoid. `errors` are the messages (the footer shows the first), `fieldErrors` the ones that belong to a field
 * (`path`), shown under it.
 */
export function buildVariant(variant, index, { baseSteps, usedStepIds, variantIds }) {
  const errors = [];
  const fieldErrors = [];
  const vid = variant.id || uniqueId(slugify(variant.title) || `variant-${index + 1}`, variantIds);
  variantIds.add(vid);
  const name = variant.title || vid;
  if (variant.title.trim() === "") errors.push(`Variant ${index + 1} needs a title.`);
  if (Object.keys(variant.when).length === 0) errors.push(`Variant "${name}" needs a condition (when).`);
  const out = { id: vid, title: variant.title.trim(), ...(variant.description.trim() ? { description: variant.description.trim() } : {}), when: variant.when };

  const { overrides } = variant;
  // A stored value is written back exactly as it is (no trimming); an override that is empty is an error, not a silent removal.
  for (const [key, label] of TEXT_OVERRIDES) {
    if (overrides[key] === undefined) continue;
    out[key] = overrides[key];
    if (overrides[key].trim() === "") {
      errors.push(`Variant "${name}": the ${label.toLowerCase()} override is empty.`);
      fieldErrors.push({ path: `variant.${index}.override.${key}`, message: `The ${label.toLowerCase()} override is empty. Enter text or use the base.` });
    }
  }
  if (overrides.personas !== undefined) out.personas = [...overrides.personas];
  const actors = actorsMap(variant.swaps);
  // A stored empty `actors: {}` stays, like `steps: []`.
  if (Object.keys(actors).length > 0 || variant.hadActors) out.actors = actors;
  variant.swaps.forEach((swap, j) => {
    if (swap.from !== "" && swap.from === swap.to) {
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

  const flow = baseFlow(baseSteps, variant.swaps);
  const ops = [];
  variant.ops.forEach((op, i) => {
    const where = `Variant "${name}", change ${i + 1}`;
    const path = `variant.${index}.op.${i}`;
    if (op.op !== "append" && op.stepId === "") {
      errors.push(`${where}: pick the step it changes.`);
      fieldErrors.push({ path: `${path}.pick`, message: "Pick the step this change applies to." });
    }
    if (op.op === "remove") {
      applyOp(flow, op);
      ops.push({ op: "remove", step_id: op.stepId });
      return;
    }
    const step = op.step ?? emptyStep();
    if (step.action.trim() === "") errors.push(`${where}: the step needs an action.`);
    const typed = step.id.trim();
    const id = typed || uniqueId(slugify(step.action) || `step-${i + 1}`, usedStepIds);
    usedStepIds.add(id);
    if (typed !== "" && !isValidId(typed)) {
      const message = `${typed} is not a valid id. Use lowercase letters, digits and dashes.`;
      errors.push(`${where}: ${message}`);
      fieldErrors.push({ path: `${path}.id`, message });
    }
    const at = op.stepId === "" ? -1 : flow.findIndex((entry) => entry.id === op.stepId);
    const applies = op.op === "append" || at >= 0;
    // The effective flow must not hold a second step with this id (spec §6); a replace may keep the id of the step it replaces.
    if (applies && flow.some((entry, j) => entry.id === id && !(op.op === "replace" && j === at))) {
      const message = `${id} is already a step in this flow. Give the new step another id.`;
      errors.push(`${where}: ${id} is already a step in this flow.`);
      fieldErrors.push({ path: `${path}.id`, message });
    }
    const built = buildStepObject(step, id, where, errors);
    applyOp(flow, op, built);
    ops.push(op.op === "append" ? { op: "append", step: built } : { op: op.op, step_id: op.stepId, step: built });
  });
  if (ops.length > 0 || variant.hadSteps) out.steps = ops;
  return { out, errors, fieldErrors };
}

/** Reference problems of one variant (warnings, never blocking): a change naming a step that is not in the flow at that point, an unknown persona in a swap. */
export function variantWarnings({ variant, index, baseSteps, pool }) {
  const warnings = [];
  variant.ops.forEach((op, i) => {
    if (op.op === "append" || op.stepId === "") return;
    if (!flowBefore(baseSteps, variant, i).some((entry) => entry.id === op.stepId)) {
      warnings.push({ path: `variant.${index}.op.${i}.step`, message: `${op.stepId} is not a step of the flow at this point. This change is skipped; you can still save.` });
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
  for (const hint of root.querySelectorAll(".uc-field-error")) {
    const found = fieldErrors.filter((e) => e.path === hint.dataset.path);
    hint.hidden = found.length === 0;
    hint.textContent = found.map((e) => e.message).join(" ");
  }
  for (const el of root.querySelectorAll("[data-error-path]")) {
    const bad = fieldErrors.some((e) => e.path === el.dataset.errorPath);
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

// --- The editor (DOM) -------------------------------------------------------------------------------------------------

const OP_LABELS = { replace: "Replace", insert_after: "Insert after", remove: "Remove", append: "Append" };

/**
 * @param {{
 *   draft: Record<string, any>,
 *   pool: () => any,
 *   screens: () => string[],
 *   ensureNodes: (screen: string) => Promise<string[]> | undefined,
 *   objectOptions: () => { value: string, label: string }[],
 *   actorOptions: (current: string) => { value: string, label: string }[],
 *   markDirty: () => void,
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
  function stepBody(step, variantIndex, opIndex, onEdit) {
    const path = `variant.${variantIndex}.op.${opIndex}`;
    const label = `Variant ${variantIndex + 1} change ${opIndex + 1}`;
    const screenListId = nextId("uc-screens");
    const nodeListId = nextId("uc-nodes");
    const nodeList = h("datalist", { id: nodeListId });
    const fillNodes = (screen) => env.ensureNodes(screen)?.then((list) => nodeList.replaceChildren(...(list ?? []).slice(0, 400).map((n) => h("option", { value: n }, n))));
    const idHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `${path}.id` } });
    const idInput = textInput({ value: step.id, mono: true, placeholder: "step id", ariaLabel: `${label} step id`, onInput: (value) => { step.id = value; markDirty(); onEdit(); } });
    idInput.dataset.errorPath = `${path}.id`;
    idInput.dataset.hint = idHint.id;
    const actionInput = textInput({ value: step.action, placeholder: "What happens", ariaLabel: `${label} action`, onInput: (value) => { step.action = value; markDirty(); onEdit(); } });
    const screenInput = textInput({ value: step.screen, list: screenListId, placeholder: "screen", mono: true, ariaLabel: `${label} screen`, onInput: (value) => { step.screen = value; markDirty(); if (env.screens().includes(value.trim())) fillNodes(value.trim()); } });
    const nodeInput = textInput({ value: step.node, list: nodeListId, placeholder: "element id", mono: true, ariaLabel: `${label} element`, onInput: (value) => { step.node = value; markDirty(); } });
    const targetRow = h("div", { class: "uc-target-edit" });
    const drawTarget = () => {
      fill(targetRow,
        segmented({ label: `${label} target`, name: `kind-${variantIndex}-${opIndex}`, value: step.kind, options: [{ value: "screen", label: "Screen" }, { value: "element", label: "Element" }, { value: "none", label: "None" }], onChange: (value) => { step.kind = value; markDirty(); drawTarget(); } }),
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
            textInput({ value: d.before, mono: true, placeholder: "status: draft", ariaLabel: `${label} data ${j + 1} before`, onInput: (value) => { d.before = value; markDirty(); } }),
            icon("arrow_forward", "uc-data-arrow"),
            textInput({ value: d.after, mono: true, placeholder: "status: ready", ariaLabel: `${label} data ${j + 1} after`, onInput: (value) => { d.after = value; markDirty(); } }),
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
      h("div", { class: "uc-op-fields" }, idInput, selectInput({ options: env.actorOptions(step.actor), value: step.actor || "system", ariaLabel: `${label} actor`, onChange: (value) => { step.actor = value; markDirty(); } }), actionInput),
      idHint,
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

    const ROWS = [
      ...TEXT_OVERRIDES.map(([key, label]) => ({ key, label, baseText: () => baseText(draft[key]) })),
      { key: "personas", label: "Personas", baseText: personaText },
      { key: "inputs", label: "Inputs", baseText: () => ioSummary(draft.inputs) },
      { key: "outputs", label: "Outputs", baseText: () => ioSummary(draft.outputs) },
    ];

    function editorFor(spec) {
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
      if (TEXT_OVERRIDES.some(([k]) => k === key)) variant.overrides[key] = draft[key];
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
          toSel.dataset.path = `variant.${index}.swap.${j}.to`;
          toSel.dataset.errorPath = `variant.${index}.swap.${j}`;
          toSel.dataset.hint = same.id;
          return h(
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
        }),
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { variant.swaps.push({ from: "", to: "" }); markDirty(); drawSwaps(true); } }, icon("add"), "Actor swap"),
      );
      syncSwaps();
      if (focusLast) [...swapBox.querySelectorAll(".uc-swap-row")].at(-1)?.querySelector("select")?.focus();
      env.refresh();
    };
    drawSwaps();

    // --- Step changes ---
    const opsBox = h("div", { class: "uc-ops-edit" });
    const fillStepOptions = (select, op, i) => {
      const flow = flowBefore(baseSteps(), variant, i);
      const options = [{ value: "", label: "Step…" }, ...flow.flatMap((entry, k) => (entry.id === "" ? [] : [{ value: entry.id, label: `${k + 1} · ${entry.action || "(no action yet)"}` }]))];
      if (op.stepId !== "" && !options.some((o) => o.value === op.stepId)) options.push({ value: op.stepId, label: `${op.stepId} (unknown)` });
      select.replaceChildren(...options.map((o) => h("option", { value: o.value }, o.label)));
      select.value = op.stepId;
    };
    let stepSelects = [];
    /** Re-lists the flow in every change's step select. Called when the changes or the base change, never on focus (that would rewrite an open select). */
    const refreshOptions = () => stepSelects.forEach(({ select, op, i }) => fillStepOptions(select, op, i));
    const drawOps = (focus = null) => {
      stepSelects = [];
      fill(opsBox,
        variant.ops.length === 0 ? h("p", { class: "uc-muted uc-var-empty" }, `None. This variant runs the ${baseSteps().length} base steps as they are.`) : null,
        ...variant.ops.map((op, i) => {
          const label = `Variant ${n} change ${i + 1}`;
          const kindSel = selectInput({ options: Object.entries(OP_LABELS).map(([value, text]) => ({ value, label: text })), value: op.op, ariaLabel: `${label} operation`, onChange: (value) => changeKind(op, i, value) });
          let stepControl;
          if (op.op === "append") stepControl = h("span", { class: "uc-op-after-last" }, "after the last step");
          else {
            stepControl = h("select", { class: "chrome-field uc-select", "aria-label": `${label} step`, dataset: { path: `variant.${index}.op.${i}.step`, role: "step" } });
            fillStepOptions(stepControl, op, i);
            stepSelects.push({ select: stepControl, op, i });
            stepControl.dataset.errorPath = `variant.${index}.op.${i}.pick`;
            stepControl.addEventListener("change", () => pickStep(op, i, stepControl.value));
          }
          const warn = h("p", { class: "uc-field-warn", id: nextId("uc-warn"), hidden: true, dataset: { path: `variant.${index}.op.${i}.step` } });
          const pickErr = h("p", { class: "uc-field-error uc-op-hint", id: nextId("uc-err"), hidden: true, dataset: { path: `variant.${index}.op.${i}.pick` } });
          warn.classList.add("uc-op-hint");
          if (stepControl.tagName === "SELECT") stepControl.dataset.hint = `${pickErr.id} ${warn.id}`;
          let body = null;
          if (op.op === "remove") {
            const entry = flowBefore(baseSteps(), variant, i).find((e) => e.id === op.stepId);
            body = h(
              "div",
              { class: "uc-op-removed" },
              diffBadge("removed"),
              entry ? h("span", { class: "uc-op-struck" }, [actorName(entry.baseActor, pool.personasById), entry.action, entry.step.screen].filter(Boolean).join(" · ")) : h("span", { class: "uc-muted" }, "Pick the step to remove."),
            );
          } else if (op.step) body = stepBody(op.step, index, i, refreshOptions);
          return h(
            "div",
            { class: "uc-step-op", dataset: { op: op.op, index: String(i) } },
            h("div", { class: "uc-op-top" }, kindSel, stepControl, removeButton(`Remove change ${i + 1} of variant ${n}`, () => { variant.ops.splice(i, 1); markDirty(); drawOps(); })),
            pickErr,
            warn,
            body,
          );
        }),
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { variant.ops.push({ op: "replace", stepId: "", step: null }); markDirty(); drawOps({ index: variant.ops.length - 1 }); } }, icon("add"), "Step change"),
      );
      if (focus) opsBox.querySelectorAll(".uc-step-op")[focus.index]?.querySelector(focus.part === "step" ? "[data-role=step]" : "select")?.focus();
      env.refresh();
    };
    /** A new id for a step a change adds: unique in the flow at that point and among every id the case already has. */
    const freshId = (i) => {
      const taken = new Set([...flowBefore(baseSteps(), variant, i).map((e) => e.id), ...baseSteps().map((s) => s.id), ...variantStepIds(draft.variants)].filter(Boolean));
      return uniqueId("new-step", taken);
    };
    const newBody = (i) => ({ ...emptyStep(draft.personas[0] ?? "system"), id: freshId(i) });
    /** The flow entry a replace starts from: its whole step, carrying the actor the swaps give it. */
    const prefill = (op, i) => {
      const entry = flowBefore(baseSteps(), variant, i).find((e) => e.id === op.stepId);
      return entry ? { ...cloneStep(entry.step), actor: entry.actor } : null;
    };
    function pickStep(op, i, value) {
      op.stepId = value;
      // A pick fills the body from that step while nothing was typed into it; later picks keep what was typed.
      if (op.op === "replace" && (!op.step || isUntouched(op.step))) op.step = prefill(op, i);
      markDirty();
      drawOps({ index: i, part: "step" });
    }
    function changeKind(op, i, value) {
      op.op = value;
      if (value === "replace") {
        if (!op.step || isUntouched(op.step)) op.step = op.stepId !== "" ? prefill(op, i) : null;
      } else if ((value === "insert_after" || value === "append") && !op.step) op.step = newBody(i);
      markDirty();
      drawOps({ index: i });
    }
    drawOps();
    syncers.push(() => {
      for (const spec of ROWS) if (variant.overrides[spec.key] === undefined) drawRow(spec.key);
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
      section("Actor swaps", "applied once to the inherited base steps, before the step changes; not chained", swapBox),
      section("Step changes", "applied in order, top to bottom", opsBox),
    );
  }

  return { el: box, draw, syncBase: () => syncers.forEach((sync) => sync()), cards: () => [...box.querySelectorAll(".uc-variant-edit")] };
}
