import type { Warning } from "../tools/types.js";
import { SYSTEM_ACTOR, ownValue, type Constellation, type DataField, type Entity, type Persona, type RelationshipType, type UseCaseVariant } from "./schema.js";
import type { EffectiveUseCase } from "./resolve.js";
import type { ValidationPools } from "./validate.js";

export type ParticipantKind = "persona" | "entity";

/**
 * What an id names. Personas and entities share one participant namespace; while an id is in both (the
 * `ambiguous_id` warning), the persona wins.
 */
export function resolveParticipant(id: string, personas: Persona[], entities: Entity[]): ParticipantKind | undefined {
  if (personas.some((p) => p.id === id)) return "persona";
  if (entities.some((e) => e.id === id)) return "entity";
  return undefined;
}

/** `ambiguous_id` for every id the two pools share — a warning, never a write error. `only` narrows it to the ids a call touched. */
export function ambiguousIds(personas: Persona[], entities: Entity[], only?: Set<string>): Warning[] {
  const entityIds = new Set(entities.map((e) => e.id));
  return personas
    .filter((p) => entityIds.has(p.id) && (only === undefined || only.has(p.id)))
    .map((p): Warning => ({
      kind: "ambiguous_id",
      target: `persona:${p.id}`,
      message: `"${p.id}" is both a persona and an entity; references to it resolve to the persona`,
      suggestion: "give one of them another id",
    }));
}

// --- Consistency warnings (ADR-011, spec §6) -------------------------------------
// Everything below is advisory: it returns warnings and never throws.

/** The pool lists `resolveParticipant` takes, built once per pools object (a check runs it for many ids). */
const lists = new WeakMap<ValidationPools, { personas: Persona[]; entities: Entity[] }>();

function listsOf(pools: ValidationPools): { personas: Persona[]; entities: Entity[] } {
  let entry = lists.get(pools);
  if (!entry) {
    entry = { personas: [...pools.personas.values()], entities: pools.world.entities };
    lists.set(pools, entry);
  }
  return entry;
}

/** What `id` names in the pools after the call; `system` is neither. */
export function participantKind(id: string, pools: ValidationPools): ParticipantKind | undefined {
  const { personas, entities } = listsOf(pools);
  return resolveParticipant(id, personas, entities);
}

function traitsOf(id: string, pools: ValidationPools): Record<string, string> | undefined {
  const kind = participantKind(id, pools);
  if (kind === "persona") return pools.personas.get(id)?.traits;
  if (kind === "entity") return pools.world.entities.find((e) => e.id === id)?.traits;
  return undefined;
}

/** The ends of a constellation's relationships: its members. */
export function membersOf(constellation: Constellation): Set<string> {
  return new Set(constellation.relationships.flatMap((r) => [r.from, r.to]));
}

/** Trait problems of one participant or constellation: a dimension or a value the pool does not define. */
export function traitWarnings(traits: Record<string, string>, target: string, pools: ValidationPools): Warning[] {
  const warnings: Warning[] = [];
  for (const [dimId, valueId] of Object.entries(traits)) {
    const dimension = pools.dimensions.get(dimId);
    if (!dimension) {
      warnings.push({ kind: "unknown_dimension", target, message: `trait "${dimId}" is not a defined dimension` });
    } else if (!dimension.values.some((v) => v.id === valueId)) {
      warnings.push({ kind: "unknown_trait_value", target, message: `"${valueId}" is not a value of dimension "${dimId}"`, suggestion: dimension.values.map((v) => v.id).join(", ") });
    }
  }
  return warnings;
}

/** `YYYY-MM-DD` that exists in the calendar (no 2024-02-30). */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Whether `value` fits the field's type (and `enum` values). `null` fits anything: nothing there yet. Dates are checked by shape, not evaluated. */
function fitsField(field: DataField, value: unknown): boolean {
  if (value === null) return true;
  switch (field.type) {
    case "string":
    case "ref":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDate(value);
    case "datetime":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)) && isCalendarDate(value.slice(0, 10));
    case "enum":
      return typeof value === "string" && (field.values === undefined || field.values.includes(value));
    case "list":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
  }
}

/** Entities in the call: traits against the dimensions, `object` against the data model (only with one), no constellation naming them. */
export function validateEntity(entity: Entity, pools: ValidationPools): Warning[] {
  const target = `entity:${entity.id}`;
  const warnings = traitWarnings(entity.traits, target, pools);
  if (pools.dataModel && entity.object !== undefined && !pools.objects.has(entity.object)) {
    warnings.push({ kind: "unknown_data_object", target, message: `entity "${entity.id}" is an instance of unknown data object "${entity.object}"` });
  }
  if (!pools.world.constellations.some((c) => membersOf(c).has(entity.id))) {
    warnings.push({ kind: "entity_unrelated", target, message: `no constellation names entity "${entity.id}"` });
  }
  return warnings;
}

