import { findRunningDaemon } from "../daemon/lock.js";
import { CLIENTS, defaultClientEnv, type Client, type ClientEnv, type Detection } from "./clients.js";

export type DetectedClient = { client: Client } & Detection;

/** The clients found on this machine, and whether each already has an `artisign` entry. */
export async function detectClients(env: ClientEnv = defaultClientEnv(), clients: Client[] = CLIENTS): Promise<DetectedClient[]> {
  const detected: DetectedClient[] = [];
  for (const client of clients) {
    const detection = await client.detect(env);
    if (detection.found) detected.push({ client, ...detection });
  }
  return detected;
}

export type ConnectOptions = {
  /** The version the entries pin — the version of the package running setup. */
  version: string;
  /** Only re-pin clients that already have an `artisign` entry (what `update` wants). */
  onlyExisting?: boolean;
  /** Asked once per candidate client; omitted means yes. */
  confirm?: (client: Client) => Promise<boolean>;
  env?: ClientEnv;
  clients?: Client[];
};

export type ConnectResult = { name: string; status: "done" | "skipped" | "failed"; error?: string };

/** Writes the pinned `artisign` entry into every detected (and confirmed) client. Callable from `setup` and `update`. */
export async function connectClients(opts: ConnectOptions): Promise<ConnectResult[]> {
  const env = opts.env ?? defaultClientEnv();
  const results: ConnectResult[] = [];
  for (const { client, hasEntry } of await detectClients(env, opts.clients)) {
    if ((opts.onlyExisting && !hasEntry) || (opts.confirm && !(await opts.confirm(client)))) {
      results.push({ name: client.name, status: "skipped" });
      continue;
    }
    try {
      await client.write(env, opts.version);
      results.push({ name: client.name, status: "done" });
    } catch (err) {
      results.push({ name: client.name, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** Removes the `artisign` entry from every detected client that has one. */
export async function disconnectClients(env: ClientEnv = defaultClientEnv(), clients: Client[] = CLIENTS): Promise<ConnectResult[]> {
  const results: ConnectResult[] = [];
  for (const { client, hasEntry } of await detectClients(env, clients)) {
    if (!hasEntry) continue;
    try {
      await client.remove(env);
      results.push({ name: client.name, status: "done" });
    } catch (err) {
      results.push({ name: client.name, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** The version a running daemon reports on `/health`, or undefined when none runs (or it predates the field). */
export async function runningDaemonVersion(): Promise<{ port: number; version?: string } | undefined> {
  const lock = await findRunningDaemon();
  if (!lock) return undefined;
  try {
    const body = (await (await fetch(`http://127.0.0.1:${lock.port}/health`)).json()) as { version?: string };
    return { port: lock.port, version: body.version };
  } catch {
    return undefined;
  }
}
