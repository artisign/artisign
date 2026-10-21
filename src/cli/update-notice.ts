import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { artisignHome } from "../daemon/global-config.js";
import { atomicWrite } from "../store/atomic-write.js";
import { readVersion } from "../version.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;
// The dist-tags endpoint answers with just `{"latest":"x.y.z",…}` — far smaller than the package document.
const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/artisign/dist-tags";

type Cache = { checkedAt: number; latest: string };

export type UpdateNoticeDeps = {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  error: (line: string) => void;
  fetch: typeof fetch;
  now: () => number;
  currentVersion: () => string;
};

// A cache file of its own, not a field in config.json: the daemon rewrites config.json from its own
// read-modify-write chain, and a CLI write in between would be lost or would lose theirs.
function cachePath(): string {
  return join(artisignHome(), "update-check.json");
}

function isSet(value: string | undefined): boolean {
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

async function readCache(): Promise<Cache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf-8")) as Partial<Cache>;
    return typeof parsed.checkedAt === "number" && typeof parsed.latest === "string" ? (parsed as Cache) : undefined;
  } catch {
    return undefined;
  }
}

const defaultDeps: UpdateNoticeDeps = {
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  error: (line) => console.error(line),
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  currentVersion: readVersion,
};

/**
 * Prints `New version x.y.z — run artisign update` on stderr when the npm registry has a newer release.
 * Asks the registry at most once per 24 h (result cached under ARTISIGN_HOME); a newer cached version is
 * printed straight away. Never throws and never prints on failure — it must not get in the way of `start`.
 */
export async function checkForUpdate(deps: UpdateNoticeDeps = defaultDeps): Promise<void> {
  try {
    if (isSet(deps.env.CI) || isSet(deps.env.ARTISIGN_NO_UPDATE_CHECK) || !deps.isTTY) return;

    const current = deps.currentVersion();
    const notice = (latest: string): void => deps.error(`New version ${latest} — run artisign update`);

    const cache = await readCache();
    const printedFromCache = cache !== undefined && isNewer(cache.latest, current);
    if (printedFromCache) notice(cache.latest);
    if (cache && deps.now() - cache.checkedAt < DAY_MS) return;

    const res = await deps.fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return;
    const { latest } = (await res.json()) as { latest?: unknown };
    if (typeof latest !== "string" || parseVersion(latest) === undefined) return;

    await atomicWrite(cachePath(), `${JSON.stringify({ checkedAt: deps.now(), latest })}\n`);
    if (!printedFromCache && isNewer(latest, current)) notice(latest);
  } catch {
    // offline, timeout, bad JSON, unwritable home: stay silent
  }
}
