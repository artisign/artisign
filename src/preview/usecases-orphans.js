// Use Cases tab — orphans (ADR-010 amendment 2026-11-20, CHR-1125). A pool entry can disappear while a case still names it
// (delete_entity with force, a warn-only write, a hand edit). The source is the warnings get_use_case already returns
// (unknown_persona, unknown_dimension, unknown_trait_value, unknown_constellation); there is no new warning kind.

const ORPHAN_KINDS = new Set(["unknown_persona", "unknown_dimension", "unknown_trait_value", "unknown_constellation"]);

/**
 * What the warnings of one case (base and every variant) say is missing from the pools.
 * @returns {{ personas: Set<string>, conditions: { variant: string, dimension: string, value?: string }[], constellations: Set<string>, count: number }}
 */
export function orphansOf(warnings, useCaseId) {
  const base = `use_case:${useCaseId}`;
  const out = { personas: new Set(), conditions: [], constellations: new Set(), count: 0 };
  for (const w of warnings ?? []) {
    if (!ORPHAN_KINDS.has(w.kind)) continue;
    const target = w.target ?? "";
    if (target !== base && !target.startsWith(`${base}#`) && !target.startsWith(`${base}/`)) continue;
    const variant = /^[^#/]*#([^/]*)/.exec(target)?.[1] ?? "";
    const quoted = [...String(w.message ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (w.kind === "unknown_persona" && quoted[0]) out.personas.add(quoted[0]);
    else if (w.kind === "unknown_constellation" && quoted[0]) out.constellations.add(quoted[0]);
    else if (w.kind === "unknown_dimension") {
      const dimension = quoted.at(-1);
      if (dimension) out.conditions.push({ variant, dimension });
    } else if (w.kind === "unknown_trait_value" && quoted.length >= 2) out.conditions.push({ variant, dimension: quoted[1], value: quoted[0] });
    else continue;
    out.count++;
  }
  return out;
}

/** How a condition chip of `variant` is orphaned: "dimension", "value" or null. */
export function conditionOrphan(orphans, variant, dimension, value) {
  const hits = orphans.conditions.filter((c) => c.variant === (variant ?? "") && c.dimension === dimension);
  if (hits.some((c) => c.value === undefined)) return "dimension";
  if (value !== undefined && hits.some((c) => c.value === value)) return "value";
  return null;
}

/** One sentence for the coverage card naming the orphans, or "" when there are none. */
export function orphanSummary(orphans) {
  const parts = [];
  if (orphans.conditions.length > 0) {
    const named = [...new Set(orphans.conditions.map((c) => `${c.variant || "base"}: ${c.dimension}${c.value ? ` = ${c.value}` : ""}`))];
    parts.push(`${orphans.conditions.length === 1 ? "1 condition names" : `${orphans.conditions.length} conditions name`} a dimension or value that no longer exists (${named.join("; ")})`);
  }
  if (orphans.personas.size > 0) parts.push(`${orphans.personas.size === 1 ? "1 persona is" : `${orphans.personas.size} personas are`} missing from the pool (${[...orphans.personas].join(", ")})`);
  if (orphans.constellations.size > 0) parts.push(`${orphans.constellations.size === 1 ? "1 constellation is" : `${orphans.constellations.size} constellations are`} missing from the world (${[...orphans.constellations].join(", ")})`);
  return parts.join("; ");
}
