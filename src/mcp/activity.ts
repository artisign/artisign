// CHR-630 / ADR-005 — one "activity" SSE event per MCP tool call, so the
// preview can show what an agent is doing live. MCP-only by construction:
// derived and broadcast from the `registerTool` wrapper in server.ts, which
// the `/api/tools/*` browser path (tools-api.ts) never goes through.

import { parseNodeRef, formatNodeRef } from "../tools/node-ref.js";

export type ActivityTargetKind = "screen" | "mockup" | "component" | "pattern";
export type ActivityTarget = { kind: ActivityTargetKind; name?: string; variant?: string } | null;

export type ActivityEvent = {
  type: "activity";
  tool: string;
  kind: "read" | "write";
  target: ActivityTarget;
  nodes: string[];
  ok: boolean;
  at: number;
};

/**
 * Where a tool call's activity is broadcast to — the resolved project's own
 * `SseHub` (`broadcastActivity`, additive to its existing `change`
 * broadcast). Threaded into `createMcpServer`/`createMcpHttpHandler` as one
 * explicit extra parameter, never placed on `ToolHandlerContext` — a tool
 * handler must have no way to emit activity itself. Undefined for the stdio
 * transport (no hub at all) and for an HTTP request with no project
 * resolved; either way the wrapper degrades to a no-op.
 */
export type ActivitySink = { broadcastActivity: (event: ActivityEvent) => void };

// Everything not listed here is a write — deliberately a read allowlist, not
// a write allowlist: a new tool defaults to "write", the more conservative
// misclassification (a stray activity event on a read is noise; miscounting
// a write as a read tells the preview nothing happened when it did).
const READ_TOOLS = new Set([
  "get_project",
  "get_screen",
  "get_node",
  "get_design_system",
  "find_nodes",
  "list_comments",
  "get_guide",
  "get_mockup",
  "get_screenshot",
  "inspect_node",
]);

function toolKind(tool: string, input: Record<string, unknown>): "read" | "write" {
  // set_board_state with no field is its own read form — there is no get_board_state.
  if (tool === "set_board_state" && input.filter === undefined && input.pins === undefined) return "read";
  return READ_TOOLS.has(tool) ? "read" : "write";
}

const NONE: { target: ActivityTarget; nodes: string[] } = { target: null, nodes: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : [];
}

/** A node ref (`"<screen>.<node-id>"` / `"component:<name>#<variant>.<node-id>"` / `"pattern:<name>.<node-id>"`) is both the target and the one affected node — the common case for every node-addressed tool. */
function fromNodeRef(ref: string): { target: ActivityTarget; nodes: string[] } {
  try {
    const parsed = parseNodeRef(ref);
    if (parsed.kind === "screen") return { target: { kind: "screen", name: parsed.screen }, nodes: [ref] };
    if (parsed.kind === "component") {
      return { target: { kind: "component", name: parsed.name, variant: parsed.variant }, nodes: [ref] };
    }
    return { target: { kind: "pattern", name: parsed.name }, nodes: [ref] };
  } catch {
    return NONE;
  }
}

/**
 * Per-tool target/node derivation, from `toolDef.name`, the input, and the
 * handler's own returned JSON only — never a re-parsed `ScreenDocument`,
 * never a forced diff. A field that the response doesn't carry (a blocking
 * error short-circuited before it, or the tool just doesn't produce one)
 * degrades to the coarser `NONE`/`[]` rather than being guessed at.
 */
