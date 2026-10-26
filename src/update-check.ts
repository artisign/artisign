import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { artisignHome } from "./daemon/global-config.js";
import { atomicWrite } from "./store/atomic-write.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;
// The dist-tags endpoint answers with just `{"latest":"x.y.z",…}` — far smaller than the package document.
const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/artisign/dist-tags";

export type UpdateCheckCache = { checkedAt: number; latest: string };

export type UpdateCheckDeps = {
  fetch: typeof fetch;
  now: () => number;
};

export const defaultUpdateCheckDeps: UpdateCheckDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
};

// A cache file of its own, not a field in config.json: the daemon rewrites config.json from its own
// read-modify-write chain, and a CLI write in between would be lost or would lose theirs.
function cachePath(): string {
  return join(artisignHome(), "update-check.json");
}

/** True for a set, non-falsy environment value (`1`, `true`, …); empty, `0` and `false` count as unset. */
export function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function parseVersion(version: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** True when `latest` is a plain x.y.z strictly above `current`'s x.y.z (prereleases are ignored). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current.split(/[-+]/)[0]!);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export async function readUpdateCache(): Promise<UpdateCheckCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf-8")) as Partial<UpdateCheckCache>;
    return typeof parsed.checkedAt === "number" && typeof parsed.latest === "string" ? (parsed as UpdateCheckCache) : undefined;
  } catch {
    return undefined;
  }
}

/** A checkedAt in the future (clock was ahead when it was written) counts as stale, not as fresh forever. */
export function isCacheFresh(cache: UpdateCheckCache | undefined, now: number): boolean {
  if (cache === undefined) return false;
  const age = now - cache.checkedAt;
  return age >= 0 && age < DAY_MS;
}

/** Asks the registry for the latest version and caches it. Undefined on any failure; never throws. */
export async function fetchLatest(deps: UpdateCheckDeps = defaultUpdateCheckDeps): Promise<string | undefined> {
  try {
    // Not aborted when a CLI command finishes: a running daemon makes `start` return within a millisecond,
    // which would cancel every check. At most once a day the exit waits for this request (≤ TIMEOUT_MS).
    const res = await deps.fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const { latest } = (await res.json()) as { latest?: unknown };
    if (typeof latest !== "string" || parseVersion(latest) === undefined) return undefined;
    await atomicWrite(cachePath(), `${JSON.stringify({ checkedAt: deps.now(), latest })}\n`);
    return latest;
  } catch {
    // offline, timeout, bad JSON, unwritable home
    return undefined;
  }
}

/**
 * The latest published version: the cached one while it is under 24 h old, else a fresh registry answer (cached),
 * else the stale cached value, else undefined. Never throws.
 */
export async function latestVersion(deps: UpdateCheckDeps = defaultUpdateCheckDeps): Promise<string | undefined> {
  const cache = await readUpdateCache();
  if (cache !== undefined && isCacheFresh(cache, deps.now())) return cache.latest;
  return (await fetchLatest(deps)) ?? cache?.latest;
}
