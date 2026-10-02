import { describe, it, expect, vi, afterEach } from "vitest";
import { runStart, shouldOpenBrowser, type StartDeps } from "./start.js";

const LOCK = { pid: 123, port: 4795 };

function deps(over: Partial<StartDeps> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const d: StartDeps = {
    findRunningDaemon: vi.fn(async () => undefined),
    spawnDaemon: vi.fn(),
    pollForHealthyDaemon: vi.fn(async () => LOCK),
    openBrowser: vi.fn(),
    env: {},
    isTTY: true,
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
    ...over,
  };
  return { d, logs, errors };
}

const START = { projects: [], cliEntry: "/x/index.js" };

afterEach(() => {
  process.exitCode = undefined;
});

describe("runStart: opening the browser", () => {
  it("opens the preview once the daemon is healthy", async () => {
    const { d, logs } = deps();
    await runStart(START, d);
    expect(logs).toEqual(["artisign running on http://127.0.0.1:4795"]);
    expect(d.openBrowser).toHaveBeenCalledTimes(1);
    expect(d.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:4795/");
  });

  it("opens it when the daemon was already running (reuse)", async () => {
    const { d, logs } = deps({ findRunningDaemon: vi.fn(async () => ({ pid: 9, port: 4711 })) });
    await runStart(START, d);
    expect(logs).toEqual(["artisign already running on http://127.0.0.1:4711"]);
    expect(d.spawnDaemon).not.toHaveBeenCalled();
    expect(d.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:4711/");
  });

  it("passes the port and the projects to the daemon it spawns", async () => {
    const { d } = deps();
    await runStart({ port: 4800, projects: ["a", "b"], cliEntry: "/x/index.js" }, d);
    expect(d.spawnDaemon).toHaveBeenCalledWith("/x/index.js", ["__daemon", "--port", "4800", "a", "b"]);
  });

  it("does not open when the daemon never came up", async () => {
    const { d, errors } = deps({ pollForHealthyDaemon: vi.fn(async () => undefined) });
    await runStart(START, d);
    expect(errors).toEqual(["Timed out waiting for the daemon to start"]);
    expect(process.exitCode).toBe(1);
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("--no-open suppresses it, also on reuse", async () => {
    const fresh = deps();
    await runStart({ ...START, noOpen: true }, fresh.d);
    expect(fresh.d.openBrowser).not.toHaveBeenCalled();
    const reuse = deps({ findRunningDaemon: vi.fn(async () => LOCK) });
    await runStart({ ...START, noOpen: true }, reuse.d);
    expect(reuse.d.openBrowser).not.toHaveBeenCalled();
  });

  it("ARTISIGN_NO_OPEN=1 suppresses it", async () => {
    const { d } = deps({ env: { ARTISIGN_NO_OPEN: "1" } });
    await runStart(START, d);
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("CI suppresses it", async () => {
    const { d } = deps({ env: { CI: "true" } });
    await runStart(START, d);
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("a non-TTY stdout suppresses it", async () => {
    const { d } = deps({ isTTY: false });
    await runStart(START, d);
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("an opener that throws leaves the printed URL and a clean exit", async () => {
    const { d, logs } = deps({
      openBrowser: vi.fn(() => {
        throw new Error("spawn xdg-open ENOENT");
      }),
    });
    await expect(runStart(START, d)).resolves.toBeUndefined();
    expect(logs).toEqual(["artisign running on http://127.0.0.1:4795"]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("shouldOpenBrowser", () => {
  const base = { env: {}, isTTY: true };
  it("is on for an interactive terminal", () => expect(shouldOpenBrowser(base)).toBe(true));
  it("treats ARTISIGN_NO_OPEN=0, false and empty as not set", () => {
    for (const v of ["0", "false", "FALSE", ""]) expect(shouldOpenBrowser({ ...base, env: { ARTISIGN_NO_OPEN: v } })).toBe(true);
  });
  it("treats CI=0, false and empty as not set", () => {
    for (const v of ["0", "false", ""]) expect(shouldOpenBrowser({ ...base, env: { CI: v } })).toBe(true);
  });
});
