// Use Cases tab — the world sections of the case dialog (ADR-011, CHR-1154): the trigger in its three forms (text, action, state or
// time), the constellations the case holds in, and the list of its branches (each edited in the branch dialog). The variant editor
// reuses the trigger editor and the constellation chips for its own overrides (usecases-variant-world.js).

import { h, icon, fill } from "./usecases-dom.js";
import { field, textInput, textArea, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { segmented } from "./usecases-parts.js";
import { openMenu } from "./usecases-menu.js";
import { conditionRows } from "./usecases-forms-rows.js";
import { conditionChip, timeChip } from "./usecases-world-parts.js";
import { openBranchDialog } from "./usecases-forms-branch.js";
import { blankBranch, buildConditions, isIsoAt, AT_ERROR } from "./usecases-world-edit.js";
import { numberBranches } from "./usecases-world-data.js";
import { baseModel, placesIn } from "./usecases-variant-edit.js";
import { slugify, uniqueId, plural } from "./usecases-data.js";

// --- Trigger ----------------------------------------------------------------------------------------------------------

const TRIGGER_HINTS = {
  text: "A sentence, as before. Pick Action or State to give the trigger a structure.",
  action: "Someone does something that starts the case.",
  state: "The case starts when the world is in a state, or at a time.",
};

/**
 * The trigger editor: a segmented control (Text, Action, State or time) and the fields of the chosen form. The text is the trigger's own
 * `text` in every form. Switching the form keeps what was typed, so nothing is lost by looking; what is saved follows the form
 * (see buildTrigger).
 * @param {{ read: () => string, write: (text: string) => void, shape: Record<string, any>, pool: () => any, actorOptions: (current: string) => { value: string, label: string }[], path: string, label: string, markDirty: () => void, refresh: () => void }} spec
 */
export function createTriggerEditor({ read, write, shape, pool, actorOptions, path, label, markDirty, refresh, empty = null }) {
  const box = h("fieldset", { class: "uc-trigger-edit" });
  const body = h("div", { class: "uc-trigger-body" });
  const hintEl = h("span", { class: "uc-form-note" });
  const mode = segmented({ label: `${label} form`, name: nextId("uc-trigger-kind"), value: shape.kind, options: [{ value: "text", label: "Text" }, { value: "action", label: "Action" }, { value: "state", label: "State or time" }], onChange: (value) => { shape.kind = value; markDirty(); draw(); } });
  const errorHint = (suffix) => h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `${path}.${suffix}` } });
  const bound = (el, suffix, hintNode) => {
    el.dataset.errorPath = `${path}.${suffix}`;
    el.dataset.hint = hintNode.id;
    return el;
  };
  let conditions = null;
  /** The text control of the form owns the "empty override" error of a variant, when there is one. */
  const textControl = (el) => {
    if (empty) {
      el.dataset.errorPath = empty.path;
      el.dataset.hint = empty.hint.id;
    }
    return el;
  };

  function drawPreview(target) {
    const ready = shape.conditions.filter((c) => c.subject !== "" && c.property.trim() !== "" && c.value.trim() !== "");
    const errors = [];
    const built = buildConditions(ready, { path: "x", label: "x", errors, fieldErrors: [] });
    const at = shape.at.trim();
    const chips = [...built.flatMap((c, i) => [i > 0 ? h("span", { class: "uc-cond-and" }, "and") : null, conditionChip(c)]), at !== "" && isIsoAt(at) ? timeChip(at) : null];
    fill(target, h("span", { class: "uc-label-hint" }, "Trigger line in the detail"), h("div", { class: "uc-trigger-line" }, read().trim() !== "" ? h("span", { class: "uc-trigger-text" }, read().trim()) : null, ...chips));
  }

  function draw() {
    hintEl.textContent = TRIGGER_HINTS[shape.kind];
    conditions = null;
    if (shape.kind === "text") {
      fill(body, textControl(textArea({ value: read(), rows: 3, ariaLabel: `${label} text`, onInput: (value) => { write(value); markDirty(); } })));
    } else if (shape.kind === "action") {
      const viaHint = errorHint("via");
      const via = bound(textInput({ value: shape.via, placeholder: "webhook", ariaLabel: `${label} via`, onInput: (value) => { shape.via = value; markDirty(); } }), "via", viaHint);
      const actor = selectInput({ options: [{ value: "", label: "Actor…" }, ...actorOptions(shape.actor).filter((o) => o.value !== "system")], value: shape.actor, ariaLabel: `${label} actor`, onChange: (value) => { shape.actor = value; markDirty(); } });
      actor.dataset.path = `${path}.actor`;
      fill(
        body,
        h("div", { class: "uc-trigger-action" }, field("Actor", actor), field("What happens", textControl(textInput({ value: read(), placeholder: "sends the renewal notice", ariaLabel: `${label} what happens`, onInput: (value) => { write(value); markDirty(); } }))), field("Via", via, { hint: "optional" })),
        viaHint,
        h("p", { class: "uc-warn-text uc-field-warn", hidden: true, dataset: { path: `${path}.actor` } }),
        h("p", { class: "uc-form-note" }, "Via names the channel and needs an actor. Personas only: an entity cannot act."),
      );
    } else {
      const atHint = errorHint("at");
      const preview = h("div", { class: "uc-trigger-preview" });
      const at = bound(textInput({ value: shape.at, mono: true, placeholder: "2027-01-01", ariaLabel: `${label} at`, onInput: (value) => { shape.at = value; markDirty(); drawPreview(preview); } }), "at", atHint);
      conditions = conditionRows({ rows: shape.conditions, pool, path: `${path}.state`, label: "Condition", markDirty: () => { markDirty(); drawPreview(preview); }, refresh });
      fill(
        body,
        field("Description", textControl(textInput({ value: read(), placeholder: "The renewal date is reached and nobody has cancelled", ariaLabel: `${label} description`, onInput: (value) => { write(value); markDirty(); drawPreview(preview); } }))),
        h("div", { class: "uc-field" }, h("span", { class: "uc-label" }, "When all of these hold"), conditions.el),
        field("At", at, { hint: "optional date or time" }),
        atHint,
        h("p", { class: "uc-form-note" }, 'Shown as "from 2027-01-01" on the trigger line. State and time can be combined. No actor here: the world starts this case, not a persona.'),
        preview,
      );
      drawPreview(preview);
    }
    refresh();
  }

  box.append(h("legend", { class: "uc-form-h" }, label), h("div", { class: "uc-trigger-mode" }, mode, hintEl), body);
  draw();
  return { el: box, redraw: draw, atError: AT_ERROR };
}

