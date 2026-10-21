import { createServer as createHttpServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { createMcpHttpHandler, type ProjectResolver } from "../mcp/index.js";
import { handleToolsApi } from "./tools-api.js";
import { handlePreviewRoutes } from "./preview-routes.js";
import { handleCommentsRoutes } from "./comments-routes.js";
import { handleProjectsApi } from "./projects-routes.js";
import { handleFsApi } from "./fs-routes.js";
import { handleSseConnection } from "./sse.js";
import { isAllowedOrigin, hasJsonContentType } from "./origin-guard.js";
import { sendJson } from "./json.js";
import type { ProjectRegistry, ProjectHandle } from "../daemon/project-registry.js";
import { ToolError, type ViewState, type BoardStatePatch, type ToolHandlerContext } from "../tools/index.js";

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

/** A bare 500 mid-MCP-request looks like a server bug to a JSON-RPC client; this is a well-formed (if id-less, since the request body was never parsed) JSON-RPC error instead — used only for project resolution failures that happen before a transport is even created. -32602 is JSON-RPC 2.0's standard "Invalid params" code, an apt fit for a request carrying the removed `?project=` parameter. */
function sendMcpError(res: ServerResponse, message: string): void {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32602, message } }));
}

/**
 * Composes the tools layer's `ViewState` (CHR-624/ADR-005) over one
 * resolved project's `boardState` + `sseHub` — the one place a board-state
 * mutation and its broadcast happen together: apply the patch, and only if
 * it actually changed something, broadcast it, tagged with `source`.
 */
function buildViewState(handle: ProjectHandle, source: "agent" | "human"): ViewState {
  return {
    getBoardState: () => handle.boardState.get(),
    setBoardState: (patch: BoardStatePatch) => {
      const { state, changed } = handle.boardState.set(patch);
      if (changed) handle.sseHub.broadcastBoardState(state, source);
      return state;
    },
    pruneScreen: (name: string) => {
      const { state, changed } = handle.boardState.pruneScreen(name);
      if (changed) handle.sseHub.broadcastBoardState(state, source);
    },
  };
}

/** Builds the `ToolHandlerContext` for one request — `source` is set by the caller: `"agent"` for `/mcp`, `"human"` for `POST /api/tools/<name>`. `viewState` is undefined when no project resolved (bootstrap mode) — nothing to compose it over. */
function buildToolContext(handle: ProjectHandle | undefined, registry: ProjectRegistry, source: "agent" | "human"): ToolHandlerContext {
  return {
    openProject: (dir: string) => registry.open(dir),
    listProjects: () => registry.listKnown(),
    viewState: handle ? buildViewState(handle, source) : undefined,
    source,
  };
}

/** `?project=` with no value, or all whitespace, is treated the same as an absent param — otherwise it resolves to `resolve("")`, the daemon's own cwd, which is never the caller's intent. */
function normalizeProjectParam(url: URL): string | undefined {
  const raw = url.searchParams.get("project");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves a tool call's `project` input against the registry: an absolute
 * path opens that folder if it isn't open yet (MCP clients are trusted
 * callers, unlike the browser UI — see `resolveUiProject` below); anything
 * else is a known project's name. There is deliberately no fallback to the
 * active project — that slot belongs to the preview UI.
 */
function createMcpProjectResolver(registry: ProjectRegistry): ProjectResolver {
  return async (project) => {
    const requested = project?.trim();
    if (!requested) throw new ToolError("validation_failed", "project is required — call list_projects");

    let handle: ProjectHandle | undefined;
    if (isAbsolute(requested)) {
      try {
        handle = registry.get(requested) ?? (await registry.open(requested));
      } catch (err) {
        throw new ToolError("not_found", err instanceof Error ? err.message : String(err));
      }
    } else {
      const matches = (await registry.listKnown()).filter((p) => p.name === requested);
      if (matches.length === 0) {
        throw new ToolError("not_found", `unknown project "${requested}" — call list_projects, or pass an absolute path`);
      }
      if (matches.length > 1) {
        throw new ToolError(
          "validation_failed",
          `project name "${requested}" is ambiguous — pass the root instead: ${matches.map((p) => p.root).join(", ")}`,
        );
      }
      const root = matches[0]!.root;
      try {
        handle = registry.get(root) ?? (await registry.open(root));
      } catch (err) {
        throw new ToolError("not_found", err instanceof Error ? err.message : String(err));
      }
    }
    return { store: handle.store, ctx: buildToolContext(handle, registry, "agent"), activity: handle.sseHub };
  };
}

/**
 * `/mcp` is not bound to a project: each tool call names its own (see
 * `createMcpProjectResolver`). The old `?project=` query parameter is gone —
 * a request still carrying it gets a JSON-RPC error saying how to
 * reconfigure, rather than being silently served against the wrong project.
 *
 * Zero projects open is fine: `list_projects` and `init_project` need none.
 */
async function handleMcpRoute(req: IncomingMessage, res: ServerResponse, registry: ProjectRegistry, url: URL): Promise<void> {
  if (url.searchParams.has("project")) {
    sendMcpError(
      res,
      "the ?project= parameter was removed from /mcp: every tool call now names its project in a `project` input (see list_projects). Reconfigure your MCP entry without it — run `artisign setup`.",
    );
    return;
  }

  const mcpHandler = createMcpHttpHandler(undefined, buildToolContext(undefined, registry, "agent"), undefined, createMcpProjectResolver(registry));
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
        handleToolsApi(req, res, handle?.store, buildToolContext(handle, registry, "human"))
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
        handlePreviewRoutes(req, res, handle.store, handle.boardState).then(respondUnhandled).catch((err: unknown) => failSafe(res, err));
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
