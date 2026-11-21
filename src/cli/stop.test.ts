import { describe, it, expect, vi, afterEach } from "vitest";
import { runStop, type StopDeps } from "./stop.js";

const lock = { pid: 4242, port: 4799, shutdownToken: "t" };

/** A daemon that ignores the stop request: its lock stays and its pid stays alive until `kill(SIGKILL)`. */
function stuckDaemon(platform: NodeJS.Platform): { deps: StopDeps; state: { lock: boolean; alive: boolean }; logs: string[]; errors: string[] } {
  const state = { lock: true, alive: true };
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: StopDeps = {
    platform,
    timeoutMs: 150,
    findRunningDaemon: async () => (state.alive ? lock : undefined),
    readLock: async () => (state.lock ? lock : undefined),
    removeLock: async () => {
      state.lock = false;
    },
    isProcessAlive: () => state.alive,
    kill: vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") state.alive = false;
    }),
    requestShutdown: vi.fn(async () => {}),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  };
  return { deps, state, logs, errors };
}

describe("runStop", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("windows: asks the daemon to stop, then hard-kills after the timeout, removes the lock and says so", async () => {
    const { deps, state, logs } = stuckDaemon("win32");
    await runStop(deps);
    expect(deps.requestShutdown).toHaveBeenCalledWith(lock);
    expect(deps.kill).toHaveBeenCalledTimes(1);
    expect(deps.kill).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(state.lock).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/did not stop within .*killed the daemon \(pid 4242\) and removed the lock/);
    expect(logs).not.toContain("artisign stopped");
    expect(process.exitCode).toBeUndefined();
  });

  it("windows: reports success without a kill when the daemon exits on its own", async () => {
    const { deps, state, logs } = stuckDaemon("win32");
    deps.requestShutdown = vi.fn(async () => {
      state.lock = false;
      state.alive = false;
    });
    await runStop(deps);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(logs).toEqual(["artisign stopped"]);
  });

  it("windows: does not report success while the lock is gone but the process still runs", async () => {
    const { deps, state, logs } = stuckDaemon("win32");
    deps.requestShutdown = vi.fn(async () => {
      state.lock = false;
    });
    await runStop(deps);
    expect(deps.kill).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(logs).not.toContain("artisign stopped");
  });

  it("posix: sends SIGTERM and, on timeout, keeps the old error without a hard kill", async () => {
    const { deps, state, errors } = stuckDaemon("linux");
    await runStop(deps);
    expect(deps.requestShutdown).not.toHaveBeenCalled();
    expect(deps.kill).toHaveBeenCalledTimes(1);
    expect(deps.kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(state.lock).toBe(true);
    expect(errors).toEqual(["Timed out waiting for the daemon (pid 4242) to stop"]);
    expect(process.exitCode).toBe(1);
  });
});
