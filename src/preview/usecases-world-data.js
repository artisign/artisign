// Use Cases tab — pure logic of the world model views (ADR-011, no DOM): participants, condition text, branch numbering and
// placement, the warning grammar of the bundle, and the variant differences of constellations, starting state and branches.
// Artisign never evaluates a condition: everything here only reads and arranges what get_use_case returns.

import { avatarOf, initials, plural, triggerKey } from "./usecases-data.js";

// --- Conditions -------------------------------------------------------------------------------------------------

/** Operator symbol (what a chip shows) and word (its accessible name; the editors use the words). */
export const OPERATORS = {
  eq: { symbol: "=", word: "equals" },
  ne: { symbol: "≠", word: "does not equal" },
  lt: { symbol: "<", word: "is less than" },
  lte: { symbol: "≤", word: "is at most" },
  gt: { symbol: ">", word: "is greater than" },
  gte: { symbol: "≥", word: "is at least" },
  in: { symbol: "in", word: "is one of" },
};

/** The text of a state or condition value: strings plain, a list as comma-separated items, anything else as compact JSON. */
export function conditionValueText(value) {
  if (Array.isArray(value)) return value.map(conditionValueText).join(", ");
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** @returns {{ key: string, symbol: string, word: string, value: string }} the three parts of a condition chip */
export function conditionParts(condition) {
  const op = OPERATORS[condition.op ?? "eq"] ?? OPERATORS.eq;
  return { key: `${condition.subject}.${condition.property}`, symbol: op.symbol, word: op.word, value: conditionValueText(condition.value) };
}

const conditionKey = (c) => `${c.subject}.${c.property}`;

// --- Participants ---------------------------------------------------------------------------------------------

export const KIND_ICONS = {
  human: { icon: "person", label: "Human" },
  agent: { icon: "smart_toy", label: "Agent" },
  service: { icon: "api", label: "Service" },
  organization: { icon: "corporate_fare", label: "Organization" },
};

/**
 * What an id names in the world of one bundle. One namespace (spec §2): a persona wins over an entity with the same id,
 * `system` is the app itself, anything else is unknown (the `unknown_participant` warning sits at its row).
 * @returns {{ kind: "persona" | "entity" | "system" | "unknown", id: string, name: string, avatar: any, persona?: any, entity?: any, type?: string }}
 */
export function participant(id, { bundle, pool }) {
  if (id === "system") return { kind: "system", id, name: "System", avatar: avatarOf("system") };
  const persona = (bundle?.personas ?? []).find((p) => p.id === id) ?? pool?.personasById?.get?.(id);
  if (persona) return { kind: "persona", id, name: persona.name, persona, avatar: avatarOf(id, new Map([[id, persona]])) };
  const entity = (bundle?.entities ?? []).find((e) => e.id === id);
  if (entity) return { kind: "entity", id, name: entity.name, entity, type: entity.type ?? "", avatar: { kind: "entity", text: entity.avatar?.emoji || initials(entity.name), color: "" } };
  return { kind: "unknown", id, name: id, avatar: { kind: "unknown", text: initials(id), color: "" } };
}

/** The members of a constellation: the ends of its relationships, in order of first appearance. */
export function constellationMembers(constellation) {
  const ids = [];
  for (const r of constellation.relationships ?? []) for (const id of [r.from, r.to]) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** A relationship type's label as a row reads it ("is parent of"), the id when the type is not in the bundle. */
export function relationLabel(typeId, bundle) {
  return (bundle?.relationship_types ?? []).find((t) => t.id === typeId)?.label ?? typeId;
}

// --- Branch numbering and placement -------------------------------------------------------------------------------

/** A, B, … Z, then AA, AB, … (a spreadsheet's columns): the letters never wrap around to a used one. */
export function branchLetter(n) {
  let out = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
  return out;
}

/**
 * The branches of an effective case with their design numbers: `<fork step number><letter>` (2A), no fork number before the first
 * step (A); the letters restart at every fork. A fork that is not a main-flow step (a dangling `from`) leads like "before the first
 * step" and is numbered with a "?" in place of the step number.
 * @returns {{ branch: any, label: string, forkIndex: number | null, forkStep: any | null, dangling: boolean }[]}
 */
export function numberBranches(useCase) {
  const steps = useCase.steps ?? [];
  const letters = new Map();
  return (useCase.branches ?? []).map((branch) => {
    const forkIndex = branch.from === undefined ? null : steps.findIndex((s) => s.id === branch.from);
    const dangling = branch.from !== undefined && forkIndex === -1;
    // One letter group per fork step; every branch with a dangling fork shares one group (they all lead, numbered "?A", "?B", …).
    const groupKey = branch.from === undefined ? "" : dangling ? "?" : branch.from;
    const n = letters.get(groupKey) ?? 0;
    letters.set(groupKey, n + 1);
    const letter = branchLetter(n);
    const prefix = branch.from === undefined ? "" : dangling ? "?" : String(forkIndex + 1);
    return { branch, label: `${prefix}${letter}`, forkIndex: dangling ? null : forkIndex, forkStep: dangling || branch.from === undefined ? null : steps[forkIndex], dangling };
  });
}

/** The branches that sit at one place of the flow: after the main step `stepId`, or (`null`) at the top, before the first step (no `from`, or a `from` that is no main step). The one placement rule of the detail, the mapping view and the numbering. */
export function lanesAtStep(numbered, stepId) {
  return numbered.filter((e) => (stepId === null ? e.branch.from === undefined || e.dangling : e.branch.from === stepId && !e.dangling));
}

/**
 * The steps of a case in flow order with their numbers: the branches that start before the first step, then every main step
 * (numbered 1, 2, …) followed by the branches forking after it (numbered 2A.1, 2A.2, …). `branch` is the numbered branch a step is in.
 * @returns {{ step: any, number: number | string, branch: ReturnType<typeof numberBranches>[number] | null }[]}
 */
export function flowSequence(steps, branches = []) {
  const numbered = numberBranches({ steps, branches });
  const out = [];
  const addLanes = (entries) => {
    for (const entry of entries) (entry.branch.steps ?? []).forEach((step, i) => out.push({ step, number: branchStepNumber(entry.label, i + 1), branch: entry }));
  };
  addLanes(lanesAtStep(numbered, null));
  steps.forEach((step, i) => {
    out.push({ step, number: i + 1, branch: null });
    addLanes(lanesAtStep(numbered, step.id));
  });
  return out;
}

/** `2A.1` for the first step of branch 2A. */
export function branchStepNumber(label, position) {
  return `${label}.${position}`;
}

/** Where the branch leaves the main flow, as the lane header says it. */
export function forkText(entry, steps) {
  if (entry.branch.from === undefined) return "before the first step";
  if (entry.dangling) return `after ${entry.branch.from}`;
  return `after step ${steps.findIndex((s) => s.id === entry.branch.from) + 1}`;
}

/** Where a branch goes on: the end badge's kind and text. */
export function branchEnd(branch, steps) {
  if (branch.rejoin === undefined) return { kind: "end", text: branch.outcome ? `Ends: ${branch.outcome}` : "Ends the case" };
  const index = steps.findIndex((s) => s.id === branch.rejoin);
  if (index === -1) return { kind: "warning", text: `Continues at ${branch.rejoin}, which is not a main-flow step` };
  return { kind: "rejoin", text: `Continues at step ${index + 1} · ${steps[index].action}` };
}

// --- Warnings at their targets (spec §6 grammar) ----------------------------------------------------------------

/**
 * Splits the bundle's warnings by where they belong. A target is `use_case:<id>[#<variant>]` followed by nothing (the case), `/trigger`,
 * `/trigger/state:<s>.<p>`, `/state:<s>.<p>`, `/branch:<id>`, `/branch:<id>/state:<s>.<p>`, `/constellation:<id>` or `/<step id>`.
 * A base view reads the targets without a variant, a variant view only its own (a variant repeats no base warning).
 */
export function warningsByTarget(warnings, useCaseId, variantId) {
  const at = `use_case:${useCaseId}${variantId ? `#${variantId}` : ""}`;
  const out = { case: [], trigger: [], triggerState: new Map(), state: new Map(), branch: new Map(), branchState: new Map(), constellation: new Map(), step: new Map(), pool: new Map() };
  const push = (map, key, w) => map.set(key, [...(map.get(key) ?? []), w]);
  for (const w of warnings ?? []) {
    const target = w.target ?? "";
    if (!target.startsWith("use_case:")) {
      push(out.pool, target, w);
      continue;
    }
    if (target !== at && !target.startsWith(`${at}/`)) continue;
    const rest = target.slice(at.length + 1);
    if (target === at) out.case.push(w);
    else if (rest === "trigger") out.trigger.push(w);
    else if (rest.startsWith("trigger/state:")) push(out.triggerState, rest.slice("trigger/state:".length), w);
    else if (rest.startsWith("state:")) push(out.state, rest.slice("state:".length), w);
    else if (rest.startsWith("constellation:")) push(out.constellation, rest.slice("constellation:".length), w);
    else if (rest.startsWith("branch:")) {
      const [id, ...tail] = rest.slice("branch:".length).split("/");
      if (tail.length === 0) push(out.branch, id, w);
      else if (tail[0].startsWith("state:")) push(out.branchState, `${id}/${tail[0].slice("state:".length)}`, w);
      else push(out.branch, id, w);
    } else push(out.step, rest, w);
  }
  return out;
}

/** The messages of a list of warnings joined into one line (a space between them); `null` when there are none. */
export const warningLine = (list) => (list && list.length > 0 ? list.map((w) => w.message).join(" ") : null);

// --- Starting state ---------------------------------------------------------------------------------------------

const stateKey = (e) => `${e.subject}.${e.property}`;

/**
 * The rows of the starting-state table. Base: the entries as stored. A variant: the effective entries each flagged `changed`,
 * `added` or `base` (from base, with the base value of a changed one), plus the unset ones from `removed_state`, each right after the
 * base entry that preceded it (at the top when none of its predecessors is shown).
 */
export function stateRows({ state = [], removedState = [], baseState = [], variantSelected }) {
  if (!variantSelected) return state.map((entry) => ({ entry, change: null }));
  const baseByKey = new Map(baseState.map((e) => [stateKey(e), e]));
  const rows = state.map((entry) => ({ entry, change: entry.change ?? "base", was: entry.change === "changed" ? baseByKey.get(stateKey(entry)) : undefined }));
  const baseKeys = baseState.map(stateKey);
  for (const entry of removedState) {
    let at = 0;
    for (let i = baseKeys.indexOf(stateKey(entry)) - 1; i >= 0; i--) {
      const found = rows.findIndex((row) => stateKey(row.entry) === baseKeys[i]);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    rows.splice(at, 0, { entry, change: "removed" });
  }
  return rows;
}

/** "1 changed · 1 added · 1 unset · 4 from base". */
export function stateSummary(rows) {
  const n = (c) => rows.filter((r) => r.change === c).length;
  return [n("changed") && `${n("changed")} changed`, n("added") && `${n("added")} added`, n("removed") && `${n("removed")} unset`, n("base") && `${n("base")} from base`].filter(Boolean).join(" · ");
}

// --- Constellations in a variant ------------------------------------------------------------------------------

/**
 * The constellation diff of a variant: every constellation of the variant's own list (`added` when the base does not list it, else
 * from base) and every base one the variant dropped (`removed`, with the members that are in no constellation of the variant left).
 */
export function constellationRows({ variantIds, baseIds, byId, bundle, pool }) {
  const rows = variantIds.map((id) => ({ id, change: baseIds.includes(id) ? "base" : "added", constellation: byId.get(id) ?? null }));
  const kept = variantIds.flatMap((id) => (byId.get(id) ? constellationMembers(byId.get(id)) : []));
  for (const id of baseIds) {
    if (variantIds.includes(id)) continue;
    const constellation = byId.get(id) ?? null;
    const orphans = constellation ? constellationMembers(constellation).filter((m) => !kept.includes(m)).map((m) => participant(m, { bundle, pool }).name) : [];
    rows.push({ id, change: "removed", constellation, orphans });
  }
  return rows;
}

/** "Jon is in no constellation of this variant" (at most three names). */
export function orphanText(names) {
  if (names.length === 0) return "";
  const shown = names.slice(0, 3);
  const list = names.length > 3 ? `${shown.join(", ")} and ${names.length - 3} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
  return `${list} ${names.length === 1 ? "is" : "are"} in no constellation of this variant`;
}

// --- Branches in a variant -------------------------------------------------------------------------------------

/**
 * The branch rows of a variant: each effective branch with its marker (`changed` / `added` from the bundle, `emptied` when a variant
 * left it without steps, else `base`), what the base had for a changed one, then the removed branches.
 */
export function branchRows({ numbered, baseBranches = [], removedBranches = [] }) {
  const baseById = new Map(baseBranches.map((b) => [b.id, b]));
  const rows = numbered.map((entry) => {
    const { branch } = entry;
    const base = baseById.get(branch.id);
    // Emptied is something a variant did: the branch is empty now and had steps in the base (one that is empty in the base is not the variant's doing).
    const emptied = (branch.steps ?? []).length === 0 && (base?.steps ?? []).length > 0;
    const change = emptied ? "emptied" : branch.change ?? "base";
    return { entry, change, base: change === "changed" ? base : undefined };
  });
  for (const branch of removedBranches) rows.push({ entry: null, change: "removed", removed: branch });
  return rows;
}

/** "Main flow unchanged · 1 changed · 1 added · 1 removed · 1 emptied". */
export function branchSummary(rows, mainDifferences) {
  const n = (c) => rows.filter((r) => r.change === c).length;
  return [mainDifferences === 0 ? "Main flow unchanged" : `Main flow ${plural(mainDifferences, "difference")}`, n("changed") && `${n("changed")} changed`, n("added") && `${n("added")} added`, n("removed") && `${n("removed")} removed`, n("emptied") && `${n("emptied")} emptied`].filter(Boolean).join(" · ");
}

/** The base conditions of a changed branch that the variant no longer has exactly as written. */
export function whenWas(branch, base) {
  if (!base) return null;
  const sig = (c) => JSON.stringify([conditionKey(c), c.op ?? "eq", c.value]);
  const now = new Set((branch.when ?? []).map(sig));
  const was = (base.when ?? []).filter((c) => !now.has(sig(c)));
  return was.length === 0 ? null : was;
}

/** The base steps of a changed branch the variant no longer has (by id), for the struck "Base:" lines. */
export function droppedBranchSteps(branch, base) {
  if (!base) return [];
  const kept = new Set((branch.steps ?? []).map((s) => s.id));
  return (base.steps ?? []).filter((s) => !kept.has(s.id));
}

// --- Trigger -------------------------------------------------------------------------------------------------

/** The object form of a trigger whichever way it came (a string is text only). */
export function triggerObject(trigger) {
  if (trigger === undefined || trigger === null) return { text: "" };
  return typeof trigger === "string" ? { text: trigger } : trigger;
}

/** "an action" or "a state or time": the label next to "Trigger". */
export function triggerKind(trigger) {
  const t = triggerObject(trigger);
  if (t.actor !== undefined) return "an action";
  if ((t.state ?? []).length > 0 || t.at !== undefined) return "a state or time";
  return "";
}

export const triggerChanged = (a, b) => triggerKey(a) !== triggerKey(b);

// --- Variant "applies when" -------------------------------------------------------------------------------------

/** The scope of a dimension; stored dimensions without one are persona dimensions (spec §3.1). */
export const scopeOf = (dimension) => dimension?.scope ?? "personas";

/** Constellations whose traits satisfy a `when` on constellation-scoped dimensions (any-of per dimension, all must match). */
export function matchingConstellations(when, constellations, dimensionsById) {
  const entries = Object.entries(when ?? {}).filter(([dimension]) => scopeOf(dimensionsById.get(dimension)) === "constellations");
  if (entries.length === 0) return [];
  return constellations.filter((c) => entries.every(([dimension, values]) => values.includes(c.traits?.[dimension])));
}

/** "a world trait", "a persona trait" or both, by the scopes of the dimensions a `when` names. */
export function whenScopeText(when, dimensionsById) {
  const scopes = new Set(Object.keys(when ?? {}).map((d) => scopeOf(dimensionsById.get(d))));
  if (scopes.has("constellations") && scopes.has("personas")) return "world and persona traits";
  return scopes.has("constellations") ? "a world trait" : "a persona trait";
}
