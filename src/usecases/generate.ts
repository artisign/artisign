import type { Constellation, Dimension, Persona, UseCase } from "./schema.js";
import { ID_MAX, isValidId, ownValue } from "./schema.js";

export type Combination = Record<string, string>;
/** Anything coverage looks at: a persona, or a constellation when generating those. */
export type Covering = { traits: Record<string, string> };
export type Strategy = "all" | "pairwise";

/**
 * An existing persona covers a combination when every one of its traits
 * matches it — a missing trait means "any value".
 * A persona without any trait is a catch-all and covers nothing here, or
 * generating around it would never produce anything.
 */
export function personaCovers(persona: Covering, combination: Combination): boolean {
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
  /** Set when the work budget ran out before the whole space was walked: the result is a prefix, not the full answer. */
  partial?: true;
};

/**
 * Upper bound on the basic steps one expansion may take (a step is one
 * combination visited, one persona checked against it, one pair weighed).
 * The daemon runs the expansion in a single tick, so a call must not walk an
 * unbounded space: 2,000,000 steps is on the order of 100 ms, far above what
 * the default limit of 100 personas needs, and still lets `all` visit the
 * whole 1,000,000-combination space when few personas exist. When it runs out
 * the result is returned as `partial`.
 */
export const WORK_BUDGET = 2_000_000;

/** Number of value pairs `pairwise` has to cover — the pairwise counterpart of the size of the full product. */
export function pairSpace(dimensions: Dimension[]): number {
  let pairs = 0;
  for (let i = 0; i < dimensions.length; i++) {
    for (let j = i + 1; j < dimensions.length; j++) pairs += dimensions[i]!.values.length * dimensions[j]!.values.length;
  }
  return pairs;
}

function productSize(dimensions: Dimension[]): number {
  return dimensions.reduce((size, d) => size * d.values.length, 1);
}

