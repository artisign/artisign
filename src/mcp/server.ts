import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../store/index.js";
import { TOOLS, ToolError, type ToolHandlerContext } from "../tools/index.js";
import { INSTRUCTIONS } from "./instructions.js";

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

/**
 * Builds the MCP server exposing all tools, backed by `store`. Shared by the
 * stdio and streamable-HTTP transports. `ctx` is the daemon-only extra
 * context a handful of tools need — omitted by the stdio transport, which has no registry.
 *
 * `store` is undefined in "bootstrap mode" — a daemon with zero projects
 * open and no `?project=` given. Every tool but
 * `init_project` (which builds its own `Store` from `input.dir` and never
 * touches this one) and `get_guide` (which touches no store at all) — see
 * `requiresProject` on `ToolDefinition` — reports a
 * clean `invalid_state` error in that mode instead of crashing on a missing
 * store, so an agent can still discover and call `init_project` to create
 * its first project without the whole route 503ing before dispatch.
 */
export function createMcpServer(store: Store | undefined, ctx?: ToolHandlerContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const toolDef of TOOLS) {
    server.registerTool(
      toolDef.name,
      { description: toolDef.description, inputSchema: toolDef.inputShape },
      async (input: Record<string, unknown>) => {
        try {
          if (!store && toolDef.requiresProject !== false) {
            throw new ToolError("invalid_state", "no project open — pass ?project=<path>, or call init_project to create one");
          }
          const result = await toolDef.handler(store as Store, input, ctx);
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
          const body =
            err instanceof ToolError
              ? { code: err.code, message: err.message }
              : { code: "io_error", message: err instanceof Error ? err.message : String(err) };
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true };
        }
      },
    );
  }

  return server;
}
