import type { IncomingMessage, ServerResponse } from "node:http";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILENAME } from "../init/artisign-config.js";
import { sendJson, readJsonBody, PayloadTooLargeError } from "./json.js";

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
  if (url.pathname === "/api/fs/dirs" && req.method === "POST") return createDir(req, res);
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

/**
 * `POST /api/fs/dirs` `{ parent, name }` — creates exactly one directory
 * inside `parent` (the folder browser's "+ New folder"). `name` is a single
 * path segment: separators, a leading `.` (incl. `.`/`..`) and empty names are rejected so the
 * request can never escape `parent` or create nested folders. Failures keep
 * distinct codes the UI maps to its copy: `validation_failed` 400,
 * `not_found` 404 (parent missing), `already_exists` 409,
 * `permission_denied` 403. Success is 201 with the new `{ name, path }`.
 */
async function createDir(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { code: "validation_failed", message: err.message });
    } else {
      sendJson(res, 400, { code: "validation_failed", message: "request body is not valid JSON" });
    }
    return true;
  }

  const { parent, name } = body ?? {};
  if (typeof parent !== "string" || !isAbsolute(parent)) {
    sendJson(res, 400, { code: "validation_failed", message: "parent must be an absolute path" });
    return true;
  }
  const folderName = typeof name === "string" ? name.trim() : "";
  if (!isValidFolderName(folderName)) {
    sendJson(res, 400, {
      code: "validation_failed",
      message: "folder names can't start with \".\", contain / or \\, or be empty",
    });
    return true;
  }

  const path = join(resolve(parent), folderName);
  try {
    await mkdir(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      sendJson(res, 409, { code: "already_exists", message: `a folder named "${folderName}" already exists here` });
    } else if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      sendJson(res, 403, { code: "permission_denied", message: `permission denied: ${resolve(parent)}` });
    } else if (code === "ENAMETOOLONG") {
      sendJson(res, 400, { code: "validation_failed", message: "folder name is too long" });
    } else if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      sendJson(res, 404, { code: "not_found", message: `directory not found: ${resolve(parent)}` });
    } else {
      throw err;
    }
    return true;
  }
  sendJson(res, 201, { name: folderName, path });
  return true;
}

/** A single visible path segment: the listing hides dotdirs, so a leading `.` (which also covers `.` and `..`) is refused. */
function isValidFolderName(name: string): boolean {
  return name !== "" && !name.startsWith(".") && !/[/\\\0]/.test(name);
}
