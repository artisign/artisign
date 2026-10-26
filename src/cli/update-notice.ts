import { readVersion } from "../version.js";
import { fetchLatest, isCacheFresh, isNewer, isSet, readUpdateCache } from "../update-check.js";

export { isNewer };

export type UpdateNoticeDeps = {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  error: (line: string) => void;
  fetch: typeof fetch;
  now: () => number;
  currentVersion: () => string;
};

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

    const cache = await readUpdateCache();
    const printedFromCache = cache !== undefined && isNewer(cache.latest, current);
    if (printedFromCache) notice(cache.latest);
    if (isCacheFresh(cache, deps.now())) return;

    const latest = await fetchLatest(deps);
    if (latest !== undefined && !printedFromCache && isNewer(latest, current)) notice(latest);
  } catch {
    // offline, timeout, bad JSON, unwritable home: stay silent
  }
}
