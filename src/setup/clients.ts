import { execFile } from "node:child_process";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { atomicWrite } from "../store/atomic-write.js";

/** Everything a client definition touches outside itself, so tests can run against a fake HOME and a fake `claude`. */
export type ClientEnv = {
  home: string;
  platform: NodeJS.Platform;
  /** The PATH to look for CLIs on. */
  pathEnv: string;
  /** The process environment, for tool-specific overrides such as CODEX_HOME. */
  vars: NodeJS.ProcessEnv;
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
    vars: process.env,
    execPath: process.execPath,
    run: (command, args) => new Promise((resolve) => execFile(command, args, { timeout: 30_000 }, (err) => resolve(err === null))),
  };
}

export type Detection = { found: boolean; hasEntry: boolean };

/**
 * What a human copies to connect one client by hand — the same entry `write` produces, pinned to the same version.
 * `config.path` is absolute (callers shorten it for display) and absent only where the client's config location is
 * unknown on this platform.
 */
export type Manual = { kind: "command"; text: string } | { kind: "config"; path?: string; text: string };

/** One AI tool Artisign can be connected to. A new tool is one more object in `CLIENTS`. */
export type Client = {
  name: string;
  detect: (env: ClientEnv) => Promise<Detection>;
  /** Writes (or replaces) the `artisign` entry pinned to `version`. */
  write: (env: ClientEnv, version: string) => Promise<void>;
  /** Copy-only counterpart of `write`: never touches the client's config. */
  manual: (env: ClientEnv, version: string) => Promise<Manual>;
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

/** The file holds something `JSON.parse` rejects: comments, trailing commas (JSONC) or plain breakage. */
class NotPlainJsonError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not plain JSON`);
  }
}

async function readConfig(path: string): Promise<{ config: JsonObject; mode?: number }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // Only a file that is not there is an empty config. An unreadable one (EACCES, EIO) must not be replaced by `{}`.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
    throw new Error(`could not read ${path}: ${(err as Error).message} (nothing was changed)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NotPlainJsonError(path);
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
  return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? (servers as JsonObject) : {};
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
  configPath: string,
  entry: JsonObject | undefined,
  key: ServersKey = "mcpServers",
): Promise<void> {
  // A config symlinked from a dotfiles repo stays a symlink: the atomic rename happens next to the real file.
  const path = await realpath(configPath).catch(() => configPath);
  let read: Awaited<ReturnType<typeof readConfig>>;
  try {
    read = await readConfig(path);
  } catch (err) {
    if (!(err instanceof NotPlainJsonError)) throw err;
    const todo =
      entry === undefined
        ? `Remove the "${NAME}" entry by hand.`
        : `Add this entry by hand:\n${JSON.stringify({ [key]: { [NAME]: entry } }, null, 2)}`;
    throw new Error(
      `${path} contains comments or trailing commas (or is not valid JSON); setup can't edit it without losing them. ` +
        `Nothing was changed. ${todo}`,
    );
  }
  const { config, mode } = read;
  const servers = { ...serversOf(config, key) };
  if (entry === undefined) delete servers[NAME];
  else servers[NAME] = entry;
  await atomicWrite(path, `${JSON.stringify({ ...config, [key]: servers }, null, 2)}\n`, mode);
}

const npxArgs = (version: string): string[] => ["-y", `${NAME}@${version}`, "mcp"];

const jsonSnippet = (key: ServersKey, entry: JsonObject): string => JSON.stringify({ [key]: { [NAME]: entry } }, null, 2);