// --- Constellations ------------------------------------------------------------------------------------------------------

/** The constellation chips of a list (the case's, or a variant's own) with a remove button each, and "Add constellation". Unknown ids stay and carry a warning (`path.<id>`). */
export function constellationChips({ list, pool, path, markDirty, onChange, label }) {
  const row = h("div", { class: "uc-chip-row uc-cst-chips" });
  const warnLines = h("div", { class: "uc-cst-warns" });
  const add = h("button", { type: "button", class: "uc-link-btn", "aria-haspopup": "menu", "aria-expanded": "false" }, icon("add"), "Add constellation");
  const draw = () => {
    const known = new Map((pool().world?.constellations ?? []).map((c) => [c.id, c]));
    fill(
      row,
      ...list.map((id) =>
        h("span", { class: `uc-person-chip uc-cst-chip${known.has(id) ? "" : " is-unknown"}`, dataset: { constellation: id } }, icon(known.has(id) ? "hub" : "warning"), known.has(id) ? known.get(id).name : h("span", { class: "uc-mono" }, id), removeButton(`Remove ${known.get(id)?.name ?? id}${label ? ` from ${label}` : ""}`, () => { list.splice(list.indexOf(id), 1); draw(); markDirty(); onChange?.(); })),
      ),
      add,
    );
    // One warning line per unknown constellation; the dialog's warning pass fills them (path `<path>.<id>`) and shows them while they have text.
    fill(warnLines, ...list.map((id) => h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `${path}.${id}` } })));
  };
  add.addEventListener("click", () => {
    const all = pool().world?.constellations ?? [];
    const items = all.filter((c) => !list.includes(c.id)).map((c) => ({ value: c.id, label: c.name, leading: icon("hub") }));
    openMenu({ anchor: add, label: "Constellations", items, filterable: true, emptyText: all.length === 0 ? "The world has no constellations yet. Create one in World." : "Every constellation is already added.", onPick: (value) => { list.push(value); draw(); markDirty(); onChange?.(); } });
  });
  draw();
  return { el: h("div", { class: "uc-cst-picker" }, row, warnLines), redraw: draw };
}

// --- Branches -----------------------------------------------------------------------------------------------------------

