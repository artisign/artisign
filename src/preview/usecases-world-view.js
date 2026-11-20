// Use Cases tab — the world model sections of the detail view (ADR-011, design chr-1146): the trigger line, the World card(s),
// the starting-state table, branch lanes, and for a selected variant the differences of constellations, trigger, state and branches.
// Built from get_use_case bundles; warnings sit at their targets, never block, and Artisign never picks a branch.

import { h, icon } from "./usecases-dom.js";
import { avatar, diffBadge, targetChip, traitChip } from "./usecases-parts.js";
import { triggerText, mappingFor, stepScope, plural } from "./usecases-data.js";
import { actorKind, branchEndChip, conditionChip, conditionList, entityAvatar, mappingNote, participantChip, relationRow, stepDataBlock, timeChip, warnLine } from "./usecases-world-parts.js";
import {
  participant,
  constellationMembers,
  relationLabel,
  numberBranches,
  branchStepNumber,
  forkText,
  branchEnd,
  stateRows,
  stateSummary,
  constellationRows,
  orphanText,
  branchRows,
  branchSummary,
  whenWas,
  droppedBranchSteps,
  triggerObject,
  triggerKind,
  triggerChanged,
  warningLine,
  conditionParts,
  conditionValueText,
  lanesAtStep,
} from "./usecases-world-data.js";

const dimensionOf = (ctx, id) => (ctx.bundle.dimensions ?? []).find((d) => d.id === id) ?? ctx.pool.dimensionsById.get(id);

/** A participant's avatar at a size: round colour for a persona, square for an entity, the chip icon for the system. */
export function participantAvatar(p, size = "md") {
  if (p.kind === "entity") return entityAvatar(p.avatar, size, p.name);
  return avatar(p.avatar, size, p.name);
}

/** The constellation traits as `uc-trait-chip`s: "Household | Two parents". */
function traitChips(ctx, traits) {
  return Object.entries(traits ?? {}).map(([dimension, value]) => {
    const dim = dimensionOf(ctx, dimension);
    return traitChip(dim?.label ?? dimension, dim?.values.find((v) => v.id === value)?.label ?? value);
  });
}

// --- Trigger -----------------------------------------------------------------------------------------------

function triggerBody(ctx, trigger, w) {
  const t = triggerObject(trigger);
  const text = triggerText(trigger);
  const kids = [];
  if (t.actor !== undefined) {
    const p = participant(t.actor, ctx);
    kids.push(h("span", { class: "uc-trigger-actor" }, participantAvatar(p), h("span", { class: "uc-trigger-name" }, p.name), p.kind === "persona" ? actorKind(p.persona?.kind) : null));
  } else if ((t.state ?? []).length > 0 || t.at !== undefined) {
    kids.push(h("span", { class: "uc-trigger-conds" }, h("span", { class: "uc-muted" }, "When"), conditionList(t.state ?? [], { warnings: (c) => w.triggerState.get(`${c.subject}.${c.property}`) }), t.at !== undefined ? timeChip(t.at) : null));
  }
  kids.push(h("span", { class: "uc-trigger-text" }, text || (kids.length === 0 ? h("span", { class: "uc-muted" }, "—") : "")));
  if (t.via !== undefined) kids.push(h("span", { class: "uc-trigger-via" }, "via", h("span", { class: "uc-chip" }, t.via)));
  return h("div", { class: "uc-trigger-body" }, kids);
}

/**
 * The top row of the story card. `changed` marks a variant trigger (it replaces the base trigger whole, so the base one is
 * shown as a "Base:" line).
 */
export function triggerRow(ctx, { trigger, baseTrigger, changed, w }) {
  const kind = triggerKind(trigger);
  const wl = warningLine(w.trigger);
  const stateLines = [...w.triggerState.values()].flat().map((x) => x.message);
  const baseNote = changed && baseTrigger !== undefined ? baseTriggerLine(baseTrigger) : null;
  return h(
    "div",
    { class: "uc-trigger", dataset: { change: changed ? "changed" : "" } },
    h("div", { class: "uc-story-label" }, icon("bolt"), `Trigger${kind ? ` · ${kind}` : ""}`, changed ? diffBadge("changed") : null),
    triggerBody(ctx, trigger, w),
    baseNote,
    warnLine(wl),
    stateLines.map((line) => warnLine(line)),
  );
}

