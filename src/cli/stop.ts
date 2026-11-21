import { findRunningDaemon, isProcessAlive, readLock, removeLock, type DaemonLock } from "../daemon/lock.js";
import { SHUTDOWN_PATH, SHUTDOWN_TOKEN_HEADER } from "../daemon/shutdown.js";
import { waitFor } from "./wait-for.js";

const STOP_TIMEOUT_MS = 10_000;

/** What `runStop` touches outside itself, so the hard-kill fallback is testable without a Windows runner or a stuck daemon. */
export type StopDeps = {
  platform: NodeJS.Platform;
  timeoutMs: number;
  findRunningDaemon: () => Promise<DaemonLock | undefined>;
  readLock: () => Promise<DaemonLock | undefined>;
  removeLock: () => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  requestShutdown: (lock: DaemonLock) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** SIGTERM is a hard kill on Windows, so there the daemon is asked over loopback (token from `daemon.lock`) to run its own shutdown. */
async function requestShutdown(lock: DaemonLock): Promise<void> {
  if (lock.shutdownToken) {
    try {
      await fetch(`http://127.0.0.1:${lock.port}${SHUTDOWN_PATH}`, {
        method: "POST",
        headers: { [SHUTDOWN_TOKEN_HEADER]: lock.shutdownToken },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // not reachable: the bounded wait below falls back to a hard kill
    }
  }
}

const defaultDeps: StopDeps = {
  platform: process.platform,
  timeoutMs: STOP_TIMEOUT_MS,
  findRunningDaemon,
  readLock,
  removeLock,
  isProcessAlive,
  kill: (pid, signal) => process.kill(pid, signal),
  requestShutdown,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runStop(deps: StopDeps = defaultDeps): Promise<void> {
  const lock = await deps.findRunningDaemon();
  if (!lock) {
    // A lock file may still exist for a pid that's already dead.
    await deps.removeLock();
    deps.log("no daemon running");
    return;
  }

  if (deps.platform === "win32") {
    await deps.requestShutdown(lock);
  } else {
    try {
      deps.kill(lock.pid, "SIGTERM");
    } catch {
      // process exited between findRunningDaemon() and here
    }
  }

  // The daemon's own stop handler removes the lock file once it has shut
  // down cleanly; success is reported only once the process itself is gone too.
  const stopped = await waitFor(deps.timeoutMs, async () =>
    (await deps.readLock()) === undefined && !deps.isProcessAlive(lock.pid) ? true : undefined,
  );
  if (stopped) {
    deps.log("artisign stopped");
    return;
  }

  if (deps.platform === "win32") {
    try {
      deps.kill(lock.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await deps.removeLock();
    deps.log(`artisign did not stop within ${deps.timeoutMs / 1000}s: killed the daemon (pid ${lock.pid}) and removed the lock`);
    return;
  }
  deps.error(`Timed out waiting for the daemon (pid ${lock.pid}) to stop`);
  process.exitCode = 1;
}
