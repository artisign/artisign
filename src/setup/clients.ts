import { execFile } from "node:child_process";
import { access, constants, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { atomicWrite } from "../store/atomic-write.js";

/** Everything a client definition touches outside itself, so tests can run against a fake HOME and a fake `claude`. */
export type ClientEnv = {
  home: string;
  platform: NodeJS.Platform;
  /** The PATH to look for CLIs on. */
  pathEnv: string;
  /** The node that runs setup — Desktop's entry pins it, GUI apps do not inherit the shell's PATH. */
  execPath: string;
  /** Runs a program; false when it could not be run or exited non-zero. */
  run: (command: string, args: string[]) => Promise<boolean>;
};

export function defaultClientEnv(): ClientEnv {
  return {
    home: homedir(),
    platform: process.platform,
    pathEnv: process.env.PATH ?? "",
    execPath: process.execPath,
    run: (command, args) =>
      new Promise((resolve) => execFile(command, args, (err) => resolve(err === null))),
  };
}

export type Detection = { found: boolean; hasEntry: boolean };

/** One AI tool Artisign can be connected to. A new tool is one more object in `CLIENTS`. */
export type Client = {
  name: string;
  detect: (env: ClientEnv) => Promise<Detection>;
  /** Writes (or replaces) the `artisign` entry pinned to `version`. */
  write: (env: ClientEnv, version: string) => Promise<void>;
  /** Removes the `artisign` entry and nothing else. */
  remove: (env: ClientEnv) => Promise<void>;
};

const NAME = "artisign";

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(program: string, pathEnv: string): Promise<string | undefined> {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, program);
    if (await exists(candidate, constants.X_OK)) return candidate;
  }
  return undefined;
}

type JsonObject = Record<string, unknown>;

async function readConfig(path: string): Promise<{ config: JsonObject; mode?: number }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { config: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} is not valid JSON; fix or remove it and run setup again (nothing was changed)`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not hold a JSON object (nothing was changed)`);
  }
  return { config: parsed as JsonObject, mode: (await stat(path)).mode & 0o777 };
}

/** The top-level key a client keeps its servers under (`mcpServers` for most, `servers` for VS Code, `mcp` for opencode). */
type ServersKey = string;

function serversOf(config: JsonObject, key: ServersKey): JsonObject {
  const servers = config[key];
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? (servers as JsonObject)
    : {};
}

async function hasServerEntry(path: string, key: ServersKey = "mcpServers"): Promise<boolean> {
  try {
    return NAME in serversOf((await readConfig(path)).config, key);
  } catch {
    return false;
  }
}

/** Sets or deletes the `artisign` entry under `key` in a JSON file, leaving every other key as it was. */
async function editServers(
  path: string,
  entry: JsonObject | undefined,
  key: ServersKey = "mcpServers",
): Promise<void> {
  const { config, mode } = await readConfig(path);
  const servers = { ...serversOf(config, key) };
  if (entry === undefined) delete servers[NAME];
  else servers[NAME] = entry;
  await atomicWrite(path, `${JSON.stringify({ ...config, [key]: servers }, null, 2)}\n`, mode);
}

const npxArgs = (version: string): string[] => ["-y", `${NAME}@${version}`, "mcp"];

/**
 * Claude Code, user scope (`~/.claude.json`, top-level `mcpServers`). The `claude` CLI owns that file and its locking, so
 * it is driven when it is on PATH; only when it is absent but the file exists is the file edited directly (atomically).
 */
export const claudeCode: Client = {
  name: "Claude Code",
  async detect(env) {
    const file = join(env.home, ".claude.json");
    const found = (await findOnPath("claude", env.pathEnv)) !== undefined || (await exists(file));
    return { found, hasEntry: found && (await hasServerEntry(file)) };
  },
  async write(env, version) {
    const claude = await findOnPath("claude", env.pathEnv);
    if (claude === undefined) {
      await editServers(join(env.home, ".claude.json"), {
        type: "stdio",
        command: "npx",
        args: npxArgs(version),
        env: {},
      });
      return;
    }
    // `add` refuses an existing name; replacing means remove first (its failure just means there was nothing to remove).
    await env.run(claude, ["mcp", "remove", NAME, "--scope", "user"]);
    const added = await env.run(claude, [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      NAME,
      "--",
      "npx",
      ...npxArgs(version),
    ]);
    if (!added) throw new Error("`claude mcp add` failed");
  },
  async remove(env) {
    const claude = await findOnPath("claude", env.pathEnv);
    if (claude === undefined) await editServers(join(env.home, ".claude.json"), undefined);
    else await env.run(claude, ["mcp", "remove", NAME, "--scope", "user"]);
  },
};

