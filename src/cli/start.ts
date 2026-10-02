import { spawn } from "node:child_process";
import { findRunningDaemon, readLock, type DaemonLock } from "../daemon/lock.js";
import { waitFor } from "./wait-for.js";
import { openBrowser } from "./open-browser.js";

export type StartOptions = {
  port?: number;
  projects: string[];
  /** Path to the CLI entry point (`process.argv[1]`) — re-invoked with `__daemon` to spawn detached. */
  cliEntry: string;
  /** `--no-open`: do not open the preview in the browser. */
  noOpen?: boolean;
};

/** Everything `runStart` touches outside itself, so tests can run it without a daemon, a browser or a TTY. */
export type StartDeps = {
  findRunningDaemon: () => Promise<DaemonLock | undefined>;
  spawnDaemon: (cliEntry: string, args: string[]) => void;
  pollForHealthyDaemon: (timeoutMs: number) => Promise<DaemonLock | undefined>;
  openBrowser: (url: string) => void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  log: (line: string) => void;
  error: (line: string) => void;
};

/**
 * Whether `start` opens the browser. Off for `--no-open`, `ARTISIGN_NO_OPEN` (any non-empty value except 0/false),
 * and — best effort, for scripts and pipelines — when `CI` is set or stdout is not a terminal.
 */
export function shouldOpenBrowser(opts: { noOpen?: boolean; env: NodeJS.ProcessEnv; isTTY: boolean }): boolean {
  if (opts.noOpen) return false;
  const flag = opts.env.ARTISIGN_NO_OPEN;
  if (flag !== undefined && flag !== "" && flag !== "0" && flag.toLowerCase() !== "false") return false;
  if (opts.env.CI !== undefined && opts.env.CI !== "" && opts.env.CI !== "0" && opts.env.CI.toLowerCase() !== "false") return false;
  return opts.isTTY;
}

function spawnDaemon(cliEntry: string, args: string[]): void {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const defaultDeps: StartDeps = {
  findRunningDaemon,
  spawnDaemon,
  pollForHealthyDaemon,
  openBrowser,
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
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

export async function runStart(opts: StartOptions, deps: StartDeps = defaultDeps): Promise<void> {
  const open = (port: number): void => {
    if (!shouldOpenBrowser({ noOpen: opts.noOpen, env: deps.env, isTTY: deps.isTTY })) return;
    // The URL is already printed: a browser that cannot be opened is not an error.
    try {
      deps.openBrowser(`http://127.0.0.1:${port}/`);
    } catch {
      /* ignore */
    }
  };

  const running = await deps.findRunningDaemon();
  if (running) {
    deps.log(`artisign already running on http://127.0.0.1:${running.port}`);
    open(running.port);
    return;
  }

  const args = ["__daemon"];
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  args.push(...opts.projects);
  deps.spawnDaemon(opts.cliEntry, args);

  const lock = await deps.pollForHealthyDaemon(10_000);
  if (!lock) {
    deps.error("Timed out waiting for the daemon to start");
    process.exitCode = 1;
    return;
  }

  deps.log(`artisign running on http://127.0.0.1:${lock.port}`);
  open(lock.port);
}
