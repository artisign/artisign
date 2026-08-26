import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store/index.js";
import { createComment, readCommentRecordsWithStats } from "../tools/comments.js";
import { ToolError } from "../tools/types.js";
import { loadScreen } from "../tools/context.js";
import { sendJson, readJsonBody, PayloadTooLargeError } from "./json.js";

type CreateCommentBody = { screen?: unknown; node_id?: unknown; text?: unknown; parent_id?: unknown; resolved?: unknown };

/**
 * `GET /api/comments?screen=<name>` and `POST /api/comments` — the
 * preview's comment surface. Reading returns the screen's comments flat
 * (with `resolved` and `parent_id` so the UI can group threads itself).
 * Creating covers both a new root comment and — via an optional
 * `parent_id` — a human reply on an existing thread; agents always use the
 * `reply_comment` MCP tool instead (there is no `create_comment` tool by
 * design: humans author comments in the browser, agents only reply).
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
    const body: Record<string, unknown> = { comments: records.filter((r) => r.screen === screen) };
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

  const hasParent = body.parent_id !== undefined && body.parent_id !== null;
  if (!hasParent && (typeof body.screen !== "string" || body.screen.length === 0)) {
    sendJson(res, 400, { code: "validation_failed", message: "screen is required" });
    return true;
  }
  if (typeof body.text !== "string" || body.text.length === 0) {
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
    if (!hasParent) {
      const { doc } = await loadScreen(store, body.screen as string);
      if (typeof body.node_id === "string" && !doc.nodes[body.node_id]) {
        throw new ToolError("not_found", `node "${body.node_id}" was not found on screen "${body.screen as string}"`);
      }
    }

    const comment = await createComment(store, {
      screen: typeof body.screen === "string" ? body.screen : "",
      node_id: (body.node_id as string | null | undefined) ?? null,
      text: body.text,
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
