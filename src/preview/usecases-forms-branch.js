// Use Cases tab — the branch editor (ADR-011, CHR-1154, design usecases-edit-dialog-branch / -branch-invalid): a second dialog opened
// from the case dialog (a case's branch) or from a variant (add_branch, replace_branch). It edits a copy of the branch draft and
// returns it on Apply; nothing is saved here. Hard errors (shape) block Apply and are said under their field and in the footer;
// the rest is a warning elsewhere. Step ids are one namespace across the main flow and every branch (spec §2).

import { h, icon, fill } from "./usecases-dom.js";
import { createDialog, field, textInput, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { segmented } from "./usecases-parts.js";
import { createReorder, renumberRow } from "./usecases-reorder.js";
import { showFieldErrors, touchScope, emptyStep } from "./usecases-variant-edit.js";
import { conditionRows } from "./usecases-forms-rows.js";
import { buildBranch } from "./usecases-world-edit.js";
import { numberBranches, branchStepNumber } from "./usecases-world-data.js";

/** A deep copy of a branch draft: the dialog edits the copy and only Apply hands it back. */
export function cloneBranchDraft(branch) {
  return { ...branch, when: branch.when.map((c) => ({ ...c })), steps: branch.steps.map((s) => ({ ...s, data: s.data.map((d) => ({ ...d })), extra: { ...s.extra } })), extra: { ...branch.extra } };
}

/**
 * @param {{
 *   mode: "case" | "add" | "replace",
 *   branch: Record<string, any>,
 *   context: string,
 *   mainSteps: () => { id: string, action: string }[],
 *   siblings: () => { id: string, from?: string }[],
 *   position: number,
 *   taken: () => Map<string, string>,
 *   ids: () => Set<string>,
 *   pool: () => any,
 *   screens: () => string[],
 *   actorOptions: (current: string) => { value: string, label: string }[],
 *   ensureNodes: (screen: string) => Promise<string[]> | undefined,
 *   canRemove?: boolean,
 * }} options `siblings` are the other branches in order (with `from`), `position` where this one sits among them; `taken` maps every step id outside this branch to its place
 * @returns {Promise<{ branch: Record<string, any> } | { removed: true } | null>}
 */
export async function openBranchDialog(options) {
  const { mode } = options;
  const draft = cloneBranchDraft(options.branch);
  const isNew = draft.origId === "";
  const label = () => {
    const mains = options.mainSteps();
    const list = options.siblings();
    const entries = [...list.slice(0, options.position), { id: "\u0000this", from: draft.from === "" ? undefined : draft.from }, ...list.slice(options.position)];
    const numbered = numberBranches({ steps: mains.map((s) => ({ id: s.id })), branches: entries });
    return numbered[options.position].label;
  };
  const verb = mode === "replace" ? "Replace" : mode === "add" || isNew ? "New" : "Edit";
  const dialog = createDialog({ title: `${verb} branch${isNew ? "" : ` ${label()}`}`, context: options.context, wide: true, back: true });
  let result = null;
  let ready = false;
  const touch = () => {
    dialog.setDirty(true);
    refresh();
  };

  const titleHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: "branch.title" } });
  const titleInput = textInput({ value: draft.title, autofocus: true, placeholder: "Premium rises by more than 15 %", onInput: (value) => { draft.title = value; if (isNew && draft.id === "") idInput.value = ""; touch(); } });
  titleInput.dataset.errorPath = "branch.title";
  titleInput.dataset.hint = titleHint.id;
  const idLocked = mode === "replace" || !isNew;
  const idInput = textInput({ value: draft.id, mono: true, readonly: idLocked, placeholder: "from the title", onInput: (value) => { draft.id = value; touch(); } });
  if (idLocked) idInput.classList.add("uc-locked");
  idInput.dataset.errorPath = "branch.id";
  const idHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: "branch.id" } });
  idInput.dataset.hint = idHint.id;

  // --- Where it forks ---------------------------------------------------------------------------------------------
  const forkSelect = h("select", { class: "chrome-field uc-select", "aria-label": "Forks after" });
  // Where "Continue at" starts: the step after the fork (the first step for a fork before it), none when there is no such step.
  const defaultRejoin = () => {
    const mains = options.mainSteps();
    const next = draft.from === "" ? 0 : mains.findIndex((s) => s.id === draft.from) + 1;
    return next > 0 || draft.from === "" ? (mains[next]?.id ?? "") : "";
  };
  let rejoinChosen = draft.rejoin !== ""; // a stored rejoin, or one the user picks, is never recomputed
  const drawFork = () => {
    const mains = options.mainSteps();
    const choices = [{ value: "", label: "Before the first step" }, ...mains.map((s, i) => ({ value: s.id, label: `After step ${i + 1} · ${s.action || "(no action yet)"}` }))];
    if (draft.from !== "" && !choices.some((c) => c.value === draft.from)) choices.push({ value: draft.from, label: `After ${draft.from} (not a main-flow step)` });
    fill(forkSelect, ...choices.map((c) => h("option", { value: c.value }, c.label)));
    forkSelect.value = draft.from;
  };
  forkSelect.addEventListener("change", () => {
    draft.from = forkSelect.value;
    if (!rejoinChosen) {
      draft.rejoin = defaultRejoin();
      drawContinue();
    }
    touch();
    relabelSteps();
  });

  // --- Conditions -------------------------------------------------------------------------------------------------
  const whenHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: "branch.when" } });
  const when = conditionRows({ rows: draft.when, pool: options.pool, path: "branch.when", label: "Condition", markDirty: touch, refresh: () => ready && refresh(), legend: false });

  // --- Steps ------------------------------------------------------------------------------------------------------
  const stepsBox = h("div", { class: "uc-branch-steps" });
  const stepsHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: "branch.steps" } });
  const relabelSteps = () => {
    const tag = label();
    stepsBox.querySelectorAll(":scope > .uc-branch-step").forEach((row, i) => {
      row.dataset.index = String(i);
      row.querySelector(".uc-frame-no")?.replaceChildren(branchStepNumber(tag, i + 1));
      renumberRow(row, i, { label: /^(Step |Remove step )\d+/, path: /^(branch\.step\.)\d+/ });
      row.querySelector(".uc-drag-handle")?.relabel();
      row.querySelector("[aria-haspopup='menu']")?.relabel();
    });
  };
  const reorder = createReorder({
    list: stepsBox,
    rowSelector: ".uc-branch-step",
    nameOf: (row, i) => draft.steps[i]?.action?.trim() || `Step ${i + 1}`,
    onReorder: (from, to) => { draft.steps.splice(to, 0, draft.steps.splice(from, 1)[0]); },
    onMoved: () => { relabelSteps(); refresh(); },
    onCommit: () => dialog.setDirty(true),
  });
  const drawSteps = (focusIndex = null) => {
    stepsBox.replaceChildren();
    const tag = label();
    draft.steps.forEach((step, index) => {
      const at = () => draft.steps.indexOf(step);
      const screenListId = nextId("uc-screens");
      const nodeListId = nextId("uc-nodes");
      const nodeList = h("datalist", { id: nodeListId });
      const fillNodes = (screen) => options.ensureNodes(screen)?.then((list) => nodeList.replaceChildren(...(list ?? []).slice(0, 400).map((n) => h("option", { value: n }, n))));
      const actionHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `branch.step.${index}.action` } });
      const nodeHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `branch.step.${index}.node` } });
      const idHintEl = h("p", { class: "uc-field-error uc-step-id-hint", id: nextId("uc-err"), hidden: true, dataset: { path: `branch.step.${index}.id` } });
      const actionInput = textInput({ value: step.action, placeholder: "What happens", ariaLabel: `Step ${index + 1} action`, onInput: (value) => { step.action = value; touch(); } });
      actionInput.dataset.errorPath = `branch.step.${index}.action`;
      actionInput.dataset.hint = actionHint.id;
      const stepIdInput = textInput({ value: step.id, mono: true, placeholder: "step id", ariaLabel: `Step ${index + 1} id`, onInput: (value) => { step.id = value; touch(); } });
      stepIdInput.dataset.errorPath = `branch.step.${index}.id`;
      stepIdInput.dataset.hint = idHintEl.id;
      const idRow = h("div", { class: "uc-step-id-row", hidden: !step.showId }, stepIdInput, idHintEl);
      const screenInput = textInput({ value: step.screen, list: screenListId, placeholder: "screen", mono: true, ariaLabel: `Step ${index + 1} screen`, onInput: (value) => { step.screen = value; touch(); if (options.screens().includes(value.trim())) fillNodes(value.trim()); } });
      const nodeInput = textInput({ value: step.node, list: nodeListId, placeholder: "element id", mono: true, ariaLabel: `Step ${index + 1} element`, onInput: (value) => { step.node = value; touch(); } });
      nodeInput.dataset.errorPath = `branch.step.${index}.node`;
      nodeInput.dataset.hint = nodeHint.id;
      const viaInput = textInput({ value: step.via, placeholder: "Via", ariaLabel: `Step ${index + 1} via`, onInput: (value) => { step.via = value; touch(); } });
      const targetRow = h("div", { class: "uc-target-edit" });
      const drawTarget = () => {
        fill(
          targetRow,
          segmented({ label: `Step ${at() + 1} target`, name: nextId("uc-kind"), value: step.kind, options: [{ value: "screen", label: "Screen" }, { value: "element", label: "Element" }, { value: "none", label: "None" }], onChange: (value) => { step.kind = value; drawTarget(); touch(); } }),
          step.kind !== "none" ? screenInput : null,
          step.kind === "element" ? nodeInput : null,
          step.kind === "element" ? nodeHint : null,
          step.kind !== "none" ? h("datalist", { id: screenListId }, options.screens().map((s) => h("option", { value: s }))) : null,
          step.kind === "element" ? nodeList : null,
          viaInput,
        );
      };
      drawTarget();
      if (step.kind === "element" && options.screens().includes(step.screen)) fillNodes(step.screen);
      let rowEl;
      rowEl = h(
        "div",
        { class: "uc-branch-step", dataset: { index: String(index) } },
        h("div", { class: "uc-step-edit-top" }, reorder.handle(() => rowEl), h("span", { class: "uc-frame-no is-branch" }, branchStepNumber(tag, index + 1)), selectInput({ options: options.actorOptions(step.actor), value: step.actor || "system", ariaLabel: `Step ${index + 1} actor`, onChange: (value) => { step.actor = value; touch(); } }), actionInput, h("span", { class: "uc-step-edit-tools" }, reorder.moreButton(() => rowEl), removeButton(`Remove step ${index + 1}`, () => { draft.steps.splice(at(), 1); touch(); drawSteps(); }))),
        actionHint,
        idRow,
        targetRow,
        reorder.keyHint(),
      );
      touchScope(rowEl, step, () => refresh());
      stepsBox.append(rowEl);
      rowEl.querySelector("[aria-haspopup='menu']").relabel();
      rowEl.querySelector(".uc-drag-handle").relabel();
    });
    stepsBox.append(h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.steps.push(emptyStep()); touch(); drawSteps(draft.steps.length - 1); } }, icon("add"), "Step"));
    if (focusIndex !== null) stepsBox.querySelectorAll(".uc-branch-step")[focusIndex]?.querySelector("input")?.focus();
    if (ready) refresh();
  };

  // --- After the last step ------------------------------------------------------------------------------------------
  const radioName = nextId("uc-end");
  const continueSelect = h("select", { class: "chrome-field uc-select", "aria-label": "Continue at" });
  const drawContinue = () => {
    const mains = options.mainSteps();
    if (draft.rejoin === "" && !rejoinChosen) draft.rejoin = defaultRejoin();
    fill(continueSelect, draft.rejoin === "" ? h("option", { value: "" }, "No step to continue at") : null, ...mains.map((s, i) => h("option", { value: s.id }, `Step ${i + 1} · ${s.action || "(no action yet)"}`)), draft.rejoin !== "" && !mains.some((s) => s.id === draft.rejoin) ? h("option", { value: draft.rejoin }, `${draft.rejoin} (not a main-flow step)`) : null);
    continueSelect.value = draft.rejoin;
    continueSelect.disabled = draft.ends;
  };
  const outcomeInput = textInput({ value: draft.outcome, placeholder: "Outcome of this branch (optional)", ariaLabel: "Outcome of this branch", onInput: (value) => { draft.outcome = value; touch(); } });
  outcomeInput.disabled = !draft.ends;
  const radio = (value, text) => h("label", { class: "uc-check" }, h("input", { type: "radio", name: radioName, value, checked: (value === "end") === draft.ends, onChange: () => { draft.ends = value === "end"; continueSelect.disabled = draft.ends; outcomeInput.disabled = !draft.ends; touch(); } }), text);
  continueSelect.addEventListener("change", () => {
    rejoinChosen = true;
    draft.rejoin = continueSelect.value;
    touch();
  });

  // --- Footer and validation -----------------------------------------------------------------------------------------
  const applyButton = h("button", { type: "button", class: "chrome-btn chrome-btn--primary", onClick: apply }, "Apply branch");
  let lastBuild = null;
  function build() {
    const errors = [];
    const fieldErrors = [];
    const built = buildBranch(draft, { taken: options.taken(), ids: options.ids(), errors, fieldErrors, label: "The branch", lockId: idLocked });
    return { built, errors, fieldErrors };
  }
  function refresh() {
    if (!ready) return;
    lastBuild = build();
    for (const e of lastBuild.fieldErrors) {
      const m = /^branch\.step\.(\d+)\.id$/.exec(e.path);
      if (m && draft.steps[Number(m[1])]) draft.steps[Number(m[1])].showId = true;
    }
    stepsBox.querySelectorAll(".uc-step-id-row").forEach((row, i) => { row.hidden = !draft.steps[i]?.showId; });
    showFieldErrors(dialog.body, lastBuild.fieldErrors);
    const count = lastBuild.errors.length;
    // Untouched rows report nothing until left (untilTouched), but Apply stays blocked meanwhile.
    applyButton.disabled = count > 0;
    applyButton.title = count > 0 ? lastBuild.errors[0] : "";
    // A branch nobody typed into yet says nothing in the footer (Apply is disabled and says why in its title); an edited one names its errors.
    dialog.setMessage(count > 0 && (dialog.isDirty() || !isNew) ? `${count} ${count === 1 ? "error" : "errors"}. ${lastBuild.errors[0]}` : "", "error");
  }
  function apply() {
    refresh();
    if (lastBuild.errors.length > 0) return;
    const id = idLocked || draft.id !== "" ? draft.id : lastBuild.built.id;
    draft.id = id;
    result = { branch: { ...draft, id } };
    dialog.setDirty(false);
    dialog.close(result);
  }

  const actions = [{ label: "Cancel", onClick: () => dialog.requestClose() }, applyButton];
  const removeAction = options.canRemove ? h("button", { type: "button", class: "chrome-btn uc-btn-danger uc-btn-start", onClick: () => { result = { removed: true }; dialog.setDirty(false); dialog.close(result); } }, "Remove branch") : null;
  dialog.setActions(removeAction ? [removeAction, ...actions] : actions);

  dialog.body.append(
    h(
      "div",
      { class: "uc-form uc-branch-form" },
      h("div", { class: "uc-form-row" }, h("div", { class: "uc-id-col" }, field("Title", titleInput), titleHint), h("div", { class: "uc-id-col" }, field("ID", idInput, { hint: idLocked ? undefined : "from the title" }), idHint, mode === "replace" ? h("p", { class: "uc-form-note uc-lock-note" }, icon("lock"), "A replaced branch keeps its id.") : null)),
      field("Forks", forkSelect),
      h("p", { class: "uc-form-note" }, 'Or "Before the first step": another starting state. The letter follows the fork: 2A, 2B, … and A, B, … before the first step.'),
      h("div", { class: "uc-field" }, h("span", { class: "uc-label" }, "When", h("span", { class: "uc-label-hint" }, " · all conditions hold")), whenHint, when.el),
      h("section", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Steps"), stepsHint, stepsBox, reorder.live),
      h(
        "fieldset",
        { class: "uc-end-group" },
        h("legend", { class: "uc-form-h" }, "After the last step"),
        h("div", { class: "uc-end-row" }, radio("continue", "Continue at"), continueSelect),
        h("div", { class: "uc-end-row" }, radio("end", "End the case"), outcomeInput),
      ),
    ),
  );
  drawFork();
  drawContinue();
  drawSteps();
  const closed = dialog.open();
  ready = true;
  refresh();
  await closed;
  return result;
}
