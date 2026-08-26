import { runStdioServer } from "../mcp/index.js";

export async function runMcp(dir: string): Promise<void> {
  try {
    await runStdioServer(dir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
