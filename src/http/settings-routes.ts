import type { IncomingMessage, ServerResponse } from "node:http";
import { readSettings, updateSettings, type Settings } from "../daemon/settings.js";
import { sendJson, readJsonBody, PayloadTooLargeError } from "./json.js";

const MAX_KEYS = 500;
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 10_000;

class ValidationError extends Error {}

/** Validates `{ prefs: { [key]: string | null } }`; nulls only when `allowNull`. */
function parsePrefs(body: unknown, allowNull: boolean): Record<string, string | null> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body must be an object");
  }
  const prefs = (body as Record<string, unknown>).prefs;
  if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
    throw new ValidationError("prefs must be an object");
  }
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (key === "" || key.length > MAX_KEY_LENGTH) {
      throw new ValidationError(`pref keys must be 1-${MAX_KEY_LENGTH} characters`);
    }
    if (value === null && allowNull) {
      out[key] = null;
    } else if (typeof value === "string") {
      if (value.length > MAX_VALUE_LENGTH) throw new ValidationError(`pref values must be at most ${MAX_VALUE_LENGTH} characters`);
      out[key] = value;
    } else {
      throw new ValidationError(allowNull ? "pref values must be strings or null" : "pref values must be strings");
    }
  }
  return out;
}

function merge(current: Settings, incoming: Record<string, string | null>): Settings {
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete current.prefs[key];
    else current.prefs[key] = value;
  }
  if (Object.keys(current.prefs).length > MAX_KEYS) {
    throw new ValidationError(`at most ${MAX_KEYS} prefs are allowed`);
  }
  return current;
}

/**
 * `GET /api/settings`, `POST /api/settings` (merge, null removes a key) and
 * `POST /api/settings/import` (one-time localStorage carry-over). Daemon-level
 * state — project-independent, works with zero projects open.
 */
export async function handleSettingsApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
  if (pathname === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, await readSettings());
    return true;
  }
  const isImport = pathname === "/api/settings/import";
  if (!(isImport || pathname === "/api/settings") || req.method !== "POST") return false;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { code: "validation_failed", message: err.message });
    } else {
      sendJson(res, 400, { code: "validation_failed", message: "request body is not valid JSON" });
    }
    return true;
  }

  try {
    const incoming = parsePrefs(body, !isImport);
    if (!isImport) {
      sendJson(res, 200, await updateSettings((s) => merge(s, incoming)));
      return true;
    }
    let imported = false;
    const settings = await updateSettings((s) => {
      if (s.migrated) return s;
      imported = true;
      return { ...merge(s, incoming), migrated: true };
    });
    sendJson(res, 200, { ...settings, imported });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    sendJson(res, 400, { code: "validation_failed", message: err.message });
  }
  return true;
}
