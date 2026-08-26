import { createServer as createHttpServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";
import { createMcpHttpHandler } from "../mcp/index.js";
import { handleToolsApi } from "./tools-api.js";
import { handlePreviewRoutes } from "./preview-routes.js";
import { handleCommentsRoutes } from "./comments-routes.js";
import { handleProjectsApi } from "./projects-routes.js";
import { handleFsApi } from "./fs-routes.js";
import { handleSseConnection } from "./sse.js";
import { isAllowedOrigin, hasJsonContentType } from "./origin-guard.js";
import { sendJson } from "./json.js";
import type { ProjectRegistry, ProjectHandle } from "../daemon/project-registry.js";

// This module lives at src/http/server.ts (dev) or dist/http/server.js (build);
// both are two directories below the package root, next to src/preview.
const PREVIEW_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "preview");

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Serves a static file from `src/preview/` — the only build-free way to give `.js` modules and `.css` their required MIME type. `/` maps to `index.html`; anything outside the known extensions or the preview dir 404s. Served even with zero projects open — the empty-state UI has to load from somewhere. */
function servePreviewFile(pathname: string, res: ServerResponse): void {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const ext = extname(relative);
  const contentType = STATIC_CONTENT_TYPES[ext];
  const filePath = resolve(PREVIEW_DIR, relative);
  if (!contentType || (filePath !== PREVIEW_DIR && !filePath.startsWith(PREVIEW_DIR + sep))) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  readFile(filePath)
    .then((body) => {
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    })
    .catch(() => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    });
}

/** Sends a 500 if nothing was written yet — a last-resort net for a rejection that escaped a handler. */
function failSafe(res: ServerResponse, err: unknown): void {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "io_error", message: "internal server error" }));
}

function rejectForbidden(res: ServerResponse): void {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "validation_failed", message: "forbidden: cross-origin request" }));
}

/** A bare 500 mid-MCP-request looks like a server bug to a JSON-RPC client; this is a well-formed (if id-less, since the request body was never parsed) JSON-RPC error instead — used only for project resolution failures that happen before a transport is even created. -32602 is JSON-RPC 2.0's standard "Invalid params" code, an apt fit for an unresolvable `?project=` path. */
function sendMcpError(res: ServerResponse, message: string): void {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32602, message } }));
}

