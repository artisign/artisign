import { spawn } from "node:child_process";
import { findRunningDaemon, readLock, type DaemonLock } from "../daemon/lock.js";
import { waitFor } from "./wait-for.js";

export type StartOptions = {
  port?: number;
  projects: string[];
  /** Path to the CLI entry point (`process.argv[1]`) — re-invoked with `__daemon` to spawn detached. */
  cliEntry: string;
};

async function pollForHealthyDaemon(timeoutMs: number): Promise<DaemonLock | undefined> {
  return waitFor(timeoutMs, async () => {
    const lock = await readLock();
    if (!lock) return undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${lock.port}/health`);
      if (res.ok) return lock;
    } catch {
      // daemon process is up but not accepting connections yet
    }
    return undefined;
  });
}

export async function runStart(opts: StartOptions): Promise<void> {
  const running = await findRunningDaemon();
  if (running) {
    console.log(`artisign already running on http://127.0.0.1:${running.port}`);
    return;
  }

  const args = ["__daemon"];
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  args.push(...opts.projects);

  const child = spawn(process.execPath, [opts.cliEntry, ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const lock = await pollForHealthyDaemon(10_000);
  if (!lock) {
    console.error("Timed out waiting for the daemon to start");
    process.exitCode = 1;
    return;
  }

  console.log(`artisign running on http://127.0.0.1:${lock.port}`);
}
