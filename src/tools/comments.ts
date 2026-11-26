import { randomBytes } from "node:crypto";
import type { Store } from "../store/index.js";
import { ToolError, commitFields, type CommentAuthor, type PublicComment } from "./types.js";
import type { CommitSkippedReason } from "../store/index.js";
import { formatNodeRef, parseNodeRef } from "./node-ref.js";
import { loadScreen } from "./context.js";

/**
 * The on-disk shape of one line in `comments.jsonl`: flat, with replies
 * (`parent_id`) — no deep threading. The log is
 * append-only (per CLAUDE.md's file layout), so "resolved" is modeled as an
 * event — whichever line in a thread carries `resolved: true` (root or a
 * reply) resolves the whole thread — rather than a mutation of a prior
 * line. `resolved` is always present (not just when true) so every line is
 * a complete, self-describing record.
 *
 * This is the storage/preview-facing shape (see also `GET`/`POST
 * /api/comments`, src/http/comments-routes.ts). The MCP tool-facing shape
 * (`list_comments`/`reply_comment`, `PublicComment` in ./types.ts) is
 * Tool-Palette-Schemas' `Comment` type instead — `node`/`body`/`created_at`
 * plus derived `status`/`reply_count` — which `toPublicComment` maps to
 * below, so the two naming schemes don't leak into each other.
 */
export type CommentRecord = {
  id: string;
  screen: string;
  node_id: string | null;
  text: string;
  author: CommentAuthor;
  parent_id: string | null;
  resolved: boolean;
  ts: string;
  /** Which agent wrote it (CHR-1249) — set on agent-authored lines only; older lines have none. */
  agent?: string;
  /**
   * A thread event instead of a message (CHR-1249). The log stays
   * append-only, so moving, reopening and deleting a thread are lines of
   * their own: `reanchor` carries the new `screen`/`node_id`, `reopen`
   * undoes an earlier resolve, `delete` hides the thread from every read.
   * Event lines carry `parent_id` = the thread root and empty `text`, and
   * are never listed as replies.
   */
  event?: CommentEvent;
};

export type CommentEvent = "reanchor" | "reopen" | "delete";

export function generateCommentId(): string {
  // 8 bytes (64 bits) of randomness — randomBytes(2) (16 bits, 65536 values)
  // collides within a few hundred comments and a collision silently merges
  // two unrelated threads in groupThreads.
  return `cmt_${randomBytes(8).toString("hex")}`;
}

export type CommentRecordsRead = { records: CommentRecord[]; skippedMalformedLines: number };

/**
 * comments.jsonl is human-editable by design (per CLAUDE.md's file
 * layout), so a hand-edit gone wrong must not take down every read that
 * touches comments (get_project, get_screen, find_nodes, list_comments,
 * GET /api/comments) — a line that fails to parse is skipped and counted
 * rather than thrown.
 */
export async function readCommentRecordsWithStats(store: Store): Promise<CommentRecordsRead> {
  const lines = await store.readComments();
  const records: CommentRecord[] = [];
  let skippedMalformedLines = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as CommentRecord);
    } catch {
      skippedMalformedLines += 1;
    }
  }
  return { records, skippedMalformedLines };
}

export async function readCommentRecords(store: Store): Promise<CommentRecord[]> {
  return (await readCommentRecordsWithStats(store)).records;
}

/**
 * One thread with its events applied (CHR-1249): `root` and every reply
 * carry the thread's CURRENT anchor (the latest `reanchor` event, else the
 * root's own), `replies` holds messages only, and `status` is the outcome of
 * the resolve/reopen lines in log order. `rootRecord` is the root line as
 * written, for callers that need the original anchor.
 */
export type Thread = { root: CommentRecord; replies: CommentRecord[]; status: "open" | "resolved"; rootRecord: CommentRecord };

/**
 * Groups flat records into threads keyed by root comment id, in first-seen
 * order, with events applied. A thread with a `delete` event is left out.
 */
