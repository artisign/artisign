import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dispatch, USAGE, COMMAND_HELP, type CliDeps } from "./dispatch.js";

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

  it("an unknown option is one error line plus the help hint, exit 1, and starts nothing", async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(["--prot", "4799"], ENTRY, deps)).toBe(1);
    expect(err).toEqual(["Unknown option: --prot", "Run `artisign help` for usage."]);
    expect(deps.runStart).not.toHaveBeenCalled();
  });

  it("rejects a short option it does not know instead of starting a daemon", async () => {
    for (const argv of [["-x"], ["-p", "4800"]]) {
      const { deps, err } = fakeDeps();
      expect(await dispatch(argv, ENTRY, deps)).toBe(1);
      expect(err[0]).toBe(`Unknown option: ${argv[0]}`);
      expect(deps.runStart).not.toHaveBeenCalled();
    }
  });

  it("start -p is rejected the same way", async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(["start", "-p", "4800"], ENTRY, deps)).toBe(1);
    expect(err).toEqual(["Unknown option: -p", "Run `artisign help` for usage."]);
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
    expect(err).toHaveLength(2);
    expect(err[1]).toBe("Run `artisign help` for usage.");
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
    expect(await dispatch(["serve", "--no-open"], ENTRY, deps)).toBe(1);
    expect(deps.runServe).not.toHaveBeenCalled();
  });

  it("init, mcp, status and stop are routed to their own commands", async () => {
    const { deps } = fakeDeps();
    await dispatch(["init", "p"], ENTRY, deps);
    await dispatch(["mcp"], ENTRY, deps);
    await dispatch(["status"], ENTRY, deps);
    await dispatch(["stop"], ENTRY, deps);
    expect(deps.initProject).toHaveBeenCalledWith("p");
    expect(deps.runMcp).toHaveBeenCalledWith(ENTRY);
    expect(deps.runStatus).toHaveBeenCalled();
    expect(deps.runStop).toHaveBeenCalled();
    expect(deps.runStart).not.toHaveBeenCalled();
  });
});

describe("dispatch: help and version", () => {
  it("help, --help and -h print the top-level help and exit 0", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const { deps, out } = fakeDeps();
      expect(await dispatch(argv, ENTRY, deps)).toBe(0);
      expect(out).toEqual([USAGE]);
    }
  });

  it("the top-level help opens with the three steps, before the command list", () => {
    const install = USAGE.indexOf("npm install -g artisign");
    const run = USAGE.indexOf("Run `artisign`");
    const ask = USAGE.indexOf("Ask your AI tool to create or open a project");
    const update = USAGE.indexOf("Update: `artisign update`");
    const commands = USAGE.indexOf("Commands:");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(run);
    expect(run).toBeLessThan(ask);
    expect(ask).toBeLessThan(update);
    expect(update).toBeLessThan(commands);
  });

  it("<command> --help and help <command> print that command's usage, options and an example", async () => {
    for (const command of ["start", "serve", "init", "mcp", "status", "stop"]) {
      for (const argv of [[command, "--help"], [command, "-h"], ["help", command]]) {
        const { deps, out } = fakeDeps();
        expect(await dispatch(argv, ENTRY, deps)).toBe(0);
        expect(out).toEqual([COMMAND_HELP[command]]);
        expect(out[0]).toContain(`Usage: artisign ${command}`);
        expect(out[0]).toContain("Example:");
      }
    }
  });

  it("a command's help does not run the command", async () => {
    const { deps } = fakeDeps();
    await dispatch(["serve", "--port", "4802", "--help"], ENTRY, deps);
    await dispatch(["stop", "--help"], ENTRY, deps);
    expect(deps.runServe).not.toHaveBeenCalled();
    expect(deps.runStop).not.toHaveBeenCalled();
  });

  it("help for an unknown command is the one-line error, exit 1", async () => {
    const { deps, out, err } = fakeDeps();
    expect(await dispatch(["help", "bogus"], ENTRY, deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["Unknown command: bogus", "Run `artisign help` for usage."]);
  });

  it("--help after an unknown command is the same one-line error, exit 1", async () => {
    const { deps, out, err } = fakeDeps();
    expect(await dispatch(["bogus", "--help"], ENTRY, deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["Unknown command: bogus", "Run `artisign help` for usage."]);
  });

  it("--version and -v print the version from package.json and exit 0", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) {
      const { deps, out } = fakeDeps();
      expect(await dispatch([flag], ENTRY, deps)).toBe(0);
      expect(out).toEqual([pkg.version]);
      expect(deps.runStart).not.toHaveBeenCalled();
    }
  });
});

describe("dispatch: mcp", () => {
  it("mcp <dir> fails with the per-call explanation and a pointer to setup, and runs nothing", async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(["mcp", "./proj"], ENTRY, deps)).toBe(1);
    expect(err.join("\n")).toContain("named per tool call");
    expect(err.join("\n")).toContain("artisign setup");
    expect(deps.runMcp).not.toHaveBeenCalled();
  });
});
