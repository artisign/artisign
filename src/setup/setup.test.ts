import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClientEnv, CLIENTS, claudeDesktop, type ClientEnv } from "./clients.js";
import { connectClients } from "./connect.js";
import { runSetup, restartStaleDaemon, restartDaemon, type SetupDeps } from "../cli/setup.js";

let root: string;
let home: string;
let bin: string;
let claudeLog: string;
let nodeDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artisign-setup-"));
  home = join(root, "home");
  bin = join(root, "bin");
  claudeLog = join(root, "claude.log");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  nodeDir = join(root, "nodebin");
  await mkdir(nodeDir, { recursive: true });
  await writeFile(join(nodeDir, "npx"), "#!/bin/sh\n");
  await chmod(join(nodeDir, "npx"), 0o755);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const desktopDir = (): string => join(home, "Library", "Application Support", "Claude");
const desktopFile = (): string => join(desktopDir(), "claude_desktop_config.json");

async function installFakeClaude(): Promise<void> {
  const path = join(bin, "claude");
  await writeFile(path, `#!/bin/sh\necho "$@" >> '${claudeLog}'\n`);
  await chmod(path, 0o755);
}

async function installDesktop(config: object = {}): Promise<void> {
  await mkdir(desktopDir(), { recursive: true });
  await writeFile(desktopFile(), JSON.stringify(config));
}

function env(): ClientEnv {
  return {
    ...defaultClientEnv(),
    home,
    platform: "darwin",
    pathEnv: bin,
    execPath: join(nodeDir, "node"),
  };
}

function deps(over: Partial<SetupDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: SetupDeps = {
    env: env(),
    clients: CLIENTS,
    version: "9.9.9",
    isTTY: true,
    ask: vi.fn(async () => ""),
    restartDaemon: vi.fn(async () => "unchanged" as const),
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...over,
  };
  return { d, out, err };
}

const readDesktop = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(desktopFile(), "utf8")) as Record<string, unknown>;
const claudeCalls = async (): Promise<string[]> =>
  (await readFile(claudeLog, "utf8").catch(() => "")).split("\n").filter(Boolean);

describe("setup: fresh install", () => {
  it("asks per client, drives the claude CLI at user scope and writes the Desktop entry with absolute paths", async () => {
    await installFakeClaude();
    await installDesktop({ globalShortcut: "Cmd+L", mcpServers: { other: { command: "x" } } });
    const { d, out } = deps();
    expect(await runSetup({ cliEntry: "e" }, d)).toBe(0);
    expect(d.ask).toHaveBeenCalledTimes(2);
    expect(await claudeCalls()).toEqual([
      "mcp remove artisign --scope user",
      "mcp add --scope user --transport stdio artisign -- npx -y artisign@9.9.9 mcp",
    ]);
    expect(await readDesktop()).toEqual({
      globalShortcut: "Cmd+L",
      mcpServers: {
        other: { command: "x" },
        artisign: {
          command: join(nodeDir, "npx"),
          args: ["-y", "artisign@9.9.9", "mcp"],
          env: { PATH: `${nodeDir}:/usr/local/bin:/usr/bin:/bin` },
        },
      },
    });
    expect(out.join("\n")).toMatch(/Next: open your AI tool[\s\S]*Run `artisign`/);
  });

  it("a declined client is left alone", async () => {
    await installDesktop();
    const { d } = deps({ ask: vi.fn(async () => "n") });
    await runSetup({ cliEntry: "e" }, d);
    expect(await readDesktop()).toEqual({});
  });

  it("creates the Desktop file when only the directory exists", async () => {
    await mkdir(desktopDir(), { recursive: true });
    const { d } = deps();
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect(Object.keys((await readDesktop()).mcpServers as object)).toEqual(["artisign"]);
  });
});

describe("setup: the npx Claude Desktop runs", () => {
  const entryOf = async (): Promise<{ command: string; env: { PATH: string } }> =>
    ((await readDesktop()).mcpServers as Record<string, { command: string; env: { PATH: string } }>)
      .artisign as never;

  it("is the unresolved npx found on PATH, with its directory first in PATH", async () => {
    await installDesktop();
    await writeFile(join(bin, "npx"), "#!/bin/sh\n");
    await chmod(join(bin, "npx"), 0o755);
    const { d } = deps();
    await runSetup({ cliEntry: "e", yes: true }, d);
    const entry = await entryOf();
    expect(entry.command).toBe(join(bin, "npx"));
    expect(entry.env.PATH.startsWith(`${bin}:`)).toBe(true);
  });

  it("falls back to the directory of the running node when npx is not on PATH", async () => {
    await installDesktop();
    const { d } = deps();
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect((await entryOf()).command).toBe(join(nodeDir, "npx"));
  });
});

