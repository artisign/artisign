// CHR-637 — the design-system reuse metric, `get_project`'s `reuse` field
// (fields:["reuse"] only — see reads.ts). Home is `get_project`, not
// `get_screen`: the ticket's whole output list (coverage, unused
// components/tokens, worst-reuse screens) is project-scoped, and exposing
// per-screen numbers inside this one field gives the worst-offender
// visibility the ticket asks for without a second surface.

import type { Store } from "../store/index.js";
import {
  isAdHocDesignElement,
  countLiteralDesignValues,
  tokenRefPaths,
  type DesignSystemRegistry,
  type Node as InternalNode,
  type NodeSubtree,
  type ScreenDocument,
} from "../model/index.js";
import { loadAllDocuments, type SourceDoc } from "./definitions.js";

/** A live `Node` or a slot-fill `NodeSubtree` — both carry the fields every metric here reads (`kind`, `refs`, `inlineStyles`). */
type StyleableUnit = { kind: InternalNode["kind"]; refs: InternalNode["refs"]; inlineStyles: Record<string, string> };

/**
 * `doc.nodes` plus every slot-fill's content, recursively — screen-supplied
 * markup filled into a component instance's slots, which never appears in
 * `doc.nodes` at all (CHR-584). The reference note behind this ticket's
 * numbers ("Kinder innerhalb einer Instanz werden nicht doppelt gezählt")
 * only means a component's own template markup isn't counted once per
 * instance — which the model never does anyway, since `slotOverrides` holds
 * only the *screen-supplied* fill content, never the shared definition
 * markup — not that fill content should be excluded outright. Excluding it
 * was the single largest source of miscalibration against the reference
 * figures (CHR-633 review). Mirrors the shape of `reads.ts`'s
 * `collectFillDescendants` (`find_nodes`' own fill walk) without importing
 * it — that one's module-private, and CHR-635's own occurrence-index walk
 * (`tools/style-index.ts`) is deliberately a separate, differently-shaped
 * function for a different job (ad-hoc styling in what one write touched,
 * not project-wide coverage counting) — not something to fold this into.
 */
function collectStyleableUnits(doc: ScreenDocument): StyleableUnit[] {
  const units: StyleableUnit[] = [];
  const visitFill = (sub: NodeSubtree): void => {
    units.push(sub);
    for (const child of sub.children) visitFill(child);
    for (const child of Object.values(sub.slotOverrides ?? {})) visitFill(child);
  };
  for (const node of Object.values(doc.nodes)) {
    units.push(node);
    for (const sub of Object.values(node.slotOverrides ?? {})) visitFill(sub);
  }
  return units;
}

/** `a / b`, or `null` when `b` is 0 — coverage is undefined, not zero, on a screen with nothing to divide. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Mean of whatever's defined, `null` if none are — `reuse(s)` (per-screen) and the project-level means below share this rule. */
function meanOfDefined(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
}

/** Rounds to 2 decimal places — the response is for an agent to read, not a machine to re-derive precision from; matches the ticket's own example shape (0.46, 0.68, ...). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round2OrNull(value: number | null): number | null {
  return value === null ? null : round2(value);
}

type ScreenReuse = { screen: string; component_coverage: number | null; token_coverage: number | null; reuse: number | null };

function computeScreenReuse(source: SourceDoc): ScreenReuse {
  let instances = 0;
  let adhoc = 0;
  let tokenRefCount = 0;
  let literalValues = 0;

  for (const unit of collectStyleableUnits(source.doc)) {
    if (unit.kind === "component_instance") instances += 1;
    if (isAdHocDesignElement(unit)) adhoc += 1;
    for (const [prop, ref] of Object.entries(unit.refs.tokens)) {
      if (prop === "class") continue;
      tokenRefCount += tokenRefPaths(ref).length;
    }
    literalValues += countLiteralDesignValues(unit.inlineStyles, unit.refs.tokens);
  }

  const componentCoverage = ratio(instances, instances + adhoc);
  const tokenCoverage = ratio(tokenRefCount, tokenRefCount + literalValues);
  return {
    screen: source.name,
    component_coverage: componentCoverage,
    token_coverage: tokenCoverage,
    reuse: meanOfDefined([componentCoverage, tokenCoverage]),
  };
}

function flattenTokenPaths(tokens: Record<string, Record<string, unknown>>): string[] {
  const paths: string[] = [];
  for (const [bucket, members] of Object.entries(tokens)) {
    for (const member of Object.keys(members)) paths.push(`${bucket}.${member}`);
  }
  return paths;
}

const WORST_SCREENS_CAP = 10;

/**
 * `computeReuseMetrics` — `get_project`'s `reuse` field. `component_coverage`/
 * `token_coverage`/`score` are the MEAN of the per-screen ratios (CTO
 * decision, CHR-633 review — the source analysis note's own method section:
 * "every screen counts equally"), not an aggregate over pooled counts; a
 * heavily-styled screen and a mostly-empty one contribute equally to the
 * mean regardless of how many nodes either has.
 *
 * `unused_components`/`unused_tokens` scan every source — screens, component
 * definitions, and patterns alike. Patterns count as usage even though a
 * pattern is markup a human pastes, never expanded as a live instance
 * anywhere in the model: `delete_entity` (`lifecycle.ts`'s `deleteComponent`)
 * refuses to delete a component a pattern still references, and a token
 * removed out from under a pattern breaks that pattern's next parse. A list
 * that named either "unused" would send an agent straight into a refused
 * delete or a broken file — these lists exist to be acted on, so they must
 * never name something the delete path itself will refuse.
 *
 * That delete-safety framing hides a different, equally real signal:
 * `components_used_only_in_patterns` (CTO correction, CHR-637 review round
 * 2) names a component no screen and no other component definition ever
 * references — only a pattern does. The split is deliberate, and the two
 * lists answer two different questions: `unused_components` means "nothing
 * references it, safe to delete"; `components_used_only_in_patterns` means
 * "no screen uses it, but deleting it will be refused — either adopt it
 * (reference it from a screen) or remove the pattern reference first". This
 * is CHR-635's own headline case — a component whose only "user" is a
 * pattern nobody instantiates, while its shape gets hand-built on dozens of
 * real screens instead. Omitted from the response when empty, like the
 * other optional pieces here. No token equivalent: an unused token is
 * already a complete signal on its own (`unused_tokens` above), and a
 * pattern-only token reference isn't an interesting distinction on top of
 * it.
 *
 * Default `screens[]` is capped to the 10 lowest-`score` screens (ascending;
 * a screen with `reuse: null` — nothing to divide either ratio by — sorts
 * last, since it's not a low-reuse offender to act on, just an undefined
 * one), with `screens_omitted` reporting the rest. The full array costs
 * thousands of tokens on a real project and isn't what this field is for —
 * measured at 433 tokens against a 600 budget on a 186-screen project with
 * the cap in place.
 */
