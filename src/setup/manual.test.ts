import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClientEnv, claudeCode, claudeDesktop, cursor, codex, vscode, opencode, type Client, type ClientEnv } from "./clients.js";

let root: string;
let home: string;
let bin: string;
let ran: string[][];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artisign-manual-"));
  home = join(root, "home");
  bin = join(root, "bin");
  ran = [];
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npx"), "#!/bin/sh\n");
  await chmod(join(bin, "npx"), 0o755);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = (): ClientEnv => ({
  ...defaultClientEnv(),
  home,
  platform: "darwin",
  pathEnv: bin,
  vars: {},
  execPath: join(root, "node-bin", "node"),
  run: async (command, args) => {
    ran.push([command, ...args]);
    return true;
  },
});

/** `manual` must be exactly what `write` produces: the written file holds the snippet's entry. */
async function expectManualMatchesWrite(client: Client, key: string | undefined): Promise<void> {
  const manual = await client.manual(env(), "5.0.0");
  expect(manual.kind).toBe("config");
  if (manual.kind !== "config" || manual.path === undefined) throw new Error("expected a config manual with a path");
  await client.write(env(), "5.0.0");
  const written = await readFile(manual.path, "utf8");
  if (key === undefined) expect(written).toBe(manual.text);
  else expect(JSON.parse(written)).toEqual(JSON.parse(manual.text));
}

describe("Client.manual matches Client.write", () => {
  it("Claude Code without the CLI: the ~/.claude.json entry", async () => {
    await expectManualMatchesWrite(claudeCode, "mcpServers");
  });

  it("Claude Code with the CLI: the exact `claude mcp add` command write runs", async () => {
    await writeFile(join(bin, "claude"), "#!/bin/sh\n");
    await chmod(join(bin, "claude"), 0o755);
    const manual = await claudeCode.manual(env(), "5.0.0");
    expect(manual).toEqual({
      kind: "command",
      text: "claude mcp add --scope user --transport stdio artisign -- npx -y artisign@5.0.0 mcp",
    });
    await claudeCode.write(env(), "5.0.0");
    expect(ran.at(-1)?.slice(1).join(" ")).toBe((manual as { text: string }).text.replace(/^claude /, ""));
  });

  it("Claude Desktop", async () => {
    await mkdir(join(home, "Library", "Application Support", "Claude"), { recursive: true });
    await expectManualMatchesWrite(claudeDesktop, "mcpServers");
  });

  it("Cursor", async () => {
    await mkdir(join(home, ".cursor"));
    await expectManualMatchesWrite(cursor, "mcpServers");
  });

  it("Codex CLI (TOML)", async () => {
    await mkdir(join(home, ".codex"));
    await expectManualMatchesWrite(codex, undefined);
  });

  it("VS Code", async () => {
    await mkdir(join(home, "Library", "Application Support", "Code", "User"), { recursive: true });
    await expectManualMatchesWrite(vscode, "servers");
  });

  it("opencode", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await expectManualMatchesWrite(opencode, "mcp");
  });
});

describe("Client.manual without npx", () => {
  it("falls back to plain npx where write would throw", async () => {
    const noNpx: ClientEnv = { ...env(), pathEnv: "" };
    await expect(cursor.write(noNpx, "5.0.0")).rejects.toThrow(/npx was not found/);
    const manual = await cursor.manual(noNpx, "5.0.0");
    if (manual.kind !== "config") throw new Error("expected config");
    expect(JSON.parse(manual.text)).toEqual({
      mcpServers: { artisign: { type: "stdio", command: "npx", args: ["-y", "artisign@5.0.0", "mcp"] } },
    });
  });

  it("never writes anything", async () => {
    await mkdir(join(home, ".cursor"));
    await cursor.manual(env(), "5.0.0");
    await expect(readFile(join(home, ".cursor", "mcp.json"), "utf8")).rejects.toThrow();
  });
});