export function groupThreads(records: CommentRecord[]): Thread[] {
  const roots = new Map<string, CommentRecord>();
  const linesByRoot = new Map<string, CommentRecord[]>();
  const order: string[] = [];

  for (const record of records) {
    if (record.parent_id === null) {
      roots.set(record.id, record);
      order.push(record.id);
    } else {
      const lines = linesByRoot.get(record.parent_id) ?? [];
      lines.push(record);
      linesByRoot.set(record.parent_id, lines);
    }
  }

  // Orphan replies (root not present in this read) are dropped rather than
  // surfaced as fake threads — comments.jsonl is append-only so this should
  // only happen against a malformed/truncated log.
  const threads: Thread[] = [];
  for (const id of order) {
    const rootRecord = roots.get(id)!;
    const lines = linesByRoot.get(id) ?? [];
    let screen = rootRecord.screen;
    let nodeId = rootRecord.node_id;
    let status: "open" | "resolved" = rootRecord.resolved ? "resolved" : "open";
    let deleted = false;
    const messages: CommentRecord[] = [];
    for (const line of lines) {
      if (line.event === "delete") deleted = true;
      else if (line.event === "reanchor") {
        screen = line.screen;
        nodeId = line.node_id;
      } else if (line.event === "reopen") status = "open";
      else {
        // A bare resolve (no words) changes the status but lists nothing.
        if (line.text !== "") messages.push(line);
        if (line.resolved) status = "resolved";
      }
    }
    if (deleted) continue;
    const anchored = (r: CommentRecord): CommentRecord => (r.screen === screen && r.node_id === nodeId ? r : { ...r, screen, node_id: nodeId });
    threads.push({ root: anchored(rootRecord), replies: messages.map(anchored), status, rootRecord });
  }
  return threads;
}

/**
 * The thread a comment id belongs to — the id may name the root or any of
 * its replies. `list_comments` hands out reply ids just as readily as root
 * ids, so matching roots only would split the id space between the two
 * tools and leave an agent unable to answer a reply at all.
 * Threading itself stays one level deep: the answer hangs off `root.id`.
 */
export function findThread(threads: Thread[], commentId: string): Thread | undefined {
  return threads.find((t) => t.root.id === commentId || t.replies.some((r) => r.id === commentId));
}

export function threadStatus(thread: Thread): "open" | "resolved" {
  return thread.status;
}

/**
 * Root ids of the threads whose anchor node no longer exists (CHR-1249):
 * the node was removed or renamed by a later write, or the whole screen is
 * gone. Computed on every read, never stored — a node that comes back makes
 * the thread attached again. Screen-level threads (no node) never detach.
 */
export async function detachedRootIds(store: Store, threads: Thread[]): Promise<Set<string>> {
  const byScreen = new Map<string, Thread[]>();
  for (const thread of threads) {
    if (thread.root.node_id === null) continue;
    const list = byScreen.get(thread.root.screen) ?? [];
    list.push(thread);
    byScreen.set(thread.root.screen, list);
  }
  const detached = new Set<string>();
  for (const [screen, list] of byScreen) {
    let nodes: Record<string, unknown> | undefined;
    try {
      nodes = (await loadScreen(store, screen)).doc.nodes;
    } catch (err) {
      if (!(err instanceof ToolError && err.code === "not_found")) throw err;
    }
    for (const thread of list) {
      const id = bareId(thread.root.node_id!);
      if (nodes === undefined || nodes[id] === undefined) detached.add(thread.root.id);
    }
  }
  return detached;
}

function bareId(ref: string): string {
  const dot = ref.indexOf(".");
  return dot === -1 ? ref : ref.slice(dot + 1);
}

/**
 * The MCP-facing shape. `status` of a root is its thread's status; `agent`
 * and `detached` appear only when set, which keeps a 20-thread listing
 * inside the comment tools' token budget (CHR-1254).
 */
export function toPublicComment(record: CommentRecord, replyCount: number, thread?: { status: "open" | "resolved"; detached: boolean }): PublicComment {
  return {
    id: record.id,
    parent_id: record.parent_id,
    screen: record.screen,
    node: record.node_id,
    author: record.author,
    ...(record.agent ? { agent: record.agent } : {}),
    body: record.text,
    status: thread ? thread.status : record.resolved ? "resolved" : "open",
    ...(thread?.detached ? { detached: true } : {}),
    reply_count: replyCount,
    created_at: record.ts,
  };
}

/**
 * Resolves `node` — a `<screen>.<node-id>` ref or a bare id on `screen` — to
 * the stored ref, after checking the node exists on that screen. Comments
 * only ever anchor to `doc.nodes`, the nodes `get_node`/`find_nodes` reach.
 */
export async function resolveCommentAnchor(store: Store, screen: string, node: string): Promise<{ screen: string; node_id: string }> {
  let targetScreen = screen;
  let id = node;
  if (node.includes(".")) {
    const ref = parseNodeRef(node);
    if (ref.kind !== "screen") throw new ToolError("validation_failed", `comments anchor to screen nodes only — "${node}" is not a screen node ref`);
    targetScreen = ref.screen;
    id = ref.nodeId;
  }
  const { doc } = await loadScreen(store, targetScreen);
  if (doc.nodes[id] === undefined) throw new ToolError("not_found", `node "${id}" was not found on screen "${targetScreen}"`);
  return { screen: targetScreen, node_id: formatNodeRef(targetScreen, id) };
}

