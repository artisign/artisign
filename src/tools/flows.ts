import type { Store, FlowRecord } from "../store/index.js";
import type { Flow as InternalFlow, ScreenDocument } from "../model/index.js";
import { formatNodeRef } from "./node-ref.js";
import type { FlowEventName, PublicFlow } from "./types.js";

const FLOW_EVENTS = new Set<FlowEventName>(["tap", "hover", "longpress", "swipe-left", "swipe-right"]);

/**
 * Converts a raw `flows.json` record to the public `Flow` shape. Unlike a
 * bare cast, this actually holds up: `to_kind` defaults to `"screen"` (the
 * field is optional on `FlowRecord` for backward compatibility with
 * pre-M2 records) and an unrecognized `event` value falls back to `"tap"`
 * rather than smuggling an invalid literal past the type system.
 */
export function toPublicFlowRecord(record: FlowRecord): PublicFlow {
  return {
    from: record.from,
    event: FLOW_EVENTS.has(record.event as FlowEventName) ? (record.event as FlowEventName) : "tap",
    to: record.to,
    to_kind: record.to_kind ?? "screen",
  };
}

/**
 * The screen's HTML (`data-flow-target`/`data-flow-trigger` augmentations,
 * per Schema-Spec) is the single source of truth for flow edges.
 * `flows.json` is a derived-but-persisted mirror: every write that can
 * change flows (`write_html`, `patch_html`, `set_flow`) re-parses the
 * screen afterward and calls `syncScreenFlows` to keep `flows.json` in
 * sync, which is what `get_project`/`get_screen`/`find_nodes` read back
 * without needing to re-parse every screen themselves.
 *
 * Earlier revisions had `set_flow` write `flows.json` directly without
 * touching the screen's HTML (closer to Tool-Palette-Schemas W5's literal
 * "without touching any screen file"). That let any *later* write to the
 * same screen silently wipe the edge — `syncScreenFlows` would resync
 * `flows.json` from HTML that never had the attribute, dropping it. Routing
 * `set_flow` through the HTML too (see writes.ts) closes that gap.
 */
export function toPublicFlow(screenId: string, flow: InternalFlow): PublicFlow {
  return {
    from: formatNodeRef(screenId, flow.triggerNodeId),
    event: flow.triggerEvent,
    to: flow.targetId,
    to_kind: flow.targetKind,
  };
}

function toFlowRecord(publicFlow: PublicFlow): FlowRecord {
  return { from: publicFlow.from, event: publicFlow.event, to: publicFlow.to, to_kind: publicFlow.to_kind };
}

export function belongsToScreen(record: FlowRecord, screenId: string): boolean {
  return record.from === screenId || record.from.startsWith(`${screenId}.`);
}

export async function readAllFlows(store: Store): Promise<FlowRecord[]> {
  return store.readFlows();
}

export async function readScreenFlows(store: Store, screenId: string): Promise<FlowRecord[]> {
  const all = await store.readFlows();
  return all.filter((record) => belongsToScreen(record, screenId));
}

/** Replaces every flows.json entry for `doc.id` with the flows just parsed from its HTML. */
export async function syncScreenFlows(store: Store, doc: ScreenDocument): Promise<void> {
  const all = await store.readFlows();
  const others = all.filter((record) => !belongsToScreen(record, doc.id));
  const fresh = doc.flows.map((flow) => toFlowRecord(toPublicFlow(doc.id, flow)));
  await store.writeFlows([...others, ...fresh]);
}
