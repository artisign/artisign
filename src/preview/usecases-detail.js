// Use Cases tab — the detail view of one use case: header, variant chips, people, trigger / goal / outcome, the flow as a
// step sequence (actor, action, target chip, before/after data cards), inputs and outputs as data-object cards, and for a
// selected variant the difference against the base plus the coverage matrix. Built from get_use_case bundles
// (see the use-case spec); a variant is always shown as a diff, never as a full copy.

import { h, icon } from "./usecases-dom.js";
import { openMenu } from "./usecases-menu.js";
import { avatar, statusBadge, diffBadge, targetChip, variantChip, traitChip } from "./usecases-parts.js";
import { actorKind, mappingNote, stepDataBlock, warnLine } from "./usecases-world-parts.js";
import { orphansOf, conditionOrphan, orphanParts, actorMissing, hiddenNote } from "./usecases-orphans.js";
import { constellationMembers } from "./usecases-world-data.js";
import { KIND_ICONS, warningsByTarget, numberBranches, scopeOf, matchingConstellations, whenScopeText, triggerChanged, stateRows } from "./usecases-world-data.js";
import { triggerRow, worldSection, worldDiffSection, stateSection, branchesDiffSection, lanesAt, stepBranchNotes } from "./usecases-world-view.js";
import {
  avatarOf,
  actorName,
  buildFlowRows,
  mappingFor,
  stepScope,
  fieldRows,
  ioChangedKeys,
  formatValue,
  whenEntries,
  matchingPersonas,
  coverageMatrix,
  variantChangeCount,
  plural,
} from "./usecases-data.js";

/** "Small project · Human" — a persona's trait values as labels. */
function traitSummary(persona, dimensionsById) {
  return Object.entries(persona.traits ?? {})
    .map(([dimension, value]) => `${dimensionsById.get(dimension)?.label ?? dimension} ${dimensionsById.get(dimension)?.values.find((v) => v.id === value)?.label ?? value}`)
    .join(" · ");
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   bundle: Record<string, any>, base: Record<string, any>, source: Record<string, any> | null, variantId: string | null,
 *   pool: { personas: any[], personasById: Map<string, any>, dimensionsById: Map<string, any>, dimensions: any[], objectsById: Map<string, any> },
 *   coverageOpen: boolean,
 *   handlers: { onVariant: (id: string | null) => void, onEdit: () => void, onMap: (stepId: string | null) => void, onCopyId: () => void, onCopy: (text: string) => void, onAddVariant: () => void, onToggleCoverage: () => void, onDelete: () => void },
 * }} ctx
 */
