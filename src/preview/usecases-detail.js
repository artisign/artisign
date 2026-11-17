// Use Cases tab — the detail view of one use case: header, variant chips, people, trigger / goal / outcome, the flow as a
// step sequence (actor, action, target chip, before/after data cards), inputs and outputs as data-object cards, and for a
// selected variant the difference against the base plus the coverage matrix. Built from get_use_case bundles
// (see the use-case spec); a variant is always shown as a diff, never as a full copy.

import { h, icon } from "./usecases-dom.js";
import { openMenu } from "./usecases-menu.js";
import { avatar, statusBadge, diffBadge, targetChip, dataCard, variantChip } from "./usecases-parts.js";
import {
  avatarOf,
  actorName,
  buildFlowRows,
  mappingFor,
  stepScope,
  fieldRows,
  ioChangedKeys,
  changedKeys,
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
    .map(([dimension, value]) => dimensionsById.get(dimension)?.values.find((v) => v.id === value)?.label ?? value)
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
  const matrix = coverageMatrix({ dimensions: pool.dimensions, pool: pool.personas, basePersonas, variants, uncovered: ctx.suggest?.coverage });
  const showCoverage = variants.length > 0 || matrix.gaps > 0 ? ctx.coverageOpen || Boolean(variantId) : false;

  const main = h("div", { class: "uc-detail-main" });
  main.append(header(ctx, useCase));
  main.append(variantBar(ctx, variants, source, matrix));
  if (variantInfo) main.append(variantPanel(ctx, variantInfo, sourceVariant));
  const peopleRow = people(ctx, useCase);
  if (peopleRow) main.append(peopleRow); // Node.append(null) would add the text "null"
  // The matrix is a full-width section of the detail column (not a narrow side panel): twelve columns need the room.
  if (showCoverage) main.append(coveragePanel(ctx, matrix));
  main.append(story(useCase, baseCase, sourceVariant));
  main.append(flow(ctx, useCase));
  main.append(inputsOutputs(ctx, useCase, baseCase, sourceVariant));

  root.replaceChildren(h("div", { class: "uc-detail" }, main));
}

function header(ctx, useCase) {
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
        h("button", { type: "button", class: "chrome-btn", onClick: handlers.onEdit }, icon("edit"), "Edit"),
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
  );
}

function variantBar(ctx, variants, source, matrix) {
  const { handlers, variantId } = ctx;
  const baseCase = ctx.base.use_case;
  const chips = [variantChip({ label: "Base", meta: plural(baseCase.steps.length, "step"), selected: !variantId, onClick: () => handlers.onVariant(null) })];
  for (const variant of variants) {
    const raw = (source?.variants ?? []).find((v) => v.id === variant.id);
    const changes = raw ? variantChangeCount(raw, baseCase.steps) : 0;
    chips.push(variantChip({ label: variant.title, meta: raw ? plural(changes, "change") : "", selected: variantId === variant.id, title: variant.description, onClick: () => handlers.onVariant(variant.id) }));
  }
  chips.push(variantChip({ label: "Variant", add: true, onClick: handlers.onAddVariant, title: "Add a variant" }));
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

function variantPanel(ctx, variant, raw) {
  const { pool } = ctx;
  const conditions = whenEntries(variant.when, pool.dimensionsById);
  const matches = matchingPersonas(variant.when, pool.personas);
  const overrides = ["personas", "trigger", "goal", "outcome", "inputs", "outputs"].filter((key) => raw?.[key] !== undefined);
  return h(
    "div",
    { class: "uc-variant-panel" },
    h(
      "div",
      { class: "uc-applies" },
      h("span", { class: "uc-muted" }, "Applies when"),
      conditions.map((entry) => h("span", { class: "uc-when" }, h("span", { class: "uc-when-dim" }, entry.label), h("span", { class: "uc-when-values" }, entry.values.map((v) => v.label).join(" or ")))),
      h("span", { class: "uc-muted" }, `· matches ${plural(matches.length, "persona")}`),
      h("span", { class: "uc-avatar-stack" }, matches.slice(0, 5).map((p) => avatar(avatarOf(p.id, pool.personasById), "sm", p.name))),
    ),
    variant.description ? h("p", { class: "uc-variant-desc" }, variant.description) : null,
    h(
      "div",
      { class: "uc-legend" },
      h("span", { class: "uc-muted" }, "Against base"),
      diffBadge("changed"),
      diffBadge("added"),
      diffBadge("removed"),
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
      const sub = persona ? [persona.role, traitSummary(persona, pool.dimensionsById)].filter(Boolean).join(" · ") : "Unknown persona";
      return h(
        "div",
        { class: "uc-person" },
        avatar(avatarOf(id, pool.personasById), "lg"),
        h("div", { class: "uc-person-text" }, h("span", { class: "uc-person-name" }, actorName(id, pool.personasById)), h("span", { class: "uc-person-sub" }, sub)),
      );
    }),
  );
}

