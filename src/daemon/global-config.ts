import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../store/atomic-write.js";

// The Store interface is for *project* files; this is daemon-level state that
// lives outside any project (and is needed before a project is even chosen),
// so it deliberately reads/writes the filesystem directly. `atomicWrite` is a
// plain utility, not part of the Store abstraction, and is reused here for
// the same crash-safety reason the store uses it.

export type ArtisignGlobalConfig = {
  port?: number;
  recentProjects?: string[];
};

/** `$ARTISIGN_HOME`, or `~/.artisign` — where daemon-level state (config, lock) lives. */
export function artisignHome(): string {
  return process.env.ARTISIGN_HOME ?? join(homedir(), ".artisign");
}

function configPath(): string {
  return join(artisignHome(), "config.json");
}

/** Reads the global config; a missing or invalid file is treated as empty. */
export async function readGlobalConfig(): Promise<ArtisignGlobalConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as ArtisignGlobalConfig;
  } catch {
    return {};
  }
}

export async function writeGlobalConfig(config: ArtisignGlobalConfig): Promise<void> {
  await atomicWrite(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