export function renderDetail(root, ctx) {
  const { bundle, base, source, variantId, pool } = ctx;
  const useCase = bundle.use_case;
  const baseCase = base.use_case;
  const variants = base.variants ?? [];
  const sourceVariant = variantId ? (source?.variants ?? []).find((v) => v.id === variantId) : null;
  const variantInfo = variantId ? (bundle.variant ?? variants.find((v) => v.id === variantId)) : null;
  const basePersonas = (baseCase.personas ?? []).map((id) => pool.personasById.get(id)).filter(Boolean);
  // The world's columns: the constellations the base case lists, and the values the constellation pool uses (from the tool's own coverage).
  const baseConstellations = (base.constellations ?? []).filter((c) => (baseCase.constellations ?? []).includes(c.id));
  const usedValues = new Map((ctx.suggest?.coverage ?? []).map((c) => [c.dimension, new Set([...(c.covered ?? []), ...(c.uncovered ?? [])])]));
  const matrix = coverageMatrix({ dimensions: pool.dimensions, pool: pool.personas, basePersonas, variants, uncovered: ctx.suggest?.coverage, baseConstellations, usedValues });
  const showCoverage = variants.length > 0 || matrix.gaps > 0 ? ctx.coverageOpen || Boolean(variantId) : false;
  const w = warningsByTarget(bundle.warnings, useCase.id, variantId);
  // The base bundle carries the warnings of every variant, a variant bundle its own: together they are what the case names but the pools lack.
  const seen = new Set();
  const caseWarnings = [...(base.warnings ?? []), ...(bundle.warnings ?? [])].filter((x) => !seen.has(`${x.kind}|${x.target}|${x.message}`) && seen.add(`${x.kind}|${x.target}|${x.message}`));
  ctx.orphans = orphansOf(caseWarnings, baseCase.id, [...new Set([...(baseCase.constellations ?? []), ...(useCase.constellations ?? []), ...(source?.variants ?? []).flatMap((v) => v.constellations ?? [])])], [...new Set([...(bundle.constellations ?? []), ...(base.constellations ?? [])].flatMap(constellationMembers))]);
  // get_use_case caps its warning list (warning_count is the true total): an orphan past the cap is unseen, so the card cannot confirm full coverage.
  ctx.orphans.incomplete = [base, bundle].some((b) => (b.warning_count ?? 0) > (b.warnings?.length ?? 0));

  const main = h("div", { class: "uc-detail-main" });
  main.append(header(ctx, useCase, w));
  main.append(variantBar(ctx, variants, source, matrix));
  if (variantInfo) main.append(variantPanel(ctx, variantInfo, sourceVariant));
  const peopleRow = people(ctx, useCase);
  if (peopleRow) main.append(peopleRow); // Node.append(null) would add the text "null"
  // The matrix is a full-width section of the detail column (not a narrow side panel): twelve columns need the room.
  if (showCoverage) main.append(coveragePanel(ctx, matrix));
  if (variantId) {
    // A variant is a difference against the base: its constellations, trigger, state and branches, then the main flow.
    main.append(story(ctx, w, sourceVariant));
    for (const section of [worldDiffSection(ctx, sourceVariant, w), stateSection(ctx, { rows: stateRows({ state: useCase.state ?? [], removedState: bundle.removed_state ?? [], baseState: baseCase.state ?? [], variantSelected: true }), w, variantSelected: true }), branchesDiffSection(ctx, w, mainFlowDifferences(bundle))]) if (section) main.append(section);
  } else {
    main.append(story(ctx, w, null));
    for (const section of [worldSection(ctx, w), stateSection(ctx, { rows: stateRows({ state: useCase.state ?? [], variantSelected: false }), w, variantSelected: false })]) if (section) main.append(section);
  }
  main.append(flow(ctx, useCase, w));
  main.append(inputsOutputs(ctx, useCase, baseCase, sourceVariant));

  root.replaceChildren(h("div", { class: "uc-detail" }, main));
}

/** How many main-flow steps a variant changed or added, plus the base steps it removed (branch removals are the Branches section's). */
function mainFlowDifferences(bundle) {
  return (bundle.use_case.steps ?? []).filter((s) => s.change === "changed" || s.change === "added").length + (bundle.removed_steps ?? []).filter((s) => s.branch === undefined).length;
}

