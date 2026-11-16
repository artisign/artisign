import type { Dimension, Persona, UseCase } from "./schema.js";
import { ID_MAX, isValidId, ownValue } from "./schema.js";

export type Combination = Record<string, string>;
export type Strategy = "all" | "pairwise";

/**
 * An existing persona covers a combination when every one of its traits
 * matches it — a missing trait means "any value".
 * A persona without any trait is a catch-all and covers nothing here, or
 * generating around it would never produce anything.
 */
export function personaCovers(persona: Persona, combination: Combination): boolean {
  // Only the dimensions being expanded count: a trait outside a chosen subset says nothing about the combination.
  const traits = Object.entries(persona.traits).filter(([dim]) => Object.hasOwn(combination, dim));
  return traits.length > 0 && traits.every(([dim, value]) => combination[dim] === value);
}

export type GeneratedCombinations = {
  combinations: Combination[];
  /** Size of the full space (all) or number of value pairs (pairwise) before skipping covered ones. */
  total: number;
  skipped_covered: number;
  truncated: boolean;
};

function productSize(dimensions: Dimension[]): number {
  return dimensions.reduce((size, d) => size * d.values.length, 1);
}

function expandAll(dimensions: Dimension[], existing: Persona[], limit: number): GeneratedCombinations {
  const combinations: Combination[] = [];
  let skipped = 0;
  let truncated = false;
  const counters = dimensions.map(() => 0);
  const total = productSize(dimensions);
  // Odometer over the dimensions in declared order — last dimension varies fastest, so output order is stable.
  for (let n = 0; n < total; n++) {
    const combination: Combination = {};
    dimensions.forEach((d, i) => {
      combination[d.id] = d.values[counters[i]!]!.id;
    });
    if (existing.some((p) => personaCovers(p, combination))) {
      skipped++;
    } else if (combinations.length >= limit) {
      truncated = true;
      break;
    } else {
      combinations.push(combination);
    }
    for (let i = dimensions.length - 1; i >= 0; i--) {
      counters[i] = counters[i]! + 1;
      if (counters[i]! < dimensions[i]!.values.length) break;
      counters[i] = 0;
    }
  }
  return { combinations, total, skipped_covered: skipped, truncated };
}

function pairKey(da: string, va: string, db: string, vb: string): string {
  return `${da}=${va}|${db}=${vb}`;
}

/**
 * Greedy all-pairs cover: every value pair of two different dimensions ends up
 * in at least one combination. Deterministic — the first uncovered pair (in
 * declared dimension/value order) seeds each row, the remaining dimensions take
 * the value that covers the most new pairs, ties to the first declared value.
 * A single dimension degenerates to one combination per value.
 */
function expandPairwise(dimensions: Dimension[], existing: Persona[], limit: number): GeneratedCombinations {
  if (dimensions.length === 1) {
    const only = dimensions[0]!;
    const all = only.values.map((v): Combination => ({ [only.id]: v.id }));
    const open = all.filter((c) => !existing.some((p) => personaCovers(p, c)));
    return { combinations: open.slice(0, limit), total: all.length, skipped_covered: all.length - open.length, truncated: open.length > limit };
  }

  const uncovered = new Set<string>();
  const ordered: { da: string; va: string; db: string; vb: string }[] = [];
  for (let i = 0; i < dimensions.length; i++) {
    for (let j = i + 1; j < dimensions.length; j++) {
      for (const a of dimensions[i]!.values) {
        for (const b of dimensions[j]!.values) {
          uncovered.add(pairKey(dimensions[i]!.id, a.id, dimensions[j]!.id, b.id));
          ordered.push({ da: dimensions[i]!.id, va: a.id, db: dimensions[j]!.id, vb: b.id });
        }
      }
    }
  }
  const total = uncovered.size;

  // Pairs an existing persona already stands for are not generated again.
  const cover = (combination: Combination): number => {
    let covered = 0;
    for (let i = 0; i < dimensions.length; i++) {
      for (let j = i + 1; j < dimensions.length; j++) {
        const key = pairKey(dimensions[i]!.id, combination[dimensions[i]!.id]!, dimensions[j]!.id, combination[dimensions[j]!.id]!);
        if (uncovered.delete(key)) covered++;
      }
    }
    return covered;
  };
  for (const persona of existing) {
    const traits = dimensions.filter((d) => ownValue(persona.traits, d.id) !== undefined);
    for (let i = 0; i < traits.length; i++) {
      for (let j = i + 1; j < traits.length; j++) {
        uncovered.delete(pairKey(traits[i]!.id, persona.traits[traits[i]!.id]!, traits[j]!.id, persona.traits[traits[j]!.id]!));
      }
    }
  }
  const skipped = total - uncovered.size;

  const combinations: Combination[] = [];
  let truncated = false;
  for (const seed of ordered) {
    if (!uncovered.has(pairKey(seed.da, seed.va, seed.db, seed.vb))) continue;
    if (combinations.length >= limit) {
      truncated = true;
      break;
    }
    const combination: Combination = { [seed.da]: seed.va, [seed.db]: seed.vb };
    for (const dimension of dimensions) {
      if (combination[dimension.id] !== undefined) continue;
      let best = dimension.values[0]!.id;
      let bestGain = -1;
      for (const value of dimension.values) {
        let gain = 0;
        for (const [otherId, otherValue] of Object.entries(combination)) {
          const order = dimensions.findIndex((d) => d.id === otherId) < dimensions.findIndex((d) => d.id === dimension.id);
          const key = order ? pairKey(otherId, otherValue, dimension.id, value.id) : pairKey(dimension.id, value.id, otherId, otherValue);
          if (uncovered.has(key)) gain++;
        }
        if (gain > bestGain) {
          bestGain = gain;
          best = value.id;
        }
      }
      combination[dimension.id] = best;
    }
    // Rows follow the declared dimension order, not the seeding order.
    const row: Combination = {};
    for (const dimension of dimensions) row[dimension.id] = combination[dimension.id]!;
    cover(row);
    combinations.push(row);
  }
  return { combinations, total, skipped_covered: skipped, truncated };
}

