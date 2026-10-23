import { NodeIdAllocator, flowFromAttributes, flowToAttributes, type Flow, type Node as InternalNode, type NodeSubtree, type ScreenDocument } from "../model/index.js";
import { takenIds } from "./patch.js";

/**
 * Converts a live document node (with its screen-local id) into a detached,
 * id-less subtree. A `component_instance` node keeps all of its content in
 * `slotOverrides`, never `childIds` — `slotOverrides` is carried through
 * unchanged (already detached `NodeSubtree` data, not flat-mapped nodes) so
 * nested instances aren't silently emptied out.
 */
export function nodeToSubtree(doc: ScreenDocument, nodeId: string): NodeSubtree {
  const node = doc.nodes[nodeId]!;
  return {
    kind: node.kind,
    tag: node.tag,
    text: node.text,
    attributes: node.attributes,
    refs: node.refs,
    inlineStyles: node.inlineStyles,
    children: node.childIds.map((childId) => nodeToSubtree(doc, childId)),
    slotOverrides: node.slotOverrides,
  };
}

/**
 * Deep structural equality between two detached subtrees — used by
 * `promote_to_system(kind: "component")` to find *other* occurrences of the
 * promoted node elsewhere in the project (Tool-Palette-Schemas: "rewrites
 * every occurrence in screens/ to a ref"). Ignores nothing: same kind/tag/
 * text, same attributes/refs/inlineStyles content, same children
 * recursively. Sensitive to declaration order within `attributes`/
 * `inlineStyles`/`refs.tokens` — two nodes that are semantically identical
 * but declared their styles/attributes in a different order won't match.
 * That's an accepted, documented limitation, not a bug: a proper
 * order-independent comparison is more machinery than an MVP promotion
 * feature justifies.
 */
export function subtreesStructurallyEqual(a: NodeSubtree, b: NodeSubtree): boolean {
  if (a.kind !== b.kind || a.tag !== b.tag || a.text !== b.text) return false;
  if (JSON.stringify(a.attributes) !== JSON.stringify(b.attributes)) return false;
  if (JSON.stringify(a.refs) !== JSON.stringify(b.refs)) return false;
  if (JSON.stringify(a.inlineStyles) !== JSON.stringify(b.inlineStyles)) return false;
  if (a.children.length !== b.children.length) return false;
  if (!a.children.every((child, i) => subtreesStructurallyEqual(child, b.children[i]!))) return false;

  // A component_instance's real content lives in slotOverrides, not
  // children — without this, two instances with different slot content
  // (or one bound to a different component name via refs, already caught
  // above) would compare equal on their empty children arrays alone.
  const aSlots = a.slotOverrides ?? {};
  const bSlots = b.slotOverrides ?? {};
  const aKeys = Object.keys(aSlots).sort();
  const bKeys = Object.keys(bSlots).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) return false;
  return aKeys.every((key) => subtreesStructurallyEqual(aSlots[key]!, bSlots[key]!));
}

export function collectDescendantIds(doc: ScreenDocument, nodeId: string, out: string[]): void {
  const node = doc.nodes[nodeId];
  if (!node) return;
  for (const childId of node.childIds) {
    out.push(childId);
    collectDescendantIds(doc, childId, out);
  }
}

/**
 * A node's flow edge lives in `doc.flows`, not in its attributes, so folding a
 * subtree into slot fills would drop it from the HTML and from flows.json
 * (CHR-778). Fill content keeps its `data-flow-*` as raw attributes instead,
 * and the fill keeps the node's id (generated or authored — ids are serialized
 * and stay stable), which is what addresses the edge (`<screen>.<id>`).
 */
function carryFlowsIntoFills(doc: ScreenDocument, flows: Map<string, Flow>, nodeId: string, sub: NodeSubtree): void {
  const flow = flows.get(nodeId);
  if (flow) {
    sub.attributes = { ...sub.attributes, ...flowToAttributes(flow) };
    sub.id = nodeId;
  }
  const node = doc.nodes[nodeId]!;
  for (const [i, childId] of node.childIds.entries()) carryFlowsIntoFills(doc, flows, childId, sub.children[i]!);
}