function story(useCase, baseCase, rawVariant) {
  const cells = [
    ["bolt", "Trigger", "trigger"],
    ["flag", "Goal", "goal"],
    ["task_alt", "Outcome", "outcome"],
  ];
  return h(
    "div",
    { class: "uc-story" },
    cells.map(([ic, label, key]) =>
      h("div", { class: "uc-story-cell" }, h("div", { class: "uc-story-label" }, icon(ic), label, rawVariant?.[key] !== undefined && rawVariant[key] !== baseCase[key] ? diffBadge("changed") : null), h("p", null, useCase[key] ?? h("span", { class: "uc-muted" }, "—"))),
    ),
  );
}

function flowSummary(rows, variantSelected) {
  const steps = rows.filter((r) => r.kind === "step");
  const screens = new Set(steps.map((r) => r.step.target?.screen).filter(Boolean));
  const elements = steps.filter((r) => r.step.target?.node).length;
  if (!variantSelected) return `${plural(steps.length, "step")} · ${plural(screens.size, "screen")} · ${plural(elements, "element")}`;
  const count = (kind) => steps.filter((r) => r.change === kind).length;
  const removed = rows.filter((r) => r.kind === "removed").length;
  return `${plural(steps.length, "step")} in this variant · ${count("changed")} changed · ${count("added")} added · ${removed} removed`;
}

function flow(ctx, useCase) {
  const { bundle, base, variantId } = ctx;
  const rows = buildFlowRows({ steps: useCase.steps ?? [], removedSteps: bundle.removed_steps ?? [], baseSteps: base.use_case.steps ?? [], variantSelected: Boolean(variantId) });
  const list = h("ol", { class: "uc-flow" });
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
    list.append(stepRow(ctx, row));
  }
  return h("section", { class: "uc-section" }, h("h2", { class: "uc-h2" }, "Flow", h("span", { class: "uc-h2-meta" }, flowSummary(rows, Boolean(variantId)))), rows.length === 0 ? h("p", { class: "uc-muted" }, "No steps yet.") : list);
}

function stepRow(ctx, row) {
  const { bundle, pool, handlers } = ctx;
  const step = row.step;
  const found = mappingFor(bundle, step.id);
  const mapping = found?.mapping;
  const scope = stepScope(step, mapping);
  const note = mappingNote(step, mapping, found?.screen);
  const was = row.was;
  const card = h(
    "div",
    { class: "uc-step-card", dataset: { change: row.change ?? "" } },
    h("div", { class: "uc-step-head" }, h("span", { class: "uc-step-no" }, `Step ${row.number} · ${actorName(step.actor, pool.personasById)}`), row.change === "changed" ? diffBadge("changed") : row.change === "added" ? diffBadge("added") : row.change === "base" ? diffBadge("base") : null),
    h("p", { class: "uc-step-action" }, step.action),
    was?.actor ? h("p", { class: "uc-step-was" }, "Actor was ", h("s", null, actorName(was.actor, pool.personasById))) : null,
    was?.action ? h("p", { class: "uc-step-was" }, "Base: ", h("s", null, was.action)) : null,
    was?.target ? h("p", { class: "uc-step-was" }, "Target was ", h("s", null, was.target)) : null,
    step.target ? targetChip(scope, step.target.screen, step.target.node, () => handlers.onMap(step.id)) : h("span", { class: "uc-muted uc-no-target" }, "Not mapped to a screen"),
    note,
  );
  const data = (step.data ?? []).map((entry) => {
    const name = pool.objectsById.get(entry.object)?.name ?? entry.object;
    const changed = changedKeys(entry.before, entry.after);
    return h("div", { class: "uc-step-data" }, dataCard("before", name, entry.before ?? {}, new Set()), icon("arrow_forward", "uc-data-arrow"), dataCard("after", name, entry.after ?? {}, changed));
  });
  return h("li", { class: "uc-step", dataset: { change: row.change ?? "", step: step.id } }, h("span", { class: "uc-step-rail" }, avatar(avatarOf(step.actor, pool.personasById), "lg", actorName(step.actor, pool.personasById))), card, data.length > 0 ? h("div", { class: "uc-step-datas" }, data) : null);
}