function header(ctx, useCase, w) {
  const { handlers } = ctx;
  const groupPath = (useCase.group ?? "").split("/").filter(Boolean);
  return h(
    "header",
    { class: "uc-detail-head" },
    h(
      "div",
      { class: "uc-detail-top" },
      h("div", { class: "uc-breadcrumb" }, icon("folder_open"), groupPath.length === 0 ? h("span", { class: "uc-muted" }, "No group") : groupPath.flatMap((segment, i) => [i > 0 ? icon("chevron_right", "uc-crumb-sep") : null, h("span", null, segment)])),
      h(
        "div",
        { class: "uc-actions" },
        h("button", { type: "button", class: "chrome-btn", onClick: () => handlers.onMap(null), disabled: !(useCase.steps ?? []).some((s) => s.target) }, icon("view_carousel"), "Show on screens"),
        h("button", { type: "button", class: "chrome-btn", onClick: handlers.onEdit, "aria-disabled": ctx.paused ? "true" : null, title: ctx.paused || null }, icon("edit"), "Edit"),
        h("button", { type: "button", class: "chrome-icon-btn", "aria-label": "More actions", title: "More actions", "aria-haspopup": "menu", "aria-expanded": "false", onClick: (e) => openMenu({ anchor: e.currentTarget, label: "More actions", items: [{ value: "delete", label: "Delete use case", leading: icon("delete", "chrome-menu-icon") }], onPick: () => handlers.onDelete() }) }, icon("more_horiz")),
      ),
    ),
    h("h1", { class: "uc-title" }, useCase.title),
    h(
      "div",
      { class: "uc-meta-row" },
      statusBadge(useCase.status),
      (useCase.tags ?? []).map((tag) => h("span", { class: "uc-chip" }, tag)),
      h("button", { type: "button", class: "uc-id-chip", title: "Copy id", onClick: handlers.onCopyId }, useCase.id),
    ),
    // Warnings that belong to the case as a whole (no step, branch or state to put them at).
    w.case.length > 0 ? h("div", { class: "uc-case-warnings" }, w.case.map((x) => warnLine(x.message))) : null,
  );
}

function variantBar(ctx, variants, source, matrix) {
  const { handlers, variantId } = ctx;
  const baseCase = ctx.base.use_case;
  const chips = [variantChip({ label: "Base", meta: [plural(baseCase.steps.length, "step"), (baseCase.branches ?? []).length > 0 ? plural(baseCase.branches.length, "branch", "branches") : null].filter(Boolean).join(" · "), selected: !variantId, onClick: () => handlers.onVariant(null) })];
  for (const variant of variants) {
    const raw = (source?.variants ?? []).find((v) => v.id === variant.id);
    const changes = raw ? variantChangeCount(raw, baseCase.steps, baseCase) : 0;
    chips.push(variantChip({ label: variant.title, meta: raw ? plural(changes, "change") : "", selected: variantId === variant.id, title: variant.description, onClick: () => handlers.onVariant(variant.id) }));
  }
  chips.push(variantChip({ label: "Variant", add: true, onClick: handlers.onAddVariant, title: ctx.paused || "Add a variant", paused: Boolean(ctx.paused) }));
  return h(
    "div",
    { class: "uc-variant-bar" },
    h("span", { class: "uc-variant-label" }, "Variant"),
    h("div", { class: "uc-variant-chips" }, chips),
    matrix.gaps > 0
      ? h("button", { type: "button", class: "uc-gap-hint", "aria-pressed": ctx.coverageOpen || variantId ? "true" : "false", onClick: handlers.onToggleCoverage }, icon("grid_view"), `${plural(matrix.gaps, "trait value")} not covered`)
      : variants.length > 0
        ? h("button", { type: "button", class: "uc-coverage-link", onClick: handlers.onToggleCoverage }, icon("grid_view"), "Coverage")
        : null,
  );
}

/** A condition chip; one on a deleted dimension or value is marked as orphaned, not just shown with its raw id. */
function orphanChip(ctx, variantId, entry, value) {
  const orphan = conditionOrphan(ctx.orphans, variantId, entry.dimension, value.id);
  // A deleted dimension or value shows its id, the one text that is left; the marker comes on top.
  const chip = orphan ? traitChip(entry.dimension, value.id) : traitChip(entry.label, value.label);
  if (!orphan) return chip;
  chip.classList.add("is-orphan");
  chip.dataset.orphan = orphan;
  chip.title = orphan === "dimension" ? "This dimension no longer exists" : "This value no longer exists";
  chip.append(icon("warning"), hiddenNote(orphan === "dimension" ? "this dimension no longer exists" : "this value no longer exists"));
  return chip;
}

