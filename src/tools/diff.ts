import type { Node as InternalNode, ScreenDocument } from "../model/index.js";
import { formatNodeRef } from "./node-ref.js";

export type NodeDiff = { added: string[]; removed: string[]; changed: string[] };

function nodeSignature(node: InternalNode): string {
  // Structural content only — ids/parentId/screenId/childIds are compared
  // separately via set membership, not as part of "did this node change".
  return JSON.stringify({
    kind: node.kind,
    tag: node.tag,
    text: node.text,
    attributes: node.attributes,
    refs: node.refs,
    inlineStyles: node.inlineStyles,
    slotOverrides: node.slotOverrides,
  });
}

/** Diffs two screen documents' node sets by id, for `write_html`/`patch_html`'s `response_mode: "diff"`. */
export function diffScreenDocuments(before: ScreenDocument | null, after: ScreenDocument): NodeDiff {
  const beforeIds = new Set(Object.keys(before?.nodes ?? {}));
  const afterIds = new Set(Object.keys(after.nodes));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of afterIds) {
    if (!beforeIds.has(id)) {
      added.push(formatNodeRef(after.id, id));
    } else if (nodeSignature(before!.nodes[id]!) !== nodeSignature(after.nodes[id]!)) {
      changed.push(formatNodeRef(after.id, id));
    }
  }
  for (const id of beforeIds) {
    if (!afterIds.has(id)) removed.push(formatNodeRef(after.id, id));
  }

  return { added, removed, changed };
}
