import type { CommitResult } from "../store/index.js";

export type View = "summary" | "tree" | "full";
export type ResponseMode = "summary" | "diff" | "full";

export type WarningKind =
  | "drift"
  | "ambiguous_ref"
  | "unknown_ref"
  | "orphan_flow"
  | "lock_contention"
  | "suspicious_attr"
  | "dangling_flow"
  | "load_failed"
  // A definition write touched a node with no explicit `id` in source
  // (ADR-004 §3). Deliberately its own kind, not folded into
  // `suspicious_attr`: the signal exists to be acted on programmatically
  // (add an explicit id), and reusing a free-text kind would cost `kind`
  // its discriminating power. Warns, never blocks — most definition nodes
  // are never individually addressed again, so blocking every write on
  // every un-ided node would punish the common case to guard the rare one.
  | "missing_id";

export type Warning = {
  kind: WarningKind;
  target?: string;
  message: string;
  suggestion?: string;
};

export type ToolErrorCode = "not_found" | "validation_failed" | "conflict" | "invalid_state" | "io_error" | "git_error";

/**
 * Extra, optional context threaded into a tool handler alongside `(store,
 * input)` — used by tools that need daemon-level capabilities no single
 * project's `Store` can provide. Currently just `init_project` (registers
 * the newly scaffolded project with the daemon's `ProjectRegistry` so it
 * shows up without a restart). Present for MCP/HTTP requests served by the
 * daemon; absent for the stdio server, which has no registry — those tools
 * degrade to a scaffold-only behavior (no auto-open).
 */
export type ToolHandlerContext = {
  openProject?: (dir: string) => Promise<unknown>;
};

/** Thrown by a single-resource tool (get_*) when the target doesn't exist or input is invalid. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type FlowEventName = "tap" | "hover" | "longpress" | "swipe-left" | "swipe-right";

/** The tool-layer (agent-facing) Flow shape — mirrors a line in flows.json, per Tool-Palette-Schemas. */
export type PublicFlow = {
  from: string; // node_ref
  event: FlowEventName;
  to: string; // screen name, or node_ref when to_kind="node"
  to_kind: "screen" | "node";
};

export type CommentStatus = "open" | "resolved";
export type CommentAuthor = "human" | "agent";

export type PublicComment = {
  id: string;
  parent_id: string | null;
  screen: string;
  node: string | null;
  author: CommentAuthor;
  body: string;
  status: CommentStatus;
  reply_count: number;
  created_at: string;
};

export type Predicate =
  | { kind: "style_ref"; ref_path: string }
  | { kind: "component_ref"; component_name: string }
  | { kind: "variant"; variant: string }
  | { kind: "has_comments" }
  | { kind: "text_match"; pattern: string }
  | { kind: "has_flow" };

// A nested member can be `null` to delete it.
export type TokenValue = string | number | { [key: string]: TokenValue | null };

/**
 * `patch_html`'s `set_attr` operation refuses to touch a ref-bearing or
 * identity attribute — shared by `writes.ts` (screens) and
 * `definition-patch.ts` (component/pattern definitions, ADR-004 §2), same
 * policy either way.
 */
export const RESERVED_SET_ATTR_NAMES = new Set(["class", "style", "id", "data-node-id", "data-variant", "data-flow-target", "data-flow-trigger"]);

export function reservedSetAttrMessage(name: string): string {
  if (name === "data-flow-target" || name === "data-flow-trigger") {
    return `"${name}" is ref-bearing — use set_flow instead`;
  }
  if (name === "id" || name === "data-node-id") {
    return `"${name}" is a stable node id — it cannot be changed`;
  }
  return `"${name}" is ref-bearing — use update_refs instead`;
}

/** Every write response spreads this — `commit_skipped_reason` is present only when `sha` is `null`. */
export function commitFields(result: CommitResult): { commit: string | null; commit_skipped_reason?: CommitResult["skipped_reason"] } {
  if (result.skipped_reason === undefined) return { commit: result.sha };
  return { commit: result.sha, commit_skipped_reason: result.skipped_reason };
}