/** "Base: via webhook": what the base trigger said that the variant's does not. */
function baseTriggerLine(trigger) {
  const t = triggerObject(trigger);
  const parts = [];
  if (t.text) parts.push(t.text);
  if (t.via !== undefined) parts.push(`via ${t.via}`);
  if ((t.state ?? []).length > 0) parts.push(`when ${t.state.map((c) => conditionParts(c).key).join(", ")}`);
  if (t.at !== undefined) parts.push(`from ${t.at}`);
  return h("p", { class: "uc-step-was" }, "Base: ", h("s", null, parts.join(" · ") || "no trigger"));
}

// --- World -----------------------------------------------------------------------------------------------------

function constellationCard(ctx, constellation, w) {
  const members = constellationMembers(constellation);
  const rels = (constellation.relationships ?? []).map((r) => {
    const from = participant(r.from, ctx);
    const to = participant(r.to, ctx);
    return relationRow({ from: from.name, label: relationLabel(r.type, ctx.bundle), to: to.name, note: r.note });
  });
  return h(
    "article",
    { class: "uc-cst", dataset: { constellation: constellation.id } },
    h("header", { class: "uc-cst-head" }, h("h3", { class: "uc-cst-name" }, constellation.name), (traitsOf(constellation)).length > 0 ? h("span", { class: "uc-cst-traits" }, traitChips(ctx, constellation.traits)) : null),
    rels.length > 0 ? h("ul", { class: "uc-cst-rels", "aria-label": `Relationships in ${constellation.name}` }, rels) : h("p", { class: "uc-muted uc-cst-empty" }, "No relationships yet."),
    h("div", { class: "uc-cst-members" }, h("span", { class: "uc-muted" }, "Members"), members.map((id) => participantChip(participant(id, ctx)))),
    w.constellation.get(constellation.id)?.length ? h("div", { class: "uc-cst-warn" }, w.constellation.get(constellation.id).map((x) => warnLine(x.message))) : null,
  );
}

const traitsOf = (c) => Object.keys(c.traits ?? {});

function unknownConstellationCard(id) {
  return h("article", { class: "uc-cst is-unknown", dataset: { constellation: id } }, h("span", { class: "uc-mono" }, id), warnLine("Not in the world pool. Create the constellation in World or remove it from this case."));
}

/** The World section of the base view: one card per constellation of the case, an unknown one as a dashed amber card. */
export function worldSection(ctx, w) {
  const ids = ctx.bundle.use_case.constellations ?? [];
  if (ids.length === 0) return null;
  const byId = new Map((ctx.bundle.constellations ?? []).map((c) => [c.id, c]));
  return h(
    "section",
    { class: "uc-section", "aria-labelledby": "uc-world-h" },
    h("div", { class: "uc-h2-row" }, h("h2", { class: "uc-h2", id: "uc-world-h" }, "World", h("span", { class: "uc-h2-meta" }, `${plural(ids.length, "constellation")} · the case holds ${ids.length === 1 ? "in it" : "in any of them"}`), ctx.handlers.onOpenWorld ? h("button", { type: "button", class: "chrome-btn chrome-btn--ghost chrome-btn--compact uc-h2-action", onClick: ctx.handlers.onOpenWorld }, "Open in World") : null)),
    h("div", { class: "uc-cst-grid" }, ids.map((id) => (byId.has(id) ? constellationCard(ctx, byId.get(id), w) : unknownConstellationCard(id)))),
  );
}