function variantPanel(ctx, variant, raw) {
  const { pool, bundle } = ctx;
  const conditions = whenEntries(variant.when, pool.dimensionsById);
  const personaWhen = Object.fromEntries(Object.entries(variant.when ?? {}).filter(([dimension]) => scopeOf(pool.dimensionsById.get(dimension)) !== "constellations"));
  const matches = matchingPersonas(personaWhen, pool.personas);
  // Neither the spec (§11) nor the design says which constellations "matches N" counts. A variant only takes effect in the constellations of its own case, so the count is case-scoped: the constellations the case and its variants list (persona matches count against the whole persona pool, which is every persona that could play it).
  const worldMatches = matchingConstellations(variant.when, [...(ctx.base.constellations ?? []), ...(bundle.constellations ?? [])].filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i), pool.dimensionsById);
  const hasWorldWhen = Object.keys(variant.when ?? {}).some((dimension) => scopeOf(pool.dimensionsById.get(dimension)) === "constellations");
  const matchText = [hasWorldWhen ? plural(worldMatches.length, "constellation") : null, matches.length > 0 || !hasWorldWhen ? plural(matches.length, "persona") : null].filter(Boolean).join(" and ");
  const overrides = ["personas", "constellations", "trigger", "goal", "outcome", "inputs", "outputs"].filter((key) => raw?.[key] !== undefined);
  const hasBranches = (bundle.use_case.branches ?? []).length > 0 || (bundle.removed_branches ?? []).length > 0;
  return h(
    "div",
    { class: "uc-variant-panel" },
    h(
      "div",
      { class: "uc-applies" },
      h("span", { class: "uc-muted" }, "Applies when"),
      conditions.map((entry) => entry.values.map((v) => orphanChip(ctx, variant.id, entry, v))),
      h("span", { class: "uc-muted" }, `${whenScopeText(variant.when, pool.dimensionsById)} · matches ${matchText}${conditions.some((entry) => conditionOrphan(ctx.orphans, variant.id, entry.dimension)) ? " (a condition names a dimension that no longer exists)" : conditions.some((entry) => entry.values.some((v) => conditionOrphan(ctx.orphans, variant.id, entry.dimension, v.id) === "value")) ? " (a condition names a value that no longer exists)" : ""}`),
      matches.length > 0 ? h("span", { class: "uc-avatar-stack" }, matches.slice(0, 5).map((p) => avatar(avatarOf(p.id, pool.personasById), "sm", p.name))) : null,
    ),
    variant.description ? h("p", { class: "uc-variant-desc" }, variant.description) : null,
    h(
      "div",
      { class: "uc-legend" },
      h("span", { class: "uc-muted" }, "Against base"),
      diffBadge("changed"),
      diffBadge("added"),
      diffBadge("removed"),
      hasBranches ? diffBadge("emptied") : null,
      diffBadge("base"),
      overrides.length > 0 ? h("span", { class: "uc-muted uc-legend-note" }, `Overrides ${overrides.join(", ")}`) : null,
    ),
  );
}

function people(ctx, useCase) {
  const { pool } = ctx;
  const actors = new Set((useCase.steps ?? []).map((s) => s.actor));
  const ids = [...new Set([...(useCase.personas ?? []), ...actors])].filter((id) => id !== "system");
  if (ids.length === 0) return null;
  return h(
    "div",
    { class: "uc-people" },
    ids.map((id) => {
      const persona = pool.personasById.get(id);
      const orphan = Boolean(ctx.orphans?.personas.has(id));
      const sub = persona ? [KIND_ICONS[persona.kind]?.label, persona.role, traitSummary(persona, pool.dimensionsById)].filter(Boolean).join(" · ") : "Unknown persona";
      return h(
        "div",
        { class: orphan ? "uc-person is-orphan" : "uc-person", dataset: orphan ? { orphan: "persona" } : {} },
        avatar(avatarOf(id, pool.personasById), "lg"),
        h("div", { class: "uc-person-text" }, h("span", { class: "uc-person-name" }, actorName(id, pool.personasById), actorKind(persona?.kind)), h("span", { class: "uc-person-sub" }, sub), orphan ? h("span", { class: "uc-orphan-note" }, icon("warning"), "Missing from the persona pool") : null),
      );
    }),
  );
}

