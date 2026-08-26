import { randomBytes } from "node:crypto";
import type { Store } from "../store/index.js";
import { ToolError, commitFields, type CommentAuthor, type PublicComment } from "./types.js";
import type { CommitSkippedReason } from "../store/index.js";
import { formatNodeRef } from "./node-ref.js";

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
};

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

export type Thread = { root: CommentRecord; replies: CommentRecord[] };

/** Groups flat records into threads keyed by root comment id, in first-seen order. */
export function groupThreads(records: CommentRecord[]): Thread[] {
  const roots = new Map<string, CommentRecord>();
  const repliesByRoot = new Map<string, CommentRecord[]>();
  const order: string[] = [];

  for (const record of records) {
    if (record.parent_id === null) {
      roots.set(record.id, record);
      order.push(record.id);
    } else {
      const replies = repliesByRoot.get(record.parent_id) ?? [];
      replies.push(record);
      repliesByRoot.set(record.parent_id, replies);
    }
  }

  // Orphan replies (root not present in this read) are dropped rather than
  // surfaced as fake threads — comments.jsonl is append-only so this should
  // only happen against a malformed/truncated log.
  return order.map((id) => ({ root: roots.get(id)!, replies: repliesByRoot.get(id) ?? [] }));
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
  const resolved = thread.root.resolved || thread.replies.some((r) => r.resolved);
  return resolved ? "resolved" : "open";
}

export function toPublicComment(record: CommentRecord, replyCount: number): PublicComment {
  return {
    id: record.id,
    parent_id: record.parent_id,
    screen: record.screen,
    node: record.node_id,
    author: record.author,
    body: record.text,
    status: record.resolved ? "resolved" : "open",
    reply_count: replyCount,
    created_at: record.ts,
  };
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
 * thread. Not an MCP tool — there is no `create_comment` tool by design
 * (Tool-Palette-Schemas: humans author comments in the browser preview,
 * agents only reply via `reply_comment`). Called from
 * `POST /api/comments` (src/http/comments-routes.ts) only, which is why
 * `author` isn't a parameter: the browser is always the human's interface.
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
  body: string;
  resolve?: boolean;
};

export type ReplyCommentResult = {
  comment_id: string;
  reply_id: string;
  status: "open" | "resolved";
  path: "comments.jsonl";
  commit: string | null;
  commit_skipped_reason?: CommitSkippedReason;
};

/** C1 reply_comment — appends a reply and optionally resolves the thread. */
export async function replyComment(store: Store, input: ReplyCommentInput): Promise<ReplyCommentResult> {
  const records = await readCommentRecords(store);
  const threads = groupThreads(records);
  const thread = findThread(threads, input.comment_id);
  if (!thread) {
    throw new ToolError("not_found", `comment "${input.comment_id}" was not found`);
  }

  const reply: CommentRecord = {
    id: generateCommentId(),
    screen: thread.root.screen,
    node_id: thread.root.node_id,
    text: input.body,
    author: "agent",
    parent_id: thread.root.id,
    resolved: input.resolve ?? false,
    ts: new Date().toISOString(),
  };

  await store.appendComment(JSON.stringify(reply));
  const commitResult = await store.commit(`reply_comment: ${thread.root.id}`);

  return {
    comment_id: thread.root.id,
    reply_id: reply.id,
    status: input.resolve ? "resolved" : threadStatus(thread),
    path: "comments.jsonl",
    ...commitFields(commitResult),
  };
}
