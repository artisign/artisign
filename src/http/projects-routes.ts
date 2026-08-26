import type { IncomingMessage, ServerResponse } from "node:http";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initProjectTool } from "../tools/lifecycle.js";
import { ToolError } from "../tools/index.js";
import type { ProjectRegistry } from "../daemon/project-registry.js";
import { readGlobalConfig } from "../daemon/global-config.js";
import { CONFIG_FILENAME } from "../init/artisign-config.js";
import { sendJson, readJsonBody, PayloadTooLargeError } from "./json.js";
import { STATUS_BY_CODE } from "./tools-api.js";

type ProjectsResponse = {
  active: string | null;
  open: { root: string; name: string }[];
  recent: string[];
};

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

/** `GET /api/projects`'s body — also reused as the response of every mutating route below, so the UI never has to re-fetch after a call. */
async function buildProjectsResponse(registry: ProjectRegistry): Promise<ProjectsResponse> {
  // `handle.name` is cached and kept live by a watcher subscription (see
  // ProjectRegistry.openNew) — no per-request artisign.json read, and this
  // stays correct even for a project whose artisign.json is currently
  // broken on disk.
  const open = registry.list().map((handle) => ({ root: handle.root, name: handle.name }));

  const config = await readGlobalConfig();
  const recentCandidates = config.recentProjects ?? [];
  const recentChecks = await Promise.all(recentCandidates.map((dir) => pathExists(dir)));
  const recent = recentCandidates.filter((_dir, i) => recentChecks[i]);

  return { active: registry.activeProject ?? null, open, recent };
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  try {
    return (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { code: "validation_failed", message: err.message });
    } else {
      sendJson(res, 400, { code: "validation_failed", message: "request body is not valid JSON" });
    }
    return undefined;
  }
}

/**
 * `/api/projects*` — the preview's project switcher: list open/recent
 * projects, open one, scaffold+open a new one, or switch which one is
 * active. Unlike every other route, these operate on the `ProjectRegistry`
 * itself rather than one project's `Store`, so they're routed before (and
 * independently of) the per-request project resolution in `server.ts`.
 * Returns `false` when `req` doesn't match `/api/projects*`, so the caller
 * can fall through to its next handler.
 */
export async function handleProjectsApi(req: IncomingMessage, res: ServerResponse, registry: ProjectRegistry): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/projects" && !url.pathname.startsWith("/api/projects/")) return false;

  if (url.pathname === "/api/projects" && req.method === "GET") {
    sendJson(res, 200, await buildProjectsResponse(registry));
    return true;
  }

  if (url.pathname === "/api/projects/open" && req.method === "POST") {
    const body = await readBody(req, res);
    if (body === undefined) return true;
    if (typeof body.dir !== "string" || body.dir.length === 0) {
      sendJson(res, 400, { code: "validation_failed", message: "dir is required" });
      return true;
    }

    let handle;
    try {
      handle = await registry.open(body.dir);
    } catch (err) {
      sendJson(res, 400, { code: "validation_failed", message: err instanceof Error ? err.message : String(err) });
      return true;
    }
    registry.activeProject = handle.root;
    sendJson(res, 200, await buildProjectsResponse(registry));
    return true;
  }

  if (url.pathname === "/api/projects/init" && req.method === "POST") {
    const body = await readBody(req, res);
    if (body === undefined) return true;
    if (typeof body.dir !== "string" || body.dir.length === 0) {
      sendJson(res, 400, { code: "validation_failed", message: "dir is required" });
      return true;
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      sendJson(res, 400, { code: "validation_failed", message: "name must be a string" });
      return true;
    }

    const dir = resolve(body.dir);
    const configPath = join(dir, CONFIG_FILENAME);
    if (await pathExists(configPath)) {
      sendJson(res, 409, { code: "conflict", message: `a project already exists at ${configPath}` });
      return true;
    }

    // Same scaffold path init_project (the MCP/agent tool) uses — a
    // UI-created and an agent-created project must be identical on disk,
    // commit included. openProject registers it with this
    // same registry; activeProject still needs setting explicitly since
    // initProjectTool only opens, it never assumes it should also switch
    // what the UI is showing (see src/tools/lifecycle.ts).
    let result;
    try {
      result = await initProjectTool(
        { dir, name: typeof body.name === "string" ? body.name : undefined, seed: { kind: "empty" } },
        { openProject: (d: string) => registry.open(d) },
      );
    } catch (err) {
      if (err instanceof ToolError) {
        sendJson(res, STATUS_BY_CODE[err.code], { code: err.code, message: err.message });
      } else {
        // Unexpected failure — keep the stack in the daemon log (failSafe
        // did this before the scaffold call was wrapped); the client only
        // gets the message.
        console.error(err);
        sendJson(res, 500, { code: "io_error", message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // initProjectTool awaited openProject last, so the root is registered —
    // the setter cannot throw here (a failure would reach failSafe anyway).
    registry.activeProject = result.root as string;
    sendJson(res, 200, await buildProjectsResponse(registry));
    return true;
  }

  if (url.pathname === "/api/projects/activate" && req.method === "POST") {
    const body = await readBody(req, res);
    if (body === undefined) return true;
    if (typeof body.root !== "string" || body.root.length === 0) {
      sendJson(res, 400, { code: "validation_failed", message: "root is required" });
      return true;
    }

    try {
      registry.activeProject = body.root;
    } catch (err) {
      sendJson(res, 400, { code: "validation_failed", message: err instanceof Error ? err.message : String(err) });
      return true;
    }
    sendJson(res, 200, await buildProjectsResponse(registry));
    return true;
  }

  return false;
}
