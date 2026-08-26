import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../store/atomic-write.js";
import { artisignHome } from "./global-config.js";

export type DaemonLock = {
  pid: number;
  port: number;
};

// Daemon-level state, outside any project — see the note in global-config.ts
// for why this bypasses the Store interface.
function lockPath(): string {
  return join(artisignHome(), "daemon.lock");
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 does not kill the process; it only checks whether it exists
    // and whether we have permission to signal it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readLock(): Promise<DaemonLock | undefined> {
  try {
    const raw = await readFile(lockPath(), "utf-8");
    return JSON.parse(raw) as DaemonLock;
  } catch {
    return undefined;
  }
}

/**
 * Returns the existing lock if a daemon is already running, or undefined if
 * it is safe to start.
 */
export async function findRunningDaemon(): Promise<DaemonLock | undefined> {
  const lock = await readLock();
  if (lock && isProcessAlive(lock.pid)) {
    return lock;
  }
  return undefined;
}

export async function writeLock(lock: DaemonLock): Promise<void> {
  await atomicWrite(lockPath(), `${JSON.stringify(lock, null, 2)}\n`);
}

export async function removeLock(): Promise<void> {
  await rm(lockPath(), { force: true });
}