/** Directories Claude Desktop keeps `claude_desktop_config.json` in. Anthropic documents macOS only; the Linux ones are community builds. */
function desktopDirs(env: ClientEnv): string[] {
  if (env.platform === "darwin")
    return [join(env.home, "Library", "Application Support", "Claude")];
  if (env.platform === "linux")
    return [join(env.home, ".config", "Claude"), join(env.home, ".config", "claude")];
  return [];
}

async function desktopConfigPath(env: ClientEnv): Promise<string | undefined> {
  for (const dir of desktopDirs(env))
    if (await exists(dir)) return join(dir, "claude_desktop_config.json");
  return undefined;
}

/**
 * `{command, args, env}` for a GUI client, which does not inherit the shell's PATH: an absolute npx and a PATH that starts
 * with its directory (npx's `#!/usr/bin/env node` then finds the same node). The npx is the one on the user's PATH,
 * unresolved — `/opt/homebrew/bin/npx` survives a `brew upgrade node`, the versioned Cellar path it links to does not.
 * Only without npx on PATH does it fall back to the directory of the node running setup.
 */
async function absoluteNpxEntry(
  env: ClientEnv,
  version: string,
): Promise<{ command: string; args: string[]; env: { PATH: string } }> {
  const npx = (await findOnPath("npx", env.pathEnv)) ?? join(dirname(env.execPath), "npx");
  const bin = dirname(npx);
  return {
    command: npx,
    args: npxArgs(version),
    env: { PATH: [bin, "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter) },
  };
}

/** Claude Desktop: `claude_desktop_config.json`, key `mcpServers`, absolute npx (see `absoluteNpxEntry`). */
export const claudeDesktop: Client = {
  name: "Claude Desktop",
  async detect(env) {
    const path = await desktopConfigPath(env);
    return {
      found: path !== undefined,
      hasEntry: path !== undefined && (await hasServerEntry(path)),
    };
  },
  async write(env, version) {
    const path = await desktopConfigPath(env);
    if (path === undefined) throw new Error("Claude Desktop's config directory is gone");
    await editServers(path, await absoluteNpxEntry(env, version));
  },
  async remove(env) {
    const path = await desktopConfigPath(env);
    if (path !== undefined && (await exists(path))) await editServers(path, undefined);
  },
};

/** Cursor: `~/.cursor/mcp.json`, key `mcpServers` (https://cursor.com/docs/context/mcp). A GUI app, so absolute npx. */
export const cursor: Client = {
  name: "Cursor",
  async detect(env) {
    const dir = join(env.home, ".cursor");
    const found = await exists(dir);
    return { found, hasEntry: found && (await hasServerEntry(join(dir, "mcp.json"))) };
  },
  async write(env, version) {
    await editServers(join(env.home, ".cursor", "mcp.json"), await absoluteNpxEntry(env, version));
  },
  async remove(env) {
    const path = join(env.home, ".cursor", "mcp.json");
    if (await exists(path)) await editServers(path, undefined);
  },
};

// Codex CLI keeps its servers in TOML tables. Rather than a TOML library, the `artisign` tables are cut out and
// re-appended as text: a header line `[mcp_servers.artisign]` (or a sub-table such as `.env`) runs to the next header.
const CODEX_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*("artisign"|artisign)\s*(\.[^\]]*)?\]/;
const TOML_HEADER = /^\s*\[/;

function withoutCodexEntry(toml: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (TOML_HEADER.test(line)) skipping = CODEX_TABLE.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n+$/, "");
}

