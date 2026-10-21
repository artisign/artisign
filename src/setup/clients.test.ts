import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultClientEnv, cursor, codex, vscode, opencode, type Client, type ClientEnv } from "./clients.js";
import { connectClients, disconnectClients } from "./connect.js";

let root: string;
let home: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artisign-clients-"));
  home = join(root, "home");
  bin = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npx"), "#!/bin/sh\n");
  await chmod(join(bin, "npx"), 0o755);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = (platform: NodeJS.Platform = "darwin"): ClientEnv => ({
  ...defaultClientEnv(),
  home,
  platform,
  pathEnv: bin,
});

async function writeAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

/** The shared contract of every client definition: write, replace, keep the rest, remove only ours. */
async function expectContract(client: Client, file: string, key: string, platform: NodeJS.Platform = "darwin"): Promise<void> {
  const e = env(platform);
  const before = { other: 1, [key]: { keep: { command: "k" }, artisign: { command: "STALE-ENTRY" } } };
  await writeAt(file, JSON.stringify(before));
  expect(await connectClients({ version: "5.0.0", env: e, clients: [client] })).toEqual([{ name: client.name, status: "done" }]);
  const written = await readJson(file);
  expect(written.other).toBe(1);
  const servers = written[key] as Record<string, unknown>;
  expect(servers.keep).toEqual({ command: "k" });
  expect(JSON.stringify(servers.artisign)).toContain("artisign@5.0.0");
  expect(JSON.stringify(servers.artisign)).not.toContain("STALE-ENTRY");
  expect(await disconnectClients(e, [client])).toEqual([{ name: client.name, status: "done" }]);
  expect(await readJson(file)).toEqual({ other: 1, [key]: { keep: { command: "k" } } });
}

describe("Cursor", () => {
  it("is detected by ~/.cursor and nothing else", async () => {
    expect(await cursor.detect(env())).toEqual({ found: false, hasEntry: false });
    await mkdir(join(home, ".cursor"));
    expect(await cursor.detect(env())).toEqual({ found: true, hasEntry: false });
  });

  it("writes, replaces and removes only its entry in ~/.cursor/mcp.json", async () => {
    await expectContract(cursor, join(home, ".cursor", "mcp.json"), "mcpServers");
  });

  it("uses the absolute npx on PATH with its directory first in PATH", async () => {
    await mkdir(join(home, ".cursor"));
    await connectClients({ version: "5.0.0", env: env(), clients: [cursor] });
    const entry = ((await readJson(join(home, ".cursor", "mcp.json"))).mcpServers as Record<string, { command: string; args: string[]; env: { PATH: string } }>).artisign;
    expect(entry?.command).toBe(join(bin, "npx"));
    expect(entry?.args).toEqual(["-y", "artisign@5.0.0", "mcp"]);
    expect(entry?.env.PATH.startsWith(`${bin}:`)).toBe(true);
  });
});


describe("Codex CLI", () => {
  const file = (): string => join(home, ".codex", "config.toml");

  it("is detected by ~/.codex or a codex binary on PATH", async () => {
    expect(await codex.detect(env())).toEqual({ found: false, hasEntry: false });
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    expect((await codex.detect(env())).found).toBe(true);
    await rm(join(bin, "codex"));
    await mkdir(join(home, ".codex"));
    expect((await codex.detect(env())).found).toBe(true);
  });

  it("creates the file with the table and plain npx", async () => {
    await mkdir(join(home, ".codex"));
    await connectClients({ version: "5.0.0", env: env(), clients: [codex] });
    expect(await readFile(file(), "utf8")).toBe('[mcp_servers.artisign]\ncommand = "npx"\nargs = ["-y","artisign@5.0.0","mcp"]\n');
    expect((await codex.detect(env())).hasEntry).toBe(true);
  });

  it("replaces our tables (sub-tables too), keeps everything else and removes only ours", async () => {
    const other = '# my settings\nmodel = "gpt-x"\n\n[mcp_servers.keep]\ncommand = "k"\nargs = ["a"]\n\n[profiles.fast]\nmodel = "m"\n';
    const ours = '\n[mcp_servers.artisign]\ncommand = "old"\n\n[mcp_servers.artisign.env]\nX = "1"\n';
    await writeAt(file(), other + ours);
    await connectClients({ version: "6.0.0", env: env(), clients: [codex] });
    const written = await readFile(file(), "utf8");
    expect(written.startsWith(other.trimEnd())).toBe(true);
    expect(written).toContain("artisign@6.0.0");
    expect(written).not.toContain('"old"');
    expect(written).not.toContain("X = ");
    expect(written.match(/\[mcp_servers\.artisign\]/g)).toHaveLength(1);
    await disconnectClients(env(), [codex]);
    expect(await readFile(file(), "utf8")).toBe(other);
  });
});

describe("VS Code", () => {
  const file = (): string => join(home, "Library", "Application Support", "Code", "User", "mcp.json");

  it("is detected by its user directory", async () => {
    expect((await vscode.detect(env())).found).toBe(false);
    await mkdir(dirname(file()), { recursive: true });
    expect((await vscode.detect(env())).found).toBe(true);
  });

  it("writes a stdio entry under `servers` and keeps the rest", async () => {
    await expectContract(vscode, file(), "servers");
    await connectClients({ version: "5.0.0", env: env(), clients: [vscode] });
    const entry = ((await readJson(file())).servers as Record<string, { type: string; command: string }>).artisign;
    expect(entry?.type).toBe("stdio");
    expect(entry?.command).toBe(join(bin, "npx"));
  });

  it("uses ~/.config/Code/User on Linux", async () => {
    await expectContract(vscode, join(home, ".config", "Code", "User", "mcp.json"), "servers", "linux");
  });
});

describe("opencode", () => {
  const dir = (): string => join(home, ".config", "opencode");

  it("is detected by its config directory or a binary on PATH", async () => {
    expect((await opencode.detect(env())).found).toBe(false);
    await mkdir(dir(), { recursive: true });
    expect((await opencode.detect(env())).found).toBe(true);
  });

  it("writes a local entry with the command as an array and keeps the rest", async () => {
    await expectContract(opencode, join(dir(), "opencode.json"), "mcp");
    await connectClients({ version: "5.0.0", env: env(), clients: [opencode] });
    const entry = ((await readJson(join(dir(), "opencode.json"))).mcp as Record<string, unknown>).artisign;
    expect(entry).toEqual({ type: "local", command: ["npx", "-y", "artisign@5.0.0", "mcp"], enabled: true });
  });

  it("edits opencode.jsonc when that is the only config file", async () => {
    await writeAt(join(dir(), "opencode.jsonc"), "{}");
    await connectClients({ version: "5.0.0", env: env(), clients: [opencode] });
    expect(JSON.stringify(await readJson(join(dir(), "opencode.jsonc")))).toContain("artisign@5.0.0");
  });
});

describe("Codex CLI: a config that cannot be read", () => {
  it("is left alone instead of being replaced", async () => {
    const file = join(home, ".codex", "config.toml");
    await writeAt(file, 'model = "precious"\n');
    await chmod(file, 0o000);
    try {
      const [result] = await connectClients({ version: "5.0.0", env: env(), clients: [codex] });
      expect(result?.status).toBe("failed");
    } finally {
      await chmod(file, 0o600);
    }
    expect(await readFile(file, "utf8")).toBe('model = "precious"\n');
  });
});