/** Gives every base step without an id the id a save would give it, so a branch can fork after it and the id stays put. */
export function ensureStepIds(draft) {
  const used = new Set([...draft.steps.map((s) => s.id), ...draft.branches.flatMap((b) => b.steps.map((s) => s.id)), ...draft.variants.flatMap((v) => v.ops.flatMap((op) => [op.step?.id, ...(op.branch?.steps ?? []).map((s) => s.id)]))].filter(Boolean));
  draft.steps.forEach((step, i) => {
    if (step.id !== "") return;
    step.id = uniqueId(slugify(step.action) || `step-${i + 1}`, used);
    used.add(step.id);
  });
}

/** One line under a branch row: where it forks, how many conditions and steps, where it goes on. */
export function branchMeta(branch, mains) {
  const at = branch.from === "" ? "before the first step" : `after step ${mains.findIndex((s) => s.id === branch.from) + 1}`;
  const end = branch.ends ? "ends the case" : `continues at step ${mains.findIndex((s) => s.id === branch.rejoin) + 1}`;
  return `${at} · ${plural(branch.when.length, "condition")} · ${plural(branch.steps.length, "step")} · ${end}`;
}

/**
 * The "Branches" list of the case dialog: one row per branch (number, title, meta, Edit, remove) and "Add branch". The edits go to
 * `draft.branches` and are saved with the case; the dialog Cancel discards them.
 * @param {{ draft: Record<string, any>, pool: () => any, screens: () => string[], actorOptions: (current: string) => any[], ensureNodes: (screen: string) => any, markDirty: () => void, refresh: () => void }} env
 */
export function createBranchList(env) {
  const { draft } = env;
  const box = h("div", { class: "uc-branch-list" });
  const mains = () => draft.steps.filter((s) => s.id !== "").map((s) => ({ id: s.id, action: s.action }));
  const labels = () => numberBranches({ steps: mains(), branches: draft.branches.map((b) => ({ id: b.id, from: b.from === "" ? undefined : b.from })) }).map((e) => e.label);

  function context(self) {
    const others = () => draft.branches.filter((b) => b !== self);
    return {
      context: `in ${draft.title.trim() || "this use case"}`,
      mainSteps: mains,
      siblings: () => others().map((b) => ({ id: b.id, from: b.from === "" ? undefined : b.from })),
      position: self ? draft.branches.indexOf(self) : draft.branches.length,
      taken: () => placesIn(baseModel({ steps: draft.steps, branches: others() }, []), null),
      ids: () => new Set(others().map((b) => b.id)),
      pool: env.pool,
      screens: env.screens,
      actorOptions: env.actorOptions,
      ensureNodes: env.ensureNodes,
    };
  }

  async function edit(branch) {
    ensureStepIds(draft);
    const answer = await openBranchDialog({ ...context(branch), mode: "case", branch, canRemove: true });
    if (!answer) return;
    if (answer.removed) draft.branches.splice(draft.branches.indexOf(branch), 1);
    else draft.branches[draft.branches.indexOf(branch)] = answer.branch;
    env.markDirty();
    draw();
  }

  async function add() {
    ensureStepIds(draft);
    const steps = mains();
    const from = steps.at(-1)?.id ?? "";
    const blank = blankBranch({ from, rejoin: "" });
    const answer = await openBranchDialog({ ...context(null), mode: "case", branch: blank, canRemove: false });
    if (!answer || answer.removed) return;
    draft.branches.push(answer.branch);
    env.markDirty();
    draw();
  }

  function draw() {
    const tags = labels();
    const steps = mains();
    fill(
      box,
      ...draft.branches.map((branch, i) =>
        h(
          "div",
          { class: "uc-branch-row", role: "group", "aria-label": `Branch ${tags[i]}`, dataset: { branch: branch.id } },
          h("span", { class: "uc-frame-no", dataset: { kind: "branch" } }, tags[i]),
          h("div", { class: "uc-branch-row-text" }, h("span", { class: "uc-branch-row-title" }, branch.title || branch.id), h("span", { class: "uc-form-note" }, branchMeta(branch, steps))),
          h("button", { type: "button", class: "chrome-btn chrome-btn--compact", "aria-label": `Edit branch ${tags[i]}`, onClick: () => edit(branch) }, "Edit"),
          removeButton(`Remove branch ${tags[i]}`, () => { draft.branches.splice(draft.branches.indexOf(branch), 1); env.markDirty(); draw(); }),
          h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `branch.${i}` } }),
        ),
      ),
      draft.branches.length === 0 ? h("p", { class: "uc-muted" }, "No branches. A branch is an alternative or exception path that forks from a step.") : null,
      h("button", { type: "button", class: "uc-link-btn", onClick: add }, icon("add"), "Add branch"),
    );
    env.refresh();
  }
  return { el: box, redraw: draw };
}
