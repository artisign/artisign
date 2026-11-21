import { findRunningDaemon, isProcessAlive, readLock, removeLock, type DaemonLock } from "../daemon/lock.js";
import { SHUTDOWN_PATH, SHUTDOWN_TOKEN_HEADER } from "../daemon/shutdown.js";
import { waitFor } from "./wait-for.js";

const STOP_TIMEOUT_MS = 10_000;

/** SIGTERM is a hard kill on Windows, so there the daemon is asked over loopback (token from `daemon.lock`) to run its own shutdown. */
async function requestStop(lock: DaemonLock): Promise<void> {
  if (process.platform === "win32" && lock.shutdownToken) {
    try {
      await fetch(`http://127.0.0.1:${lock.port}${SHUTDOWN_PATH}`, {
        method: "POST",
        headers: { [SHUTDOWN_TOKEN_HEADER]: lock.shutdownToken },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // not reachable: the bounded wait below falls back to a hard kill
    }
    return;
  }
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch {
    // process exited between findRunningDaemon() and here
  }
}

export async function runStop(): Promise<void> {
  const lock = await findRunningDaemon();
  if (!lock) {
    // A lock file may still exist for a pid that's already dead.
    await removeLock();
    console.log("no daemon running");
    return;
  }

  await requestStop(lock);

  // The daemon's own stop handler removes the lock file once it has shut
  // down cleanly; success is reported only once the process itself is gone too.
  const stopped = await waitFor(STOP_TIMEOUT_MS, async () =>
    (await readLock()) === undefined && !isProcessAlive(lock.pid) ? true : undefined,
  );
  if (stopped) {
    console.log("artisign stopped");
    return;
  }

  if (process.platform === "win32") {
    try {
      process.kill(lock.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await removeLock();
    console.log(`artisign did not stop within ${STOP_TIMEOUT_MS / 1000}s: killed the daemon (pid ${lock.pid}) and removed the lock`);
    return;
  }
  console.error(`Timed out waiting for the daemon (pid ${lock.pid}) to stop`);
  process.exitCode = 1;
}