/** The World section of a variant: its own list against the base (From base / Added), the ones it dropped (Removed, with why). */
export function worldDiffSection(ctx, rawVariant, w) {
  const { bundle, base } = ctx;
  const variantIds = bundle.use_case.constellations ?? [];
  const baseIds = base.use_case.constellations ?? [];
  if (variantIds.length === 0 && baseIds.length === 0) return null;
  const byId = new Map([...(base.constellations ?? []), ...(bundle.constellations ?? [])].map((c) => [c.id, c]));
  const rows = constellationRows({ variantIds, baseIds, byId, bundle: { ...bundle, personas: [...(bundle.personas ?? []), ...(base.personas ?? [])], entities: [...(bundle.entities ?? []), ...(base.entities ?? [])] }, pool: ctx.pool });
  const own = rawVariant?.constellations !== undefined;
  return h(
    "section",
    { class: "uc-section", "aria-labelledby": "uc-world-h" },
    h("div", { class: "uc-h2-row" }, h("h2", { class: "uc-h2", id: "uc-world-h" }, "World", h("span", { class: "uc-h2-meta" }, own ? "The variant sets its own constellations" : "Constellations of the base case"))),
    h("ul", { class: "uc-diff-list" }, rows.map((row) => constellationDiffRow(ctx, row, w))),
  );
}

function constellationDiffRow(ctx, row, w) {
  const { constellation } = row;
  const name = constellation?.name ?? row.id;
  const members = constellation ? constellationMembers(constellation).map((id) => participant(id, ctx).name).join(" · ") : "";
  const why = row.change === "removed" ? orphanText(row.orphans ?? []) : !constellation ? "Not in the world pool. Create it in World or remove it from this variant." : members;
  return h(
    "li",
    { class: "uc-diff-row", dataset: { change: row.change, constellation: row.id } },
    icon("hub", "uc-diff-row-icon"),
    row.change === "removed" ? h("s", { class: "uc-diff-row-name" }, name) : h("span", { class: "uc-diff-row-name" }, name),
    h("span", { class: `uc-diff-row-sub${!constellation && row.change !== "removed" ? " is-warn" : ""}` }, why),
    row.change === "base" ? diffBadge("base") : row.change === "added" ? diffBadge("added") : diffBadge("removed"),
    (w.constellation.get(row.id) ?? []).map((x) => warnLine(x.message)),
  );
}

// --- Starting state -----------------------------------------------------------------------------------------------

function subjectCell(ctx, id, change, flagged) {
  const p = participant(id, ctx);
  // An unknown id is a mono id; it carries the warning mark only where the warning itself is shown (a variant repeats no base warning).
  if (p.kind === "unknown") return h("span", { class: flagged ? "uc-subject is-unknown" : "uc-subject" }, flagged ? icon("warning") : null, h("span", { class: "uc-mono" }, id));
  const body = h("span", { class: "uc-subject" }, participantAvatar(p, "sm"), change === "removed" ? h("s", null, p.name) : p.name);
  return body;
}

/** The Starting state table (`uc-state-table`); with a variant an "Against base" column and its row markers. */
export function stateSection(ctx, { rows, w, variantSelected }) {
  if (rows.length === 0) return null;
  const summary = variantSelected ? stateSummary(rows) : "Values at the start of the case. Artisign stores them, it never evaluates them.";
  const head = ["Subject", "Property", "Value", variantSelected ? "Against base" : null].filter(Boolean);
  const body = rows.map(({ entry, change, was }) => {
    const key = `${entry.subject}.${entry.property}`;
    const warnings = w.state.get(key) ?? [];
    const unknown = participant(entry.subject, ctx).kind === "unknown" && warnings.length > 0;
    // An unknown subject says it in the design's neutral words; other warnings keep the tool's message.
    const message = unknown ? `${entry.subject} is neither a persona nor an entity. Add it to the world or correct the id.` : warningLine(warnings);
    const value =
      change === "removed"
        ? h("span", null, "Unset · base was ", h("s", { class: "uc-mono" }, conditionValueText(entry.value)))
        : h("span", { class: "uc-mono" }, was ? [conditionValueText(entry.value), " ", h("s", { class: "uc-old" }, conditionValueText(was.value))] : conditionValueText(entry.value));
    const struck = (text) => (change === "removed" ? h("s", null, text) : text);
    return h(
      "tr",
      { class: unknown || warnings.length > 0 ? "has-warning" : "", dataset: { change: change ?? "", key } },
      h("th", { scope: "row" }, subjectCell(ctx, entry.subject, change, unknown)),
      h("td", { class: "uc-mono" }, struck(entry.property)),
      h("td", null, value, message ? h("span", { class: "uc-state-warn" }, message) : null),
      variantSelected ? h("td", { class: "uc-state-diff" }, change === "changed" ? diffBadge("changed") : change === "added" ? diffBadge("added") : change === "removed" ? diffBadge("removed") : diffBadge("base")) : null,
    );
  });
  return h(
    "section",
    { class: "uc-section", "aria-labelledby": "uc-state-h" },
    h("div", { class: "uc-h2-row" }, h("h2", { class: "uc-h2", id: "uc-state-h" }, "Starting state", h("span", { class: "uc-h2-meta" }, summary))),
    h("div", { class: "uc-state-wrap", role: "region", "aria-labelledby": "uc-state-h", tabindex: "0" }, h("table", { class: "uc-state", dataset: { variant: variantSelected ? "true" : "false" } }, h("thead", null, h("tr", null, head.map((text) => h("th", { scope: "col" }, text)))), h("tbody", null, body))),
    variantSelected ? h("p", { class: "uc-muted uc-state-note" }, "Warnings the base already has show on Base only.") : null,
  );
}

