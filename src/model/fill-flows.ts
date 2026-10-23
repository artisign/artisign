import type { Flow, FlowTriggerEvent, NodeId, NodeSubtree, ScreenDocument, ValidationIssue } from "./types.js";

export const ALLOWED_FLOW_TRIGGERS: readonly FlowTriggerEvent[] = ["tap", "hover", "longpress", "swipe-left", "swipe-right"];

/** `"checkout.node-id"` targets a node, anything else a screen. */
export function guessFlowTargetKind(flowTarget: string): "screen" | "node" {
  return flowTarget.includes(".") ? "node" : "screen";
}

/** Every slot-fill subtree below `owner`, depth first (fills of fills included), with the live node that owns the outermost slot. */
export function forEachFill(doc: ScreenDocument, visit: (sub: NodeSubtree, ownerId: NodeId) => void): void {
  for (const owner of Object.values(doc.nodes)) {
    const walk = (sub: NodeSubtree): void => {
      visit(sub, owner.id);
      for (const child of sub.children) walk(child);
      for (const child of Object.values(sub.slotOverrides ?? {})) walk(child);
    };
    for (const sub of Object.values(owner.slotOverrides ?? {})) walk(sub);
  }
}

function invalidTrigger(sub: NodeSubtree): string | undefined {
  const raw = sub.attributes["data-flow-trigger"];
  return raw && !(ALLOWED_FLOW_TRIGGERS as readonly string[]).includes(raw) ? raw : undefined;
}

/** `unknown_flow_trigger` issues for freshly parsed fill content (patch_html fragments, which never go through `parseScreen`). */
export function fillTriggerIssues(subs: NodeSubtree[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const walk = (sub: NodeSubtree): void => {
    const raw = invalidTrigger(sub);
    if (raw) issues.push({ code: "unknown_flow_trigger", message: `"${raw}" is not a valid data-flow-trigger` });
    for (const child of sub.children) walk(child);
    for (const child of Object.values(sub.slotOverrides ?? {})) walk(child);
  };
  subs.forEach(walk);
  return issues;
}

/**
 * Flow edges authored on slot-fill content. Fills live outside `doc.nodes`, so
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
    const target = sub.attributes["data-flow-target"];
    const invalid = invalidTrigger(sub);
    if (invalid) errors.push({ code: "unknown_flow_trigger", message: `"${invalid}" is not a valid data-flow-trigger`, nodeId: ownerId });
    if (!target) return;
    const triggerEvent = (invalid ? undefined : (sub.attributes["data-flow-trigger"] as FlowTriggerEvent | undefined)) ?? "tap";
    if (sub.id === undefined) {
      missingIdOwners.add(ownerId);
      return;
    }
    flows.push({ triggerNodeId: sub.id, triggerEvent, targetKind: guessFlowTargetKind(target), targetId: target });
  });
  return { flows, errors, missingIdOwners: [...missingIdOwners] };
}
