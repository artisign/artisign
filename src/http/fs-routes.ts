import type { IncomingMessage, ServerResponse } from "node:http";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILENAME } from "../init/artisign-config.js";
import { sendJson } from "./json.js";

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

type DirEntry = { name: string; path: string; isArtisignProject: boolean };

/**
 * `GET /api/fs/dirs?path=<abs>` — directory listing for the preview's folder
 * browser. Directories only — including
 * symlinks that resolve to one — hidden dotdirs skipped; each entry
 * flags whether it already holds a readable `artisign.json` so the browser
 * can badge it. Project-independent, like
 * `/api/projects*` — no `Store` involved. `path` defaults to the user's
 * home directory when omitted, so the browser UI (which never knows an
 * absolute path up front, especially with zero projects open) can start
 * browsing without a separate "give me a starting point" round trip.
 */
export async function handleFsApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/fs/dirs" || req.method !== "GET") return false;

  const pathParam = url.searchParams.get("path");
  if (pathParam !== null && !isAbsolute(pathParam)) {
    sendJson(res, 400, { code: "validation_failed", message: "path must be an absolute path" });
    return true;
  }

  const path = resolve(pathParam ?? homedir());
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch {
    sendJson(res, 404, { code: "not_found", message: `directory not found: ${path}` });
    return true;
  }

  // `withFileTypes` reports the link's own type, not its target's, so a
  // symlinked directory would silently vanish from the listing — the natural
  // workaround for an unreachable path failing quietly. `stat`
  // follows the chain and rejects self-referential links (ELOOP) and dangling
  // ones, both treated here as "not a directory". A link to one of its own
  // ancestors resolves fine and is listed: descending it repeats path segments
  // but terminates whenever the user stops clicking, so it needs no guard.
  const visible = dirents.filter((d) => !d.name.startsWith("."));
  const dirNames = (
    await Promise.all(
      visible.map(async (d) => {
        if (d.isDirectory()) return d.name;
        if (!d.isSymbolicLink()) return null;
        return stat(join(path, d.name)).then(
          (s) => (s.isDirectory() ? d.name : null),
          () => null,
        );
      }),
    )
  ).filter((name): name is string => name !== null);
  const entries: DirEntry[] = await Promise.all(
    dirNames
      .sort((a, b) => a.localeCompare(b))
      .map(async (name) => {
        const entryPath = join(path, name);
        return { name, path: entryPath, isArtisignProject: await pathExists(join(entryPath, CONFIG_FILENAME)) };
      }),
  );

  const parent = dirname(path);
  sendJson(res, 200, { path, parent: parent === path ? null : parent, entries, home: homedir() });
  return true;
}