export { stateRows };

// --- Branch lanes -------------------------------------------------------------------------------------------------

function laneStep(ctx, branchEntry, step, position, w) {
  const { bundle, handlers } = ctx;
  const p = participant(step.actor, ctx);
  const found = mappingFor(bundle, step.id);
  const scope = stepScope(step, found?.mapping);
  const note = mappingNote(step, found?.mapping, found?.screen);
  const stepWarnings = (w.step.get(step.id) ?? []).filter((x) => !x.kind.startsWith("mapping_"));
  return h(
    "li",
    { class: "uc-lane-step", dataset: { step: step.id, change: step.change ?? "" } },
    participantAvatar(p),
    h(
      "div",
      { class: "uc-lane-step-body" },
      h("span", { class: "uc-step-no" }, `Step ${branchStepNumber(branchEntry.label, position)} · ${p.name}${step.via ? ` · via ${step.via}` : ""}`),
      h("span", { class: "uc-lane-step-action" }, step.action),
      step.target ? targetChip(scope, step.target.screen, step.target.node, () => handlers.onMap(step.id)) : null,
      note,
      stepWarnings.map((x) => warnLine(x.message)),
      stepDataBlock(step, ctx.pool.objectsById),
    ),
  );
}

function laneHead(ctx, entry, steps, change, w) {
  const { branch } = entry;
  const branchWarnings = w.branch.get(branch.id) ?? [];
  return h(
    "div",
    { class: "uc-lane-head" },
    h("div", { class: "uc-lane-title" }, icon("call_split", "uc-lane-icon"), h("span", { class: "uc-lane-name" }, `Branch ${entry.label}`), h("span", { class: "uc-lane-branch-title" }, branch.title), change === "changed" ? diffBadge("changed") : change === "added" ? diffBadge("added") : change === "emptied" ? diffBadge("emptied") : null, h("span", { class: "uc-lane-where" }, forkText(entry, steps))),
    // An emptied branch says it in the lane's own words; the tool's branch_empty line would repeat it.
    branchWarnings.filter((x) => !(change === "emptied" && x.kind === "branch_empty")).map((x) => warnLine(x.message)),
  );
}

/** The When line: conditions joined by "and"; a condition with a warning at its chip is underlined, with the message under the line. */
function whenLine(branch, w, was) {
  const stateWarn = (c) => w.branchState.get(`${branch.id}/${c.subject}.${c.property}`);
  const messages = (branch.when ?? []).flatMap((c) => (stateWarn(c) ?? []).map((x) => x.message));
  const dropped = was ?? [];
  const sameKeyOnly = dropped.length === 1 && (branch.when ?? []).some((c) => c.subject === dropped[0].subject && c.property === dropped[0].property);
  return h(
    "div",
    { class: "uc-lane-when" },
    h("span", { class: "uc-muted" }, "When"),
    conditionList(branch.when ?? [], { warnings: stateWarn }),
    dropped.length > 0 ? (sameKeyOnly ? h("span", { class: "uc-lane-base" }, "base ", h("s", null, conditionParts(dropped[0]).value)) : h("span", { class: "uc-lane-base" }, "Base: ", dropped.map((c, i) => [i > 0 ? " and " : null, conditionChip(c, { struck: true })]))) : null,
    messages.map((m) => warnLine(m)),
  );
}