function deriveTargetAndNodes(tool: string, input: Record<string, unknown>, result: unknown): { target: ActivityTarget; nodes: string[] } {
  const r = (result ?? {}) as Record<string, unknown>;

  switch (tool) {
    case "get_screen": {
      const screen = str(input.screen);
      return screen ? { target: { kind: "screen", name: screen }, nodes: [] } : NONE;
    }
    case "get_mockup": {
      const mockup = str(input.mockup);
      if (!mockup) return NONE;
      const variant = str(input.variant);
      return { target: { kind: "mockup", name: mockup, ...(variant ? { variant } : {}) }, nodes: [] };
    }
    case "get_node":
    case "inspect_node":
    case "update_refs":
    case "set_flow": {
      const node = str(input.node);
      return node ? fromNodeRef(node) : NONE;
    }
    case "get_screenshot": {
      const node = str(input.node);
      if (node) return fromNodeRef(node);
      const screen = str(input.screen);
      if (screen) return { target: { kind: "screen", name: screen }, nodes: [] };
      const mockup = str(input.mockup);
      if (mockup) {
        const variant = str(input.variant);
        return { target: { kind: "mockup", name: mockup, ...(variant ? { variant } : {}) }, nodes: [] };
      }
      return NONE;
    }
    case "write_html": {
      const screen = str(input.screen);
      if (!screen) return NONE;
      // kind:"component"/"pattern" writes a design-system definition file —
      // writeDefinition's response carries no per-node ids at all (a
      // definition is written verbatim, never canonicalized), so nodes
      // stays coarsely empty regardless.
      if (input.kind === "component" || input.kind === "pattern") {
        return { target: { kind: input.kind, name: screen }, nodes: [] };
      }
      const rootNodeId = str(r.root_node_id);
      return { target: { kind: "screen", name: screen }, nodes: rootNodeId ? [formatNodeRef(screen, rootNodeId)] : [] };
    }
    case "patch_html": {
      const target = input.target as Record<string, unknown> | undefined;
      let base: ActivityTarget = null;
      if (target?.kind === "node" && typeof target.node === "string") {
        base = fromNodeRef(target.node).target;
      } else if (target?.kind === "selector" && typeof target.screen === "string") {
        base = { kind: "screen", name: target.screen };
      }
      return { target: base, nodes: strArray(r.affected_nodes) };
    }
    case "promote_to_system": {
      // The source screen, not the component/pattern it creates: the
      // rewritten nodes live on the screen, and that is where a follower
      // should look.
      const node = str(input.node);
      const target = node ? fromNodeRef(node).target : null;
      return { target, nodes: strArray(r.rewritten_nodes) };
    }
    case "promote_mockup": {
      const screen = str(input.screen);
      if (!screen) return NONE;
      const rootNodeId = str(r.root_node_id);
      return { target: { kind: "screen", name: screen }, nodes: rootNodeId ? [formatNodeRef(screen, rootNodeId)] : [] };
    }
    case "import_html": {
      // A dedupe hit writes nothing and returns `imported: []` without
      // `errors`, so it reads as `ok: true` with no target — the one write
      // whose null target means "skipped", not "too broad to model".
      const imported = Array.isArray(r.imported) ? (r.imported[0] as Record<string, unknown> | undefined) : undefined;
      const screen = str(imported?.screen);
      return screen ? { target: { kind: "screen", name: screen }, nodes: [] } : NONE;
    }
    case "write_mockup": {
      const mockup = str(input.mockup);
      if (!mockup) return NONE;
      const variant = str(input.variant);
      return { target: { kind: "mockup", name: mockup, ...(variant ? { variant } : {}) }, nodes: [] };
    }
    case "set_meta": {
      const target = input.target as Record<string, unknown> | undefined;
      if (target?.kind === "screen" && typeof target.screen === "string") {
        return { target: { kind: "screen", name: target.screen }, nodes: [] };
      }
      if (target?.kind === "mockup" && typeof target.mockup === "string") {
        return { target: { kind: "mockup", name: target.mockup }, nodes: [] };
      }
      if ((target?.kind === "component" || target?.kind === "pattern") && typeof target.name === "string") {
        return { target: { kind: target.kind, name: target.name }, nodes: [] };
      }
      // design_system / tag targets have no matching ActivityTarget kind.
      return NONE;
    }
    case "delete_entity": {
      const kind = input.kind;
      const name = str(input.name);
      if ((kind === "screen" || kind === "component" || kind === "pattern" || kind === "mockup") && name) {
        const variant = kind === "mockup" ? str(input.variant) : undefined; // only mockups have variants to delete
        return { target: { kind, name, ...(variant ? { variant } : {}) }, nodes: [] };
      }
      return NONE;
    }
    // get_project, find_nodes, get_design_system, list_comments, get_guide —
    // broad reads: feed-only per ADR-005, never a navigation target — also
    // `list_comments` when filtered to one screen or node.
    // set_tokens — rewrites across many screens/components/patterns at once.
    // init_project, reply_comment — no target shape this event models fits.
    // set_board_state (CHR-624) — the Board's filter/pins aren't a single
    // screen/mockup/component/pattern; `toolKind` tells its read form apart.
    default:
      return NONE;
  }
}

/** Builds the event a tool call emits — never throws (see server.ts's wrapper, which also swallows a broadcast failure). */
/**
 * `write_html` (and its definition-write path) and `import_html` all return
 * a normal, non-throwing result carrying `errors: [...]` (never empty when
 * present — every tool that populates this field only does so for a
 * blocking issue; a non-blocking one is degraded to `warnings` instead, per
 * `issue-filter.ts`'s existing convention) when a blocking parse/validation
 * issue meant nothing was written. `ok` must say so too — a preview acting
 * on `ok: true` here would navigate to a screen that was never written and
 * may not even exist (ADR-005: "never navigate or highlight — there is
 * nothing confirmed to point at").
 */
function hasBlockingErrors(result: unknown): boolean {
  const errors = (result as Record<string, unknown> | null | undefined)?.errors;
  return Array.isArray(errors) && errors.length > 0;
}

export function deriveActivityEvent(tool: string, input: Record<string, unknown>, ok: boolean, result: unknown): ActivityEvent {
  const { target, nodes } = deriveTargetAndNodes(tool, input, result);
  return { type: "activity", tool, kind: toolKind(tool, input), target, nodes, ok: ok && !hasBlockingErrors(result), at: Date.now() };
}