describe("setup: restarting a stale daemon", () => {
  const make = (info: { version?: string; port?: number; projects: string[] } | undefined, stuck = false) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        daemon: async () => (info ? { port: 1, ...info } : undefined),
        stop: async () => void calls.push("stop"),
        stillRunning: async () => stuck,
        start: async (o: { port: number; projects: string[]; noOpen: boolean }) =>
          void calls.push(`start :${o.port} ${o.projects.join(",")} noOpen=${o.noOpen}`),
      },
    };
  };

  it("stops an older daemon and starts it again on its port with the projects it had open", async () => {
    const { calls, deps: d } = make({ version: "1.0.0", port: 4800, projects: ["/a", "/b"] });
    expect(await restartStaleDaemon("e", "2.0.0", d)).toBe("restarted");
    expect(calls).toEqual(["stop", "start :4800 /a,/b noOpen=true"]);
  });

  it("restarts a daemon that reports no version (it predates the field)", async () => {
    const { calls, deps: d } = make({ projects: [] });
    expect(await restartStaleDaemon("e", "2.0.0", d)).toBe("restarted");
    expect(calls[0]).toBe("stop");
  });

  it("leaves a current, a newer and a missing daemon alone (no downgrade)", async () => {
    for (const info of [{ version: "2.0.0", projects: ["/a"] }, { version: "2.1.0", projects: [] }, { version: "10.0.0", projects: [] }, undefined]) {
      const { calls, deps: d } = make(info);
      expect(await restartStaleDaemon("e", "2.0.0", d)).toBe("unchanged");
      expect(calls).toEqual([]);
    }
  });

  it("restartDaemon restarts a daemon that claims to be current, on its port with its projects", async () => {
    const { calls, deps: d } = make({ version: "2.0.0", port: 4801, projects: ["/a"] });
    expect(await restartDaemon("e", d)).toBe("restarted");
    expect(calls).toEqual(["stop", "start :4801 /a noOpen=true"]);
  });

  it("restartDaemon leaves a daemon that is not running stopped", async () => {
    const { calls, deps: d } = make(undefined);
    expect(await restartDaemon("e", d)).toBe("unchanged");
    expect(calls).toEqual([]);
  });

  it("reports failure, and does not start a second daemon, when the old one would not stop", async () => {
    const { calls, deps: d } = make({ version: "1.0.0", projects: [] }, true);
    expect(await restartStaleDaemon("e", "2.0.0", d)).toBe("failed");
    expect(calls).toEqual(["stop"]);
  });

  it("runSetup says so and exits 1 when the restart failed", async () => {
    await installDesktop();
    const { d, out, err } = deps({ restartDaemon: vi.fn(async () => "failed" as const) });
    expect(await runSetup({ cliEntry: "e", yes: true }, d)).toBe(1);
    expect(err.join("\n")).toContain("could not be stopped");
    expect(out.join("\n")).not.toContain("Restarted");
  });
});

describe("setup: config files that must not be clobbered", () => {
  it("an unreadable ~/.claude.json is not replaced by a fresh one", async () => {
    const file = join(home, ".claude.json");
    await writeFile(file, JSON.stringify({ precious: true }));
    await chmod(file, 0o000);
    try {
      const { d, err } = deps();
      expect(await runSetup({ cliEntry: "e", yes: true }, d)).toBe(1);
      expect(err.join("\n")).toContain("nothing was changed");
    } finally {
      await chmod(file, 0o600);
    }
    expect(await readFile(file, "utf8")).toBe(JSON.stringify({ precious: true }));
  });

  it("a symlinked config stays a symlink and the real file is updated", async () => {
    const real = join(root, "dotfiles", "claude_desktop_config.json");
    await mkdir(join(root, "dotfiles"), { recursive: true });
    await writeFile(real, JSON.stringify({ keep: 1 }));
    await mkdir(desktopDir(), { recursive: true });
    await symlink(real, desktopFile());
    const { d } = deps();
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect((await lstat(desktopFile())).isSymbolicLink()).toBe(true);
    const written = JSON.parse(await readFile(real, "utf8")) as Record<string, unknown>;
    expect(written.keep).toBe(1);
    expect(written.mcpServers).toHaveProperty("artisign");
  });

  it("--remove fails loudly when `claude mcp remove` fails", async () => {
    const path = join(bin, "claude");
    await writeFile(path, "#!/bin/sh\nexit 1\n");
    await chmod(path, 0o755);
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { artisign: {} } }));
    const { d, err } = deps();
    expect(await runSetup({ cliEntry: "e", remove: true }, d)).toBe(1);
    expect(err.join("\n")).toContain("claude mcp remove");
  });

  it("refuses to write a Desktop entry when no npx can be found", async () => {
    await installDesktop({ keep: 1 });
    const { d, err } = deps({ env: { ...env(), execPath: join(root, "nowhere", "node") } });
    expect(await runSetup({ cliEntry: "e", yes: true }, d)).toBe(1);
    expect(err.join("\n")).toContain("npx was not found");
    expect(await readDesktop()).toEqual({ keep: 1 });
  });

  it("on Linux, ~/.config/claude counts as Claude Desktop only with a config file inside", async () => {
    await mkdir(join(home, ".config", "claude"), { recursive: true });
    // A case-insensitive filesystem (macOS) cannot tell the two directories apart; there the case is moot.
    if (await stat(join(home, ".config", "Claude")).then(() => true, () => false)) return;
    const linux = { ...env(), platform: "linux" as const };
    expect((await claudeDesktop.detect(linux)).found).toBe(false);
    await writeFile(join(home, ".config", "claude", "claude_desktop_config.json"), "{}");
    expect((await claudeDesktop.detect(linux)).found).toBe(true);
  });
});

