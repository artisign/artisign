import type { IncomingMessage, ServerResponse } from "node:http";
import { releasesBetween, type Release } from "../changelog.js";
import { sendJson } from "./json.js";

/**
 * `GET /api/whats-new?since=<x.y.z>` — the changelog sections newer than `since` up to the version this daemon
 * started with, newest first. `releases` is the changelog as read at startup, so what is shown matches `version`
 * even if an `npm install -g` has since replaced the file on disk. An absent or unparsable `since` means all of them.
 * Project-independent.
 */
export async function handleWhatsNewApi(
  req: IncomingMessage,
  res: ServerResponse,
  version: string,
  releases: Release[],
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/whats-new" || req.method !== "GET") return false;
  const since = url.searchParams.get("since") ?? undefined;
  const lowerBound = since !== undefined && /^\d+\.\d+\.\d+$/.test(since) ? since : undefined;
  sendJson(res, 200, { version, releases: releasesBetween(releases, lowerBound, version) });
  return true;
}
