import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, isAbsolute, sep } from "node:path";
import { CLIENTS, defaultClientEnv, type ClientEnv, type Manual } from "../setup/clients.js";
import { sendJson } from "./json.js";

type ClientStatus = { name: string; found: boolean; connected: boolean; manual: Manual };

/** Shows a path under the home directory as `~/…`. */
function tildify(path: string, home: string): string {
  const rel = relative(home, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
  return `~${sep}${rel}`;
}

/**
 * `GET /api/setup` — which AI tools are installed and connected, plus what to
 * copy to connect each by hand. Copy-only: nothing here writes a client's
 * config (`detect` and `manual` only touch the filesystem to look, and spawn
 * no programs). Project-independent.
 */
export async function handleSetupApi(
  req: IncomingMessage,
  res: ServerResponse,
  version: string,
  env: ClientEnv = defaultClientEnv(),
): Promise<boolean> {
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/api/setup" || req.method !== "GET") return false;
  const clients: ClientStatus[] = [];
  for (const client of CLIENTS) {
    const { found, hasEntry } = await client.detect(env);
    const manual = await client.manual(env, version);
    clients.push({
      name: client.name,
      found,
      connected: hasEntry,
      manual: manual.kind === "config" && manual.path !== undefined ? { ...manual, path: tildify(manual.path, env.home) } : manual,
    });
  }
  sendJson(res, 200, { command: "artisign setup", clients });
  return true;
}
