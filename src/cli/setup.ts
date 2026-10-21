import { createInterface } from "node:readline/promises";
import { CLIENTS, defaultClientEnv, type Client, type ClientEnv } from "../setup/clients.js";
import { connectClients, detectClients, disconnectClients, runningDaemonVersion } from "../setup/connect.js";
import { readVersion } from "../version.js";
import { runStart } from "./start.js";
import { runStop } from "./stop.js";

export type SetupOptions = {
  /** Accept every detected client without asking. */
  yes?: boolean;
  /** Remove the `artisign` entries instead of writing them. */
  remove?: boolean;
  cliEntry: string;
};

/** Everything `runSetup` touches outside itself, so tests need no terminal, daemon or real client config. */
export type SetupDeps = {
  env: ClientEnv;
  clients: Client[];
  version: string;
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  restartDaemon: (cliEntry: string, version: string) => Promise<boolean>;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** Restarts a running daemon whose version differs from `version`, so it serves what the entries now pin. */
export async function restartStaleDaemon(cliEntry: string, version: string): Promise<boolean> {
  const daemon = await runningDaemonVersion();
  if (!daemon || daemon.version === version) return false;
  await runStop();
  await runStart({ projects: [], cliEntry, noOpen: true });
  return true;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const defaultDeps = (): SetupDeps => ({
  env: defaultClientEnv(),
  clients: CLIENTS,
  version: readVersion(),
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask,
  restartDaemon: restartStaleDaemon,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

const SUPPORTED = CLIENTS.map((c) => c.name).join(" and ");

const MANUAL = (version: string): string[] => [
  "Add this MCP server by hand in your AI tool (stdio):",
  `  command: npx    args: -y artisign@${version} mcp`,
];

const NEXT_STEPS = [
  "",
  "Next: open your AI tool and ask it to create or open a project.",
  "Run `artisign` to watch what it designs in the browser.",
];

/** `artisign setup`: connects the detected AI tools, or with `remove` disconnects them. Returns the exit code. */
export async function runSetup(opts: SetupOptions, deps: SetupDeps = defaultDeps()): Promise<number> {
  const { log, error } = deps;

  if (opts.remove) {
    const results = await disconnectClients(deps.env, deps.clients);
    if (results.length === 0) log("No artisign entry found in a supported AI tool; nothing to remove.");
    for (const r of results) log(r.status === "done" ? `Removed the artisign entry from ${r.name}.` : `${r.name}: ${r.error}`);
    return results.some((r) => r.status === "failed") ? 1 : 0;
  }

  const detected = await detectClients(deps.env, deps.clients);
  if (detected.length === 0) {
    log(`No supported AI tool found. Supported: ${SUPPORTED}.`);
    for (const line of MANUAL(deps.version)) log(line);
    return 0;
  }

  if (!opts.yes && !deps.isTTY) {
    log(`Found: ${detected.map((d) => d.client.name).join(", ")}.`);
    error("Not a terminal, so nothing was changed. Run `artisign setup` in a terminal (or add --yes).");
    return 1;
  }

  const results = await connectClients({
    version: deps.version,
    env: deps.env,
    clients: deps.clients,
    confirm: opts.yes
      ? undefined
      : async (client) => !/^n/i.test((await deps.ask(`Connect ${client.name}? [Y/n] `)).trim()),
  });
  for (const r of results) {
    if (r.status === "done") log(`Connected ${r.name} (artisign@${deps.version}).`);
    else if (r.status === "skipped") log(`Skipped ${r.name}.`);
    else error(`${r.name}: ${r.error}`);
  }

  if (results.some((r) => r.status === "done") && (await deps.restartDaemon(opts.cliEntry, deps.version))) {
    log("Restarted the running Artisign so it matches this version.");
  }
  if (results.some((r) => r.status === "failed")) return 1;
  if (results.some((r) => r.status === "done")) for (const line of NEXT_STEPS) log(line);
  return 0;
}
