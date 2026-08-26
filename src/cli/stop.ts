import { findRunningDaemon, readLock, removeLock } from "../daemon/lock.js";
import { waitFor } from "./wait-for.js";

export async function runStop(): Promise<void> {
  const lock = await findRunningDaemon();
  if (!lock) {
    // A lock file may still exist for a pid that's already dead.
    await removeLock();
    console.log("no daemon running");
    return;
  }

  try {
    process.kill(lock.pid, "SIGTERM");
  } catch {
    // process exited between findRunningDaemon() and here
  }

  // The daemon's own stop handler removes the lock file once it has shut
  // down cleanly, so an absent lock is the confirmation the caller needs.
  const stopped = await waitFor(10_000, async () => ((await readLock()) === undefined ? true : undefined));
  if (!stopped) {
    console.error(`Timed out waiting for the daemon (pid ${lock.pid}) to stop`);
    process.exitCode = 1;
    return;
  }

  console.log("artisign stopped");
}
