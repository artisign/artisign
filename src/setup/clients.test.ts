import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { defaultClientEnv, cursor, codex, vscode, opencode, claudeCode, claudeDesktop, type Client, type ClientEnv } from "./clients.js";
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

const env = (platform: NodeJS.Platform = "darwin", vars: NodeJS.ProcessEnv = {}): ClientEnv => ({
  ...defaultClientEnv(),
  home,
  platform,
  pathEnv: bin,
  vars,
});

async function writeAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

/** The shared contract of every client definition: write, replace, keep the rest, remove only ours. */
async function expectContract(client: Client, file: string, key: string, platform: NodeJS.Platform = "darwin", e: ClientEnv = env(platform)): Promise<void> {
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
    expect((entry as unknown as { type: string }).type).toBe("stdio");
    expect(entry?.args).toEqual(["-y", "artisign@5.0.0", "mcp"]);
    expect(entry?.env.PATH.startsWith(`${bin}${delimiter}`)).toBe(true);
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
    expect(await readFile(file(), "utf8")).toBe('[mcp_servers.artisign]\ncommand = "npx"\nargs = ["-y","artisign@5.0.0","mcp"]\nstartup_timeout_sec = 60\n');
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
    expect(entry).toEqual({ type: "local", command: ["npx", "-y", "artisign@5.0.0", "mcp"], enabled: true, timeout: 60000 });
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

describe("Codex CLI: shapes the text edit must not duplicate", () => {
  const file = (): string => join(home, ".codex", "config.toml");

  it.each([
    ["an inline table", '[mcp_servers]\nartisign = { command = "old" }\n'],
    ["a dotted key", 'mcp_servers.artisign.command = "old"\n'],
    ["a quoted dotted key", "mcp_servers.'artisign'.command = \"old\"\n"],
    ["an inline mcp_servers", 'mcp_servers = { artisign = { command = "old" } }\n'],
  ])("refuses %s, changes nothing and shows the snippet", async (_name, input) => {
    await writeAt(file(), input);
    const [result] = await connectClients({ version: "5.0.0", env: env(), clients: [codex] });
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("Nothing was changed");
    expect(result?.error).toContain("artisign@5.0.0");
    expect(await readFile(file(), "utf8")).toBe(input);
  });

  it("recognises a literal-quoted table header as its own entry", async () => {
    await writeAt(file(), "[mcp_servers.'artisign']\ncommand = \"old\"\n");
    await connectClients({ version: "5.0.0", env: env(), clients: [codex] });
    const text = await readFile(file(), "utf8");
    expect(text).not.toContain("old");
    expect(text.match(/\[mcp_servers\./g)).toHaveLength(1);
  });

  it("keeps the comments and blank lines that belong to the next table", async () => {
    const input = '[mcp_servers.artisign]\ncommand = "old"\n\n# the other server\n[mcp_servers.keep]\ncommand = "k"\n';
    await writeAt(file(), input);
    await disconnectClients(env(), [codex]);
    expect(await readFile(file(), "utf8")).toBe("\n# the other server\n[mcp_servers.keep]\ncommand = \"k\"\n");
    await writeAt(file(), input);
    await connectClients({ version: "5.0.0", env: env(), clients: [codex] });
    const text = await readFile(file(), "utf8");
    expect(text).toContain("# the other server\n[mcp_servers.keep]");
  });

  it("honours CODEX_HOME", async () => {
    const custom = join(root, "codex-home");
    await mkdir(custom);
    const e = env("darwin", { CODEX_HOME: custom });
    expect((await codex.detect(e)).found).toBe(true);
    await connectClients({ version: "5.0.0", env: e, clients: [codex] });
    expect(await readFile(join(custom, "config.toml"), "utf8")).toContain("artisign@5.0.0");
  });

  it.skipIf(process.platform === "win32")("drives the codex CLI when it is on PATH, then adds the startup timeout", async () => {
    const log = join(root, "codex.log");
    await writeFile(
      join(bin, "codex"),
      `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$2" = add ]; then mkdir -p '${home}/.codex'; printf '[mcp_servers.artisign]\\ncommand = "npx"\\n' > '${home}/.codex/config.toml'; fi\n`,
    );
    await chmod(join(bin, "codex"), 0o755);
    const [result] = await connectClients({ version: "5.0.0", env: env(), clients: [codex] });
    expect(result?.status).toBe("done");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["mcp remove artisign", "mcp add artisign -- npx -y artisign@5.0.0 mcp"]);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain("startup_timeout_sec = 60");
  });

  it("reports a failing codex CLI", async () => {
    await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, "codex"), 0o755);
    const [result] = await connectClients({ version: "5.0.0", env: env(), clients: [codex] });
    expect(result?.status).toBe("failed");
  });
});

