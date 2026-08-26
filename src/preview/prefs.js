// Tolerant localStorage-backed boolean preferences. Pure functions taking
// the storage as an argument (rather than importing `localStorage`
// directly) so they can be unit-tested without a DOM/jsdom environment.

// One-time migration: the localStorage prefix used to be "uxd.",
// now it's "artisign.". `migratedRaw` is the single shared implementation
// — used by both readBoolPref and readStringPref — rather than one copy
// per reader.
const LEGACY_PREFIX = "uxd.";
const CURRENT_PREFIX = "artisign.";

/**
 * Reads the raw stored string for `key`, migrating it from the pre-rename
 * `uxd.`-prefixed key if `key` is `artisign.`-prefixed, present under the
 * legacy name, and absent under the new one: migrating means writing the
 * value under `key` and removing the legacy key, a silent one-time upgrade
 * of a human's existing preferences. Returns `null` if nothing is found
 * (under either name) or storage throws. Only does raw string lookup —
 * callers own value validation (e.g. readBoolPref's "true"/"false" check).
 *
 * @param {Storage} storage
 * @param {string} key
 * @returns {string | null}
 */
function migratedRaw(storage, key) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw !== null) return raw;
  if (!key.startsWith(CURRENT_PREFIX)) return null;
  const legacyKey = LEGACY_PREFIX + key.slice(CURRENT_PREFIX.length);
  let legacyRaw;
  try {
    legacyRaw = storage.getItem(legacyKey);
  } catch {
    return null;
  }
  if (legacyRaw === null) return null;
  try {
    storage.setItem(key, legacyRaw);
    storage.removeItem(legacyKey);
  } catch {
    // ignore — persistence is best-effort, still return the migrated value
  }
  return legacyRaw;
}

/**
 * Reads a boolean preference, falling back on a missing key, a value that
 * isn't the stored "true"/"false" format, or a storage that's unavailable
 * or throws (private browsing, disabled storage, etc).
 *
 * @param {Storage | null | undefined} storage
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function readBoolPref(storage, key, fallback) {
  if (!storage) return fallback;
  const raw = migratedRaw(storage, key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/**
 * Writes a boolean preference, swallowing any error (quota exceeded,
 * storage disabled, etc) — a failed write just means the preference isn't
 * persisted, not a functional failure.
 *
 * @param {Storage | null | undefined} storage
 * @param {string} key
 * @param {boolean} value
 */
export function writeBoolPref(storage, key, value) {
  if (!storage) return;
  try {
    storage.setItem(key, String(value));
  } catch {
    // ignore — persistence is best-effort
  }
}

/**
 * Reads a string preference, falling back on a missing key or a storage
 * that's unavailable or throws. No validation — callers whose value must be
 * one of a fixed set (zoom, view) parse the result themselves.
 *
 * See `migratedRaw` for the `uxd.` -> `artisign.` legacy-key migration
 * applied here.
 *
 * @param {Storage | null | undefined} storage
 * @param {string} key
 * @param {string | null} fallback
 * @returns {string | null}
 */
export function readStringPref(storage, key, fallback) {
  if (!storage) return fallback;
  const raw = migratedRaw(storage, key);
  return raw === null ? fallback : raw;
}

/**
 * Writes a string preference, swallowing any error (quota exceeded, storage
 * disabled, etc) — a failed write just means the preference isn't
 * persisted, not a functional failure.
 *
 * @param {Storage | null | undefined} storage
 * @param {string} key
 * @param {string} value
 */
export function writeStringPref(storage, key, value) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // ignore — persistence is best-effort
  }
}

/**
 * Picks which screen to open on boot/project-switch: the persisted screen
 * if it still exists among the project's current screens, otherwise the
 * graceful fallback — the first screen (or `null` if the project has none).
 *
 * @param {{ name: string }[]} screens
 * @param {string | null} persisted
 * @returns {string | null}
 */
export function pickInitialScreen(screens, persisted) {
  if (persisted !== null && screens.some((s) => s.name === persisted)) return persisted;
  return screens[0]?.name ?? null;
}

/**
 * Parses a persisted zoom value ("fit" or a positive number, stringified),
 * falling back on anything else — a missing key, a value from an older/
 * incompatible format, or a non-positive/non-finite number.
 *
 * @param {string | null} raw
 * @param {"fit" | number} fallback
 * @returns {"fit" | number}
 */
export function parseZoomPref(raw, fallback) {
  if (raw === "fit") return "fit";
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Parses the persisted last-selection value for a project (see
 * `lastScreenKey` in app.js): either a plain screen name — the historical
 * format, kept for backwards compatibility — or a `mockup:<name>`-prefixed
 * one for a selected mockup.
 *
 * @param {string | null} raw
 * @returns {{ kind: "screen" | "mockup", name: string } | null}
 */
export function parseLastSelection(raw) {
  if (raw === null) return null;
  if (raw.startsWith("mockup:")) {
    const name = raw.slice("mockup:".length);
    return name.length > 0 ? { kind: "mockup", name } : null;
  }
  return { kind: "screen", name: raw };
}

/**
 * Parses a persisted value that must be one of a fixed set of strings
 * (view, mode), falling back on anything else — a missing key or a value
 * that's no longer one of the allowed options.
 *
 * @param {string | null} raw
 * @param {readonly string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
export function parseEnumPref(raw, allowed, fallback) {
  return raw !== null && allowed.includes(raw) ? raw : fallback;
}
