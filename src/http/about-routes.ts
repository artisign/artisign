import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./json.js";

/**
 * `GET /api/about` — facts about the running daemon for the settings menu.
 * `version` is the one the process started with (see `STARTED_VERSION`), never
 * re-read from disk. Project-independent.
 */
export async function handleAboutApi(req: IncomingMessage, res: ServerResponse, version: string): Promise<boolean> {
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/api/about" || req.method !== "GET") return false;
  sendJson(res, 200, { version });
  return true;
}
