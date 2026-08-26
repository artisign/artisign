import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Store } from "../store/index.js";
import type { ToolHandlerContext } from "../tools/index.js";
import { createMcpServer } from "./server.js";

/**
 * Builds a `/mcp` request handler backed by the streamable-HTTP transport,
 * in stateless mode (no session id) — a fitting match for a single local
 * writer with no multi-client coordination story.
 *
 * A fresh `McpServer` + `StreamableHTTPServerTransport` pair is built per
 * request rather than reused across requests: in stateless mode the SDK
 * tears the transport down at the end of each request/response cycle, so a
 * shared instance serves exactly one request successfully and then 500s on
 * every subsequent call.
 */
export function createMcpHttpHandler(
  store: Store | undefined,
  ctx?: ToolHandlerContext,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const server = createMcpServer(store, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
