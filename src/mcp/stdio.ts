import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FsStore } from "../store/index.js";
import { createMcpServer } from "./server.js";

/** Runs the MCP server over stdio for `projectDir` — the entry point for Claude Desktop / Claude Code. */
export async function runStdioServer(projectDir: string): Promise<void> {
  const store = new FsStore(projectDir);
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
