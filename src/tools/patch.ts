import {
  parseScreen,
  parseSubtreeFragment,
  type DesignSystemRegistry,
  type Node as InternalNode,
  type NodeSubtree,
  type ScreenDocument,
  type ValidationIssue,
} from "../model/index.js";
import { isBlockingIssue } from "./issue-filter.js";
import { ToolError, RESERVED_SET_ATTR_NAMES, reservedSetAttrMessage } from "./types.js";

/**
 * A deliberately small subset of CSS selector syntax: a single simple
 * selector — optional tag name, plus any mix of `#id`, `.class`,
 * `[attr=value]`. No combinators, no descendant selectors. A full CSS
 * selector engine is out of proportion for `patch_html`'s scope; this
 * covers the common "find the one node I mean" cases.
 */
function parseSimpleSelector(selector: string): { tag?: string; id?: string; classes: string[]; attrs: [string, string][] } {
  const result: { tag?: string; id?: string; classes: string[]; attrs: [string, string][] } = { classes: [], attrs: [] };
  const partRe = /(#[\w-]+)|(\.[\w-]+)|(\[[\w-]+=[^\]]+\])|^([\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = partRe.exec(selector))) {
    const [, idPart, classPart, attrPart, tagPart] = match;
    if (idPart) result.id = idPart.slice(1);
    else if (classPart) result.classes.push(classPart.slice(1));
    else if (attrPart) {
      const inner = attrPart.slice(1, -1);
      const eq = inner.indexOf("=");
      result.attrs.push([inner.slice(0, eq), inner.slice(eq + 1).replace(/^["']|["']$/g, "")]);
    } else if (tagPart) result.tag = tagPart;
  }
  return result;
}

type SelectorSubject = { kind: string; tag?: string; id?: string; attributes: Record<string, string> };

function matchesSelector(parsed: ReturnType<typeof parseSimpleSelector>, subject: SelectorSubject): boolean {
  if (subject.kind === "text") return false;
  if (parsed.tag && subject.tag !== parsed.tag) return false;
  if (parsed.id && subject.id !== parsed.id) return false;
  const classes = (subject.attributes.class ?? "").split(/\s+/).filter(Boolean);
  if (parsed.classes.length > 0 && !parsed.classes.every((c) => classes.includes(c))) return false;
  if (parsed.attrs.length > 0 && !parsed.attrs.every(([k, v]) => subject.attributes[k] === v)) return false;
  return true;
}

export function findBySelector(doc: ScreenDocument, selector: string): InternalNode[] {
  const parsed = parseSimpleSelector(selector);
  return Object.values(doc.nodes).filter((node) => matchesSelector(parsed, node));
}

/**
 * A slot-fill subtree and where it hangs. Fill content lives in a component
 * instance's `slotOverrides`, never in `doc.nodes` (Schema-Spec, CHR-584), so
 * it is addressed here by walking the instances instead. `container` is what
 * a write needs to splice it: the slot record + key for a top-level fill, the
 * parent's `children` array for anything nested deeper.
 */
export type FillLocation = {
  sub: NodeSubtree;
  owner: InternalNode;
  container: { kind: "slot"; slots: Record<string, NodeSubtree>; key: string } | { kind: "children"; siblings: NodeSubtree[] };
};

/** Every slot-fill subtree in the document, pre-order. */
export function collectFills(doc: ScreenDocument): FillLocation[] {
  const out: FillLocation[] = [];
  const visit = (sub: NodeSubtree, owner: InternalNode, container: FillLocation["container"]): void => {
    out.push({ sub, owner, container });
    for (const child of sub.children) visit(child, owner, { kind: "children", siblings: sub.children });
    if (sub.slotOverrides) {
      for (const [key, nested] of Object.entries(sub.slotOverrides)) visit(nested, owner, { kind: "slot", slots: sub.slotOverrides, key });
    }
  };
  for (const node of Object.values(doc.nodes)) {
    if (!node.slotOverrides) continue;
    for (const [key, sub] of Object.entries(node.slotOverrides)) visit(sub, node, { kind: "slot", slots: node.slotOverrides, key });
  }
  return out;
}

export function findFillById(doc: ScreenDocument, id: string): FillLocation | undefined {
  return collectFills(doc).find((f) => f.sub.id === id);
}

export function findFillsBySelector(doc: ScreenDocument, selector: string): FillLocation[] {
  const parsed = parseSimpleSelector(selector);
  return collectFills(doc).filter((f) => matchesSelector(parsed, f.sub));
}

function subtreeIds(sub: NodeSubtree, out: Set<string>): Set<string> {
  if (sub.id !== undefined) out.add(sub.id);
  for (const child of sub.children) subtreeIds(child, out);
  for (const nested of Object.values(sub.slotOverrides ?? {})) subtreeIds(nested, out);
  return out;
}

/** Every id in use on the screen — flat-map nodes plus authored slot-fill ids — minus `exclude` (the ids of a subtree about to be replaced). */
function takenIds(doc: ScreenDocument, exclude?: ReadonlySet<string>): Set<string> {
  const taken = new Set(Object.keys(doc.nodes));
  for (const f of collectFills(doc)) if (f.sub.id !== undefined) taken.add(f.sub.id);
  if (exclude) for (const id of exclude) taken.delete(id);
  return taken;
}

function assertIdsFree(ids: Iterable<string>, taken: ReadonlySet<string>): void {
  for (const id of ids) {
    if (taken.has(id)) throw new ToolError("validation_failed", `id "${id}" is already used in this screen`);
  }
}

export type FillPatch = {
  operation: "replace" | "insert_before" | "insert_after" | "delete" | "set_attr"; 
  html_aug?: string;
  attr?: { name: string; value: string | null };
};

/**
 * Applies one patch operation to a slot-fill subtree, editing the authored
 * fill markup in place (the serializer writes it back out from
 * `slotOverrides`). Returns the ids to report as affected (the fill's own
 * authored ids — or the owning instance's when a fill carries none) plus
 * non-blocking fragment issues, or `null` when an earlier operation in the
 * same call already removed this fill.
 */
export function patchFill(
  doc: ScreenDocument,
  target: NodeSubtree,
  patch: FillPatch,
  registry: DesignSystemRegistry,
): { affected: string[]; refWarnings: { issue: ValidationIssue; owner: string }[] } | null {
  const loc = collectFills(doc).find((f) => f.sub === target);
  if (!loc) return null;
  const { sub, owner, container } = loc;
  const affectedOf = (subs: NodeSubtree[]): string[] => {
    const ids = subs.flatMap((s) => (s.id === undefined ? [] : [s.id]));
    return ids.length > 0 ? ids : [owner.id];
  };
  const removeFromContainer = (): void => {
    if (container.kind === "slot") delete container.slots[container.key];
    else container.siblings.splice(container.siblings.indexOf(sub), 1);
  };

  switch (patch.operation) {
    case "delete":
      removeFromContainer();
      return { affected: affectedOf([sub]), refWarnings: [] };
    case "set_attr": {
      if (!patch.attr) throw new ToolError("validation_failed", 'attr is required for operation "set_attr"');
      if (RESERVED_SET_ATTR_NAMES.has(patch.attr.name)) {
        throw new ToolError("validation_failed", reservedSetAttrMessage(patch.attr.name));
      }
      if (patch.attr.value === null) delete sub.attributes[patch.attr.name];
      else sub.attributes[patch.attr.name] = patch.attr.value;
      return { affected: affectedOf([sub]), refWarnings: [] };
    }
    case "replace":
    case "insert_before":
    case "insert_after": {
      if (!patch.html_aug) throw new ToolError("validation_failed", `html_aug is required for operation "${patch.operation}"`);
      const { subtrees, errors, explicitIds } = parseSubtreeFragment(patch.html_aug, registry);
      const blocking = errors.filter(isBlockingIssue);
      if (blocking.length > 0) throw new ToolError("validation_failed", blocking.map((e) => e.message).join("; "));
      if (subtrees.length === 0) throw new ToolError("validation_failed", "html_aug contains no element");

      // A replace may keep the replaced subtree's own ids; an insert may not.
      const own = subtreeIds(sub, new Set());
      assertIdsFree(explicitIds, takenIds(doc, patch.operation === "replace" ? own : undefined));

      if (container.kind === "slot") {
        // A top-level fill is bound to its slot by name: one element can take
        // its place, but a sibling would need a slot of its own.
        if (patch.operation !== "replace") {
          throw new ToolError(
            "validation_failed",
            "a slot's top-level fill has no siblings — insert inside it, or replace it with a single element",
          );
        }
        if (subtrees.length !== 1) {
          throw new ToolError("validation_failed", "a slot's top-level fill can only be replaced by a single element");
        }
        container.slots[container.key] = subtrees[0]!;
      } else {
        const index = container.siblings.indexOf(sub);
        if (patch.operation === "replace") container.siblings.splice(index, 1, ...subtrees);
        else container.siblings.splice(patch.operation === "insert_before" ? index : index + 1, 0, ...subtrees);
      }
      return {
        affected: affectedOf(subtrees),
        refWarnings: errors.filter((e) => !isBlockingIssue(e)).map((issue) => ({ issue, owner: owner.id })),
      };
    }
  }
}

/**
 * Parses `htmlAug` as a standalone fragment and splices its top-level
 * node(s) into `doc` as new entries, reparented under `parentId`. Ids in the
 * fragment are guaranteed not to collide with `doc`'s existing ids. Returns
 * the ids of the newly spliced top-level nodes, in document order, plus any
 * non-blocking issues found (see issue-filter.ts — `unresolved_ref` and
 * `suspicious_attr`) — those degrade to warnings (same rule as `write_html`,
 * see writes.ts) rather than blocking the patch, since a ref can go
 * dangling for reasons unrelated to this specific edit (a token or
 * component removed elsewhere). Every other error kind still blocks.
 */
export function spliceFragment(
  doc: ScreenDocument,
  htmlAug: string,
  parentId: string,
  registry: DesignSystemRegistry,
): { ids: string[]; refWarnings: ValidationIssue[] } {
  const wrapped = `<div id="__artisign_patch_root__">${htmlAug}</div>`;
  const taken = takenIds(doc);
  const { doc: fragDoc, errors } = parseScreen(wrapped, doc.id, registry, { reservedIds: taken });
  const blocking = errors.filter(isBlockingIssue);
  if (blocking.length > 0) {
    throw new ToolError("validation_failed", blocking.map((e) => e.message).join("; "));
  }
  const refWarnings = errors.filter((e) => !isBlockingIssue(e));

  const syntheticRootId = fragDoc.rootNodeId;
  // Explicit fragment ids are taken as-is by the parser; a collision would
  // overwrite a node or leave a duplicate id in the file. Generated ids were
  // already steered clear of `taken`.
  assertIdsFree(Object.keys(fragDoc.nodes).filter((id) => id !== syntheticRootId), taken);
  const newTopLevelIds = fragDoc.nodes[syntheticRootId]!.childIds;

  for (const [id, node] of Object.entries(fragDoc.nodes)) {
    if (id === syntheticRootId) continue;
    doc.nodes[id] = node;
  }
  for (const id of newTopLevelIds) {
    doc.nodes[id]!.parentId = parentId;
  }
  doc.flows.push(...fragDoc.flows);

  return { ids: newTopLevelIds, refWarnings };
}

/** Removes a node and its entire descendant subtree from `doc`, unlinking it from its parent's childIds. */
export function removeNode(doc: ScreenDocument, nodeId: string): void {
  const node = doc.nodes[nodeId];
  if (!node) return;

  for (const childId of node.childIds) removeNode(doc, childId);

  if (node.parentId) {
    const parent = doc.nodes[node.parentId];
    if (parent) parent.childIds = parent.childIds.filter((id) => id !== nodeId);
  }
  delete doc.nodes[nodeId];
}