/** Goal and outcome are plain text: a variant's differs from the base when the strings differ. (The trigger is compared by what it says, in `triggerChanged`.) */
const differs = (a, b) => a !== b;

/**
 * The story card: the trigger line on top (full width), Goal and Outcome below in two columns. A variant shows the trigger it
 * replaces whole (with the base one named) and only the cells it overrides.
 */
function story(ctx, w, rawVariant) {
  const { bundle, base, variantId } = ctx;
  const useCase = bundle.use_case;
  const baseCase = base.use_case;
  const trigger = triggerRow(ctx, { trigger: useCase.trigger, baseTrigger: baseCase.trigger, changed: Boolean(variantId) && rawVariant?.trigger !== undefined && triggerChanged(rawVariant.trigger, baseCase.trigger), w });
  const cells = [
    ["flag", "Goal", "goal"],
    ["task_alt", "Outcome", "outcome"],
  ].filter(([, , key]) => !variantId || rawVariant?.[key] !== undefined);
  return h(
    "div",
    { class: "uc-story", dataset: { cells: String(cells.length) } },
    trigger,
    cells.map(([ic, label, key]) =>
      h("div", { class: "uc-story-cell" }, h("div", { class: "uc-story-label" }, icon(ic), label, rawVariant?.[key] !== undefined && differs(rawVariant[key], baseCase[key]) ? diffBadge("changed") : null), h("p", null, useCase[key] || h("span", { class: "uc-muted" }, "—"))),
    ),
  );
}

function flowSummary(rows, variantSelected, branchCount) {
  const steps = rows.filter((r) => r.kind === "step");
  const screens = new Set(steps.map((r) => r.step.target?.screen).filter(Boolean));
  const elements = steps.filter((r) => r.step.target?.node).length;
  if (!variantSelected) {
    if (branchCount > 0) return `${plural(steps.length, "step")} · ${plural(branchCount, "branch", "branches")} · branches are never chosen by artisign, every lane is shown`;
    return `${plural(steps.length, "step")} · ${plural(screens.size, "screen")} · ${plural(elements, "element")}`;
  }
  const count = (kind) => steps.filter((r) => r.change === kind).length;
  const removed = rows.filter((r) => r.kind === "removed").length;
  return `${plural(steps.length, "step")} in this variant · ${count("changed")} changed · ${count("added")} added · ${removed} removed`;
}

function flow(ctx, useCase, w) {
  const { bundle, base, variantId } = ctx;
  // A step removed from a branch is not a main-flow row; branch removals are shown with the branch view.
  const rows = buildFlowRows({ steps: useCase.steps ?? [], removedSteps: (bundle.removed_steps ?? []).filter((r) => r.branch === undefined), baseSteps: base.use_case.steps ?? [], variantSelected: Boolean(variantId) });
  // Branch lanes sit in the flow after the step they fork from (a base view; a variant lists its branches in their own section).
  const numbered = variantId ? [] : numberBranches(useCase);
  const list = h("ol", { class: "uc-flow" });
  list.append(...lanesAt(ctx, numbered, null, w));
  for (const row of rows) {
    if (row.kind === "removed") {
      list.append(
        h(
          "li",
          { class: "uc-step is-removed" },
          h("span", { class: "uc-step-rail" }, h("span", { class: "uc-step-ghost", "aria-hidden": "true" })),
          h("div", { class: "uc-step-card" }, diffBadge("removed"), h("s", { class: "uc-removed-text" }, `Base step · ${row.step.action}`), bundle.variant?.description ? h("span", { class: "uc-removed-why" }, bundle.variant.description) : null),
        ),
      );
      continue;
    }
    list.append(stepRow(ctx, row, numbered, w));
    list.append(...lanesAt(ctx, numbered, row.step.id, w));
  }
  return h("section", { class: "uc-section" }, h("h2", { class: "uc-h2" }, "Flow", h("span", { class: "uc-h2-meta" }, flowSummary(rows, Boolean(variantId), numbered.length))), rows.length === 0 ? h("p", { class: "uc-muted" }, "No steps yet.") : list);
}

