import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store/index.js";
import { applyThreadAction, createComment, detachedRootIds, groupThreads, readCommentRecordsWithStats } from "../tools/comments.js";
import { formatNodeRef } from "../tools/node-ref.js";
import { ToolError } from "../tools/types.js";
import { loadScreen } from "../tools/context.js";
import { findFillById } from "../tools/patch.js";
import type { ScreenDocument } from "../model/index.js";
import { sendJson, readJsonBody, PayloadTooLargeError } from "./json.js";

type CreateCommentBody = { screen?: unknown; node_id?: unknown; text?: unknown; parent_id?: unknown; resolved?: unknown; action?: unknown; comment_id?: unknown };

const THREAD_ACTIONS = new Set(["reanchor", "reopen", "delete"]);

/**
 * Maps the DOM id comment mode clicked to the screen node a comment anchors
 * to (CHR-750) — comments only ever anchor to `doc.nodes`, the nodes
 * `get_node`/`find_nodes` can reach. Tried on the id itself, then on each
 * shorter `--`-separated prefix (component internals render as
 * `<instance>--<id>`, see render.ts); an authored slot-fill id anchors to the
 * instance it fills. Undefined when nothing matches.
 */
function resolveAnchorId(doc: ScreenDocument, domId: string): string | undefined {
  const parts = domId.split("--");
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join("--");
    if (doc.nodes[candidate] !== undefined) return candidate;
    const fill = findFillById(doc, candidate);
    if (fill !== undefined) return fill.owner.id;
  }
  return undefined;
}

/**
 * `GET /api/comments?screen=<name>` and `POST /api/comments` — the
 * preview's comment surface. Reading returns the screen's comments flat
 * (with `resolved` and `parent_id` so the UI can group threads itself).
 * Creating covers both a new root comment and — via an optional
 * `parent_id` — a human reply on an existing thread; agents use the
 * `create_comment`/`reply_comment` MCP tools instead.
 *
 * CHR-1249: the GET also returns `threads` — one entry per thread with its
 * current anchor, status and `detached` flag — and `comments` leaves out
 * event lines and deleted threads, so the canvas pins need no event logic of
 * their own. `POST` with `action` ("reanchor" | "reopen" | "delete") and
 * `comment_id` applies a thread event; reanchor takes `node_id` (a DOM id on
 * the thread's screen, mapped like a new comment's).
 */