function expandAll(dimensions: Dimension[], existing: Covering[], limit: number, budget: number): GeneratedCombinations {
  const combinations: Combination[] = [];
  let skipped = 0;
  let truncated = false;
  let partial = false;
  let work = 0;
  const counters = dimensions.map(() => 0);
  const total = productSize(dimensions);
  // Odometer over the dimensions in declared order — last dimension varies fastest, so output order is stable.
  for (let n = 0; n < total; n++) {
    work += 1 + existing.length;
    if (work > budget) {
      partial = true;
      break;
    }
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
  return { combinations, total, skipped_covered: skipped, truncated, ...(partial ? { partial: true as const } : {}) };
}

/**
 * Greedy all-pairs cover: every value pair of two different dimensions ends up
 * in at least one combination. Deterministic — the first uncovered pair (in
 * declared dimension/value order) seeds each row, the remaining dimensions take
 * the value that covers the most new pairs, ties to the first declared value.
 * A single dimension degenerates to one combination per value.
 *
 * A pair (a = x, b = y) counts as already covered when some persona with at
 * least one trait on the expanded dimensions has x or no trait on `a`, and y or
 * no trait on `b` — the any-value rule `all` follows (a persona without such a
 * trait covers nothing). Every step counts against `budget`: one pair weighed,
 * one persona trait indexed, one persona visited per dimension pair, one value
 * weighed while a row is built. If the budget runs out before coverage is
 * known, nothing is generated.
 */
function expandPairwise(dimensions: Dimension[], existing: Covering[], limit: number, budget: number): GeneratedCombinations {
  let work = 0;
  if (dimensions.length === 1) {
    const only = dimensions[0]!;
    const all = only.values.map((v): Combination => ({ [only.id]: v.id }));
    const open: Combination[] = [];
    for (const c of all) {
      work++;
      let covered = false;
      for (const p of existing) {
        work++;
        if (personaCovers(p, c)) {
          covered = true;
          break;
        }
      }
      if (work > budget) return { combinations: [], total: all.length, skipped_covered: 0, truncated: false, partial: true };
      if (!covered) open.push(c);
    }
    return { combinations: open.slice(0, limit), total: all.length, skipped_covered: all.length - open.length, truncated: open.length > limit };
  }

  const count = dimensions.length;
  const dimIndex = new Map(dimensions.map((d, i) => [d.id, i]));
  const valueIndex = dimensions.map((d) => new Map(d.values.map((v, i) => [v.id, i])));
  const size = dimensions.map((d) => d.values.length);
  const total = pairSpace(dimensions);
  const nothingYet = (): GeneratedCombinations => ({ combinations: [], total, skipped_covered: 0, truncated: false, partial: true });

  // A value pair is one slot: its number is the offset of its dimension pair plus x * size[j] + y, in declared order.
  const offset = new Int32Array(count * count);
  let next = 0;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      offset[i * count + j] = next;
      next += size[i]! * size[j]!;
    }
  }

  // Index the personas that count: per dimension, persona position -> pinned value index. A persona with a trait
  // that is not a value of its dimension allows no combination, so it is not indexed and covers nothing (as in `all`).
  const pinned = dimensions.map(() => new Map<number, number>());
  let relevant = 0;
  for (const persona of existing) {
    const entries = Object.entries(persona.traits);
    work += 1 + entries.length;
    const pins: [number, number][] = [];
    let stale = false;
    for (const [dim, value] of entries) {
      const i = dimIndex.get(dim);
      if (i === undefined) continue;
      const v = valueIndex[i]!.get(value);
      if (v === undefined) {
        stale = true;
        break;
      }
      pins.push([i, v]);
    }
    if (stale || pins.length === 0) continue;
    for (const [i, v] of pins) pinned[i]!.set(relevant, v);
    relevant++;
  }
  if (work > budget) return nothingYet();

  // 1 = still to cover. A pair is weighed once here.
  const uncovered = new Uint8Array(total).fill(1);
  let open = total;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const pi = pinned[i]!;
      const pj = pinned[j]!;
      work += 1 + size[i]! * size[j]! + pi.size + pj.size;
      if (work > budget) return nothingYet();
      // Personas pinning neither dimension leave both open: they cover every pair of this dimension pair.
      let union = pi.size;
      const aOnly = new Set<number>();
      const bOnly = new Set<number>();
      const both = new Set<number>();
      for (const [who, x] of pi) {
        const y = pj.get(who);
        if (y === undefined) aOnly.add(x);
        else both.add(x * size[j]! + y);
      }
      for (const [who, y] of pj) {
        if (pi.has(who)) continue;
        union++;
        bOnly.add(y);
      }
      const everything = relevant > union;
      const base = offset[i * count + j]!;
      for (let x = 0; x < size[i]!; x++) {
        for (let y = 0; y < size[j]!; y++) {
          if (everything || aOnly.has(x) || bOnly.has(y) || both.has(x * size[j]! + y)) {
            uncovered[base + x * size[j]! + y] = 0;
            open--;
          }
        }
      }
    }
  }
  const skipped = total - open;

  const combinations: Combination[] = [];
  let truncated = false;
  let partial = false;
  let slot = 0;
  scan: for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      for (let x = 0; x < size[i]!; x++) {
        for (let y = 0; y < size[j]!; y++, slot++) {
          if (!uncovered[slot]) continue;
          if (combinations.length >= limit) {
            truncated = true;
            break scan;
          }
          // The seed pair fixes two dimensions; every other one takes the value that covers the most open pairs.
          const chosen = new Array<number>(count).fill(-1);
          chosen[i] = x;
          chosen[j] = y;
          for (let k = 0; k < count; k++) {
            if (chosen[k]! >= 0) continue;
            let best = 0;
            let bestGain = -1;
            for (let v = 0; v < size[k]!; v++) {
              let gain = 0;
              for (let m = 0; m < count; m++) {
                const other = chosen[m]!;
                if (other < 0) continue;
                const at = m < k ? offset[m * count + k]! + other * size[k]! + v : offset[k * count + m]! + v * size[m]! + other;
                gain += uncovered[at]!;
              }
              if (gain > bestGain) {
                bestGain = gain;
                best = v;
              }
            }
            work += size[k]! * (count - 1);
            if (work > budget) {
              partial = true;
              break scan;
            }
            chosen[k] = best;
          }
          // Marking the row's pairs covered walks every dimension pair once.
          work += (count * (count - 1)) / 2;
          if (work > budget) {
            partial = true;
            break scan;
          }
          for (let a = 0; a < count; a++) {
            for (let b = a + 1; b < count; b++) uncovered[offset[a * count + b]! + chosen[a]! * size[b]! + chosen[b]!] = 0;
          }
          // Rows follow the declared dimension order.
          const row: Combination = {};
          dimensions.forEach((d, k) => {
            row[d.id] = d.values[chosen[k]!]!.id;
          });
          combinations.push(row);
        }
      }
    }
  }
  return { combinations, total, skipped_covered: skipped, truncated, ...(partial ? { partial: true as const } : {}) };
}

export function expandCombinations(dimensions: Dimension[], strategy: Strategy, existing: Covering[], limit: number, budget: number = WORK_BUDGET): GeneratedCombinations {
  return strategy === "all" ? expandAll(dimensions, existing, limit, budget) : expandPairwise(dimensions, existing, limit, budget);
}

