// Use Cases tab — the pure part of the world editors (ADR-011, CHR-1154, no DOM): the value text rule of states and conditions,
// state rows, conditions, the trigger in its three forms, branches, and the payload builders of entities, relationship types
// and constellations. Everything a Save blocks on is a shape error (spec §6); a reference problem is a warning and never blocks.
// Artisign never evaluates a state or a condition: the editors only store what was typed.

import { slugify, uniqueId, isValidId } from "./usecases-data.js";
import { buildStepObject, stepDraft, emptyStep } from "./usecases-variant-edit.js";

// --- Operators and values ------------------------------------------------------------------------------------------

/** The editors use the words; the read views show the symbols (Use-Cases-Spec §11). The stored `op` is the value. */
export const CONDITION_WORDS = [
  { value: "eq", label: "is" },
  { value: "ne", label: "is not" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "at most" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "at least" },
  { value: "in", label: "is one of" },
];

/** The operator symbol of each word, for the legend under the condition rows. */
export const CONDITION_SYMBOLS = { eq: "=", ne: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥", in: "in" };

export const VALUE_HELP = 'Values: true or false, a number (17, 0.15) or text. A date stays text (2027-01-01); quotes keep a number as text ("17").';

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** The value a text stands for (design rule 3): true / false → boolean, a plain number → number, quotes force a string, else text. */
export function parseStateValue(text) {
  const t = String(text ?? "").trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not a JSON string: the quotes are the user's own, take what is between them
    }
    return t.slice(1, -1);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (NUMBER_RE.test(t)) return Number(t);
  return t;
}

/** The text of one value; a string that would read back as another type is quoted. */
export function formatStateValue(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value === "" || value !== value.trim() || value === "true" || value === "false" || NUMBER_RE.test(value) || value.startsWith('"') ? JSON.stringify(value) : value;
  return typeof value === "boolean" || typeof value === "number" ? String(value) : JSON.stringify(value);
}