function stepRow(ctx, row, numbered, w) {
  const { bundle, pool, handlers } = ctx;
  const step = row.step;
  const found = mappingFor(bundle, step.id);
  const mapping = found?.mapping;
  const scope = stepScope(step, mapping);
  const note = mappingNote(step, mapping, found?.screen);
  const was = row.was;
  // The orphan notes already say it in human words: the raw warning text of the same fact is not shown a second time.
  const stepObjects = new Set((step.data ?? []).map((d) => d.object));
  const stepWarnings = (w.step.get(step.id) ?? []).filter(
    (x) =>
      !x.kind.startsWith("mapping_") &&
      !(x.kind === "unknown_persona" && actorMissing(ctx, step.actor) && x.message.includes(`"${step.actor}"`)) &&
      !(x.kind === "unknown_data_object" && [...stepObjects].some((id) => ctx.orphans?.dataObjects.has(id) && x.message.includes(`"${id}"`))),
  );
  const card = h(
    "div",
    { class: "uc-step-card", dataset: { change: row.change ?? "" } },
    h("div", { class: "uc-step-head" }, h("span", { class: "uc-step-no" }, `Step ${row.number} · ${actorName(step.actor, pool.personasById)}${step.via ? ` · via ${step.via}` : ""}`), row.change === "changed" ? diffBadge("changed") : row.change === "added" ? diffBadge("added") : row.change === "base" ? diffBadge("base") : null),
    h("p", { class: "uc-step-action" }, step.action),
    actorMissing(ctx, step.actor) ? h("p", { class: "uc-orphan-note", dataset: { orphan: "actor" } }, icon("warning"), `${step.actor} is missing from the persona pool`) : null,
    was?.actor ? h("p", { class: "uc-step-was" }, "Actor was ", h("s", null, actorName(was.actor, pool.personasById))) : null,
    was?.action ? h("p", { class: "uc-step-was" }, "Base: ", h("s", null, was.action)) : null,
    was?.target ? h("p", { class: "uc-step-was" }, "Target was ", h("s", null, was.target)) : null,
    step.target ? targetChip(scope, step.target.screen, step.target.node, () => handlers.onMap(step.id)) : h("span", { class: "uc-muted uc-no-target" }, "Not mapped to a screen"),
    note,
    stepWarnings.map((x) => warnLine(x.message)),
    stepBranchNotes(numbered, step.id),
  );
  return h("li", { class: "uc-step", dataset: { change: row.change ?? "", step: step.id } }, h("span", { class: "uc-step-rail" }, avatar(avatarOf(step.actor, pool.personasById), "lg", actorName(step.actor, pool.personasById))), card, stepDataBlock(step, pool.objectsById, ctx.orphans?.dataObjects));
}

