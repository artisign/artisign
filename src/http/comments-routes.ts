import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store/index.js";
import { applyThreadAction, createComment, detachedRootIds, groupThreads, isMockupTarget, readCommentRecordsWithStats, type CommentAnchor, type Thread } from "../tools/comments.js";
import { MOCKUP_NAME_RE, readVariantIds } from "../tools/mockup-ids.js";
import { formatNodeRef } from "../tools/node-ref.js";
import { ToolError } from "../tools/types.js";
import { loadScreen } from "../tools/context.js";
import { findFillById } from "../tools/patch.js";
import type { ScreenDocument } from "../model/index.js";
import { sendJson, readJsonBody, PayloadTooLargeError } from "./json.js";

type CreateCommentBody = { screen?: unknown; mockup?: unknown; variant?: unknown; node_id?: unknown; text?: unknown; parent_id?: unknown; resolved?: unknown; action?: unknown; comment_id?: unknown };

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
    const scope = url.searchParams.get("scope");
    const mockup = url.searchParams.get("mockup");
    const selectors = [screen, scope, mockup].filter((v) => v !== null && v !== "").length;
    if (selectors !== 1 || (scope !== null && scope !== "" && scope !== "screens")) {
      sendJson(res, 400, { code: "validation_failed", message: "pass exactly one of screen=<name>, scope=screens or mockup=<name>" });
      return true;
    }
    const { records, skippedMalformedLines } = await readCommentRecordsWithStats(store);
    const all = groupThreads(records);
    const threads = screen
      ? all.filter((t) => !isMockupTarget(t.root) && t.root.screen === screen)
      : mockup
        ? all.filter((t) => isMockupTarget(t.root) && t.root.mockup === mockup)
        : all.filter((t) => !isMockupTarget(t.root));
    const detached = await detachedRootIds(store, threads);
    // The board (scope=screens) names each thread's screen, the compare view (mockup=) its variant.
    const entryTarget = (t: Thread): Record<string, string> =>
      isMockupTarget(t.root) ? { variant: t.root.variant } : scope ? { screen: t.root.screen } : {};
    const body: Record<string, unknown> = {
      comments: threads.flatMap((t) => [{ ...t.root, resolved: t.status === "resolved" }, ...t.replies]),
      threads: threads.map((t) => ({
        id: t.root.id,
        ...entryTarget(t),
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
  if (body.screen !== undefined && body.mockup !== undefined) {
    sendJson(res, 400, { code: "validation_failed", message: "pass either screen or mockup + variant, not both" });
    return true;
  }
  const isMockupRoot = !hasParent && body.mockup !== undefined;
  if (isMockupRoot && (typeof body.mockup !== "string" || typeof body.variant !== "string" || !MOCKUP_NAME_RE.test(body.mockup) || !MOCKUP_NAME_RE.test(body.variant))) {
    sendJson(res, 400, { code: "validation_failed", message: "mockup and variant are required and must match ^[\\w-]+$" });
    return true;
  }
  if (!hasParent && !isMockupRoot && (typeof body.screen !== "string" || body.screen.length === 0)) {
    sendJson(res, 400, { code: "validation_failed", message: "screen (or mockup + variant) is required" });
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
    if (isMockupRoot) {
      // Mockup comments anchor to authored ids, taken as the DOM gave them — no `--` instance mapping.
      nodeId = await checkMockupNode(store, body.mockup as string, body.variant as string, nodeId);
    } else if (!hasParent) {
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
      ...(isMockupRoot ? { mockup: body.mockup as string, variant: body.variant as string } : { screen: typeof body.screen === "string" ? body.screen : "" }),
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
    let anchor: CommentAnchor | undefined;
    if (action === "reanchor") {
      if (typeof body.node_id !== "string" || (body.screen !== undefined && body.mockup !== undefined)) {
        sendJson(res, 400, { code: "validation_failed", message: "reanchor needs node_id and either screen or mockup + variant" });
        return;
      }
      if (body.mockup !== undefined) {
        if (typeof body.mockup !== "string" || typeof body.variant !== "string" || !MOCKUP_NAME_RE.test(body.mockup) || !MOCKUP_NAME_RE.test(body.variant)) {
          sendJson(res, 400, { code: "validation_failed", message: "reanchor needs mockup and variant matching ^[\\w-]+$" });
          return;
        }
        const nodeId = await checkMockupNode(store, body.mockup, body.variant, body.node_id);
        anchor = { mockup: body.mockup, variant: body.variant, node_id: formatNodeRef(`mockup:${body.mockup}#${body.variant}`, nodeId!) };
      } else if (typeof body.screen === "string") {
        const { doc } = await loadScreen(store, body.screen);
        const anchorId = resolveAnchorId(doc, body.node_id);
        if (anchorId === undefined) throw new ToolError("not_found", `node "${body.node_id}" was not found on screen "${body.screen}"`);
        anchor = { screen: body.screen, node_id: formatNodeRef(body.screen, anchorId) };
      } else {
        sendJson(res, 400, { code: "validation_failed", message: "reanchor needs node_id and either screen or mockup + variant" });
        return;
      }
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

/**
 * The DOM id comment mode clicked in a mockup column, checked against the
 * variant file (ADR-012): the variant must exist and the id must be one of
 * its authored `id` attributes. `null` is the whole variant.
 */
async function checkMockupNode(store: Store, mockup: string, variant: string, nodeId: string | null): Promise<string | null> {
  const ids = await readVariantIds(store, mockup, variant);
  if (ids === undefined) throw new ToolError("not_found", `mockup "${mockup}" variant "${variant}" was not found`);
  if (nodeId !== null && !ids.has(nodeId)) {
    throw new ToolError("not_found", `"${nodeId}" is not an authored id of mockup "${mockup}" variant "${variant}"`);
  }
  return nodeId;
}