async function editCodexConfig(path: string, version: string | undefined): Promise<void> {
  let text = "";
  let mode: number | undefined;
  try {
    text = await readFile(path, "utf8");
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // A missing file is created.
  }
  const rest = withoutCodexEntry(text);
  const entry =
    version === undefined
      ? ""
      : `[mcp_servers.artisign]\ncommand = "npx"\nargs = ${JSON.stringify(npxArgs(version))}\n`;
  const out = [rest, entry].filter((part) => part !== "").join("\n\n");
  await atomicWrite(path, out === "" ? "" : `${out.replace(/\n*$/, "")}\n`, mode);
}

/** Codex CLI: `~/.codex/config.toml`, table `[mcp_servers.artisign]` (https://developers.openai.com/codex/mcp). A terminal tool, so plain `npx`. */
export const codex: Client = {
  name: "Codex CLI",
  async detect(env) {
    const path = join(env.home, ".codex", "config.toml");
    const found = (await exists(join(env.home, ".codex"))) || (await findOnPath("codex", env.pathEnv)) !== undefined;
    let hasEntry = false;
    try {
      hasEntry = (await readFile(path, "utf8")).split("\n").some((line) => CODEX_TABLE.test(line));
    } catch {
      // No file, no entry.
    }
    return { found, hasEntry };
  },
  async write(env, version) {
    await editCodexConfig(join(env.home, ".codex", "config.toml"), version);
  },
  async remove(env) {
    const path = join(env.home, ".codex", "config.toml");
    if (await exists(path)) await editCodexConfig(path, undefined);
  },
};

/** VS Code's user-profile data directory. The docs name `mcp.json` in the user profile but not its path; these are VS Code's standard locations. */
function vscodeUserDir(env: ClientEnv): string | undefined {
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", "Code", "User");
  if (env.platform === "linux") return join(env.home, ".config", "Code", "User");
  return undefined;
}

/** VS Code: user-profile `mcp.json`, top-level `servers`, `{type: "stdio", command, args, env}`. A GUI app, so absolute npx. */
export const vscode: Client = {
  name: "VS Code",
  async detect(env) {
    const dir = vscodeUserDir(env);
    const found = dir !== undefined && (await exists(dir));
    return { found, hasEntry: found && (await hasServerEntry(join(dir, "mcp.json"), "servers")) };
  },
  async write(env, version) {
    const dir = vscodeUserDir(env);
    if (dir === undefined) throw new Error("VS Code's user directory is unknown on this platform");
    await editServers(join(dir, "mcp.json"), { type: "stdio", ...(await absoluteNpxEntry(env, version)) }, "servers");
  },
  async remove(env) {
    const dir = vscodeUserDir(env);
    if (dir !== undefined && (await exists(join(dir, "mcp.json")))) await editServers(join(dir, "mcp.json"), undefined, "servers");
  },
};

/** opencode keeps its global config in `opencode.json`, or `opencode.jsonc` when only that exists. */
async function opencodeConfigPath(env: ClientEnv): Promise<string> {
  const dir = join(env.home, ".config", "opencode");
  const jsonc = join(dir, "opencode.jsonc");
  return !(await exists(join(dir, "opencode.json"))) && (await exists(jsonc)) ? jsonc : join(dir, "opencode.json");
}

/** opencode: `~/.config/opencode/opencode.json`, key `mcp`, `{type: "local", command: [...], enabled}`; a terminal tool, so plain `npx`. */
export const opencode: Client = {
  name: "opencode",
  async detect(env) {
    const found = (await exists(join(env.home, ".config", "opencode"))) || (await findOnPath("opencode", env.pathEnv)) !== undefined;
    return { found, hasEntry: found && (await hasServerEntry(await opencodeConfigPath(env), "mcp")) };
  },
  async write(env, version) {
    await editServers(await opencodeConfigPath(env), { type: "local", command: ["npx", ...npxArgs(version)], enabled: true }, "mcp");
  },
  async remove(env) {
    const path = await opencodeConfigPath(env);
    if (await exists(path)) await editServers(path, undefined, "mcp");
  },
};

export const CLIENTS: Client[] = [claudeCode, claudeDesktop, cursor, codex, vscode, opencode];