/** `field` of a relationship type against the data model (only with one): an existing object, a `ref` or `list` field on it. */
export function validateRelationshipType(type: RelationshipType, pools: ValidationPools): Warning[] {
  const target = `relationship_type:${type.id}`;
  const warnings: Warning[] = (type.same_traits ?? [])
    .filter((dimId) => !pools.dimensions.has(dimId))
    .map((dimId): Warning => ({ kind: "unknown_dimension", target, message: `same_traits names "${dimId}", which is not a defined dimension` }));
  if (!pools.dataModel || type.field === undefined) return warnings;
  const object = pools.objects.get(type.field.object);
  if (!object) return [...warnings, { kind: "unknown_data_object", target, message: `field of relationship type "${type.id}" names unknown data object "${type.field.object}"` }];
  const field = object.fields.find((f) => f.name === type.field!.name);
  if (!field) return [...warnings, { kind: "unknown_data_field", target, message: `"${type.field.name}" is not a field of data object "${object.id}"` }];
  if (field.type !== "ref" && field.type !== "list") {
    return [...warnings, { kind: "unknown_data_field", target, message: `field "${object.id}.${field.name}" is of type ${field.type}; a relationship maps to a ref or list field` }];
  }
  return warnings;
}

/** One constellation: traits against the dimensions, every relationship against the participants and types, and the three trait conflicts it can have itself. */
export function validateConstellation(constellation: Constellation, pools: ValidationPools): Warning[] {
  const target = `constellation:${constellation.id}`;
  const warnings = traitWarnings(constellation.traits, target, pools);
  const types = new Map(pools.world.relationship_types.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (const rel of constellation.relationships) {
    const label = `${rel.from} ${rel.type} ${rel.to}`;
    for (const end of [rel.from, rel.to]) {
      if (end !== SYSTEM_ACTOR && participantKind(end, pools) === undefined) {
        warnings.push({ kind: "unknown_participant", target, message: `"${end}" in relationship "${label}" is neither a persona nor an entity` });
      }
    }
    const type = types.get(rel.type);
    if (!type) warnings.push({ kind: "unknown_relationship_type", target, message: `relationship "${label}" names undeclared type "${rel.type}"` });
    if (rel.from === rel.to) warnings.push({ kind: "self_relationship", target, message: `"${rel.from}" is related to itself ("${label}")` });
    if (seen.has(label)) warnings.push({ kind: "duplicate_relationship", target, message: `relationship "${label}" appears twice` });
    seen.add(label);
    // (1) the ends of a type that lists a dimension in `same_traits` must agree on it
    const fromTraits = traitsOf(rel.from, pools);
    const toTraits = traitsOf(rel.to, pools);
    for (const dimId of type?.same_traits ?? []) {
      const a = fromTraits && ownValue(fromTraits, dimId);
      const b = toTraits && ownValue(toTraits, dimId);
      if (a !== undefined && b !== undefined && a !== b) {
        warnings.push({ kind: "trait_conflict", target, message: `"${rel.from}" (${dimId}: ${a}) and "${rel.to}" (${dimId}: ${b}) differ on "${dimId}", which type "${rel.type}" requires to agree` });
      }
    }
  }
  // (2) the constellation's own trait must not differ from a member's trait on the same dimension
  for (const member of membersOf(constellation)) {
    const traits = traitsOf(member, pools);
    for (const [dimId, valueId] of Object.entries(constellation.traits)) {
      const memberValue = traits && ownValue(traits, dimId);
      if (memberValue !== undefined && memberValue !== valueId) {
        warnings.push({ kind: "trait_conflict", target, message: `constellation "${constellation.id}" has ${dimId}: ${valueId}, member "${member}" has ${dimId}: ${memberValue}` });
      }
    }
  }
  return warnings;
}

type Subject = { subject: string; property: string; value?: unknown; op?: string };

/**
 * The world warnings of one effective case (the base case or one resolved variant), judged on its own resolved state:
 * `at` is the target of the case (`use_case:<id>[#<variant>]`). `when` is the variant's, for the constellation-trait conflict.
 * Actor checks (`unknown_persona` / `entity_as_actor`) stay with the step and trigger checks in `validateUseCase`.
 */
export function caseWorldWarnings(effective: EffectiveUseCase, pools: ValidationPools, at: string, when?: UseCaseVariant["when"]): Warning[] {
  const warnings: Warning[] = [];
  const known = effective.constellations.flatMap((id) => {
    const found = pools.world.constellations.find((c) => c.id === id);
    if (!found) warnings.push({ kind: "unknown_constellation", target: `${at}/constellation:${id}`, message: `constellation "${id}" does not exist` });
    return found ? [found] : [];
  });

  /** `outside_constellation` when the case lists constellations and the participant is a member of none of them; once per participant, on its first occurrence. */
  const flagged = new Set<string>();
  const checkMember = (id: string, target: string, actor = false): void => {
    if (known.length === 0 || id === SYSTEM_ACTOR || flagged.has(id)) return;
    const kind = participantKind(id, pools);
    if (kind === undefined || (actor && kind === "entity")) return; // an entity actor is entity_as_actor already
    if (known.some((c) => membersOf(c).has(id))) return;
    flagged.add(id);
    const names = known.map((c) => `"${c.id}"`).join(", ");
    warnings.push({ kind: "outside_constellation", target, message: `"${id}" is not a member of ${known.length === 1 ? "constellation" : "any of the constellations"} ${names}`, suggestion: `add a relationship naming "${id}" to ${known.length === 1 ? "it" : "one of them"}` });
  };
  /** A state entry or condition: the subject is a known participant (or `system`), a member, and its property fits the mapped data object. */
  const checkSubject = (entry: Subject, target: string): void => {
    if (entry.subject !== SYSTEM_ACTOR && participantKind(entry.subject, pools) === undefined) {
      warnings.push({ kind: "unknown_participant", target, message: `state subject "${entry.subject}" is neither a persona, an entity nor "system"` });
      return;
    }
    checkMember(entry.subject, target);
    if (!pools.dataModel || participantKind(entry.subject, pools) !== "entity") return;
    const objectId = pools.world.entities.find((e) => e.id === entry.subject)?.object;
    const object = objectId === undefined ? undefined : pools.objects.get(objectId);
    if (!object) return; // an unmapped entity, or a missing object (reported on the entity itself)
    const field = object.fields.find((f) => f.name === entry.property);
    if (!field) {
      warnings.push({ kind: "unknown_data_field", target, message: `"${entry.property}" is not a field of data object "${object.id}" (subject "${entry.subject}")` });
      return;
    }
    const values = entry.op === "in" && Array.isArray(entry.value) && field.type !== "list" ? entry.value : [entry.value];
    if (!values.every((value) => fitsField(field, value))) {
      const allowed = field.type === "enum" && field.values !== undefined ? ` (${field.values.join(", ")})` : "";
      warnings.push({ kind: "state_value_mismatch", target, message: `value of "${entry.subject}.${entry.property}" does not fit field type ${field.type}${allowed} of data object "${object.id}"` });
    }
  };

  // Every warning gets a target of its own subject, because a base warning suppresses a variant's of the same kind and target.
  const stateAt = (base: string, entry: Subject): string => `${base}/state:${entry.subject}.${entry.property}`;
  // Actors first (trigger, main flow, branches), so a participant that is also a state subject is reported once, on its first step.
  if (effective.trigger?.actor !== undefined) checkMember(effective.trigger.actor, `${at}/trigger`, true);
  for (const step of [...effective.steps, ...(effective.branches ?? []).flatMap((b) => b.steps)]) checkMember(step.actor, `${at}/${step.id}`, true);
  for (const entry of effective.state ?? []) checkSubject(entry, stateAt(at, entry));
  for (const condition of effective.trigger?.state ?? []) checkSubject(condition, stateAt(`${at}/trigger`, condition));
  for (const branch of effective.branches ?? []) for (const condition of branch.when) checkSubject(condition, stateAt(`${at}/branch:${branch.id}`, condition));

  // (3) a variant `when` on a constellation-scoped dimension must cover the traits of the constellations it uses
  for (const [dimId, valueIds] of Object.entries(when ?? {})) {
    if (pools.dimensions.get(dimId)?.scope !== "constellations") continue;
    for (const c of known) {
      const trait = ownValue(c.traits, dimId);
      if (trait !== undefined && !valueIds.includes(trait)) {
        warnings.push({ kind: "trait_conflict", target: `${at}/constellation:${c.id}`, message: `variant "when" names ${dimId}: ${valueIds.join(", ")}, but constellation "${c.id}" has ${dimId}: ${trait}` });
      }
    }
  }
  return warnings;
}