export type CreateCommentInput = {
  screen: string;
  /**
   * A bare element id — exactly what the browser has on hand (`el.id`),
   * never a `<screen>.<node-id>` ref. `createComment` normalizes it, so
   * this is the one place that translation happens; every read path
   * (`list_comments`, `find_nodes`, `get_node`) matches `CommentRecord.node_id`
   * against the full ref (see `formatNodeRef`/`parseNodeRef` in
   * ./node-ref.ts), same as flow edges.
   */
  node_id?: string | null;
  text: string;
  /** Replies to an existing thread instead of starting a new one, when given. */
  parent_id?: string | null;
  resolved?: boolean;
};

export type CreateCommentResult = CommentRecord & { reply_count: number; commit: string | null; commit_skipped_reason?: CommitSkippedReason };

/**
 * Creates a comment from the browser — a new root comment anchored to a
 * screen/node, or (when `parent_id` is given) a human reply on an existing
 * thread. Called from `POST /api/comments` (src/http/comments-routes.ts)
 * only, which is why `author` isn't a parameter: the browser is always the
 * human's interface. Agents start threads with `create_comment`
 * (`createAgentComment` below, CHR-1254).
 */
export async function createComment(store: Store, input: CreateCommentInput): Promise<CreateCommentResult> {
  let screen = input.screen;
  let nodeId = input.node_id ? formatNodeRef(input.screen, input.node_id) : null;
  let parentId = input.parent_id ?? null;

  if (input.parent_id) {
    const thread = findThread(groupThreads(await readCommentRecords(store)), input.parent_id);
    if (!thread) {
      throw new ToolError("not_found", `comment "${input.parent_id}" was not found`);
    }
    // A reply belongs to its thread's screen/node, same as reply_comment —
    // not whatever the caller happened to pass. thread.root.node_id is
    // already a normalized ref (it went through this same function), so no
    // second formatNodeRef call here.
    screen = thread.root.screen;
    nodeId = thread.root.node_id;
    // Answering a reply attaches to the thread ROOT, never to the reply.
    // Threading is one level deep by design, and a record pointing at a
    // non-root parent is dropped as an orphan by groupThreads — the reply
    // would vanish from every read.
    parentId = thread.root.id;
  }

  const record: CommentRecord = {
    id: generateCommentId(),
    screen,
    node_id: nodeId,
    text: input.text,
    author: "human",
    parent_id: parentId,
    resolved: input.resolved ?? false,
    ts: new Date().toISOString(),
  };

  await store.appendComment(JSON.stringify(record));
  const commitResult = await store.commit(`create_comment: ${record.id}`);

  return { ...record, reply_count: 0, ...commitFields(commitResult) };
}

export type ReplyCommentInput = {
  comment_id: string;
  body?: string;
  resolve?: boolean;
  /** Reopens a resolved thread (CHR-1249). */
  reopen?: boolean;
  /** Moves the thread to another node: a `<screen>.<node-id>` ref, or a bare id on the thread's screen (CHR-1254). */
  reanchor?: string;
  /** The answering agent's name; defaults to the MCP client's name. */
  agent?: string;
};

export type ReplyCommentResult = {
  comment_id: string;
  reply_id?: string;
  status: "open" | "resolved";
  node: string | null;
  path: "comments.jsonl";
  commit: string | null;
  commit_skipped_reason?: CommitSkippedReason;
};

function eventRecord(thread: Thread, event: CommentEvent, author: CommentAuthor, agent: string | undefined, anchor?: { screen: string; node_id: string }): CommentRecord {
  return {
    id: generateCommentId(),
    screen: anchor?.screen ?? thread.root.screen,
    node_id: anchor ? anchor.node_id : thread.root.node_id,
    text: "",
    author,
    ...(agent ? { agent } : {}),
    parent_id: thread.root.id,
    resolved: false,
    ts: new Date().toISOString(),
    event,
  };
}

/**
 * C1 reply_comment — answers a thread and, in the same call, can resolve or
 * reopen it and move it to another node (re-anchoring a detached thread).
 * `body` may be left out when the call only resolves, reopens or re-anchors.
 */