/**
 * One branch lane (`uc-branch-lane`). Base view: the lane inside the flow list. Variant view (`diff`): a card of the Branches section
 * with its marker, what the base had, and the emptied message.
 */
export function branchLane(ctx, entry, w, { change = null, base = null } = {}) {
  const { bundle } = ctx;
  const steps = bundle.use_case.steps ?? [];
  const { branch } = entry;
  const end = branchEnd(branch, steps);
  const emptied = change === "emptied";
  const dropped = droppedBranchSteps(branch, base);
  const was = whenWas(branch, base);
  const body = emptied
    ? [h("p", { class: "uc-warn" }, icon("warning"), `This variant removes the only step of the branch (${branchStepNumber(entry.label, 1)}). Remove the branch too, or give it a step.`)]
    : [
        whenLine(branch, w, was),
        h("ol", { class: "uc-lane-steps" }, (branch.steps ?? []).map((step, i) => laneStep(ctx, entry, step, i + 1, w))),
        dropped.map((s) => h("p", { class: "uc-step-was" }, "Base: ", h("s", null, `${participant(s.actor, ctx).name} ${s.action}`.trim()))),
        branchEndChip(end.kind, end.text),
      ];
  const label = `Branch ${entry.label}, ${forkText(entry, steps)}`;
  return h("div", { class: "uc-lane-card", dataset: { branch: branch.id, change: change ?? "" }, role: "group", "aria-label": label }, laneHead(ctx, entry, steps, change, w), body);
}

/** The lanes forking after a main-flow step (or before the first one, `stepId` null) as `<li>`s of the flow list. */
export function lanesAt(ctx, numbered, stepId, w) {
  return lanesAtStep(numbered, stepId).map((entry) => h("li", { class: "uc-lane", dataset: { branch: entry.branch.id } }, branchLane(ctx, entry, w)));
}

/** The lines under a main-flow step row: which branches fork here and which continue here. */
export function stepBranchNotes(numbered, stepId) {
  const forks = numbered.filter((e) => e.branch.from === stepId && !e.dangling);
  const rejoins = numbered.filter((e) => e.branch.rejoin === stepId);
  return [
    ...rejoins.map((e) => h("p", { class: "uc-step-branch-note" }, icon("u_turn_left"), `Branch ${e.label} continues here`)),
    forks.length > 0 ? h("p", { class: "uc-step-branch-note" }, icon("call_split"), `${plural(forks.length, "branch", "branches")} fork${forks.length === 1 ? "s" : ""} here`) : null,
  ];
}

/** The Branches section of a variant: changed / added / emptied / removed branches (and the unchanged ones) with the main-flow summary. */
export function branchesDiffSection(ctx, w, mainDifferences) {
  const { bundle, base } = ctx;
  const numbered = numberBranches(bundle.use_case);
  const rows = branchRows({ numbered, baseBranches: base.use_case.branches ?? [], removedBranches: bundle.removed_branches ?? [] });
  if (rows.length === 0) return null;
  const baseNumbered = numberBranches(base.use_case);
  const cards = rows.map((row) => {
    if (row.change === "removed") {
      const label = baseNumbered.find((e) => e.branch.id === row.removed.id)?.label;
      return h("li", { class: "uc-diff-row", dataset: { change: "removed", branch: row.removed.id } }, icon("call_split", "uc-diff-row-icon"), h("s", { class: "uc-diff-row-name" }, label ? `Branch ${label} · ${row.removed.title}` : `Branch · ${row.removed.title}`), diffBadge("removed"));
    }
    return h("li", { class: "uc-lane-li" }, branchLane(ctx, row.entry, w, { change: row.change === "base" ? null : row.change, base: row.base }));
  });
  return h(
    "section",
    { class: "uc-section", "aria-labelledby": "uc-branches-h" },
    h("div", { class: "uc-h2-row" }, h("h2", { class: "uc-h2", id: "uc-branches-h" }, "Branches", h("span", { class: "uc-h2-meta" }, branchSummary(rows, mainDifferences)))),
    h("ul", { class: "uc-diff-list uc-branch-list" }, cards),
  );
}

export { numberBranches, triggerChanged };