/**
 * Converts `node` in-place from a plain element into a `component_instance`
 * bound to `componentName`. Its current children are preserved by moving
 * them into `slotOverrides` (positional `slot-0`, `slot-1`, …) and removing
 * their now-redundant entries from the flat node map — mirroring what the
 * parser itself does when it first encounters `class="$name"` resolving to
 * a component. Without this, the serializer (which renders
 * `component_instance` nodes from `slotOverrides` only, never `childIds`)
 * would silently drop the node's entire subtree.
 */
export function convertToComponentInstance(doc: ScreenDocument, node: InternalNode, componentName: string): void {
  const descendantIds: string[] = [];
  collectDescendantIds(doc, node.id, descendantIds);
  const subtree = nodeToSubtree(doc, node.id);
  const flowsByTrigger = new Map(doc.flows.map((f) => [f.triggerNodeId, f]));
  for (const [i, child] of node.childIds.entries()) carryFlowsIntoFills(doc, flowsByTrigger, child, subtree.children[i]!);

  node.kind = "component_instance";
  node.refs.component = componentName;
  node.slotOverrides = Object.fromEntries(subtree.children.map((child, i) => [`slot-${i}`, child]));
  node.childIds = [];
  for (const id of descendantIds) delete doc.nodes[id];
  // Their flows now live on the fills' attributes (carried above), not in doc.flows.
  const gone = new Set(descendantIds);
  doc.flows = doc.flows.filter((f) => !gone.has(f.triggerNodeId));
}

function materializeSubtree(
  doc: ScreenDocument,
  subtree: NodeSubtree,
  parentId: string,
  allocator: NodeIdAllocator,
): string {
  if (subtree.kind === "text") {
    const id = allocator.allocateTextId(parentId);
    doc.nodes[id] = {
      id,
      parentId,
      screenId: doc.id,
      kind: "text",
      text: subtree.text,
      attributes: {},
      refs: { tokens: {} },
      inlineStyles: {},
      childIds: [],
    };
    return id;
  }

  // Keep the fill's own id unless a live node already uses it (only via hand edits).
  const id = allocator.allocateElementId(subtree.id !== undefined && !doc.nodes[subtree.id] ? subtree.id : undefined);
  // The fill's flow is a real node flow again: it moves from the raw
  // attributes into doc.flows (the serializer emits it from there).
  const attributes = { ...subtree.attributes };
  const { flow } = flowFromAttributes(id, attributes);
  if (flow) doc.flows.push(flow);
  // Always stripped: a trigger without a target must not stay behind as a reserved attribute.
  delete attributes["data-flow-target"];
  delete attributes["data-flow-trigger"];
  // A component_instance's content stays embedded in slotOverrides, never
  // flat-mapped via childIds — materializing its (empty) `children` instead
  // would silently drop it, the same bug this subtree machinery had before.
  const isInstance = subtree.kind === "component_instance";
  const childIds = isInstance ? [] : subtree.children.map((child) => materializeSubtree(doc, child, id, allocator));
  doc.nodes[id] = {
    id,
    parentId,
    screenId: doc.id,
    kind: subtree.kind,
    tag: subtree.tag,
    attributes,
    refs: subtree.refs,
    inlineStyles: subtree.inlineStyles,
    slotOverrides: isInstance ? subtree.slotOverrides : undefined,
    childIds,
  };
  return id;
}

/**
 * Reverses `convertToComponentInstance`: turns a `component_instance` back
 * into a plain element, re-materializing its `slotOverrides` content as real
 * entries in the flat node map. A fill that carries its own id (every fill
 * with a flow does, see `carryFlowsIntoFills`) gets that id back; the rest were
 * never recorded, so new ones are minted, the same way `patch_html`'s fragment
 * splicing does for newly-inserted content.
 */
export function revertComponentInstanceToElement(doc: ScreenDocument, node: InternalNode): void {
  const allocator = new NodeIdAllocator();
  // Live ids plus fill ids (folded fills keep theirs), so a minted id never repeats one.
  allocator.seedUsed(takenIds(doc));

  const slotOverrides = node.slotOverrides ?? {};
  const childIds = Object.values(slotOverrides).map((subtree) => materializeSubtree(doc, subtree, node.id, allocator));

  node.kind = "element";
  delete node.refs.component;
  delete node.slotOverrides;
  node.childIds = childIds;
}