/** `?project=` with no value, or all whitespace, is treated the same as an absent param — otherwise it resolves to `resolve("")`, the daemon's own cwd, which is never the caller's intent. */
function normalizeProjectParam(url: URL): string | undefined {
  const raw = url.searchParams.get("project");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves `?project=<path>` against the registry, auto-opening it if it
 * isn't already open — MCP clients (agents) are trusted callers, unlike the
 * browser UI (see `resolveUiProject` below), so an unopened-but-valid path
 * just works. Falls back to the active project when the param is absent.
 *
 * When no project resolves either way — no `?project=` and nothing active —
 * this still builds the MCP server, in "bootstrap mode" (`store: undefined`,
 * review fix 1): `init_project` is the one tool that doesn't need a project
 * (it builds its own `Store` from `input.dir`), and a daemon with zero
 * projects open has no other way for an agent to create the first one.
 * Every other tool reports a clean error in that mode instead of the whole
 * route 503ing before an MCP client can even call `tools/list`.
 */
async function handleMcpRoute(req: IncomingMessage, res: ServerResponse, registry: ProjectRegistry, url: URL): Promise<void> {
  const projectParam = normalizeProjectParam(url);
  let handle: ProjectHandle | undefined;

  if (projectParam !== undefined) {
    try {
      handle = registry.get(projectParam) ?? (await registry.open(projectParam));
    } catch (err) {
      sendMcpError(res, err instanceof Error ? err.message : String(err));
      return;
    }
  } else if (registry.activeProject !== undefined) {
    handle = registry.get(registry.activeProject);
  }

  const mcpHandler = createMcpHttpHandler(handle?.store, { openProject: (dir: string) => registry.open(dir) });
  await mcpHandler(req, res);
}

/**
 * Resolves `?project=<path>` for the browser UI routes — unlike the MCP
 * route, an explicit but unopened project 404s rather than auto-opening
 * (only `POST /api/projects/open|init` open a project from the UI). Absent
 * param falls back to the active project.
 */
function resolveUiProject(registry: ProjectRegistry, url: URL): { handle: ProjectHandle | undefined; explicitMiss: boolean } {
  const projectParam = normalizeProjectParam(url);
  if (projectParam !== undefined) {
    const handle = registry.get(projectParam);
    return { handle, explicitMiss: handle === undefined };
  }
  const active = registry.activeProject;
  return { handle: active !== undefined ? registry.get(active) : undefined, explicitMiss: false };
}

export type HttpServer = {
  server: Server;
};

/**
 * Routes every request. `/health`, `/api/projects*`, `/api/fs/dirs`, and the
 * static preview files (including `/`) work with zero projects open — the
 * daemon itself, the project registry, and the empty-state UI don't depend
 * on one.
 * `/mcp`, `/api/tools/*`, and `/events` also work with zero projects open,
 * each in its own bootstrap-appropriate way (see `handleMcpRoute`,
 * `handleToolsApi`, and `handleSseConnection`); `/api/comments` and the GET
 * preview routes (`/api/screens`, `/api/render/*`, etc.) genuinely need a
 * resolved project and 503 without one. Every project-dependent route
 * resolves via `?project=` (falling back to the registry's active project)
 * — see `handleMcpRoute` and `resolveUiProject` for the two different
 * resolution policies.
 */
export function createServer(registry: ProjectRegistry): HttpServer {
  const server = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const isMcp = url.pathname === "/mcp";
    const isToolsApi = url.pathname.startsWith("/api/tools/");
    const isCommentsApi = url.pathname === "/api/comments";
    const isProjectsApi = url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/");
    const isFsApi = req.method === "GET" && url.pathname === "/api/fs/dirs";
    const isSse = req.method === "GET" && url.pathname === "/events";
    const isApiPath = url.pathname.startsWith("/api/");
    const isPreviewApi = req.method === "GET" && isApiPath && !isToolsApi && !isCommentsApi && !isProjectsApi && !isFsApi;

    // A `handle*Routes` helper returns `false` when it recognized the path
    // prefix but not this exact method/pattern (e.g. DELETE /api/comments,
    // GET /api/tools/x, or an /api/render/<screen> that doesn't match). Left
    // unchecked, that boolean was discarded and the request just hung with
    // no response. Every `/api/*` request must resolve to a response.
    const respondUnhandled = (handled: boolean): void => {
      if (!handled) sendJson(res, 404, { code: "not_found", message: "unknown API route" });
    };

    if (isMcp || isToolsApi || isCommentsApi || isProjectsApi || isFsApi || isSse || isPreviewApi) {
      if (!isAllowedOrigin(req) || (req.method === "POST" && !hasJsonContentType(req))) {
        rejectForbidden(res);
        return;
      }

      if (isProjectsApi) {
        handleProjectsApi(req, res, registry).then(respondUnhandled).catch((err: unknown) => failSafe(res, err));
        return;
      }

      if (isFsApi) {
        handleFsApi(req, res).then(respondUnhandled).catch((err: unknown) => failSafe(res, err));
        return;
      }

      if (isMcp) {
        handleMcpRoute(req, res, registry, url).catch((err: unknown) => failSafe(res, err));
        return;
      }

      const { handle, explicitMiss } = resolveUiProject(registry, url);
      if (explicitMiss) {
        sendJson(res, 404, { code: "unknown_project", message: `project not open: ${normalizeProjectParam(url)}` });
        return;
      }

      // Bootstrap-capable routes: proceed with `handle` possibly undefined
      // (only when nothing was explicitly requested — an explicit miss
      // already returned above) rather than 503ing before dispatch.
      if (isToolsApi) {
        handleToolsApi(req, res, handle?.store, { openProject: (dir: string) => registry.open(dir) })
          .then(respondUnhandled)
          .catch((err: unknown) => failSafe(res, err));
        return;
      }
      if (isSse) {
        handleSseConnection(res, registry.lifecycle, handle?.sseHub);
        return;
      }

      if (!handle) {
        sendJson(res, 503, { code: "no_project", message: "no project open" });
        return;
      }

      if (isCommentsApi) {
        handleCommentsRoutes(req, res, handle.store).then(respondUnhandled).catch((err: unknown) => failSafe(res, err));
      } else {
        handlePreviewRoutes(req, res, handle.store).then(respondUnhandled).catch((err: unknown) => failSafe(res, err));
      }
      return;
    }

    if (isApiPath) {
      sendJson(res, 404, { code: "not_found", message: "unknown API route" });
      return;
    }

    servePreviewFile(url.pathname, res);
  });

  return { server };
}
