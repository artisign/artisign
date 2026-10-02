import { describe, it, expect, vi } from "vitest";
import { dispatch, USAGE, type CliDeps } from "./dispatch.js";

function fakeDeps() {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    initProject: vi.fn(async () => undefined),
    runServe: vi.fn(async () => {}),
    runMcp: vi.fn(async () => {}),
    runDaemonForeground: vi.fn(async () => {}),
    runStart: vi.fn(async () => {}),
    runStop: vi.fn(async () => {}),
    runStatus: vi.fn(async () => {}),
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { deps, out, err };
}

const ENTRY = "/fake/dist/cli/index.js";

describe("dispatch: bare artisign", () => {
  it("with no command behaves like start", async () => {
    const { deps } = fakeDeps();
    expect(await dispatch([], ENTRY, deps)).toBe(0);
    expect(deps.runStart).toHaveBeenCalledWith({ port: undefined, projects: [], cliEntry: ENTRY, noOpen: false });
  });

  it("with an option first behaves like start with the same arguments", async () => {
    const { deps } = fakeDeps();
    expect(await dispatch(["--port", "4800", "./proj"], ENTRY, deps)).toBe(0);
    expect(deps.runStart).toHaveBeenCalledWith({ port: 4800, projects: ["./proj"], cliEntry: ENTRY, noOpen: false });
  });

  it("parses the arguments exactly like start does", async () => {
    const a = fakeDeps();
    const b = fakeDeps();
    await dispatch(["--port", "4801", "--no-open", "one", "two"], ENTRY, a.deps);
    await dispatch(["start", "--port", "4801", "--no-open", "one", "two"], ENTRY, b.deps);
    expect(vi.mocked(a.deps.runStart).mock.calls).toEqual(vi.mocked(b.deps.runStart).mock.calls);
  });

  it("passes --no-open through, bare and with start", async () => {
    const a = fakeDeps();
    await dispatch(["--no-open"], ENTRY, a.deps);
    expect(a.deps.runStart).toHaveBeenCalledWith(expect.objectContaining({ noOpen: true }));
    const b = fakeDeps();
    await dispatch(["start", "--no-open", "proj"], ENTRY, b.deps);
    expect(b.deps.runStart).toHaveBeenCalledWith(expect.objectContaining({ noOpen: true, projects: ["proj"] }));
  });

  it("still rejects an unknown option, as start does", async () => {
    const { deps } = fakeDeps();
    await expect(dispatch(["--prot", "4799"], ENTRY, deps)).rejects.toThrow("Unknown option: --prot");
    expect(deps.runStart).not.toHaveBeenCalled();
  });

  it("rejects a short option it does not know instead of starting a daemon", async () => {
    for (const argv of [["-v"], ["-p", "4800"]]) {
      const { deps } = fakeDeps();
      await expect(dispatch(argv, ENTRY, deps)).rejects.toThrow(`Unknown option: ${argv[0]}`);
      expect(deps.runStart).not.toHaveBeenCalled();
    }
  });

  it("start -p is rejected the same way", async () => {
    const { deps } = fakeDeps();
    await expect(dispatch(["start", "-p", "4800"], ENTRY, deps)).rejects.toThrow("Unknown option: -p");
    expect(deps.runStart).not.toHaveBeenCalled();
  });

  it("-h and --help print usage and start nothing", async () => {
    for (const flag of ["-h", "--help"]) {
      const { deps, out } = fakeDeps();
      expect(await dispatch([flag], ENTRY, deps)).toBe(0);
      expect(out).toEqual([USAGE]);
      expect(deps.runStart).not.toHaveBeenCalled();
    }
  });
});

describe("dispatch: unknown commands", () => {
  it("a bare path as the first argument is an unknown command: usage and a non-zero code", async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(["./my-project"], ENTRY, deps)).toBe(1);
    expect(err[0]).toBe("Unknown command: ./my-project");
    expect(err[1]).toBe(USAGE);
    expect(deps.runStart).not.toHaveBeenCalled();
  });

  it("a misspelt command is rejected too", async () => {
    const { deps } = fakeDeps();
    expect(await dispatch(["strat"], ENTRY, deps)).toBe(1);
  });
});

describe("dispatch: the other commands never start the browser path", () => {
  it("serve runs the foreground daemon and not start", async () => {
    const { deps } = fakeDeps();
    await dispatch(["serve", "--port", "4802", "proj"], ENTRY, deps);
    expect(deps.runServe).toHaveBeenCalledWith({ port: 4802, projects: ["proj"] });
    expect(deps.runStart).not.toHaveBeenCalled();
  });

  it("serve does not take --no-open (it never opens a browser, so there is nothing to switch off)", async () => {
    const { deps } = fakeDeps();
    await expect(dispatch(["serve", "--no-open"], ENTRY, deps)).rejects.toThrow("Unknown option: --no-open");
  });

  it("init, mcp, status and stop are routed to their own commands", async () => {
    const { deps } = fakeDeps();
    await dispatch(["init", "p"], ENTRY, deps);
    await dispatch(["mcp", "p"], ENTRY, deps);
    await dispatch(["status"], ENTRY, deps);
    await dispatch(["stop"], ENTRY, deps);
    expect(deps.initProject).toHaveBeenCalledWith("p");
    expect(deps.runMcp).toHaveBeenCalledWith("p");
    expect(deps.runStatus).toHaveBeenCalled();
    expect(deps.runStop).toHaveBeenCalled();
    expect(deps.runStart).not.toHaveBeenCalled();
  });
});
