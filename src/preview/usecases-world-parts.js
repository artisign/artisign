// Use Cases tab — the reusable pieces of the world model design components: uc-actor-kind, uc-condition-chip, uc-branch-end,
// uc-relation-row, uc-trait-chip, the entity avatar and a participant (avatar + name + kind / type). One builder per component.

import { h, icon } from "./usecases-dom.js";
import { avatar, dataCard } from "./usecases-parts.js";
import { changedKeys } from "./usecases-data.js";
import { KIND_ICONS, conditionParts } from "./usecases-world-data.js";

/** `uc-actor-kind`: the kind icon after a persona's name; a persona without a kind states none and shows none. */
export function actorKind(kind) {
  const spec = KIND_ICONS[kind];
  if (!spec) return null;
  return h("span", { class: "uc-kind icon", role: "img", "aria-label": spec.label, title: spec.label }, spec.icon);
}

/** `uc-avatar entity` / `entity-sm`: a square neutral avatar for a main entity. */
export function entityAvatar(av, size = "md", title = "") {
  return h("span", { class: "uc-avatar", dataset: { size, kind: "entity" }, title }, av.text);
}

/** A participant as a small inline unit: avatar, name, then the kind icon (personas) or the type (entities). */
export function participantChip(p, { size = "sm", withTail = true } = {}) {
  const art = p.kind === "entity" ? entityAvatar(p.avatar, size, p.name) : p.kind === "unknown" ? h("span", { class: "uc-avatar", dataset: { size, kind: "unknown" }, title: p.id }, p.avatar.text) : avatar(p.avatar, size, p.name);
  const tail = !withTail ? null : p.kind === "persona" ? actorKind(p.persona?.kind) : p.kind === "entity" && p.type ? h("span", { class: "uc-participant-type" }, p.type) : null;
  return h("span", { class: "uc-participant", dataset: { kind: p.kind } }, art, h("span", { class: "uc-participant-name" }, p.name), tail);
}

/** `uc-condition-chip`: subject.property, the operator symbol (its word is the accessible name), the value. `warning` underlines the key. */
export function conditionChip(condition, { warning = false, struck = false } = {}) {
  const parts = conditionParts(condition);
  return h(
    "span",
    { class: `uc-cond${warning ? " is-warning" : ""}${struck ? " is-struck" : ""}`, role: "group", "aria-label": `${parts.key} ${parts.word} ${parts.value}` },
    h("span", { class: "uc-cond-key" }, parts.key),
    h("span", { class: "uc-cond-op", "aria-hidden": "true" }, parts.symbol),
    h("span", { class: "uc-cond-value" }, parts.value),
  );
}

/** `uc-condition-chip time`: "from <date>". */
export function timeChip(at) {
  return h("span", { class: "uc-cond-time" }, icon("event"), h("span", { class: "uc-cond-from" }, "from"), h("span", { class: "uc-cond-value" }, at));
}

/** Conditions joined by "and". */
export function conditionList(conditions, { warnings = null, struck = false } = {}) {
  const out = [];
  conditions.forEach((condition, i) => {
    if (i > 0) out.push(h("span", { class: "uc-cond-and" }, "and"));
    out.push(conditionChip(condition, { struck, warning: Boolean(warnings?.(condition)) }));
  });
  return out;
}

const END_ICONS = { rejoin: "u_turn_left", end: "stop_circle", warning: "link_off" };

/** `uc-branch-end` (default = rejoin, `end`, `warning`). */
export function branchEndChip(kind, text) {
  return h("span", { class: "uc-branch-end", dataset: { kind } }, icon(END_ICONS[kind] ?? END_ICONS.rejoin), h("span", null, text));
}

/** `uc-relation-row`: from — type → to, and the relationship's note when it has one. */
export function relationRow({ from, label, to, note, warning = "" }) {
  return h(
    "li",
    { class: `uc-relation${warning ? " is-warning" : ""}` },
    h("span", { class: "uc-relation-line" }, h("span", { class: "uc-relation-end" }, from), h("span", { class: "uc-relation-type" }, h("span", { "aria-hidden": "true" }, "—"), h("span", null, label), icon("arrow_forward")), h("span", { class: "uc-relation-end" }, to)),
    note ? h("span", { class: "uc-relation-note" }, note) : null,
  );
}

/** A warning line at its target: amber, never blocking. */
export function warnLine(text, id = null) {
  return text ? h("p", { class: "uc-warn", id }, icon("warning"), text) : null;
}

/** The warning line under a target chip: a stale screen / node, or a generated node id (mapping warnings of one step). */
export function mappingNote(step, mapping, screenEntry) {
  if (!step.target || !mapping) return null;
  if (mapping.stale) {
    const text = screenEntry && screenEntry.exists === false ? `Screen ${step.target.screen} no longer exists. Pick a new target.` : `Element ${step.target.node} no longer exists on ${step.target.screen}. Pick a new target.`;
    return h("p", { class: "uc-warn" }, icon("warning"), text);
  }
  if (mapping.unstable) return h("p", { class: "uc-warn" }, icon("warning"), `${step.target.node} is a generated id: it can point at another element after a rewrite. Give the node an authored id.`);
  return null;
}

/** The before / after data cards of a step, `null` without data. */
export function stepDataBlock(step, objectsById) {
  const data = (step.data ?? []).map((entry) => {
    const name = objectsById.get(entry.object)?.name ?? entry.object;
    return h("div", { class: "uc-step-data" }, dataCard("before", name, entry.before ?? {}, new Set()), icon("arrow_forward", "uc-data-arrow"), dataCard("after", name, entry.after ?? {}, changedKeys(entry.before, entry.after)));
  });
  return data.length > 0 ? h("div", { class: "uc-step-datas" }, data) : null;
}

/** "Branch 2A · Premium rises by more than 15 %": a branch's number and title. */
export function branchLabel(entry) {
  return `Branch ${entry.label} · ${entry.branch.title}`;
}