export async function replyComment(store: Store, input: ReplyCommentInput, clientName?: string): Promise<ReplyCommentResult> {
  const body = input.body?.trim() ?? "";
  if (input.resolve && input.reopen) throw new ToolError("validation_failed", "resolve and reopen cannot both be true");
  if (!body && !input.resolve && !input.reopen && !input.reanchor) {
    throw new ToolError("validation_failed", "body is required unless the call resolves, reopens or re-anchors the thread");
  }
  const records = await readCommentRecords(store);
  const threads = groupThreads(records);
  const thread = findThread(threads, input.comment_id);
  if (!thread) {
    throw new ToolError("not_found", `comment "${input.comment_id}" was not found`);
  }
  const agent = input.agent ?? clientName;

  const lines: CommentRecord[] = [];
  let anchor = { screen: thread.root.screen, node_id: thread.root.node_id };
  if (input.reanchor) {
    const target = await resolveCommentAnchor(store, thread.root.screen, input.reanchor);
    lines.push(eventRecord(thread, "reanchor", "agent", agent, target));
    anchor = target;
  }
  let reply: CommentRecord | undefined;
  if (body || input.resolve) {
    reply = {
      id: generateCommentId(),
      screen: anchor.screen,
      node_id: anchor.node_id,
      text: body,
      author: "agent",
      ...(agent ? { agent } : {}),
      parent_id: thread.root.id,
      resolved: input.resolve ?? false,
      ts: new Date().toISOString(),
    };
    // A resolve without words stays an event-like line: no text to list.
    if (!body) lines.push({ ...reply, text: "" });
    else lines.push(reply);
  }
  if (input.reopen) lines.push(eventRecord(thread, "reopen", "agent", agent));

  for (const line of lines) await store.appendComment(JSON.stringify(line));
  const commitResult = await store.commit(`reply_comment: ${thread.root.id}`);

  const status = input.resolve ? "resolved" : input.reopen ? "open" : threadStatus(thread);
  return {
    comment_id: thread.root.id,
    ...(reply && body ? { reply_id: reply.id } : {}),
    status,
    node: anchor.node_id,
    path: "comments.jsonl",
    ...commitFields(commitResult),
  };
}

export type CreateAgentCommentInput = {
  screen: string;
  /** A `<screen>.<node-id>` ref or a bare id on `screen`; left out for a screen-level thread. */
  node?: string;
  body: string;
  agent?: string;
};

export type CreateAgentCommentResult = {
  comment_id: string;
  screen: string;
  node: string | null;
  status: "open";
  path: "comments.jsonl";
  commit: string | null;
  commit_skipped_reason?: CommitSkippedReason;
};

/** C2 create_comment — an agent starts a thread anchored to a node (CHR-1254). */
export async function createAgentComment(store: Store, input: CreateAgentCommentInput, clientName?: string): Promise<CreateAgentCommentResult> {
  const body = input.body.trim();
  if (!body) throw new ToolError("validation_failed", "body is required");
  let anchor: { screen: string; node_id: string | null };
  if (input.node) {
    anchor = await resolveCommentAnchor(store, input.screen, input.node);
  } else {
    await loadScreen(store, input.screen);
    anchor = { screen: input.screen, node_id: null };
  }
  const agent = input.agent ?? clientName;
  const record: CommentRecord = {
    id: generateCommentId(),
    screen: anchor.screen,
    node_id: anchor.node_id,
    text: body,
    author: "agent",
    ...(agent ? { agent } : {}),
    parent_id: null,
    resolved: false,
    ts: new Date().toISOString(),
  };
  await store.appendComment(JSON.stringify(record));
  const commitResult = await store.commit(`create_comment: ${record.id}`);
  return { comment_id: record.id, screen: anchor.screen, node: anchor.node_id, status: "open", path: "comments.jsonl", ...commitFields(commitResult) };
}

export type ThreadActionInput = {
  comment_id: string;
  action: CommentEvent;
  /** reanchor only: the stored `<screen>.<node-id>` ref, already validated by the caller. */
  anchor?: { screen: string; node_id: string };
};

/**
 * A human re-anchors, reopens or deletes a thread from the browser
 * (`POST /api/comments` with `action`). Deleting appends a `delete` event:
 * the thread leaves every read, the log keeps it.
 */
export async function applyThreadAction(store: Store, input: ThreadActionInput): Promise<{ comment_id: string; commit: string | null; commit_skipped_reason?: CommitSkippedReason }> {
  const thread = findThread(groupThreads(await readCommentRecords(store)), input.comment_id);
  if (!thread) throw new ToolError("not_found", `comment "${input.comment_id}" was not found`);
  if (input.action === "reanchor" && !input.anchor) throw new ToolError("validation_failed", "reanchor needs a node");
  await store.appendComment(JSON.stringify(eventRecord(thread, input.action, "human", undefined, input.anchor)));
  const commitResult = await store.commit(`${input.action}_comment: ${thread.root.id}`);
  return { comment_id: thread.root.id, ...commitFields(commitResult) };
}
