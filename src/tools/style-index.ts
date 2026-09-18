// CHR-635 — the project-wide style-occurrence index `computeRepeatedPatternWarnings`
// (model/validate.ts) matches a write's own candidate nodes against.
//
// Built fresh per write, never cached: `.artisign/index.json` (model/index-builder.ts)
// stores `refs` only, never `inlineStyles`, and no tool reads that cache
// today — extending it would be the first tool-layer consumer, a new
// coupling ADR-001 doesn't ask for on the numbers below.
//
// Measured cost (3 runs each, warm-ish disk cache, real 186-screen/42-
// component project): loadAllDocuments (screens+components+patterns)
// 61.8-112.8ms, mean ~80ms; screens only, 49.7-69.4ms, mean ~56ms. Well
// under a 150ms budget — writes.ts's cheap pre-check (only build this when
// the write's own affected nodes contain a qualifying node) is cheap
// insurance against the worst case drifting past that on a slower machine,
// not a response to these numbers actually being a problem.

import type { Store } from "../store/index.js";
import {
  parseComponentDefinition,
  parseScreen,
  isRepeatedPatternCandidate,
  repeatedPatternFingerprint,
  type DesignSystemRegistry,
  type ScreenId,
  type StyleOccurrenceIndex,
  type NodeSubtree,
} from "../model/index.js";
import { loadAllDocuments } from "./definitions.js";

function recordOccurrence(fingerprint: string, screen: ScreenId, byScreen: Map<string, Set<ScreenId>>): void {
  const screens = byScreen.get(fingerprint) ?? new Set<ScreenId>();
  screens.add(screen);
  byScreen.set(fingerprint, screens);
}

/**
 * Walks a component instance's slot-fill content — screen-supplied markup
 * substituted into a definition's slot, which never appears in `doc.nodes`
 * at all (CHR-584) — recursively, since a fill can itself be a component
 * instance with its own fills. A screen's own hand-built fill content is
 * that screen's content and a real occurrence, same as anything in
 * `doc.nodes` (CTO decision, CHR-633 review — the calibration note found
 * this is where much of the real duplication `repeated_pattern` exists to
 * catch actually lives). Mirrors the shape of `reads.ts`'s
 * `collectFillDescendants` (find_nodes' fill-matching walk) without
 * importing it — that one's module-private, and this walk's only consumer
 * is the occurrence index, not a second general-purpose export.
 */
function collectFillOccurrences(subtree: NodeSubtree, screen: ScreenId, byScreen: Map<string, Set<ScreenId>>): void {
  if (isRepeatedPatternCandidate(subtree)) {
    recordOccurrence(repeatedPatternFingerprint(subtree), screen, byScreen);
  }
  for (const child of subtree.children) collectFillOccurrences(child, screen, byScreen);
  for (const child of Object.values(subtree.slotOverrides ?? {})) collectFillOccurrences(child, screen, byScreen);
}

/**
 * `byScreen` is built from `source.kind === "screen"` sources only —
 * patterns/components must never feed it (the AC is screen-occurrence
 * only; a repeated *definition* is a design-system authoring choice, not
 * the "the same ad-hoc thing keeps getting hand-built" signal this warning
 * flags). `byComponent` is built from each component's default-variant
 * root only — `defaultVariant` isn't on `loadAllDocuments`'s `SourceDoc`,
 * so each component definition is parsed once more via
 * `parseComponentDefinition` to get it. `loadAllDocuments` already returns
 * components in name order, so "first match per fingerprint wins" is
 * deterministic regardless of on-disk file order.
 */
export async function buildStyleOccurrenceIndex(store: Store, registry: DesignSystemRegistry): Promise<StyleOccurrenceIndex> {
  const { docs } = await loadAllDocuments(store, registry);

  const byScreen = new Map<string, Set<ScreenId>>();
  for (const source of docs) {
    if (source.kind !== "screen") continue;
    for (const node of Object.values(source.doc.nodes)) {
      if (isRepeatedPatternCandidate(node)) {
        recordOccurrence(repeatedPatternFingerprint(node), source.name, byScreen);
      }
      if (node.slotOverrides) {
        for (const subtree of Object.values(node.slotOverrides)) {
          collectFillOccurrences(subtree, source.name, byScreen);
        }
      }
    }
  }

  const byComponent = new Map<string, string>();
  const componentNames = docs.filter((d) => d.kind === "component").map((d) => d.name);
  for (const name of new Set(componentNames)) {
    const html = await store.readComponent(name);
    const definition = parseComponentDefinition(name, html);
    const defaultVariant = definition.variants.find((v) => v.name === definition.defaultVariant);
    if (!defaultVariant) continue;
    const { doc } = parseScreen(defaultVariant.htmlAug, name, registry);
    const root = doc.nodes[doc.rootNodeId];
    if (!root) continue;
    const fingerprint = repeatedPatternFingerprint(root);
    if (!byComponent.has(fingerprint)) byComponent.set(fingerprint, name);
  }

  return { byScreen, byComponent };
}