function ioCard(ctx, item, kind, compareTo) {
  const { pool } = ctx;
  const object = pool.objectsById.get(item.object);
  const sideLabel = kind === "input" ? (item.source ? `from ${item.source}` : "") : item.target ? `to ${item.target}` : "";
  const highlight = kind === "output" && !compareTo ? ioChangedKeys(item, ctx.bundle.use_case.inputs) : new Set();
  const before = compareTo?.example;
  const rows = fieldRows(object, item.example);
  return h(
    "div",
    { class: "uc-io-card" },
    h("div", { class: "uc-io-head" }, h("span", { class: "uc-io-name" }, object?.name ?? item.object), ctx.orphans?.dataObjects.has(item.object) ? h("span", { class: "uc-orphan-note", dataset: { orphan: "data_object" } }, icon("warning"), "Missing from the pool") : null, h("span", { class: "uc-io-id" }, item.object), h("span", { class: "uc-io-side" }, sideLabel)),
    h(
      "table",
      { class: "uc-table" },
      h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Type"), h("th", null, "Example"))),
      h(
        "tbody",
        null,
        rows.map((row) => {
          const known = before !== undefined && Object.hasOwn(before, row.name);
          const isNew = compareTo !== undefined && !known && row.hasExample;
          const differs = compareTo !== undefined && known && JSON.stringify(before[row.name]) !== JSON.stringify(row.example);
          const cls = isNew ? "is-added" : differs ? "is-changed" : highlight.has(row.name) ? "is-highlight" : "";
          return h(
            "tr",
            { class: cls, title: row.declared ? null : "Not a field of this data object" },
            h("td", { class: "uc-mono" }, row.name),
            h("td", { class: "uc-muted uc-mono" }, row.type),
            h("td", { class: "uc-mono" }, differs ? [h("s", { class: "uc-old" }, formatValue(before[row.name])), " "] : null, row.hasExample ? formatValue(row.example) : "—"),
          );
        }),
      ),
    ),
  );
}

function inputsOutputs(ctx, useCase, baseCase, rawVariant) {
  const outputsChanged = rawVariant?.outputs !== undefined;
  const inputsChanged = rawVariant?.inputs !== undefined;
  const column = (title, ic, items, kind, changed, baseItems) =>
    h(
      "div",
      { class: "uc-io-col" },
      h("h3", { class: "uc-h3" }, icon(ic), title, changed ? diffBadge("changed") : null),
      items.map((item) => ioCard(ctx, item, kind, changed ? baseItems.find((b) => b.object === item.object) ?? { example: {} } : undefined)),
    );
  return h(
    "section",
    { class: "uc-section" },
    h("h2", { class: "uc-h2" }, "Inputs and outputs", h("span", { class: "uc-h2-meta" }, "Example values a coding agent can test against")),
    h("div", { class: "uc-io" }, column("Inputs", "login", useCase.inputs ?? [], "input", inputsChanged, baseCase.inputs ?? []), column("Outputs", "logout", useCase.outputs ?? [], "output", outputsChanged, baseCase.outputs ?? [])),
  );
}

