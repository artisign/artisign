import type { UseCase } from "./schema.js";

export type UseCaseFilter = {
  group?: string;
  persona?: string;
  screen?: string;
  node?: string;
  tag?: string;
  status?: string;
  query?: string;
  has_variants?: boolean;
};

export const SORT_KEYS = ["group", "title", "id", "status"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type UseCaseSummary = {
  id: string;
  title: string;
  group?: string;
  status: string;
  personas?: string[];
  tags?: string[];
  steps: number;
  variants?: number;
  screens?: string[];
};

/** Every step of the base flow plus every step a variant introduces — the places a use case can touch a screen. */
function allSteps(useCase: UseCase): { actor: string; screen?: string; node?: string; action: string }[] {
  const steps = useCase.steps.map((s) => ({ actor: s.actor, action: s.action, screen: s.target?.screen, node: s.target?.node }));
  for (const variant of useCase.variants ?? []) {
    for (const op of variant.steps ?? []) {
      if (op.op !== "remove") steps.push({ actor: op.step.actor, action: op.step.action, screen: op.step.target?.screen, node: op.step.target?.node });
    }
  }
  return steps;
}

export function screensOf(useCase: UseCase): string[] {
  return [...new Set(allSteps(useCase).flatMap((s) => (s.screen ? [s.screen] : [])))].sort();
}

export function personasOf(useCase: UseCase): Set<string> {
  const ids = new Set(useCase.personas);
  for (const variant of useCase.variants ?? []) for (const id of variant.personas ?? []) ids.add(id);
  for (const step of allSteps(useCase)) if (step.actor !== "system") ids.add(step.actor);
  return ids;
}

/** Path-prefix match: "catalog" matches "catalog" and "catalog/loans", not "catalog-x". */
function inGroup(group: string | undefined, prefix: string): boolean {
  const wanted = prefix.replace(/\/+$/, "");
  return group !== undefined && (group === wanted || group.startsWith(`${wanted}/`));
}

function haystack(useCase: UseCase): string {
  const parts = [useCase.id, useCase.title, useCase.goal, useCase.trigger, useCase.outcome, ...useCase.steps.map((s) => s.action)];
  return parts.filter((p): p is string => p !== undefined).join("\n").toLowerCase();
}

export function matchesFilter(useCase: UseCase, filter: UseCaseFilter): boolean {
  if (filter.status !== undefined && useCase.status !== filter.status) return false;
  if (filter.group !== undefined && !inGroup(useCase.group, filter.group)) return false;
  if (filter.tag !== undefined && !(useCase.tags ?? []).some((t) => t.toLowerCase() === filter.tag!.toLowerCase())) return false;
  if (filter.has_variants !== undefined && ((useCase.variants?.length ?? 0) > 0) !== filter.has_variants) return false;
  if (filter.persona !== undefined && !personasOf(useCase).has(filter.persona)) return false;
  if (filter.screen !== undefined || filter.node !== undefined) {
    const hit = allSteps(useCase).some((s) => (filter.screen === undefined || s.screen === filter.screen) && (filter.node === undefined || s.node === filter.node));
    if (!hit) return false;
  }
  if (filter.query !== undefined && filter.query.trim() !== "" && !haystack(useCase).includes(filter.query.trim().toLowerCase())) return false;
  return true;
}

const collator = new Intl.Collator();

const STATUS_ORDER = ["draft", "ready"];

function rank(order: string[], value: string | undefined): number {
  const index = value === undefined ? -1 : order.indexOf(value);
  return index === -1 ? order.length : index;
}

/** Stable total order: the chosen key first, then group, title and id as tie-breakers. */
export function compareUseCases(sort: SortKey): (a: UseCase, b: UseCase) => number {
  const text = (a: string | undefined, b: string | undefined): number => collator.compare(a ?? "\uffff", b ?? "\uffff");
  return (a, b) => {
    let result = 0;
    if (sort === "status") result = rank(STATUS_ORDER, a.status) - rank(STATUS_ORDER, b.status);
    else if (sort === "title") result = text(a.title, b.title);
    else if (sort === "id") result = text(a.id, b.id);
    if (result === 0) result = text(a.group, b.group);
    if (result === 0) result = text(a.title, b.title);
    if (result === 0) result = text(a.id, b.id);
    return result;
  };
}

export function summarize(useCase: UseCase): UseCaseSummary {
  const screens = screensOf(useCase);
  return {
    id: useCase.id,
    title: useCase.title,
    ...(useCase.group !== undefined ? { group: useCase.group } : {}),
    status: useCase.status,
    ...(useCase.personas.length > 0 ? { personas: useCase.personas } : {}),
    ...(useCase.tags && useCase.tags.length > 0 ? { tags: useCase.tags } : {}),
    steps: useCase.steps.length,
    ...(useCase.variants && useCase.variants.length > 0 ? { variants: useCase.variants.length } : {}),
    ...(screens.length > 0 ? { screens } : {}),
  };
}

export const FACET_LIMIT = 50;

export type Facets = Record<"status" | "group" | "tag" | "persona", Record<string, number>>;

/** Counts over `useCases` per facet, biggest first, each capped at FACET_LIMIT; `truncated` names the capped ones. */
export function facetCounts(useCases: UseCase[]): { facets: Facets; truncated: string[] } {
  const raw: Record<keyof Facets, Map<string, number>> = {
    status: new Map(),
    group: new Map(),
    tag: new Map(),
    persona: new Map(),
  };
  const bump = (facet: keyof Facets, key: string | undefined): void => {
    if (key !== undefined) raw[facet].set(key, (raw[facet].get(key) ?? 0) + 1);
  };
  for (const useCase of useCases) {
    bump("status", useCase.status);
    bump("group", useCase.group);
    for (const tag of new Set(useCase.tags ?? [])) bump("tag", tag);
    for (const persona of personasOf(useCase)) bump("persona", persona);
  }
  const facets = {} as Facets;
  const truncated: string[] = [];
  for (const name of Object.keys(raw) as (keyof Facets)[]) {
    const entries = [...raw[name]].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
    if (entries.length > FACET_LIMIT) truncated.push(name);
    facets[name] = Object.fromEntries(entries.slice(0, FACET_LIMIT));
  }
  return { facets, truncated };
}