describe("setup: Claude Code without the CLI", () => {
  it("edits ~/.claude.json atomically, keeping every other key and the file mode", async () => {
    const file = join(home, ".claude.json");
    await writeFile(
      file,
      JSON.stringify({ numStartups: 3, mcpServers: { keep: { command: "k" } } }),
      { mode: 0o600 },
    );
    const { d } = deps();
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      numStartups: 3,
      mcpServers: {
        keep: { command: "k" },
        artisign: { type: "stdio", command: "npx", args: ["-y", "artisign@9.9.9", "mcp"], env: {} },
      },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite a file that is not valid JSON", async () => {
    const file = join(home, ".claude.json");
    await writeFile(file, "{ nope");
    const { d, err } = deps();
    expect(await runSetup({ cliEntry: "e", yes: true }, d)).toBe(1);
    expect(await readFile(file, "utf8")).toBe("{ nope");
    expect(err.join("\n")).toContain("comments or trailing commas");
  });
});

describe("setup: upgrade and remove", () => {
  it("a newer version replaces the pinned entry and restarts the daemon", async () => {
    await installDesktop();
    const old = deps({ version: "1.0.0" });
    await runSetup({ cliEntry: "e", yes: true }, old.d);
    const next = deps({ version: "2.0.0", restartDaemon: vi.fn(async () => "restarted" as const) });
    await runSetup({ cliEntry: "e", yes: true }, next.d);
    const servers = (await readDesktop()).mcpServers as Record<string, { args: string[] }>;
    expect(servers.artisign?.args).toEqual(["-y", "artisign@2.0.0", "mcp"]);
    expect(next.d.restartDaemon).toHaveBeenCalledWith("e", "2.0.0");
    expect(next.out.join("\n")).toContain("Restarted");
  });

  it("onlyExisting re-pins just the clients that already have an entry", async () => {
    await installFakeClaude();
    await installDesktop({ mcpServers: { artisign: { command: "old" } } });
    const results = await connectClients({ version: "3.0.0", onlyExisting: true, env: env() });
    expect(results).toEqual([
      { name: "Claude Code", status: "skipped" },
      { name: "Claude Desktop", status: "done" },
    ]);
    expect(await claudeCalls()).toEqual([]);
  });

  it("--remove removes exactly the artisign entries", async () => {
    await installFakeClaude();
    await installDesktop({
      theme: "dark",
      mcpServers: { other: { command: "x" }, artisign: { command: "a" } },
    });
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { artisign: {} } }));
    const { d } = deps();
    expect(await runSetup({ cliEntry: "e", remove: true }, d)).toBe(0);
    expect(await readDesktop()).toEqual({ theme: "dark", mcpServers: { other: { command: "x" } } });
    expect(await claudeCalls()).toEqual(["mcp remove artisign --scope user"]);
  });
});

describe("setup: nothing to do", () => {
  it("names the supported clients and the manual entry when none is found", async () => {
    const { d, out } = deps();
    expect(await runSetup({ cliEntry: "e" }, d)).toBe(0);
    expect(out.join("\n")).toMatch(
      /Claude Code and Claude Desktop[\s\S]*npx[\s\S]*artisign@9\.9\.9 mcp/,
    );
  });

  it("without a TTY it prompts for nothing, changes nothing and says where to run it", async () => {
    await installDesktop();
    const { d, out, err } = deps({ isTTY: false });
    expect(await runSetup({ cliEntry: "e" }, d)).toBe(1);
    expect(d.ask).not.toHaveBeenCalled();
    expect(await readDesktop()).toEqual({});
    expect(out.join("\n")).toContain("Claude Desktop");
    expect(err.join("\n")).toContain("terminal");
  });

  it("--yes works without a TTY", async () => {
    await installDesktop();
    const { d } = deps({ isTTY: false });
    expect(await runSetup({ cliEntry: "e", yes: true }, d)).toBe(0);
    expect(d.ask).not.toHaveBeenCalled();
  });

  it("on Linux, a lowercase ~/.config/claude with a config file is detected and written", async () => {
    const file = join(home, ".config", "claude", "claude_desktop_config.json");
    await mkdir(join(home, ".config", "claude"), { recursive: true });
    await writeFile(file, "{}");
    const { d } = deps({ env: { ...env(), platform: "linux" } });
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty("mcpServers.artisign");
  });

  it("on Linux, a lowercase ~/.config/claude without a config file is not Claude Desktop", async () => {
    await mkdir(join(home, ".config", "claude"), { recursive: true });
    // A case-insensitive filesystem (macOS) cannot tell the two directories apart; there the case is moot.
    if (await stat(join(home, ".config", "Claude")).then(() => true, () => false)) return;
    const { d, out } = deps({ env: { ...env(), platform: "linux" } });
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect(out.join("\n")).toContain("No supported AI tool found");
    await expect(stat(join(home, ".config", "claude", "claude_desktop_config.json"))).rejects.toThrow();
  });
});
