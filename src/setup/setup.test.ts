import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClientEnv, CLIENTS, type ClientEnv } from "./clients.js";
import { connectClients } from "./connect.js";
import { runSetup, type SetupDeps } from "../cli/setup.js";

let root: string;
let home: string;
let bin: string;
let claudeLog: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artisign-setup-"));
  home = join(root, "home");
  bin = join(root, "bin");
  claudeLog = join(root, "claude.log");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
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
    execPath: "/opt/node/bin/node",
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
    restartDaemon: vi.fn(async () => false),
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
          command: "/opt/node/bin/npx",
          args: ["-y", "artisign@9.9.9", "mcp"],
          env: { PATH: "/opt/node/bin:/usr/local/bin:/usr/bin:/bin" },
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
    expect(err.join("\n")).toContain("not valid JSON");
  });
});

describe("setup: upgrade and remove", () => {
  it("a newer version replaces the pinned entry and restarts the daemon", async () => {
    await installDesktop();
    const old = deps({ version: "1.0.0" });
    await runSetup({ cliEntry: "e", yes: true }, old.d);
    const next = deps({ version: "2.0.0", restartDaemon: vi.fn(async () => true) });
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

  it("detects the Linux Desktop directory that exists, in either capitalisation", async () => {
    await mkdir(join(home, ".config", "claude"), { recursive: true });
    const { d } = deps({ env: { ...env(), platform: "linux" } });
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect(
      JSON.parse(
        await readFile(join(home, ".config", "claude", "claude_desktop_config.json"), "utf8"),
      ),
    ).toHaveProperty("mcpServers.artisign");
  });
});