/** Splits a "is one of" text at the commas outside quotes. */
export function splitList(text) {
  const parts = [];
  let quoted = false;
  let start = 0;
  const source = String(text ?? "");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

export const parseList = (text) => splitList(text).map((part) => part.trim()).filter((part) => part !== "").map(parseStateValue);
/** One list item: a string with a comma or a quote is quoted too, or it would read back as two items (or lose its quotes). */
const formatListItem = (item) => (typeof item === "string" && /[,"]/.test(item) ? JSON.stringify(item) : formatStateValue(item));
export const formatList = (list) => list.map(formatListItem).join(", ");

const valueText = (value, op) => (op === "in" && Array.isArray(value) ? formatList(value) : formatStateValue(value));

/** JSON with object keys sorted, so two values that differ only in key order compare equal. */
export function canonical(value) {
  return JSON.stringify(value, (_key, v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

// --- Conditions and state rows ---------------------------------------------------------------------------------------

/** The draft row of a stored condition. `orig*` keep what was stored: a row nobody touched is written back exactly as it was. */
export function conditionDraft(condition) {
  const op = condition.op ?? "eq";
  const text = valueText(condition.value, op);
  return { subject: condition.subject, property: condition.property, op, hadOp: condition.op !== undefined, value: text, orig: condition.value, origText: text, origOp: op };
}

export const blankCondition = () => ({ subject: "", property: "", op: "eq", hadOp: false, value: "", orig: undefined, origText: undefined, origOp: undefined });

/** The draft row of a stored state entry; a variant entry may be `unset`. */
export function stateDraft(entry) {
  const text = entry.unset === true ? "" : formatStateValue(entry.value);
  return { subject: entry.subject, property: entry.property, value: text, unset: entry.unset === true, orig: entry.value, origText: text };
}

export const blankState = () => ({ subject: "", property: "", value: "", unset: false, orig: undefined, origText: undefined });

/** The value of a row: the stored one while its text is untouched, else what the text reads as. */
function valueOf(row, op) {
  if (row.origText !== undefined && row.value === row.origText && (op === undefined || op === row.origOp)) return row.orig;
  return op === "in" ? parseList(row.value) : parseStateValue(row.value);
}

const missing = (row) => row.subject === "" || row.property.trim() === "";

/**
 * The condition rows as payload entries. Problems go to `errors` (the footer shows the first) and `fieldErrors` (under the field);
 * `path` prefixes the field paths: `<path>.<row>` for the row, `<path>.<row>.value` for its value.
 */
export function buildConditions(rows, { path, label, errors, fieldErrors }) {
  const out = [];
  rows.forEach((row, j) => {
    if (missing(row)) {
      errors.push(`${label} ${j + 1}: pick a subject and name the property.`);
      fieldErrors.push({ path: `${path}.${j}`, message: "Pick a subject and name the property.", untilTouched: true });
      return;
    }
    const value = valueOf(row, row.op);
    if (row.op === "in" ? value.length === 0 : row.value.trim() === "") {
      const message = row.op === "in" ? "Add at least one value, separated by commas." : "Enter a value.";
      errors.push(`${label} ${j + 1}: ${message.toLowerCase().replace(/\.$/, "")}.`);
      fieldErrors.push({ path: `${path}.${j}.value`, message, untilTouched: true });
      return;
    }
    out.push({ subject: row.subject, property: row.property.trim(), ...(row.op !== "eq" || row.hadOp ? { op: row.op } : {}), value });
  });
  return out;
}

/**
 * The starting-state rows as payload entries (a variant's may be `unset`). One entry per (subject, property): a second row with
 * the same key is a shape error on its Property field (spec §3.7, design rule "Duplicate").
 */
export function buildState(rows, { path, label, errors, fieldErrors, nameOf = (id) => id }) {
  const out = [];
  const seen = new Set();
  rows.forEach((row, j) => {
    if (missing(row)) {
      errors.push(`${label} ${j + 1}: pick a subject and name the property.`);
      fieldErrors.push({ path: `${path}.${j}`, message: "Pick a subject and name the property.", untilTouched: true });
      return;
    }
    const property = row.property.trim();
    const key = JSON.stringify([row.subject, property]);
    if (seen.has(key)) {
      const message = `${nameOf(row.subject)} · ${property} is already set above. Change that row instead.`;
      errors.push(`${label} ${j + 1}: ${message}`);
      fieldErrors.push({ path: `${path}.${j}.property`, message });
      return;
    }
    seen.add(key);
    if (row.unset) return void out.push({ subject: row.subject, property, unset: true });
    if (row.value.trim() === "") {
      errors.push(`${label} ${j + 1}: enter a value.`);
      fieldErrors.push({ path: `${path}.${j}.value`, message: "Enter a value.", untilTouched: true });
      return;
    }
    out.push({ subject: row.subject, property, value: valueOf(row) });
  });
  return out;
}

// --- Trigger ---------------------------------------------------------------------------------------------------------

const ISO_AT = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;

/** An ISO date or datetime, calendar-checked (no 2026-02-31) — the rule of the tool's schema. */
export function isIsoAt(value) {
  const match = ISO_AT.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export const AT_ERROR = "Use a date (2027-01-01) or a date and time (2027-01-01T09:00).";

/** The three forms of a trigger: text only, an action trigger (actor, via), a state or time trigger (conditions, at). */
export function triggerShape(trigger) {
  const t = trigger !== null && typeof trigger === "object" ? trigger : {};
  const kind = t.actor !== undefined ? "action" : t.state !== undefined || t.at !== undefined ? "state" : "text";
  return { kind, actor: t.actor ?? "", via: t.via ?? "", conditions: (t.state ?? []).map(conditionDraft), at: t.at ?? "" };
}

export const blankTriggerShape = () => ({ kind: "text", actor: "", via: "", conditions: [], at: "" });

const asObject = (trigger) => (typeof trigger === "string" ? { text: trigger } : trigger);

/**
 * The trigger to store. The text is the trigger's own `text` in every form. Deliberate rules:
 * - Text form: the text, or no trigger when it is empty.
 * - Action form: needs an actor (a persona); without one the trigger is the text alone. `via` without an actor is a shape error.
 * - State or time form: conditions and `at`; with neither the trigger is the text alone. A malformed `at` is a shape error.
 * - Clearing the text of a structured trigger keeps the structure (`text: ""`): the actor or the conditions are data the user
 *   did not ask to lose. Switching the form to Text is the explicit way to drop them.
 * - A trigger nobody touched is written back exactly as stored (a string stays a string).
 * @returns {string | object | undefined} `undefined` = no trigger
 */
export function buildTrigger({ text, origText, shape, orig }, { path, label, errors, fieldErrors }) {
  const t = text === origText ? text : text.trim();
  let value;
  if (shape.kind === "action" && shape.actor !== "") {
    value = { text: t, actor: shape.actor, ...(shape.via.trim() !== "" ? { via: shape.via.trim() } : {}) };
  } else if (shape.kind === "state") {
    const conditions = buildConditions(shape.conditions, { path: `${path}.state`, label: `${label} condition`, errors, fieldErrors });
    const at = shape.at.trim();
    if (at !== "" && !isIsoAt(at)) {
      errors.push(`${label}: ${AT_ERROR}`);
      fieldErrors.push({ path: `${path}.at`, message: AT_ERROR });
    }
    value = conditions.length > 0 || at !== "" ? { text: t, ...(conditions.length > 0 ? { state: conditions } : {}), ...(at !== "" ? { at } : {}) } : t === "" ? undefined : t;
  } else {
    if (shape.kind === "action" && shape.via.trim() !== "") {
      errors.push(`${label}: via names the channel and needs an actor.`);
      fieldErrors.push({ path: `${path}.via`, message: "Via names the channel and needs an actor." });
    }
    value = t === "" ? undefined : t;
  }
  if (orig !== undefined && value !== undefined && canonical(asObject(value)) === canonical(asObject(orig))) return orig;
  return value;
}

// --- Branches --------------------------------------------------------------------------------------------------------

/** The draft of a stored branch: conditions and steps as editable rows; unknown keys are carried. */
export function branchDraft(branch) {
  const { id, title, from, when, steps, rejoin, outcome, ...extra } = branch;
  return {
    id,
    origId: id,
    title,
    origTitle: title,
    from: from ?? "",
    when: (when ?? []).map(conditionDraft),
    steps: (steps ?? []).map(stepDraft),
    ends: rejoin === undefined,
    rejoin: rejoin ?? "",
    outcome: outcome ?? "",
    origOutcome: outcome ?? "",
    origEnds: rejoin === undefined,
    extra,
  };
}

/** A new branch: forks after `from`, one blank condition and one blank step, continues at the step after the fork (else the case ends). */
export function blankBranch({ from = "", rejoin = "" } = {}) {
  return { id: "", origId: "", title: "", origTitle: "", from, when: [blankCondition()], steps: [emptyStep()], ends: rejoin === "", rejoin, outcome: "", origOutcome: "", extra: {} };
}

const written = (value, orig) => (value === orig ? value : value.trim());

/**
 * One branch as its payload object, with the problems that block Apply. `taken` maps every step id of the rest of the case to the
 * place it lives in ("step 3 of the main flow", "step 2B.1 of branch 2B"); the branch's own steps share that one namespace
 * (spec §2). `ids` is the case's branch ids (a new branch needs a free one unless `lockId`).
 */
export function buildBranch(draft, { taken, ids, errors, fieldErrors, label = "Branch", lockId = false }) {
  const title = written(draft.title, draft.origTitle);
  if (title.trim() === "") {
    errors.push(`${label} needs a title.`);
    fieldErrors.push({ path: "branch.title", message: "Give the branch a title.", untilTouched: true });
  }
  const id = lockId || draft.id !== "" ? draft.id : uniqueId(slugify(draft.title) || "branch", ids);
  if (!lockId && draft.id !== "" && !isValidId(draft.id)) {
    errors.push(`${label}: ${draft.id} is not a valid id.`);
    fieldErrors.push({ path: "branch.id", message: `${draft.id} is not a valid id. Use lowercase letters, digits and dashes.` });
  }
  if (!lockId && draft.id !== "" && isValidId(draft.id) && ids.has(draft.id)) {
    const message = `${draft.id} is already a branch of this case. Give the new branch another id.`;
    errors.push(`${label}: ${message}`);
    fieldErrors.push({ path: "branch.id", message });
  }
  const when = buildConditions(draft.when, { path: "branch.when", label: "Condition", errors, fieldErrors });
  if (draft.when.length === 0) {
    errors.push("Add at least one condition. A branch without one cannot be saved.");
    fieldErrors.push({ path: "branch.when", message: "Add at least one condition. A branch without one cannot be saved." });
  }
  if (draft.steps.length === 0) {
    errors.push("Add at least one step. A branch without one cannot be saved.");
    fieldErrors.push({ path: "branch.steps", message: "Add at least one step. A branch without one cannot be saved." });
  }
  const used = new Map(taken);
  const steps = draft.steps.map((step, i) => {
    if (step.action.trim() === "") {
      errors.push(`${label} step ${i + 1} needs an action.`);
      fieldErrors.push({ path: `branch.step.${i}.action`, message: "The step needs an action.", untilTouched: true });
    }
    const typed = step.id.trim();
    const stepId = typed || uniqueId(slugify(step.action) || `step-${i + 1}`, new Set(used.keys()));
    if (typed !== "" && !isValidId(typed)) {
      const message = `${typed} is not a valid id. Use lowercase letters, digits and dashes.`;
      errors.push(`${label} step ${i + 1}: ${message}`);
      fieldErrors.push({ path: `branch.step.${i}.id`, message });
    } else if (used.has(stepId)) {
      const message = `${stepId} is already ${used.get(stepId)}. Give this step another id.`;
      errors.push(`${label} step ${i + 1}: ${message}`);
      fieldErrors.push({ path: `branch.step.${i}.id`, message });
    }
    used.set(stepId, `step ${i + 1} of this branch`);
    return buildStepObject(step, stepId, `${label} step ${i + 1}`, errors);
  });
  const out = { ...draft.extra, id, title, ...(draft.from !== "" ? { from: draft.from } : {}), when, steps };
  if (!draft.ends && draft.rejoin !== "") out.rejoin = draft.rejoin;
  const outcome = written(draft.outcome, draft.origOutcome);
  // An untouched end mode writes a stored outcome back as stored (even next to a rejoin); it only falls away when the user changed the mode.
  if ((draft.ends || (draft.ends === draft.origEnds && draft.origOutcome !== "")) && outcome.trim() !== "") out.outcome = outcome;
  return out;
}

// --- Participants ------------------------------------------------------------------------------------------------------

/** The warning for a subject or member that is neither a persona, an entity nor the system (spec §6 `unknown_participant`). */
export function participantWarning(id, { personasById, entitiesById }) {
  if (id === "" || id === "system" || personasById.has(id) || entitiesById.has(id)) return "";
  return `${id} is neither a persona nor an entity. Add it to the world or pick another subject.`;
}

// --- Entities, relationship types, constellations ---------------------------------------------------------------------------

const idError = (id, errors, reservedOk = false) => {
  if (!isValidId(id)) errors.push("The id must be lowercase kebab-case (a-z, 0-9, -).");
  else if (id === "system" && !reservedOk) errors.push("system is reserved for artisign itself. Pick another id.");
};

/** The avatar key: untouched emoji leaves the stored avatar (a colour included) alone; a new emoji is merged into it; `null` only when nothing is left. */
function avatarPart(emoji, stored) {
  if (emoji === (stored?.emoji ?? "")) return {};
  if (emoji) return { avatar: { ...(stored ?? {}), emoji } };
  const rest = { ...(stored ?? {}) };
  delete rest.emoji;
  return Object.keys(rest).length > 0 ? { avatar: rest } : { avatar: null };
}

const optional = (key, value, had) => (value !== undefined ? { [key]: value } : had ? { [key]: null } : {});
const text = (value) => (value.trim() === "" ? undefined : value.trim());

export function buildEntityPayload({ id, draft, source }) {
  const errors = [];
  if (draft.name.trim() === "") errors.push("A name is required.");
  idError(id, errors);
  if (errors.length > 0) return { errors };
  const traits = Object.fromEntries(Object.entries(draft.traits).filter(([, value]) => value !== ""));
  return {
    payload: {
      id,
      name: draft.name.trim(),
      ...optional("type", text(draft.type), source?.type !== undefined),
      ...optional("description", text(draft.description), source?.description !== undefined),
      ...avatarPart(draft.emoji, source?.avatar),
      ...optional("traits", Object.keys(traits).length > 0 ? traits : undefined, source?.traits !== undefined),
      ...optional("object", draft.object !== "" ? draft.object : undefined, source?.object !== undefined),
    },
  };
}

export function buildRelationshipTypePayload({ id, draft, source }) {
  const errors = [];
  if (draft.label.trim() === "") errors.push("A label is required.");
  idError(id, errors, true);
  if (draft.fieldObject !== "" && draft.fieldName === "") errors.push("Pick the field that stores this relationship, or leave the data object empty.");
  if (errors.length > 0) return { errors };
  return {
    payload: {
      id,
      label: draft.label.trim(),
      ...optional("inverse_label", text(draft.inverse), source?.inverse_label !== undefined),
      ...optional("description", text(draft.description), source?.description !== undefined),
      ...optional("same_traits", draft.sameTraits.length > 0 ? [...draft.sameTraits] : undefined, source?.same_traits !== undefined),
      ...optional("field", draft.fieldObject !== "" ? { object: draft.fieldObject, name: draft.fieldName } : undefined, source?.field !== undefined),
    },
  };
}

/** A constellation draft row: `orig` keeps a stored relationship (its note, untrimmed, and unknown keys) so an untouched row is written back as it was. */
export function relationshipDraft(relationship) {
  return { from: relationship.from, type: relationship.type, to: relationship.to, note: relationship.note ?? "", orig: relationship };
}

export function buildConstellationPayload({ id, draft, source }) {
  const errors = [];
  const fieldErrors = [];
  if (draft.name.trim() === "") errors.push("A name is required.");
  idError(id, errors, true);
  const relationships = draft.relationships.map((row, i) => {
    if (row.from === "" || row.type === "" || row.to === "") {
      errors.push(`Relationship ${i + 1} needs from, a type and to.`);
      fieldErrors.push({ path: `relationship.${i}`, message: "Pick from, a type and to.", untilTouched: true });
    }
    const o = row.orig;
    if (o && o.from === row.from && o.type === row.type && o.to === row.to && (o.note ?? "") === row.note) return o;
    return { from: row.from, type: row.type, to: row.to, ...(row.note.trim() !== "" ? { note: row.note.trim() } : {}) };
  });
  if (errors.length > 0) return { errors, fieldErrors };
  const traits = Object.fromEntries(Object.entries(draft.traits).filter(([, value]) => value !== ""));
  return {
    payload: {
      id,
      name: draft.name.trim(),
      relationships,
      ...optional("description", text(draft.description), source?.description !== undefined),
      ...optional("traits", Object.keys(traits).length > 0 ? traits : undefined, source?.traits !== undefined),
      ...(draft.generated ? { generated: true } : source?.generated ? { generated: null } : {}),
    },
    fieldErrors,
  };
}

/** The members of a draft constellation: the ends of its relationships, in order of first appearance. */
export function draftMembers(relationships) {
  const ids = [];
  for (const r of relationships) for (const id of [r.from, r.to]) if (id !== "" && !ids.includes(id)) ids.push(id);
  return ids;
}
