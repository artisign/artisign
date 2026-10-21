import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultClientEnv, cursor, type Client, type ClientEnv } from "./clients.js";
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

