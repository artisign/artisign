import type { Store } from "../store/index.js";
import {
  collectFills,
  parseScreen,
  repeatedPatternFingerprint,
  type DesignSystemRegistry,
  type Node,
  type ScreenDocument,
} from "../model/index.js";
import { ToolError, type Warning } from "./types.js";
import { formatNodeRef } from "./node-ref.js";

export const BACKDROP_ATTR = "data-backdrop";

// backdrop_candidate thresholds (CHR-938): an overlay that repeats at least
// this share of ITS OWN nodes AND at least this many of them repeat the parent
// is most likely a copy of the parent with a sheet on top.
export const BACKDROP_CANDIDATE_MIN_SHARE = 0.5;
export const BACKDROP_CANDIDATE_MIN_MATCHED = 20;

export function rootBackdrop(doc: ScreenDocument): string | undefined {
  return doc.nodes[doc.rootNodeId]?.attributes[BACKDROP_ATTR];
}

/**
 * The `data-backdrop` target of a screen on disk, `undefined` when it has
 * none or cannot be read — a missing, unparsable or hand-broken screen ends a
 * chain walk quietly instead of throwing (ADR-008: reads never throw on it).
 */
export async function readBackdropTarget(store: Store, registry: DesignSystemRegistry, screen: string): Promise<string | undefined> {
  try {
    return rootBackdrop(parseScreen(await store.readScreen(screen), screen, registry).doc);
  } catch {
    return undefined;
  }
}

