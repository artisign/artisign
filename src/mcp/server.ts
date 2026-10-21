import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "../store/index.js";
import { TOOLS, ToolError, type ToolHandlerContext } from "../tools/index.js";
import { INSTRUCTIONS } from "./instructions.js";
import { deriveActivityEvent, type ActivitySink } from "./activity.js";

// Read from package.json rather than repeated here: this string is what every
// MCP client shows as the server's version, and a second copy of it drifts the
// moment a release bumps one and not the other — it sat at 0.9.0 while the
// package moved on. Resolved relative to this module, the same way
// `src/tools/guide.ts` reaches the shipped docs, so it works identically from
// `src/mcp/` under tsx and from `dist/mcp/` in the published package.
const packageJson = createRequire(import.meta.url)("../../package.json") as { version: string };

const SERVER_INFO = { name: "artisign", version: packageJson.version };

/** Marker shape a tool result can return (see `get_screenshot`) to be sent back as an MCP image content block instead of JSON text. */
type ImageResult = { __image: { data: string; mimeType: string } };

function isImageResult(value: unknown): value is ImageResult {
  if (typeof value !== "object" || value === null || !("__image" in value)) return false;
  const image = (value as { __image: unknown }).__image;
  return typeof image === "object" && image !== null && "data" in image && "mimeType" in image;
}

/** What a named `project` resolves to for one call: its store, the context built over it, and its activity hub. */
export type ResolvedProject = { store: Store; ctx: ToolHandlerContext; activity: ActivitySink };

/**
 * Resolves a tool call's required `project` input (a known project's name or
 * an absolute path) — throws a `ToolError` for a missing, unknown or
 * ambiguous one. Supplied by the daemon; absent for a fixed-store server.
 */
export type ProjectResolver = (project: string | undefined) => Promise<ResolvedProject>;

// Repeated in every project-bound tool's schema, so it stays short.
const PROJECT_INPUT = z.string({ error: "project is required — call list_projects" }).describe("Project name (see list_projects) or absolute path");

/**
 * Derives and broadcasts one `activity` event (CHR-630/ADR-005) for a tool
 * call. Called from a `finally`, after the MCP response is already built —
 * an exception here (derivation or the broadcast itself) must never alter
 * that response, so it's caught and logged, not rethrown. A no-op when
 * `activity` is undefined (stdio transport, or no project resolved).
 */
function emitActivity(activity: ActivitySink | undefined, tool: string, input: Record<string, unknown>, ok: boolean, result: unknown): void {
  if (!activity) return;
  try {
    activity.broadcastActivity(deriveActivityEvent(tool, input, ok, result));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}

/**
 * Builds the MCP server exposing all tools, backed by `store`. Shared by the
 * stdio and streamable-HTTP transports. `ctx` is the daemon-only extra
 * context a handful of tools need — omitted by the stdio transport, which has no registry.
 *
 * `store` is undefined in "bootstrap mode" — a daemon with zero projects
 * open. Every tool but
 * `init_project` (which builds its own `Store` from `input.dir` and never
 * touches this one) and `get_guide` (which touches no store at all) — see
 * `requiresProject` on `ToolDefinition` — reports a
 * clean `invalid_state` error in that mode instead of crashing on a missing
 * store, so an agent can still discover and call `init_project` to create
 * its first project without the whole route 503ing before dispatch.
 *
 * With `resolveProject` (the daemon's `/mcp`), the server is not bound to one
 * project: every tool except the `requiresProject: false` ones takes a
 * required `project` input, resolved per call — and `store`/`activity` of the
 * call come from that project, never from the arguments above.
 *
 * `activity` (CHR-630/ADR-005) is the resolved project's activity sink, fed
 * one derived event per tool call — reads included — after the handler
 * settles either way (success or `ToolError`). Absent for the stdio
 * transport, which has no hub to broadcast to. A call the SDK rejects for
 * an invalid input schema never reaches this callback and emits nothing.
 */
export function createMcpServer(
  store: Store | undefined,
  ctx?: ToolHandlerContext,
  activity?: ActivitySink,
  resolveProject?: ProjectResolver,
): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const toolDef of TOOLS) {
    const named = resolveProject !== undefined && toolDef.requiresProject !== false;
    server.registerTool(
      toolDef.name,
      { description: toolDef.description, inputSchema: named ? { project: PROJECT_INPUT, ...toolDef.inputShape } : toolDef.inputShape },
      async (rawInput: Record<string, unknown>) => {
        let ok = true;
        let result: unknown;
        let callStore = store;
        let callCtx = ctx;
        let callActivity = activity;
        let input = rawInput;
        try {
          if (named) {
            const { project, ...rest } = rawInput;
            ({ store: callStore, ctx: callCtx, activity: callActivity } = await resolveProject(project as string | undefined));
            input = rest;
          }
          if (!callStore && toolDef.requiresProject !== false) {
            throw new ToolError("invalid_state", "no project open — call init_project to create one");
          }
          result = await toolDef.handler(callStore as Store, input, callCtx);
          if (isImageResult(result)) {
            const { __image, ...rest } = result;
            const content: ({ type: "image"; data: string; mimeType: string } | { type: "text"; text: string })[] = [
              { type: "image", data: __image.data, mimeType: __image.mimeType },
            ];
            if (Object.keys(rest).length > 0) content.push({ type: "text", text: JSON.stringify(rest) });
            return { content };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          ok = false;
          const body =
            err instanceof ToolError
              ? { code: err.code, message: err.message }
              : { code: "io_error", message: err instanceof Error ? err.message : String(err) };
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true };
        } finally {
          emitActivity(callActivity, toolDef.name, input, ok, result);
        }
      },
    );
  }

  return server;
}