function coveragePanel(ctx, matrix) {
  const { variantId, handlers } = ctx;
  const useCaseId = ctx.base.use_case.id;
  const table = h("table", { class: "uc-matrix" });
  // With constellation dimensions the header has three levels: scope group (World · constellations | Personas), dimension, value.
  const grouped = matrix.columns.some((column) => column.scope === "constellations");
  const levels = grouped ? 3 : 2;
  const head0 = h("tr", null, h("th", { rowspan: String(levels), scope: "col", class: "uc-matrix-first" }, "Flow"));
  const head1 = h("tr");
  const head2 = h("tr");
  if (grouped) {
    for (const scope of ["constellations", "personas"]) {
      const columns = matrix.columns.filter((column) => column.scope === scope);
      if (columns.length === 0) continue;
      head0.append(h("th", { colspan: String(columns.reduce((n, c) => n + c.values.length, 0)), scope: "colgroup", class: "uc-matrix-scope", dataset: { scope } }, icon(scope === "constellations" ? "hub" : "groups"), scope === "constellations" ? "World · constellations" : "Personas"));
    }
  }
  const dimRow = grouped ? head1 : head0;
  const valueRow = grouped ? head2 : head1;
  for (const column of matrix.columns) {
    dimRow.append(h("th", { colspan: String(column.values.length), scope: "colgroup", class: "uc-matrix-dim" }, column.label));
    for (const value of column.values) valueRow.append(h("th", { scope: "col", class: value.gap ? "is-gap" : "", title: value.gap ? `${value.label}: not covered` : value.label }, value.label, value.gap ? h("span", { class: "uc-gap-tag" }, "gap") : null));
  }
  table.append(h("thead", null, head0, ...(grouped ? [head1, head2] : [head1])));
  const body = h("tbody");
  for (const row of matrix.rows) {
    const selected = row.kind === "base" ? !variantId : variantId === row.id;
    const tr = h("tr", { class: selected ? "is-selected" : "" }, h("th", { scope: "row", title: row.title }, row.title));
    for (const column of matrix.columns) {
      const cell = row.dims[column.dimension];
      if (cell?.any) tr.append(h("td", { colspan: String(column.values.length), class: "uc-any" }, "any"));
      else for (const value of column.values) tr.append(h("td", { class: value.gap ? "is-gap" : "" }, cell?.marks?.has(value.value) ? dot(`${row.title} handles ${value.label}`) : ""));
    }
    body.append(tr);
  }
  table.append(body);
  const prompt = `Suggest variants for ${useCaseId}`;
  return h(
    "section",
    { class: "uc-coverage", "aria-label": "Coverage" },
    h("h2", { class: "uc-h2" }, "Coverage"),
    h("p", { class: "uc-muted uc-coverage-intro" }, grouped ? "Rows are the base flow and each variant. Columns are the trait values of the world (constellations) and of the persona pool." : "Rows are the base flow and each variant, columns the trait values of your persona pool."),
    matrix.columns.length === 0 ? h("p", { class: "uc-muted" }, "No persona traits to cover yet.") : h("div", { class: "uc-matrix-wrap" }, table),
    h("p", { class: "uc-legend-line" }, dot(""), " The flow handles this value: for Base from the traits of its personas, for a variant the values named in its when. any: no condition on that dimension (a persona or variant without it). A column that neither Base nor any variant covers is a gap, the same rule as suggest_use_case_variants."),
    matrix.gaps > 0
      ? h("div", { class: "uc-gap-box" }, h("p", null, `${plural(matrix.gaps, "gap")}: ${matrix.columns.map((c) => ({ label: c.label, open: c.values.filter((v) => v.gap).map((v) => v.label) })).filter((c) => c.open.length > 0).map((c) => `${c.label} (${c.open.join(", ")})`).join("; ")}. Ask your agent to draft variants for them:`), h("div", { class: "uc-prompt" }, h("code", null, prompt), h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": "Copy prompt", onClick: () => handlers.onCopy(prompt) }, icon("content_copy"))))
      : ctx.orphans.count > 0 || ctx.orphans.incomplete
        ? null
        : h("p", { class: "uc-muted" }, "Every trait value the persona pool uses is covered."),
    ctx.orphans.count > 0 ? orphanBox(ctx, useCaseId) : null,
    ctx.orphans.incomplete ? h("p", { class: "uc-muted", dataset: { orphans: "incomplete" } }, "The warning list of this case is incomplete (the tool caps it), so full coverage cannot be confirmed. Ask your agent to check it with get_use_case.") : null,
  );
}

/** The coverage card never claims full coverage while the case names what the pools lack: it says what, with the copy-prompt pattern of the gap box. */
function orphanBox(ctx, useCaseId) {
  const prompt = `Repair the missing references in ${useCaseId}`;
  const { coverage, repair } = orphanParts(ctx.orphans);
  return h(
    "div",
    { class: "uc-gap-box uc-orphan-box", dataset: { orphans: String(ctx.orphans.count) } },
    coverage.length > 0 ? h("p", null, `Coverage is incomplete: ${coverage.join("; ")}. These are not counted.`) : null,
    repair.length > 0 ? h("p", null, `References to repair: ${repair.join("; ")}.`) : null,
    h("p", null, "Ask your agent to repair them:"),
    h("div", { class: "uc-prompt" }, h("code", null, prompt), h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": "Copy prompt", onClick: () => ctx.handlers.onCopy(prompt) }, icon("content_copy"))),
  );
}

function dot(title) {
  return h("span", { class: "uc-dot", role: title ? "img" : null, "aria-label": title || null, title: title || null });
}

