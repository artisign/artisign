import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../store/atomic-write.js";
import { artisignHome } from "./global-config.js";

// Preview preferences are daemon-level state (not project state, not browser
// localStorage). They live in a file of their own — `config.json` is the
// daemon's read-modify-write chain and `update-check.json` is a CLI cache.

export type Settings = {
  prefs: Record<string, string>;
  /** The one-time localStorage carry-over has happened. */
  migrated: boolean;
};

function settingsPath(): string {
  return join(artisignHome(), "settings.json");
}

function emptySettings(): Settings {
  return { prefs: {}, migrated: false };
}

/** Missing, malformed or unreadable files read as empty; non-string prefs are dropped. */
async function readFromDisk(path: string): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptySettings();
    const { prefs, migrated } = parsed as Record<string, unknown>;
    const clean: Record<string, string> = {};
    if (typeof prefs === "object" && prefs !== null && !Array.isArray(prefs)) {
      for (const [key, value] of Object.entries(prefs)) {
        if (typeof value === "string") clean[key] = value;
      }
    }
    return { prefs: clean, migrated: migrated === true };
  } catch {
    return emptySettings();
  }
}

// In-memory copy after the first read, keyed by path so a changed
// `$ARTISIGN_HOME` (tests, a restarted daemon in-process) never serves stale
// state. Writes are serialized through one chain: no lost update.
let cache: { path: string; settings: Settings } | undefined;
let chain: Promise<unknown> = Promise.resolve();

async function load(): Promise<Settings> {
  const path = settingsPath();
  if (cache?.path !== path) cache = { path, settings: await readFromDisk(path) };
  return cache.settings;
}

export async function readSettings(): Promise<Settings> {
  const run = chain.then(load);
  chain = run.catch(() => undefined);
  return structuredClone(await run);
}

/**
 * Applies `mutate` to a copy of the current settings, persists the result and
 * returns it. `mutate` may throw to reject the update; nothing is written then.
 */
export function updateSettings(mutate: (current: Settings) => Settings): Promise<Settings> {
  const run = chain.then(async () => {
    const current = await load();
    const next = mutate(structuredClone(current));
    await atomicWrite(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
    cache = { path: settingsPath(), settings: next };
    return structuredClone(next);
  });
  chain = run.catch(() => undefined);
  return run;
}
