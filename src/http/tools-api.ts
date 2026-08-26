import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Store } from "../store/index.js";
import { findTool, ToolError, type ToolErrorCode, type ToolHandlerContext } from "../tools/index.js";
import { sendJson, readJsonBody, PayloadTooLargeError } from "./json.js";

export const STATUS_BY_CODE: Record<ToolErrorCode, number> = {
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  invalid_state: 409,
  io_error: 500,
  git_error: 500,
};

/**
 * Internal JSON API for the preview frontend: `POST /api/tools/<name>` runs
 * the same tool implementation the MCP server exposes. Returns `undefined`
 * (and sends nothing) when `req` doesn't match this route, so the caller
 * can fall through to its next handler.
 *
 * `store` is undefined in "bootstrap mode"; every tool that needs a project (i.e. all
 * but `init_project` and `get_guide`) reports a clean `invalid_state` error
 * in that mode instead of crashing, mirroring
 * `mcp/server.ts`'s handling of the same case.
 */
export async function handleToolsApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store | undefined,
  ctx?: ToolHandlerContext,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = /^\/api\/tools\/([\w-]+)$/.exec(url.pathname);
  if (!match || req.method !== "POST") return false;

  const toolDef = findTool(match[1]!);
  if (!toolDef) {
    sendJson(res, 404, { code: "not_found", message: `unknown tool "${match[1]}"` });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { code: "validation_failed", message: err.message });
    } else {
      sendJson(res, 400, { code: "validation_failed", message: "request body is not valid JSON" });
    }
    return true;
  }

  try {
    if (!store && toolDef.requiresProject !== false) {
      throw new ToolError("invalid_state", "no project open — pass ?project=<path>, or call init_project to create one");
    }
    const input = z.object(toolDef.inputShape).parse(body);
    const result = await toolDef.handler(store as Store, input, ctx);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof ToolError) {
      sendJson(res, STATUS_BY_CODE[err.code], { code: err.code, message: err.message });
    } else if (err instanceof z.ZodError) {
      sendJson(res, 400, { code: "validation_failed", message: err.message });
    } else {
      sendJson(res, 500, { code: "io_error", message: err instanceof Error ? err.message : String(err) });
    }
  }
  return true;
}