const AVATAR_COLORS = ["#4F7CAC", "#C0504D", "#4E9A6B", "#B0833A", "#7B5EA7", "#3F8F9B", "#A65E7E", "#6B7A8F"];

/** `gen-<value ids>` cut to ID_MAX, falling back to `gen-<n>`; a numeric suffix on collision. Added to `takenIds`. */
function generatedId(combination: Combination, dimensions: Dimension[], takenIds: Set<string>, index: number): string {
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
  return id;
}

const valueLabel = (d: Dimension, combination: Combination): string => d.values.find((v) => v.id === combination[d.id])?.label ?? combination[d.id]!;

/** Builds the persona for one combination; ids derive from the value ids and never collide with `takenIds`. */
export function buildGeneratedPersona(combination: Combination, dimensions: Dimension[], takenIds: Set<string>, index: number): Persona {
  return {
    id: generatedId(combination, dimensions, takenIds, index),
    name: dimensions.map((d) => valueLabel(d, combination)).join(" · "),
    description: `Generated from ${dimensions.map((d) => `${d.name}: ${valueLabel(d, combination)}`).join(", ")}.`,
    avatar: { emoji: "🧑", color: AVATAR_COLORS[index % AVATAR_COLORS.length]! },
    traits: { ...combination },
    generated: true,
  };
}

/** Builds a constellation skeleton for one combination: traits only, relationships are left to the agent or the human. */
export function buildGeneratedConstellation(combination: Combination, dimensions: Dimension[], takenIds: Set<string>, index: number): Constellation {
  return {
    id: generatedId(combination, dimensions, takenIds, index),
    name: dimensions.map((d) => valueLabel(d, combination)).join(" · "),
    traits: { ...combination },
    relationships: [],
    generated: true,
  };
}

// --- suggest_use_case_variants ---------------------------------------------------------

export type DimensionCoverage = { dimension: string; covered: string[]; uncovered: string[] };

export type VariantSuggestion = {
  id: string;
  title: string;
  when: Record<string, string[]>;
  /** Left out on skeletons for constellation-scoped dimensions: a variant override replaces the base value whole, so an empty list would wipe it. */
  personas?: string[];
  /** Only on skeletons for constellation-scoped dimensions: the pool constellations with that value. */
  constellations?: string[];
};

/** An id derived from `base` (two valid ids joined by "-"): cut to ID_MAX without a trailing hyphen, a numeric suffix on collision. Always valid, never in `taken`; added to it. */
function freeVariantId(base: string, taken: Set<string>): string {
  const candidate = (n: number): string => {
    const suffix = n === 1 ? "" : `-${n}`;
    return `${base.slice(0, ID_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
  };
  let id = candidate(1);
  for (let n = 2; taken.has(id); n++) id = candidate(n);
  taken.add(id);
  return id;
}

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
  constellations: Constellation[] = [],
): { coverage: DimensionCoverage[]; suggestions: VariantSuggestion[] } {
  const byId = new Map(personas.map((p) => [p.id, p]));
  const ownPersonas = useCase.personas.map((id) => byId.get(id)).filter((p): p is Persona => p !== undefined);
  const constellationById = new Map(constellations.map((c) => [c.id, c]));
  const ownConstellations = (useCase.constellations ?? []).map((id) => constellationById.get(id)).filter((c): c is Constellation => c !== undefined);
  const coverage: DimensionCoverage[] = [];
  const suggestions: VariantSuggestion[] = [];
  const taken = new Set((useCase.variants ?? []).map((v) => v.id));

  for (const dimension of dimensions) {
    const forConstellations = dimension.scope === "constellations";
    // Constellation-scoped dimensions only matter for a case with constellations that resolve.
    if (forConstellations && ownConstellations.length === 0) continue;
    const pool: Covering[] = forConstellations ? constellations : personas;
    const own: Covering[] = forConstellations ? ownConstellations : ownPersonas;
    const used = dimension.values.filter((v) => pool.some((p) => ownValue(p.traits, dimension.id) === v.id));
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
        id: freeVariantId(`${dimension.id}-${value.id}`, taken),
        title: `${useCase.title} — ${dimension.name}: ${value.label}`,
        when: { [dimension.id]: [value.id] },
        ...(forConstellations
          ? { constellations: constellations.filter((c) => ownValue(c.traits, dimension.id) === value.id).map((c) => c.id) }
          : { personas: personas.filter((p) => ownValue(p.traits, dimension.id) === value.id).map((p) => p.id) }),
      });
    }
  }
  return { coverage, suggestions };
}
