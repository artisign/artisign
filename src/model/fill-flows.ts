import type { Flow, FlowTriggerEvent, Node, NodeId, NodeSubtree, ScreenDocument, ValidationIssue } from "./types.js";

export const ALLOWED_FLOW_TRIGGERS: readonly FlowTriggerEvent[] = ["tap", "hover", "longpress", "swipe-left", "swipe-right"];

/** `"checkout.node-id"` targets a node, anything else a screen. */
export function guessFlowTargetKind(flowTarget: string): "screen" | "node" {
  return flowTarget.includes(".") ? "node" : "screen";
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
  owner: Node;
  container: { kind: "slot"; slots: Record<string, NodeSubtree>; key: string } | { kind: "children"; siblings: NodeSubtree[] };
};

/** Every slot-fill subtree in the document, pre-order. */
export function collectFills(doc: ScreenDocument): FillLocation[] {
  const out: FillLocation[] = [];
  const visit = (sub: NodeSubtree, owner: Node, container: FillLocation["container"]): void => {
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

/** Every slot-fill subtree in the document with its owning node (see `collectFills`). */
export function forEachFill(doc: ScreenDocument, visit: (sub: NodeSubtree, ownerId: NodeId) => void): void {
  for (const { sub, owner } of collectFills(doc)) visit(sub, owner.id);
}

/** The raw `data-flow-*` attributes that encode `flow` (the inverse of `flowFromAttributes`); `tap` is the default and stays implicit. */
export function flowToAttributes(flow: Flow): Record<string, string> {
  return {
    "data-flow-target": flow.targetId,
    ...(flow.triggerEvent === "tap" ? {} : { "data-flow-trigger": flow.triggerEvent }),
  };
}

/**
 * The flow a fill's raw `data-flow-target` / `data-flow-trigger` attributes
 * describe, built the same way the parser builds a top-level one: an invalid
 * trigger falls back to `tap` and is reported in `invalidTrigger`. Every
 * consumer (edge collection, revert, render) goes through this one function.
 */
export function flowFromAttributes(
  triggerNodeId: NodeId,
  attributes: Record<string, string>,
): { flow?: Flow; invalidTrigger?: string } {
  const raw = attributes["data-flow-trigger"];
  const invalid = raw && !(ALLOWED_FLOW_TRIGGERS as readonly string[]).includes(raw) ? raw : undefined;
  const target = attributes["data-flow-target"];
  if (!target) return { invalidTrigger: invalid };
  const triggerEvent = raw && !invalid ? (raw as FlowTriggerEvent) : "tap";
  return { flow: { triggerNodeId, triggerEvent, targetKind: guessFlowTargetKind(target), targetId: target }, invalidTrigger: invalid };
}

/** `unknown_flow_trigger` issues for freshly parsed fill content (patch_html fragments, which never go through `parseScreen`). */
export function fillTriggerIssues(subs: NodeSubtree[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const walk = (sub: NodeSubtree): void => {
    const { invalidTrigger } = flowFromAttributes("", sub.attributes);
    if (invalidTrigger) issues.push({ code: "unknown_flow_trigger", message: `"${invalidTrigger}" is not a valid data-flow-trigger` });
    for (const child of sub.children) walk(child);
    for (const child of Object.values(sub.slotOverrides ?? {})) walk(child);
  };
  subs.forEach(walk);
  return issues;
}

/**
 * Flow edges authored on slot-fill content. These are derived from the
 * attributes on demand and deliberately never live in `doc.flows`, which only
 * holds flows of live nodes. Fills live outside `doc.nodes`, so
 * `buildElement` never sees them; the raw `data-flow-target` /
 * `data-flow-trigger` attributes stay on the subtree (they round-trip verbatim)
 * and are the source of truth here. An edge is keyed by the fill's authored id
 * (`<screen>.<id>`, the CHR-746 addressing); a fill with a target but no id
 * cannot be addressed, so it yields no edge and its owner is reported in
 * `missingIdOwners`.
 */
export function collectFillFlows(doc: ScreenDocument): { flows: Flow[]; errors: ValidationIssue[]; missingIdOwners: NodeId[] } {
  const flows: Flow[] = [];
  const errors: ValidationIssue[] = [];
  const missingIdOwners = new Set<NodeId>();
  forEachFill(doc, (sub, ownerId) => {
    const { flow, invalidTrigger } = flowFromAttributes(sub.id ?? "", sub.attributes);
    if (invalidTrigger) errors.push({ code: "unknown_flow_trigger", message: `"${invalidTrigger}" is not a valid data-flow-trigger`, nodeId: ownerId });
    if (!flow) return;
    if (sub.id === undefined) missingIdOwners.add(ownerId);
    else flows.push(flow);
  });
  return { flows, errors, missingIdOwners: [...missingIdOwners] };
}
