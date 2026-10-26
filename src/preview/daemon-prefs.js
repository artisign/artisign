// Daemon-backed preview preferences (CHR-924). prefs.js reads and writes through a `Storage`-shaped object; this module supplies one whose truth is the daemon's settings.json: an in-memory map seeded from GET /api/settings, with every change sent back as one coalesced POST.

import { fetchSettings, saveSettings, importSettings } from "./api.js";

const CURRENT_PREFIX = "artisign.";
const LEGACY_PREFIX = "uxd.";
// The daemon's limits (src/http/settings-routes.ts). The carry-over skips anything beyond them: one oversized value must not fail the import and leave the settings unmigrated on every boot.
const MAX_KEYS = 500;
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 10_000;

/**
 * A `Storage`-shaped adapter over an in-memory map. Writes are visible at once and flushed to `save` in a microtask, so a burst of changes becomes one request; flushes are chained so the daemon sees them in order. `save` is null for the offline fallback (nothing persisted).
 *
 * @param {Record<string, string>} initial
 * @param {((changes: Record<string, string | null>) => Promise<unknown>) | null} save
 * @returns {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void, setFromDaemon(key: string, value: string | null): void }} `setFromDaemon` takes over a value another tab or browser wrote (read back from the daemon) without sending it again; it yields to a local write that is not yet saved
 */
export function createDaemonStorage(initial, save) {
  const map = new Map(Object.entries(initial));
  let pending = null;
  let chain = Promise.resolve();
  let saving = 0;

  function queue(key, value) {
    if (!save) return;
    if (!pending) {
      pending = {};
      queueMicrotask(() => {
        const changes = pending;
        pending = null;
        saving++;
        chain = chain.then(() => save(changes)).catch(() => {}).finally(() => saving--);
      });
    }
    pending[key] = value;
  }

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem(key, value) {
      const str = String(value);
      map.set(key, str);
      queue(key, str);
    },
    removeItem(key) {
      map.delete(key);
      queue(key, null);
    },
    setFromDaemon(key, value) {
      if (pending || saving > 0) return; // our own change is on its way; the daemon's answer may predate it
      if (value === null) map.delete(key);
      else map.set(key, value);
    },
  };
}

/**
 * The prefs this browser's localStorage holds: every `artisign.` key, plus legacy `uxd.` keys mapped to `artisign.` unless the new name exists.
 *
 * @param {Storage | null} local
 * @returns {Record<string, string>}
 */
export function collectLocalPrefs(local) {
  const out = {};
  if (!local) return out;
  try {
    const legacy = {};
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i);
      if (key === null) continue;
      const value = local.getItem(key);
      if (value === null) continue;
      if (key.startsWith(CURRENT_PREFIX)) out[key] = value;
      else if (key.startsWith(LEGACY_PREFIX)) legacy[CURRENT_PREFIX + key.slice(LEGACY_PREFIX.length)] = value;
    }
    for (const [key, value] of Object.entries(legacy)) if (!(key in out)) out[key] = value;
    for (const [key, value] of Object.entries(out)) {
      if (key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) delete out[key];
    }
    for (const key of Object.keys(out).slice(MAX_KEYS)) delete out[key];
  } catch {
    // ignore — a localStorage that throws simply has nothing to carry over
  }
  return out;
}

/**
 * Loads the daemon settings and returns the storage the preview reads its prefs from. Unmigrated settings trigger the one-time carry-over of `local`'s prefs (localStorage is left as it is — only the theme mirror is rewritten — so a downgrade still finds them). If the settings cannot be loaded the result is an in-memory storage with no persistence — defaults apply.
 *
 * @param {Storage | null} local
 * @returns {Promise<ReturnType<typeof createDaemonStorage>>}
 */
export async function loadDaemonStorage(local) {
  const settings = await fetchSettings();
  if (!settings) return createDaemonStorage({}, null);
  if (settings.migrated) return createDaemonStorage(settings.prefs, saveSettings);
  const collected = collectLocalPrefs(local);
  const imported = await importSettings(collected);
  // A migrated response is the daemon's truth (it may have kept prefs another browser carried over first); anything else falls back to what we sent.
  return createDaemonStorage(imported?.migrated ? imported.prefs : collected, saveSettings);
}
