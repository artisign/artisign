import type { Store } from "../store/index.js";
import { isGeneratedId, type Node as InternalNode, type ScreenDocument } from "../model/index.js";
import { loadScreen } from "./context.js";

/** Below this `shared / max(base, member)` ratio two screens are not treated as variants of each other. */
const LOW_OVERLAP_RATIO = 0.25;

export type CompareMember = {
  screen: string;
  status: "ok" | "low_overlap";
  overlap: { shared: number; base: number; member: number; ratio: number };
  added: string[];
  removed: { id: string; parent: string | null }[];
  changed: string[];
  counts: { added: number; removed: number; changed: number };
};

export type CompareResult = { base: string; members: CompareMember[] };

/** An element takes part in matching only if its id was authored; generated ids and text nodes fold into the nearest identity ancestor. */
function isIdentity(node: InternalNode): boolean {
  return node.kind !== "text" && !isGeneratedId(node.id);
}

/** Own look of a node — everything except its id and place in the tree. */
function ownSignature(node: InternalNode): Record<string, unknown> {
  return {
    kind: node.kind,
    tag: node.tag,
    text: node.text,
    attributes: node.attributes,
    refs: node.refs,
    inlineStyles: node.inlineStyles,
    slotOverrides: node.slotOverrides,
  };
}

/** The node's own look plus its anonymous descendants, in order, down to (not into) the next identity descendant. */
function foldedSignature(doc: ScreenDocument, node: InternalNode): unknown {
  return {
    ...ownSignature(node),
    anonymous: node.childIds.flatMap((childId) => {
      const child = doc.nodes[childId];
      return child && !isIdentity(child) ? [foldedSignature(doc, child)] : [];
    }),
  };
}

type IdentityIndex = {
  /** Identity ids in document order. */
  order: string[];
  signatures: Map<string, string>;
  /** Nearest identity ancestor per identity id; null when there is none. */
  parents: Map<string, string | null>;
};

function indexIdentities(doc: ScreenDocument): IdentityIndex {
  const index: IdentityIndex = { order: [], signatures: new Map(), parents: new Map() };
  const walk = (nodeId: string, identityAncestor: string | null): void => {
    const node = doc.nodes[nodeId];
    if (!node) return;
    let next = identityAncestor;
    if (isIdentity(node)) {
      index.order.push(node.id);
      index.signatures.set(node.id, JSON.stringify(foldedSignature(doc, node)));
      index.parents.set(node.id, identityAncestor);
      next = node.id;
    }
    for (const childId of node.childIds) walk(childId, next);
  };
  walk(doc.rootNodeId, null);
  return index;
}

/** Ids of `ids` whose nearest identity ancestor is not itself in `ids` — the roots of each added/removed subtree. */
function subtreeRoots(ids: string[], parents: Map<string, string | null>): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const parent = parents.get(id);
    return parent === null || parent === undefined || !set.has(parent);
  });
}

function compareOne(baseIndex: IdentityIndex, screen: string, member: IdentityIndex): CompareMember {
  const memberIds = new Set(member.order);
  const shared = baseIndex.order.filter((id) => memberIds.has(id)).length;
  const max = Math.max(baseIndex.order.length, member.order.length);
  const ratio = max === 0 ? 0 : shared / max;
  const overlap = {
    shared,
    base: baseIndex.order.length,
    member: member.order.length,
    ratio: Math.round(ratio * 100) / 100,
  };

  if (baseIndex.order.length === 0 || member.order.length === 0 || ratio < LOW_OVERLAP_RATIO) {
    return { screen, status: "low_overlap", overlap, added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0 } };
  }

  const baseIds = new Set(baseIndex.order);
  const added = member.order.filter((id) => !baseIds.has(id));
  const removed = baseIndex.order.filter((id) => !memberIds.has(id));
  const changed = member.order.filter((id) => baseIds.has(id) && member.signatures.get(id) !== baseIndex.signatures.get(id));

  return {
    screen,
    status: "ok",
    overlap,
    added: subtreeRoots(added, member.parents),
    removed: subtreeRoots(removed, baseIndex.parents).map((id) => ({ id, parent: baseIndex.parents.get(id) ?? null })),
    changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
  };
}

/**
 * Structural comparison of screens against a reference, matched by authored
 * node ids only (no fuzzy, positional or structural fallback). Generated ids
 * and text fold into the nearest identity ancestor, so an anonymous edit
 * marks that ancestor `changed` and never shifts other nodes into
 * added/removed. `added`/`changed` refer to the member's DOM, `removed` to
 * the reference's; `removed[].parent` is the nearest identity ancestor in the
 * reference, `null` if there is none. Bare ids, no HTML.
 */
export async function compareScreens(store: Store, base: string, others: string[]): Promise<CompareResult> {
  const baseIndex = indexIdentities((await loadScreen(store, base)).doc);
  const members: CompareMember[] = [];
  for (const other of others) {
    members.push(compareOne(baseIndex, other, indexIdentities((await loadScreen(store, other)).doc)));
  }
  return { base, members };
}