/** Identities of every `data-backdrop` outside the screen root: node ids, `fill:` keys for slot-fill content. */
function misplacedBackdrops(doc: ScreenDocument): string[] {
  const out = Object.values(doc.nodes)
    .filter((n) => n.id !== doc.rootNodeId && n.attributes[BACKDROP_ATTR] !== undefined)
    .map((n) => n.id);
  collectFills(doc).forEach(({ sub, owner }, i) => {
    if (sub.attributes[BACKDROP_ATTR] !== undefined) out.push(`fill:${sub.id ?? `${owner.id}#${i}`}`);
  });
  return out;
}

/**
 * Enforces the `data-backdrop` grammar on a screen about to be written:
 * root-only, an existing target, no self-reference, no cycle back to the
 * written screen. Throws a `ToolError`; nothing has been written yet when it
 * does. Given `before` (the screen as it is on disk), the target checks are
 * skipped when the root's value is unchanged, so a dangling backdrop already
 * on disk does not block an unrelated write; `onlyNewMisplaced` additionally
 * lets a misplaced attribute that was already there pass (a patch).
 */
export async function assertValidBackdrop(
  store: Store,
  registry: DesignSystemRegistry,
  screen: string,
  doc: ScreenDocument,
  options: { before?: ScreenDocument | null; onlyNewMisplaced?: boolean } = {},
): Promise<void> {
  const { before, onlyNewMisplaced } = options;
  const known = new Set(onlyNewMisplaced && before ? misplacedBackdrops(before) : []);
  const misplaced = misplacedBackdrops(doc).filter((id) => !known.has(id));
  if (misplaced.length > 0) {
    const names = misplaced.map((id) => (id.startsWith("fill:") ? id.slice(5).replace(/#\d+$/, "<slot content>") : id)).join(", ");
    throw new ToolError("validation_failed", `${BACKDROP_ATTR} is allowed on the screen root only — remove it from ${names}`);
  }

  const target = rootBackdrop(doc);
  if (target === undefined || (before && rootBackdrop(before) === target)) return;

  if (target === screen) throw new ToolError("validation_failed", `screen "${screen}" cannot be its own backdrop`);
  if (!(await store.listScreens()).includes(target)) {
    throw new ToolError("not_found", `backdrop screen "${target}" was not found`);
  }

  // The visited set also ends the walk on a cycle already on disk that does
  // not involve `screen` (B -> C -> B).
  const chain = [screen, target];
  const visited = new Set(chain);
  let next = await readBackdropTarget(store, registry, target);
  while (next !== undefined) {
    chain.push(next);
    if (next === screen) {
      throw new ToolError("validation_failed", `${BACKDROP_ATTR} would create a cycle: ${chain.join(" -> ")}`);
    }
    if (visited.has(next)) return;
    visited.add(next);
    next = await readBackdropTarget(store, registry, next);
  }
}

/** A node's own text: its direct text children, whitespace-collapsed (element nodes carry no `text` themselves). */
function ownText(doc: ScreenDocument, node: Node): string {
  return node.childIds
    .map((id) => doc.nodes[id])
    .filter((c): c is Node => c?.kind === "text")
    .map((c) => c.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identity of a node for backdrop matching: tag, own text and normalized style; component instances by component and variant. */
function nodeKey(doc: ScreenDocument, node: Node): string {
  if (node.kind === "component_instance") {
    return JSON.stringify(["component", node.refs.component, node.refs.variant ?? "", repeatedPatternFingerprint(node)]);
  }
  return JSON.stringify([node.tag, ownText(doc, node), repeatedPatternFingerprint(node)]);
}

function elementKeys(doc: ScreenDocument): string[] {
  return Object.values(doc.nodes)
    .filter((n) => (n.kind === "element" || n.kind === "component_instance") && n.parentId !== null)
    .map((n) => nodeKey(doc, n));
}

/**
 * Advisory: an overlay that carries no `data-backdrop` but repeats a large
 * part of its `variant_of` parent. Matching is by content fingerprint, never
 * by node id, and multiset-wise: each parent node can be matched by at most
 * one overlay node, so 30 identical overlay nodes do not all count against one
 * parent node. Exits before reading the parent for every non-candidate.
 */
export async function backdropCandidateWarning(store: Store, registry: DesignSystemRegistry, screen: string, doc: ScreenDocument): Promise<Warning | undefined> {
  if (rootBackdrop(doc) !== undefined) return undefined;
  const meta = await store.readScreenMeta(screen);
  if (meta.variant_kind !== "overlay" || !meta.variant_of || meta.variant_of === screen) return undefined;
  const parent = meta.variant_of;
  if (!(await store.listScreens()).includes(parent)) return undefined;

  let parentDoc: ScreenDocument;
  try {
    parentDoc = parseScreen(await store.readScreen(parent), parent, registry).doc;
  } catch {
    return undefined;
  }

  const available = new Map<string, number>();
  for (const key of elementKeys(parentDoc)) available.set(key, (available.get(key) ?? 0) + 1);
  const overlayKeys = elementKeys(doc);
  let matched = 0;
  for (const key of overlayKeys) {
    const left = available.get(key) ?? 0;
    if (left === 0) continue;
    available.set(key, left - 1);
    matched += 1;
  }
  if (matched < BACKDROP_CANDIDATE_MIN_MATCHED || matched < overlayKeys.length * BACKDROP_CANDIDATE_MIN_SHARE) return undefined;

  return {
    kind: "backdrop_candidate",
    target: formatNodeRef(screen, doc.rootNodeId),
    message: `${matched} of ${overlayKeys.length} nodes repeat "${parent}" — add ${BACKDROP_ATTR}="${parent}" on the root and keep only the sheet`,
  };
}

/** Screens outside `deleted` whose backdrop is one of `deleted`, one warning each; nothing is repaired. */
export async function danglingBackdropWarnings(store: Store, registry: DesignSystemRegistry, deleted: string[]): Promise<Warning[]> {
  const warnings: Warning[] = [];
  for (const screen of await store.listScreens()) {
    if (deleted.includes(screen)) continue;
    let doc: ScreenDocument;
    try {
      const html = await store.readScreen(screen);
      // Cheap prefilter: most screens carry no backdrop, so skip their parse.
      if (!html.includes(BACKDROP_ATTR)) continue;
      doc = parseScreen(html, screen, registry).doc;
    } catch {
      continue;
    }
    const target = rootBackdrop(doc);
    if (target === undefined || !deleted.includes(target)) continue;
    warnings.push({
      kind: "dangling_backdrop",
      target: formatNodeRef(screen, doc.rootNodeId),
      message: `screen "${screen}" still names deleted screen "${target}" as its backdrop`,
    });
  }
  return warnings;
}
