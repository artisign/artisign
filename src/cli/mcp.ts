import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { findRunningDaemon } from "../daemon/lock.js";
import { createBridge } from "../mcp/bridge.js";
import { readVersion } from "../version.js";
import { pollForHealthyDaemon } from "./start.js";

/** Finds the running daemon, or starts one detached (what `start --no-open` does) and waits for `/health`. */
async function ensureDaemon(cliEntry: string): Promise<{ port: number }> {
  const running = await findRunningDaemon();
  if (running) return { port: running.port };
  // stdio "ignore": the daemon's console output must never reach the bridge's stdout, which carries MCP only.
  spawn(process.execPath, [cliEntry, "__daemon"], { detached: true, stdio: "ignore" }).unref();
  const lock = await pollForHealthyDaemon(10_000);
  if (!lock) throw new Error("timed out waiting for the daemon to start");
  return { port: lock.port };
}

/** `artisign mcp`: stdio on one side, the daemon's `/mcp` on the other, until stdin closes. */
export async function runMcp(cliEntry: string): Promise<void> {
  const bridge = createBridge({
    ensureDaemon: () => ensureDaemon(cliEntry),
    fetch,
    write: (line) => process.stdout.write(`${line}\n`),
    warn: (line) => console.error(line),
    version: readVersion(),
  });
  const pending = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const p = bridge.handleMessage(line).finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise<void>((resolve) => rl.once("close", resolve));
  await Promise.all(pending);
}