const claudeCodeFileEntry = (version: string): JsonObject => ({ type: "stdio", command: "npx", args: npxArgs(version), env: {} });
const claudeAddArgs = (version: string): string[] => ["mcp", "add", "--scope", "user", "--transport", "stdio", NAME, "--", "npx", ...npxArgs(version)];

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
      await editServers(join(env.home, ".claude.json"), claudeCodeFileEntry(version));
      return;
    }
    // `add` refuses an existing name; replacing means remove first (its failure just means there was nothing to remove).
    await env.run(claude, ["mcp", "remove", NAME, "--scope", "user"]);
    const added = await env.run(claude, claudeAddArgs(version));
    if (!added) throw new Error("`claude mcp add` failed");
  },
  async manual(env, version) {
    if ((await findOnPath("claude", env.pathEnv)) !== undefined) return { kind: "command", text: `claude ${claudeAddArgs(version).join(" ")}` };
    return { kind: "config", path: join(env.home, ".claude.json"), text: jsonSnippet("mcpServers", claudeCodeFileEntry(version)) };
  },
  async remove(env) {
    const claude = await findOnPath("claude", env.pathEnv);
    if (claude === undefined) await editServers(join(env.home, ".claude.json"), undefined);
    else if (!(await env.run(claude, ["mcp", "remove", NAME, "--scope", "user"]))) throw new Error("`claude mcp remove` failed");
  },
};

/** Directories Claude Desktop keeps `claude_desktop_config.json` in. Anthropic documents macOS only; the Linux ones are community builds. */
function desktopDirs(env: ClientEnv): string[] {
  if (env.platform === "darwin") return [join(env.home, "Library", "Application Support", "Claude")];
  if (env.platform === "linux") return [join(env.home, ".config", "Claude"), join(env.home, ".config", "claude")];
  return [];
}

async function desktopConfigPath(env: ClientEnv): Promise<string | undefined> {
  for (const dir of desktopDirs(env)) {
    const file = join(dir, "claude_desktop_config.json");
    // The lowercase Linux directory is also a common XDG name for other things: only a config file in it says "Desktop".
    const isLowercase = dir.endsWith("/claude");
    if (isLowercase ? await exists(file) : await exists(dir)) return file;
  }
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
  if (!(await exists(npx, constants.X_OK))) {
    throw new Error("npx was not found on PATH or next to node; install npm and run setup again (nothing was changed)");
  }
  const bin = dirname(npx);
  return {
    command: npx,
    args: npxArgs(version),
    env: { PATH: [bin, "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter) },
  };
}

/** `absoluteNpxEntry`, or plain `npx` for the copy-only snippet when there is no npx to point at. */
async function absoluteOrPlainNpxEntry(env: ClientEnv, version: string): Promise<{ command: string; args: string[]; env?: { PATH: string } }> {
  try {
    return await absoluteNpxEntry(env, version);
  } catch {
    return { command: "npx", args: npxArgs(version) };
  }
}

/** Claude Desktop: `claude_desktop_config.json`, key `mcpServers`, absolute npx (see `absoluteNpxEntry`). */
export const claudeDesktop: Client = {
  name: "Claude Desktop",
  async detect(env) {
    const path = await desktopConfigPath(env);
    return { found: path !== undefined, hasEntry: path !== undefined && (await hasServerEntry(path)) };
  },
  async write(env, version) {
    const path = await desktopConfigPath(env);
    if (path === undefined) throw new Error("Claude Desktop's config directory is gone");
    await editServers(path, await absoluteNpxEntry(env, version));
  },
  async manual(env, version) {
    const path = (await desktopConfigPath(env)) ?? (desktopDirs(env)[0] === undefined ? undefined : join(desktopDirs(env)[0] as string, "claude_desktop_config.json"));
    return { kind: "config", ...(path === undefined ? {} : { path }), text: jsonSnippet("mcpServers", await absoluteOrPlainNpxEntry(env, version)) };
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
    await editServers(join(env.home, ".cursor", "mcp.json"), { type: "stdio", ...(await absoluteNpxEntry(env, version)) });
  },
  async manual(env, version) {
    const entry = { type: "stdio", ...(await absoluteOrPlainNpxEntry(env, version)) };
    return { kind: "config", path: join(env.home, ".cursor", "mcp.json"), text: jsonSnippet("mcpServers", entry) };
  },
  async remove(env) {
    const path = join(env.home, ".cursor", "mcp.json");
    if (await exists(path)) await editServers(path, undefined);
  },
};

// Codex CLI keeps its servers in TOML tables. With the `codex` CLI on PATH it is driven (it owns the file). Without it
// the `artisign` tables are cut out and re-appended as text, no TOML library: a header line `[mcp_servers.artisign]` (or
// a sub-table such as `.env`) runs to the next header. Any other way of declaring the entry is refused, not guessed at.
const CODEX_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*("artisign"|'artisign'|artisign)\s*(\.[^\]]*)?\]/;
const TOML_HEADER = /^\s*\[/;
const STARTUP_TIMEOUT = "startup_timeout_sec = 60";

const isContent = (line: string): boolean => line.trim() !== "" && !line.trim().startsWith("#");

function withoutCodexEntry(toml: string): string {
  const kept: string[] = [];
  let block: string[] = [];
  const endBlock = (): void => {
    // Blank lines and comments after the block's last content line belong to whatever follows it.
    let last = block.length - 1;
    while (last >= 0 && !isContent(block[last] as string)) last--;
    kept.push(...block.slice(last + 1));
    block = [];
  };
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (TOML_HEADER.test(line)) {
      if (skipping) endBlock();
      skipping = CODEX_TABLE.test(line);
    }
    if (skipping) block.push(line);
    else kept.push(line);
  }
  if (skipping) endBlock();
  return kept.join("\n").replace(/\n+$/, "");
}