describe("config files with comments or trailing commas", () => {
  it.each([
    ["Cursor", cursor, join(".cursor", "mcp.json"), "mcpServers"],
    ["VS Code", vscode, join("Library", "Application Support", "Code", "User", "mcp.json"), "servers"],
    ["opencode", opencode, join(".config", "opencode", "opencode.json"), "mcp"],
  ])("%s: nothing is changed and the snippet to add by hand is shown", async (_n, client, rel, key) => {
    const input = '{\n  // my servers\n  "other": 1,\n}\n';
    await writeAt(join(home, rel), input);
    const [result] = await connectClients({ version: "5.0.0", env: env(), clients: [client] });
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("comments or trailing commas");
    expect(result?.error).toContain(`"${key}"`);
    expect(result?.error).toContain("artisign@5.0.0");
    expect(await readFile(join(home, rel), "utf8")).toBe(input);
  });

  it("one client failing does not stop the others", async () => {
    await writeAt(join(home, ".cursor", "mcp.json"), "{ // c\n}");
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    const results = await connectClients({ version: "5.0.0", env: env(), clients: [cursor, opencode] });
    expect(results.map((r) => r.status)).toEqual(["failed", "done"]);
  });
});

describe("symlinked config files", () => {
  it.each([
    ["Cursor", cursor, join(".cursor", "mcp.json")],
    ["VS Code", vscode, join("Library", "Application Support", "Code", "User", "mcp.json")],
    ["opencode", opencode, join(".config", "opencode", "opencode.json")],
    ["Claude Desktop", claudeDesktop, join("Library", "Application Support", "Claude", "claude_desktop_config.json")],
    ["Claude Code (file fallback)", claudeCode, ".claude.json"],
    ["Codex CLI", codex, join(".codex", "config.toml")],
  ])("%s: the link survives and the real file is updated", async (_n, client, rel) => {
    const real = join(root, "dotfiles", rel.replaceAll("/", "_"));
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, rel.endsWith(".toml") ? "# mine\n" : "{}");
    await mkdir(dirname(join(home, rel)), { recursive: true });
    await symlink(real, join(home, rel));
    const [result] = await connectClients({ version: "5.0.0", env: env(), clients: [client] });
    expect(result?.status).toBe("done");
    expect((await lstat(join(home, rel))).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toContain("artisign@5.0.0");
  });
});

describe("opencode detection", () => {
  it("finds the opencode binary on PATH even without a config directory", async () => {
    await writeFile(join(bin, "opencode"), "#!/bin/sh\n");
    await chmod(join(bin, "opencode"), 0o755);
    expect((await opencode.detect(env())).found).toBe(true);
  });
});