export async function handleCommentsRoutes(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/comments") return false;

  if (req.method === "GET") {
    const screen = url.searchParams.get("screen");
    if (!screen) {
      sendJson(res, 400, { code: "validation_failed", message: "screen query parameter is required" });
      return true;
    }
    const { records, skippedMalformedLines } = await readCommentRecordsWithStats(store);
    const threads = groupThreads(records).filter((t) => t.root.screen === screen);
    const detached = await detachedRootIds(store, threads);
    const body: Record<string, unknown> = {
      comments: threads.flatMap((t) => [{ ...t.root, resolved: t.status === "resolved" }, ...t.replies]),
      threads: threads.map((t) => ({
        id: t.root.id,
        node_id: t.root.node_id,
        author: t.root.author,
        ...(t.root.agent ? { agent: t.root.agent } : {}),
        status: t.status,
        detached: detached.has(t.root.id),
        reply_count: t.replies.length,
      })),
    };
    if (skippedMalformedLines > 0) body.skipped_malformed_lines = skippedMalformedLines;
    sendJson(res, 200, body);
    return true;
  }

  if (req.method !== "POST") return false;

  let body: CreateCommentBody;
  try {
    body = (await readJsonBody(req)) as CreateCommentBody;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { code: "validation_failed", message: err.message });
    } else {
      sendJson(res, 400, { code: "validation_failed", message: "request body is not valid JSON" });
    }
    return true;
  }

  if (body.action !== undefined) {
    await handleThreadAction(res, store, body);
    return true;
  }

  const hasParent = body.parent_id !== undefined && body.parent_id !== null;
  if (!hasParent && (typeof body.screen !== "string" || body.screen.length === 0)) {
    sendJson(res, 400, { code: "validation_failed", message: "screen is required" });
    return true;
  }
  // A bare resolve on a thread (the popover's Resolve button) carries no words.
  const bareResolve = hasParent && body.resolved === true && (body.text === undefined || body.text === "");
  if (!bareResolve && (typeof body.text !== "string" || body.text.length === 0)) {
    sendJson(res, 400, { code: "validation_failed", message: "text is required" });
    return true;
  }
  if (body.node_id !== undefined && body.node_id !== null && typeof body.node_id !== "string") {
    sendJson(res, 400, { code: "validation_failed", message: "node_id must be a string or null" });
    return true;
  }
  if (hasParent && typeof body.parent_id !== "string") {
    sendJson(res, 400, { code: "validation_failed", message: "parent_id must be a string" });
    return true;
  }
  if (body.resolved !== undefined && typeof body.resolved !== "boolean") {
    sendJson(res, 400, { code: "validation_failed", message: "resolved must be a boolean" });
    return true;
  }

  try {
    // A reply inherits its screen/node from the parent thread (validated
    // when that root was created), so only a new root comment needs its
    // target checked here — otherwise a typo'd screen/node id leaves an
    // orphaned record in the append-only log forever.
    let nodeId = (body.node_id as string | null | undefined) ?? null;
    if (!hasParent) {
      const { doc } = await loadScreen(store, body.screen as string);
      if (nodeId !== null) {
        const anchorId = resolveAnchorId(doc, nodeId);
        if (anchorId === undefined) {
          throw new ToolError("not_found", `node "${nodeId}" was not found on screen "${body.screen as string}"`);
        }
        nodeId = anchorId;
      }
    }

    const comment = await createComment(store, {
      screen: typeof body.screen === "string" ? body.screen : "",
      node_id: nodeId,
      text: typeof body.text === "string" ? body.text : "",
      parent_id: (body.parent_id as string | undefined) ?? null,
      resolved: body.resolved as boolean | undefined,
    });
    sendJson(res, 201, comment);
  } catch (err) {
    if (err instanceof ToolError) {
      sendJson(res, err.code === "not_found" ? 404 : 400, { code: err.code, message: err.message });
      return true;
    }
    throw err;
  }
  return true;
}

async function handleThreadAction(res: ServerResponse, store: Store, body: CreateCommentBody): Promise<void> {
  if (typeof body.action !== "string" || !THREAD_ACTIONS.has(body.action)) {
    sendJson(res, 400, { code: "validation_failed", message: "action must be reanchor, reopen or delete" });
    return;
  }
  if (typeof body.comment_id !== "string" || body.comment_id.length === 0) {
    sendJson(res, 400, { code: "validation_failed", message: "comment_id is required" });
    return;
  }
  const action = body.action as "reanchor" | "reopen" | "delete";
  try {
    let anchor: { screen: string; node_id: string } | undefined;
    if (action === "reanchor") {
      if (typeof body.node_id !== "string" || typeof body.screen !== "string") {
        sendJson(res, 400, { code: "validation_failed", message: "reanchor needs screen and node_id" });
        return;
      }
      const { doc } = await loadScreen(store, body.screen);
      const anchorId = resolveAnchorId(doc, body.node_id);
      if (anchorId === undefined) throw new ToolError("not_found", `node "${body.node_id}" was not found on screen "${body.screen}"`);
      anchor = { screen: body.screen, node_id: formatNodeRef(body.screen, anchorId) };
    }
    sendJson(res, 200, await applyThreadAction(store, { comment_id: body.comment_id, action, anchor }));
  } catch (err) {
    if (err instanceof ToolError) {
      sendJson(res, err.code === "not_found" ? 404 : 400, { code: err.code, message: err.message });
      return;
    }
    throw err;
  }
}
