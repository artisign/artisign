// Use Cases tab — orphans (ADR-010 amendment 2026-11-20, CHR-1125). A pool entry can disappear while a case still names it
// (delete_entity with force, a warn-only write, a hand edit). The source is the warnings get_use_case already returns
// (unknown_persona, unknown_dimension, unknown_trait_value, unknown_constellation); there is no new warning kind.

import { h } from "./usecases-dom.js";

const ORPHAN_KINDS = new Set([
  "unknown_persona",
  "unknown_dimension",
  "unknown_trait_value",
  "unknown_constellation",
  "unknown_participant",
  "unknown_relationship_type",
  "unknown_data_object",
]);

/**
 * What the warnings of one case (base and every variant) say is missing from the pools.
 * `constellationIds`: the constellations the case and its variants list; the warnings sitting on them (`constellation:<id>`: a relationship end or type that no longer exists) count too.
 * @returns {{ personas: Set<string>, conditions: { variant: string, dimension: string, value?: string }[], constellations: Set<string>, participants: Set<string>, relationshipTypes: Set<string>, dataObjects: Set<string>, count: number }}
 */
export function orphansOf(warnings, useCaseId, constellationIds = []) {
  const base = `use_case:${useCaseId}`;
  const inWorld = new Set(constellationIds.map((id) => `constellation:${id}`));
  const out = {
    personas: new Set(),
    conditions: [],
    constellationTraits: [],
    constellations: new Set(),
    participants: new Set(),
    relationshipTypes: new Set(),
    dataObjects: new Set(),
    count: 0,
  };
  for (const w of warnings ?? []) {
    if (!ORPHAN_KINDS.has(w.kind)) continue;
    const target = w.target ?? "";
    if (
      target !== base &&
      !target.startsWith(`${base}#`) &&
      !target.startsWith(`${base}/`) &&
      !inWorld.has(target)
    )
      continue;
    const variant = /^[^#/]*#([^/]*)/.exec(target)?.[1] ?? "";
    const quoted = [...String(w.message ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (w.kind === "unknown_persona" && quoted[0]) out.personas.add(quoted[0]);
    else if (w.kind === "unknown_participant" && quoted[0]) out.participants.add(quoted[0]);
    else if (w.kind === "unknown_relationship_type" && quoted.length > 0)
      out.relationshipTypes.add(quoted.at(-1));
    else if (w.kind === "unknown_data_object" && quoted.length > 0)
      out.dataObjects.add(quoted.at(-1));
    else if (w.kind === "unknown_constellation" && quoted[0]) out.constellations.add(quoted[0]);
    else if (w.kind === "unknown_dimension") {
      const dimension = quoted.at(-1);
      if (!dimension) continue;
      // A trait of a constellation (not a variant condition) is named by its constellation.
      if (target.startsWith("constellation:"))
        out.constellationTraits.push({
          constellation: target.slice("constellation:".length),
          dimension,
        });
      else out.conditions.push({ variant, dimension });
    } else if (w.kind === "unknown_trait_value" && quoted.length >= 2) {
      if (target.startsWith("constellation:"))
        out.constellationTraits.push({
          constellation: target.slice("constellation:".length),
          dimension: quoted[1],
          value: quoted[0],
        });
      else out.conditions.push({ variant, dimension: quoted[1], value: quoted[0] });
    } else continue;
    out.count++;
  }
  return out;
}

/** How a condition chip of `variant` is orphaned: "dimension", "value" or null. */
export function conditionOrphan(orphans, variant, dimension, value) {
  const hits = orphans.conditions.filter(
    (c) => c.variant === (variant ?? "") && c.dimension === dimension,
  );
  if (hits.some((c) => c.value === undefined)) return "dimension";
  if (value !== undefined && hits.some((c) => c.value === value)) return "value";
  return null;
}

/** One sentence for the coverage card naming the orphans, or "" when there are none. */
export function orphanSummary(orphans) {
  const parts = [];
  if (orphans.conditions.length > 0) {
    const named = [
      ...new Set(
        orphans.conditions.map(
          (c) => `${c.variant || "base"}: ${c.dimension}${c.value ? ` = ${c.value}` : ""}`,
        ),
      ),
    ];
    parts.push(
      `${orphans.conditions.length === 1 ? "1 condition names" : `${orphans.conditions.length} conditions name`} a dimension or value that no longer exists (${named.join("; ")})`,
    );
  }
  if (orphans.personas.size > 0)
    parts.push(
      `${orphans.personas.size === 1 ? "1 persona is" : `${orphans.personas.size} personas are`} missing from the pool (${[...orphans.personas].join(", ")})`,
    );
  if (orphans.constellations.size > 0)
    parts.push(
      `${orphans.constellations.size === 1 ? "1 constellation is" : `${orphans.constellations.size} constellations are`} missing from the world (${[...orphans.constellations].join(", ")})`,
    );
  if (orphans.constellationTraits.length > 0) {
    const named = [
      ...new Set(
        orphans.constellationTraits.map(
          (c) => `${c.constellation}: ${c.dimension}${c.value ? ` = ${c.value}` : ""}`,
        ),
      ),
    ];
    parts.push(
      `${orphans.constellationTraits.length === 1 ? "1 constellation trait names" : `${orphans.constellationTraits.length} constellation traits name`} a dimension or value that no longer exists (${named.join("; ")})`,
    );
  }
  const list = (set) => [...set].join(", ");
  if (orphans.participants.size > 0)
    parts.push(
      `${orphans.participants.size === 1 ? "1 participant is" : `${orphans.participants.size} participants are`} neither a persona nor an entity (${list(orphans.participants)})`,
    );
  if (orphans.relationshipTypes.size > 0)
    parts.push(
      `${orphans.relationshipTypes.size === 1 ? "1 relationship type is" : `${orphans.relationshipTypes.size} relationship types are`} undeclared (${list(orphans.relationshipTypes)})`,
    );
  if (orphans.dataObjects.size > 0)
    parts.push(
      `${orphans.dataObjects.size === 1 ? "1 data object is" : `${orphans.dataObjects.size} data objects are`} missing (${list(orphans.dataObjects)})`,
    );
  return parts.join("; ");
}

/** A step or trigger actor the pools no longer have (an entity there is `entity_as_actor`, a different warning). */
export function actorMissing(ctx, id) {
  // Only what an unknown_persona warning names: the bundle's entities are just the members and subjects, so "not in the bundle" does not mean "not in the world".
  return id !== undefined && id !== "system" && Boolean(ctx.orphans?.personas.has(id));
}

/** Text for assistive technology only; a `title` alone is not announced. */
export function hiddenNote(text) {
  return h("span", { class: "uc-visually-hidden" }, ` (${text})`);
}
