import { parseScreen, type DesignSystemRegistry, type Node as InternalNode, type ScreenDocument, type ValidationIssue } from "../model/index.js";
import { isBlockingIssue } from "./issue-filter.js";
import { ToolError } from "./types.js";

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

function nodeClasses(node: InternalNode): string[] {
  return (node.attributes.class ?? "").split(/\s+/).filter(Boolean);
}

export function findBySelector(doc: ScreenDocument, selector: string): InternalNode[] {
  const parsed = parseSimpleSelector(selector);
  return Object.values(doc.nodes).filter((node) => {
    if (node.kind === "text") return false;
    if (parsed.tag && node.tag !== parsed.tag) return false;
    if (parsed.id && node.id !== parsed.id) return false;
    if (parsed.classes.length > 0 && !parsed.classes.every((c) => nodeClasses(node).includes(c))) return false;
    if (parsed.attrs.length > 0 && !parsed.attrs.every(([k, v]) => node.attributes[k] === v)) return false;
    return true;
  });
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
  const { doc: fragDoc, errors } = parseScreen(wrapped, doc.id, registry, { reservedIds: Object.keys(doc.nodes) });
  const blocking = errors.filter(isBlockingIssue);
  if (blocking.length > 0) {
    throw new ToolError("validation_failed", blocking.map((e) => e.message).join("; "));
  }
  const refWarnings = errors.filter((e) => !isBlockingIssue(e));

  const syntheticRootId = fragDoc.rootNodeId;
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