export async function computeReuseMetrics(store: Store, registry: DesignSystemRegistry): Promise<Record<string, unknown>> {
  // `warnings` (a source that failed to parse) is discarded here, same as
  // `style-index.ts`'s own `loadAllDocuments` call — a metric, unlike
  // `delete_entity`, can afford to skip what it can't read. The consequence
  // is worth naming though: a broken screen silently drops out of every
  // mean below (as if it didn't exist, not as if it scored 0), and any
  // component/token referenced only from that screen reads as unused when
  // it may not be.
  const { docs } = await loadAllDocuments(store, registry);
  const screenSources = docs.filter((d) => d.kind === "screen");

  const perScreen = screenSources.map(computeScreenReuse);

  const usedComponents = new Set<string>();
  const usedComponentsOutsidePatterns = new Set<string>();
  const usedTokenPaths = new Set<string>();
  for (const source of docs) {
    for (const unit of collectStyleableUnits(source.doc)) {
      if (unit.refs.component) {
        usedComponents.add(unit.refs.component);
        if (source.kind !== "pattern") usedComponentsOutsidePatterns.add(unit.refs.component);
      }
      // `class` holds a token-style component ref (`class="$btn-primary"`),
      // not a style-token ref — already captured above via `refs.component`.
      // Same exclusion `index-builder.ts`'s refGraph makes for its own
      // `tokens` map, kept consistent here rather than diverging.
      for (const [prop, ref] of Object.entries(unit.refs.tokens)) {
        if (prop === "class") continue;
        for (const path of tokenRefPaths(ref)) usedTokenPaths.add(path);
      }
    }
  }

  // `collectStyleableUnits` walks a component definition's own template
  // markup too (`docs` includes component sources), so a component
  // referenced only from inside another component's definition — never
  // from a screen or pattern directly — still counts as used here. That's
  // consistent with the same lists' pattern rule above: real usage is
  // "the delete path would refuse", and `deleteComponent` walks every
  // source's nodes the same way, component definitions included.
  const [componentNames, tokens] = await Promise.all([store.listComponents(), store.readTokens()]);
  const unusedComponents = componentNames.filter((name) => !usedComponents.has(name)).sort();
  const unusedTokens = flattenTokenPaths(tokens)
    .filter((path) => !usedTokenPaths.has(path))
    .sort();
  const componentsUsedOnlyInPatterns = componentNames
    .filter((name) => usedComponents.has(name) && !usedComponentsOutsidePatterns.has(name))
    .sort();

  // Two `null`-reuse screens produce `Infinity - Infinity` = `NaN` here;
  // `Array.prototype.sort` treats a `NaN` comparator result as 0 (elements
  // considered equal, relative order preserved) — not a bug, just worth
  // flagging so a future "cleanup" doesn't turn it into a real ordering
  // rule. Pinned by the "both-null" sort test below.
  const sortedScreens = [...perScreen].sort((a, b) => (a.reuse ?? Infinity) - (b.reuse ?? Infinity));
  const worstScreens = sortedScreens.slice(0, WORST_SCREENS_CAP).map((s) => ({
    screen: s.screen,
    component_coverage: round2OrNull(s.component_coverage),
    token_coverage: round2OrNull(s.token_coverage),
    reuse: round2OrNull(s.reuse),
  }));

  return {
    component_coverage: round2OrNull(meanOfDefined(perScreen.map((s) => s.component_coverage))),
    token_coverage: round2OrNull(meanOfDefined(perScreen.map((s) => s.token_coverage))),
    // `score`, not `reuse`, for the project-level mean-of-means — deliberate
    // naming split (DX spec, CHR-633), not an inconsistency: it's the same
    // quantity as each screen's own `reuse` field, but nesting it as
    // `res.reuse.reuse` reads badly.
    score: round2OrNull(meanOfDefined(perScreen.map((s) => s.reuse))),
    unused_components: unusedComponents,
    unused_tokens: unusedTokens,
    ...(componentsUsedOnlyInPatterns.length > 0 ? { components_used_only_in_patterns: componentsUsedOnlyInPatterns } : {}),
    screens: worstScreens,
    screens_omitted: Math.max(0, sortedScreens.length - WORST_SCREENS_CAP),
  };
}
