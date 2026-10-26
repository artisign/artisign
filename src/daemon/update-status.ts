import { isNewer, isSet, latestVersion as defaultLatestVersion } from "../update-check.js";
import { readVersion } from "../version.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type UpdateStatus = { updateCheck: "on" | "off"; latest?: string; updateAvailable: boolean };

export type UpdateChecker = {
  /** Checks once now, then every 24 h. A no-op when the check is disabled. Resolves when the first check is done. */
  start: () => Promise<void>;
  /** Stops the timer. */
  stop: () => void;
  status: () => UpdateStatus;
};

export type UpdateCheckerDeps = {
  env: NodeJS.ProcessEnv;
  /** The version this process started with (CHR-886) — not re-read, so a replaced package.json can't change it. */
  currentVersion: string;
  latestVersion: () => Promise<string | undefined>;
  setInterval: (callback: () => void, ms: number) => { unref: () => unknown };
};

/**
 * Keeps the newest published version in memory for `/api/about`. Disabled entirely (no network, `updateCheck: "off"`)
 * when `CI` or `ARTISIGN_NO_UPDATE_CHECK` is set, like the CLI's update notice.
 */
export function createUpdateChecker(deps: Partial<UpdateCheckerDeps> = {}): UpdateChecker {
  const env = deps.env ?? process.env;
  const currentVersion = deps.currentVersion ?? readVersion();
  const latestVersion = deps.latestVersion ?? defaultLatestVersion;
  const schedule = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const enabled = !(isSet(env.CI) || isSet(env.ARTISIGN_NO_UPDATE_CHECK));

  let latest: string | undefined;
  let timer: { unref: () => unknown } | undefined;

  const check = async (): Promise<void> => {
    latest = (await latestVersion().catch(() => undefined)) ?? latest;
  };

  return {
    async start() {
      if (!enabled || timer !== undefined) return;
      timer = schedule(() => void check(), DAY_MS);
      timer.unref();
      await check();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer as unknown as NodeJS.Timeout);
      timer = undefined;
    },
    status() {
      if (!enabled) return { updateCheck: "off", updateAvailable: false };
      return {
        updateCheck: "on",
        ...(latest !== undefined ? { latest } : {}),
        updateAvailable: latest !== undefined && isNewer(latest, currentVersion),
      };
    },
  };
}