/** True when `artisign` is declared under mcp_servers in a form other than its own table (inline table, dotted key). */
function hasUnmatchedCodexEntry(toml: string): boolean {
  let header = "";
  for (const line of toml.split("\n")) {
    if (TOML_HEADER.test(line)) {
      header = line.trim();
      continue;
    }
    if (/^\s*mcp_servers\s*=.*\bartisign\b/.test(line)) return true;
    if (header === "" && /^\s*mcp_servers\s*\.\s*(["']?)artisign\1\s*[.=]/.test(line)) return true;
    if (/^\[\s*mcp_servers\s*\]/.test(header) && /^\s*(["']?)artisign\1\s*[.=]/.test(line)) return true;
  }
  return false;
}

const codexHome = (env: ClientEnv): string => env.vars.CODEX_HOME ?? join(env.home, ".codex");
const codexConfig = (env: ClientEnv): string => join(codexHome(env), "config.toml");

const codexEntry = (version: string): string =>
  `[mcp_servers.artisign]\ncommand = "npx"\nargs = ${JSON.stringify(npxArgs(version))}\n${STARTUP_TIMEOUT}\n`;

async function readCodexConfig(path: string): Promise<{ text: string; mode?: number }> {
  try {
    return { text: await readFile(path, "utf8"), mode: (await stat(path)).mode & 0o777 };
  } catch (err) {
    // Only a missing file is created; an unreadable one must not be replaced.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: "" };
    throw new Error(`could not read ${path}: ${(err as Error).message} (nothing was changed)`);
  }
}

async function editCodexConfig(configPath: string, version: string | undefined): Promise<void> {
  const path = await realpath(configPath).catch(() => configPath);
  const { text, mode } = await readCodexConfig(path);
  const rest = withoutCodexEntry(text);
  if (hasUnmatchedCodexEntry(rest)) {
    throw new Error(
      `${path} declares mcp_servers.artisign in a form setup does not edit (an inline table or dotted keys). Nothing was changed. ` +
        (version === undefined ? "Remove that entry by hand." : `Replace it by hand with:\n${codexEntry(version)}`),
    );
  }
  const entry = version === undefined ? "" : codexEntry(version);
  const out = [rest, entry].filter((part) => part !== "").join("\n\n");
  await atomicWrite(path, out === "" ? "" : `${out.replace(/\n*$/, "")}\n`, mode);
}

/** After `codex mcp add` (which has no timeout option): a cold `npx -y` download can exceed Codex's 10 s default. */
async function addCodexStartupTimeout(configPath: string): Promise<void> {
  const path = await realpath(configPath).catch(() => configPath);
  const { text, mode } = await readCodexConfig(path);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*("artisign"|'artisign'|artisign)\s*\]/.test(l));
  if (at < 0) return;
  let end = at + 1;
  while (end < lines.length && !TOML_HEADER.test(lines[end] as string)) end++;
  if (lines.slice(at, end).some((l) => /^\s*startup_timeout_(sec|ms)\s*=/.test(l))) return;
  lines.splice(at + 1, 0, STARTUP_TIMEOUT);
  await atomicWrite(path, lines.join("\n"), mode);
}

/** Codex CLI: `~/.codex/config.toml` (or `$CODEX_HOME`), `[mcp_servers.artisign]` (https://developers.openai.com/codex/mcp). A terminal tool, so plain `npx`. */
export const codex: Client = {
  name: "Codex CLI",
  async detect(env) {
    const found = (await exists(codexHome(env))) || (await findOnPath("codex", env.pathEnv)) !== undefined;
    let hasEntry = false;
    try {
      const text = await readFile(codexConfig(env), "utf8");
      hasEntry = text.split("\n").some((line) => CODEX_TABLE.test(line)) || hasUnmatchedCodexEntry(text);
    } catch {
      // No file, no entry.
    }
    return { found, hasEntry };
  },
  async write(env, version) {
    const bin = await findOnPath("codex", env.pathEnv);
    if (bin === undefined) {
      await editCodexConfig(codexConfig(env), version);
      return;
    }
    // `add` refuses an existing name; its failure to remove just means there was nothing to remove.
    await env.run(bin, ["mcp", "remove", NAME]);
    if (!(await env.run(bin, ["mcp", "add", NAME, "--", "npx", ...npxArgs(version)]))) throw new Error("`codex mcp add` failed");
    await addCodexStartupTimeout(codexConfig(env));
  },
  // Always the config entry, even with the `codex` CLI: `codex mcp add` has no timeout option, so only the table carries it.
  async manual(env, version) {
    return { kind: "config", path: codexConfig(env), text: codexEntry(version) };
  },
  async remove(env) {
    const bin = await findOnPath("codex", env.pathEnv);
    if (bin !== undefined) {
      if (!(await env.run(bin, ["mcp", "remove", NAME]))) throw new Error("`codex mcp remove` failed");
    } else if (await exists(codexConfig(env))) {
      await editCodexConfig(codexConfig(env), undefined);
    }
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
  async manual(env, version) {
    const dir = vscodeUserDir(env);
    const entry = { type: "stdio", ...(await absoluteOrPlainNpxEntry(env, version)) };
    return { kind: "config", ...(dir === undefined ? {} : { path: join(dir, "mcp.json") }), text: jsonSnippet("servers", entry) };
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

const opencodeEntry = (version: string): JsonObject => ({ type: "local", command: ["npx", ...npxArgs(version)], enabled: true, timeout: 60_000 });

/** opencode: `~/.config/opencode/opencode.json`, key `mcp`, `{type: "local", command: [...], enabled}`; a terminal tool, so plain `npx`. */
export const opencode: Client = {
  name: "opencode",
  async detect(env) {
    const found = (await exists(join(env.home, ".config", "opencode"))) || (await findOnPath("opencode", env.pathEnv)) !== undefined;
    return { found, hasEntry: found && (await hasServerEntry(await opencodeConfigPath(env), "mcp")) };
  },
  async write(env, version) {
    await editServers(await opencodeConfigPath(env), opencodeEntry(version), "mcp");
  },
  async manual(env, version) {
    return { kind: "config", path: await opencodeConfigPath(env), text: jsonSnippet("mcp", opencodeEntry(version)) };
  },
  async remove(env) {
    const path = await opencodeConfigPath(env);
    if (await exists(path)) await editServers(path, undefined, "mcp");
  },
};

export const CLIENTS: Client[] = [claudeCode, claudeDesktop, cursor, codex, vscode, opencode];