export function expandCombinations(dimensions: Dimension[], strategy: Strategy, existing: Persona[], limit: number): GeneratedCombinations {
  return strategy === "all" ? expandAll(dimensions, existing, limit) : expandPairwise(dimensions, existing, limit);
}

const AVATAR_COLORS = ["#4F7CAC", "#C0504D", "#4E9A6B", "#B0833A", "#7B5EA7", "#3F8F9B", "#A65E7E", "#6B7A8F"];

/** Builds the persona for one combination; ids derive from the value ids and never collide with `takenIds`. */
export function buildGeneratedPersona(combination: Combination, dimensions: Dimension[], takenIds: Set<string>, index: number): Persona {
  const labels = dimensions.map((d) => d.values.find((v) => v.id === combination[d.id])?.label ?? combination[d.id]!);
  let base = `gen-${dimensions.map((d) => combination[d.id]).join("-")}`;
  if (!isValidId(base.slice(0, ID_MAX).replace(/-+$/, ""))) base = `gen-${index + 1}`;
  // The collision suffix counts against ID_MAX too.
  const candidate = (n: number): string => {
    const suffix = n === 1 ? "" : `-${n}`;
    return `${base.slice(0, ID_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
  };
  let id = candidate(1);
  for (let n = 2; takenIds.has(id); n++) id = candidate(n);
  takenIds.add(id);
  return {
    id,
    name: labels.join(" · "),
    description: `Generated from ${dimensions.map((d) => `${d.label}: ${d.values.find((v) => v.id === combination[d.id])?.label ?? combination[d.id]}`).join(", ")}.`,
    avatar: { emoji: "🧑", color: AVATAR_COLORS[index % AVATAR_COLORS.length]! },
    traits: { ...combination },
    generated: true,
  };
}

// --- suggest_use_case_variants ---------------------------------------------------------

export type DimensionCoverage = { dimension: string; covered: string[]; uncovered: string[] };

export type VariantSuggestion = {
  id: string;
  title: string;
  when: Record<string, string[]>;
  personas: string[];
};

/**
 * Per dimension, the trait values the persona pool actually uses and whether
 * this use case reaches them: through the traits of its own personas (a
 * persona without the trait stands for any value) or through a variant's
 * `when` on that dimension. Everything else is a gap worth a variant.
 */
export function suggestVariantGaps(
  useCase: UseCase,
  dimensions: Dimension[],
  personas: Persona[],
): { coverage: DimensionCoverage[]; suggestions: VariantSuggestion[] } {
  const byId = new Map(personas.map((p) => [p.id, p]));
  const own = useCase.personas.map((id) => byId.get(id)).filter((p): p is Persona => p !== undefined);
  const coverage: DimensionCoverage[] = [];
  const suggestions: VariantSuggestion[] = [];

  for (const dimension of dimensions) {
    const used = dimension.values.filter((v) => personas.some((p) => ownValue(p.traits, dimension.id) === v.id));
    if (used.length === 0) continue;
    const covered = new Set<string>();
    for (const persona of own) {
      const trait = ownValue(persona.traits, dimension.id);
      if (trait === undefined) dimension.values.forEach((v) => covered.add(v.id));
      else covered.add(trait);
    }
    for (const variant of useCase.variants ?? []) {
      // A variant only speaks for the dimensions its `when` names.
      ownValue(variant.when, dimension.id)?.forEach((v) => covered.add(v));
    }
    const open = used.filter((v) => !covered.has(v.id));
    coverage.push({ dimension: dimension.id, covered: used.filter((v) => covered.has(v.id)).map((v) => v.id), uncovered: open.map((v) => v.id) });
    for (const value of open) {
      suggestions.push({
        id: `${dimension.id}-${value.id}`.slice(0, ID_MAX),
        title: `${useCase.title} — ${dimension.label}: ${value.label}`,
        when: { [dimension.id]: [value.id] },
        personas: personas.filter((p) => ownValue(p.traits, dimension.id) === value.id).map((p) => p.id),
      });
    }
  }
  return { coverage, suggestions };
}