/** The warning line under a target chip: stale screen / stale node / generated node id. */
function mappingNote(step, mapping, screenEntry) {
  if (!step.target || !mapping) return null;
  if (mapping.stale) {
    const text = screenEntry && screenEntry.exists === false ? `Screen ${step.target.screen} no longer exists. Pick a new target.` : `Element ${step.target.node} no longer exists on ${step.target.screen}. Pick a new target.`;
    return h("p", { class: "uc-warn" }, icon("warning"), text);
  }
  if (mapping.unstable) return h("p", { class: "uc-warn" }, icon("warning"), `${step.target.node} is a generated id: it can point at another element after a rewrite. Give the node an authored id.`);
  return null;
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
    h("div", { class: "uc-io-head" }, h("span", { class: "uc-io-name" }, object?.name ?? item.object), h("span", { class: "uc-io-id" }, item.object), h("span", { class: "uc-io-side" }, sideLabel)),
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
  const head1 = h("tr", null, h("th", { rowspan: "2", scope: "col", class: "uc-matrix-first" }, "Flow"));
  const head2 = h("tr");
  for (const column of matrix.columns) {
    head1.append(h("th", { colspan: String(column.values.length), scope: "colgroup", class: "uc-matrix-dim" }, column.label));
    for (const value of column.values) head2.append(h("th", { scope: "col", class: value.gap ? "is-gap" : "", title: value.gap ? `${value.label}: not covered` : value.label }, value.label, value.gap ? h("span", { class: "uc-gap-tag" }, "gap") : null));
  }
  table.append(h("thead", null, head1, head2));
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
    h("p", { class: "uc-muted uc-coverage-intro" }, "Rows are the base flow and each variant, columns the trait values of your persona pool."),
    matrix.columns.length === 0 ? h("p", { class: "uc-muted" }, "No persona traits to cover yet.") : h("div", { class: "uc-matrix-wrap" }, table),
    h("p", { class: "uc-legend-line" }, dot(""), " The flow handles this value: for Base from the traits of its personas, for a variant the values named in its when. any: no condition on that dimension (a persona or variant without it). A column that neither Base nor any variant covers is a gap, the same rule as suggest_use_case_variants."),
    matrix.gaps > 0
      ? h("div", { class: "uc-gap-box" }, h("p", null, `${plural(matrix.gaps, "gap")}: ${matrix.columns.map((c) => ({ label: c.label, open: c.values.filter((v) => v.gap).map((v) => v.label) })).filter((c) => c.open.length > 0).map((c) => `${c.label} (${c.open.join(", ")})`).join("; ")}. Ask your agent to draft variants for them:`), h("div", { class: "uc-prompt" }, h("code", null, prompt), h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": "Copy prompt", onClick: () => handlers.onCopy(prompt) }, icon("content_copy"))))
      : h("p", { class: "uc-muted" }, "Every trait value the persona pool uses is covered."),
  );
}

function dot(title) {
  return h("span", { class: "uc-dot", role: title ? "img" : null, "aria-label": title || null, title: title || null });
}

