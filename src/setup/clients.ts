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
    run: (command, args) => new Promise((resolve) => execFile(command, args, (err) => resolve(err === null))),
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
    throw new Error(`${path} is not valid JSON; fix or remove it and run setup again (nothing was changed)`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not hold a JSON object (nothing was changed)`);
  }
  return { config: parsed as JsonObject, mode: (await stat(path)).mode & 0o777 };
}

function serversOf(config: JsonObject): JsonObject {
  const servers = config.mcpServers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? (servers as JsonObject) : {};
}

async function hasServerEntry(path: string): Promise<boolean> {
  try {
    return NAME in serversOf((await readConfig(path)).config);
  } catch {
    return false;
  }
}

/** Sets or deletes `mcpServers.artisign` in a JSON file, leaving every other key as it was. */
async function editServers(path: string, entry: JsonObject | undefined): Promise<void> {
  const { config, mode } = await readConfig(path);
  const servers = { ...serversOf(config) };
  if (entry === undefined) delete servers[NAME];
  else servers[NAME] = entry;
  await atomicWrite(path, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, mode);
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
      await editServers(join(env.home, ".claude.json"), { type: "stdio", command: "npx", args: npxArgs(version), env: {} });
      return;
    }
    // `add` refuses an existing name; replacing means remove first (its failure just means there was nothing to remove).
    await env.run(claude, ["mcp", "remove", NAME, "--scope", "user"]);
    const added = await env.run(claude, ["mcp", "add", "--scope", "user", "--transport", "stdio", NAME, "--", "npx", ...npxArgs(version)]);
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
  if (env.platform === "darwin") return [join(env.home, "Library", "Application Support", "Claude")];
  if (env.platform === "linux") return [join(env.home, ".config", "Claude"), join(env.home, ".config", "claude")];
  return [];
}

async function desktopConfigPath(env: ClientEnv): Promise<string | undefined> {
  for (const dir of desktopDirs(env)) if (await exists(dir)) return join(dir, "claude_desktop_config.json");
  return undefined;
}

/** Claude Desktop is a GUI app without the shell's PATH: the entry uses the absolute npx next to the node running setup. */
export const claudeDesktop: Client = {
  name: "Claude Desktop",
  async detect(env) {
    const path = await desktopConfigPath(env);
    return { found: path !== undefined, hasEntry: path !== undefined && (await hasServerEntry(path)) };
  },
  async write(env, version) {
    const path = await desktopConfigPath(env);
    if (path === undefined) throw new Error("Claude Desktop's config directory is gone");
    const bin = dirname(env.execPath);
    await editServers(path, {
      command: join(bin, "npx"),
      args: npxArgs(version),
      env: { PATH: [bin, "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter) },
    });
  },
  async remove(env) {
    const path = await desktopConfigPath(env);
    if (path !== undefined && (await exists(path))) await editServers(path, undefined);
  },
};

export const CLIENTS: Client[] = [claudeCode, claudeDesktop];
