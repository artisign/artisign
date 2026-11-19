import type { Warning } from "../tools/types.js";
import type { Entity, Persona } from "./schema.js";

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