describe("Windows", () => {
  let appdata: string;
  let winBin: string;
  beforeEach(async () => {
    appdata = join(root, "AppData", "Roaming");
    winBin = join(root, "win bin");
    await mkdir(winBin, { recursive: true });
    // Plain files: Windows has no execute bit, so existence is all the lookup asks for.
    for (const name of ["npx.cmd", "claude.cmd", "codex.CMD"]) await writeFile(join(winBin, name), "@echo off\r\n");
  });
  const winEnv = (vars: NodeJS.ProcessEnv = { APPDATA: appdata }): ClientEnv => ({
    ...defaultClientEnv(),
    home,
    platform: "win32",
    pathEnv: `${join(root, "nowhere")};${winBin}`,
    vars,
    execPath: join(winBin, "node.exe"),
    run: async () => true,
  });
  const launcher = { command: "cmd", args: ["/c", "npx", "-y", "artisign@5.0.0", "mcp"] };

  it("finds claude.cmd and npx.cmd through PATHEXT, in PATH order and with a space in the directory", async () => {
    const e = winEnv({ APPDATA: appdata, PATHEXT: ".EXE;.CMD" });
    expect(await claudeCode.detect(e)).toEqual({ found: true, hasEntry: false });
    expect(await codex.detect({ ...e, vars: { ...e.vars, CODEX_HOME: join(root, "none") } })).toEqual({ found: true, hasEntry: false });
  });

  it("does not find a program without a PATHEXT extension, and uses the default list when PATHEXT is unset", async () => {
    await writeFile(join(winBin, "opencode"), "#!/bin/sh\n");
    expect((await opencode.detect(winEnv())).found).toBe(false);
    await writeFile(join(winBin, "opencode.exe"), "");
    expect((await opencode.detect(winEnv())).found).toBe(true);
  });

  it("Claude Desktop lives in %APPDATA%\\Claude and gets a cmd /c npx entry without a pinned PATH", async () => {
    const file = join(appdata, "Claude", "claude_desktop_config.json");
    expect((await claudeDesktop.detect(winEnv())).found).toBe(false);
    await mkdir(join(appdata, "Claude"), { recursive: true });
    expect((await claudeDesktop.detect(winEnv())).found).toBe(true);
    await expectContract(claudeDesktop, file, "mcpServers", "win32", winEnv());
    await rm(file);
    await connectClients({ version: "5.0.0", env: winEnv(), clients: [claudeDesktop] });
    expect((await readJson(file)).mcpServers).toEqual({ artisign: { ...launcher, env: {} } });
    expect(await claudeDesktop.manual(winEnv(), "5.0.0")).toEqual({
      kind: "config",
      path: file,
      text: JSON.stringify({ mcpServers: { artisign: { ...launcher, env: {} } } }, null, 2),
    });
  });

  it("falls back to <home>\\AppData\\Roaming without %APPDATA%", async () => {
    await mkdir(join(home, "AppData", "Roaming", "Code", "User"), { recursive: true });
    expect((await vscode.detect(winEnv({}))).found).toBe(true);
  });

  it("VS Code lives in %APPDATA%\\Code\\User", async () => {
    const dir = join(appdata, "Code", "User");
    expect((await vscode.detect(winEnv())).found).toBe(false);
    await mkdir(dir, { recursive: true });
    await expectContract(vscode, join(dir, "mcp.json"), "servers", "win32", winEnv());
    await rm(join(dir, "mcp.json"));
    await connectClients({ version: "5.0.0", env: winEnv(), clients: [vscode] });
    expect(((await readJson(join(dir, "mcp.json"))).servers as Record<string, unknown>).artisign).toEqual({ type: "stdio", ...launcher, env: {} });
  });

  it("an entry for a GUI client is refused when there is no npx", async () => {
    await mkdir(join(appdata, "Claude"), { recursive: true });
    const e = { ...winEnv(), pathEnv: join(root, "nowhere"), execPath: join(root, "nowhere", "node.exe") };
    const [result] = await connectClients({ version: "5.0.0", env: e, clients: [claudeDesktop] });
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("npx was not found");
    // The copy-only snippet still shows the same launcher form.
    expect((await claudeDesktop.manual(e, "5.0.0")).kind === "config" && JSON.stringify(await claudeDesktop.manual(e, "5.0.0"))).toContain("cmd");
  });

  it("Claude Code drives claude.cmd with cmd /c npx, and edits ~/.claude.json the same way without it", async () => {
    const calls: string[][] = [];
    const e = { ...winEnv(), run: async (c: string, a: string[]) => (calls.push([c, ...a]), true) };
    await claudeCode.write(e, "5.0.0");
    expect(calls).toEqual([
      [expect.stringMatching(/claude\.cmd$/i), "mcp", "remove", "artisign", "--scope", "user"],
      [expect.stringMatching(/claude\.cmd$/i), "mcp", "add", "--scope", "user", "--transport", "stdio", "artisign", "--", "cmd", "/c", "npx", "-y", "artisign@5.0.0", "mcp"],
    ]);
    const manual = await claudeCode.manual(e, "5.0.0");
    expect(manual).toEqual({ kind: "command", text: "claude mcp add --scope user --transport stdio artisign -- cmd /c npx -y artisign@5.0.0 mcp" });
    const bare = { ...e, pathEnv: join(root, "nowhere") };
    await writeAt(join(home, ".claude.json"), "{}");
    await claudeCode.write(bare, "5.0.0");
    expect(((await readJson(join(home, ".claude.json"))).mcpServers as Record<string, unknown>).artisign).toEqual({ type: "stdio", ...launcher, env: {} });
  });

  it("Cursor, Codex and opencode keep their home-relative locations and use the cmd /c launcher", async () => {
    await mkdir(join(home, ".cursor"));
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await connectClients({ version: "5.0.0", env: { ...winEnv(), pathEnv: "" }, clients: [cursor, opencode] });
    expect(((await readJson(join(home, ".cursor", "mcp.json"))).mcpServers as Record<string, unknown>).artisign).toEqual({ type: "stdio", ...launcher, env: {} });
    const oc = (await readJson(join(home, ".config", "opencode", "opencode.json"))).mcp as Record<string, unknown>;
    expect(oc.artisign).toMatchObject({ type: "local", command: ["cmd", "/c", "npx", "-y", "artisign@5.0.0", "mcp"] });
    const manual = await codex.manual(winEnv(), "5.0.0");
    expect(manual).toMatchObject({ kind: "config", path: join(home, ".codex", "config.toml") });
    expect((manual as { text: string }).text).toContain('command = "cmd"\nargs = ["/c","npx","-y","artisign@5.0.0","mcp"]');
  });

  it("Codex runs codex.CMD with the launcher", async () => {
    const calls: string[][] = [];
    const e = { ...winEnv(), run: async (c: string, a: string[]) => (calls.push([c, ...a]), true) };
    await codex.write(e, "5.0.0");
    expect(calls[1]).toEqual([expect.stringMatching(/codex\.cmd$/i), "mcp", "add", "artisign", "--", "cmd", "/c", "npx", "-y", "artisign@5.0.0", "mcp"]);
  });

  it("the macOS entry is still plain npx", async () => {
    expect(await claudeCode.manual({ ...env(), pathEnv: "" }, "5.0.0")).toMatchObject({ text: expect.stringContaining('"command": "npx"') });
  });
});
