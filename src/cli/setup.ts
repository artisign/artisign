import { createInterface } from "node:readline/promises";
import { CLIENTS, defaultClientEnv, type Client, type ClientEnv } from "../setup/clients.js";
import { connectClients, detectClients, disconnectClients, runningDaemonInfo } from "../setup/connect.js";
import { installSkill, readSkill, removeSkills, skillClients, skillFile, skillStatus } from "../setup/skill.js";
import { findRunningDaemon } from "../daemon/lock.js";
import { isNewer, readVersion } from "../version.js";
import { runStart } from "./start.js";
import { runStop } from "./stop.js";

export type SetupOptions = {
  /** Accept every detected client without asking. */
  yes?: boolean;
  /** Remove the `artisign` entries (and skills) instead of writing them. */
  remove?: boolean;
  /** Run only the skill step: with `remove`, remove only the skills. */
  skill?: boolean;
  cliEntry: string;
};

/** Everything `runSetup` touches outside itself, so tests need no terminal, daemon or real client config. */
export type SetupDeps = {
  env: ClientEnv;
  clients: Client[];
  version: string;
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  restartDaemon: (cliEntry: string, version: string) => Promise<RestartResult>;
  log: (line: string) => void;
  error: (line: string) => void;
};

type RestartDeps = {
  daemon: typeof runningDaemonInfo;
  stop: () => Promise<void>;
  stillRunning: () => Promise<boolean>;
  start: (opts: { port: number; projects: string[]; cliEntry: string; noOpen: boolean }) => Promise<void>;
};

export type RestartResult = "unchanged" | "restarted" | "failed";

/**
 * Restarts a running daemon that is older than `version` (or reports none), on its own port and with the projects it
 * had open. A daemon that is as new or newer is left alone: an old `npx artisign@1.x setup` must not downgrade it.
 */
export async function restartStaleDaemon(
  cliEntry: string,
  version: string,
  deps: RestartDeps = defaultRestartDeps,
): Promise<RestartResult> {
  const daemon = await deps.daemon();
  if (!daemon || (daemon.version !== undefined && !isNewer(version, daemon.version))) return "unchanged";
  return restartDaemon(cliEntry, deps);
}

const defaultRestartDeps: RestartDeps = {
  daemon: runningDaemonInfo,
  stop: runStop,
  stillRunning: async () => (await findRunningDaemon()) !== undefined,
  start: runStart,
};

/** Restarts the running daemon whatever it reports, keeping its port and open projects. A daemon that is not running stays stopped. */
export async function restartDaemon(cliEntry: string, deps: RestartDeps = defaultRestartDeps): Promise<RestartResult> {
  const daemon = await deps.daemon();
  if (!daemon) return "unchanged";
  await deps.stop();
  if (await deps.stillRunning()) return "failed";
  await deps.start({ port: daemon.port, projects: daemon.projects, cliEntry, noOpen: true });
  return "restarted";
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
    const results = opts.skill ? [] : await disconnectClients(deps.env, deps.clients);
    const skills = await removeSkills(deps.env, deps.clients);
    if (results.length === 0 && skills.length === 0) log("No artisign entry or skill found in a supported AI tool; nothing to remove.");
    for (const r of results) {
      if (r.status === "done") log(`Removed the artisign entry from ${r.name}.`);
      else error(`${r.name}: ${r.error}`);
    }
    for (const r of skills) {
      if (r.status === "done") log(`Removed the artisign skill from ${r.name}.`);
      else error(`${r.name}: ${r.error}`);
    }
    return [...results, ...skills].some((r) => r.status === "failed") ? 1 : 0;
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

  const results = opts.skill
    ? []
    : await connectClients({
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

  const skills = await installSkills(opts, deps);

  let restartFailed = false;
  if (results.some((r) => r.status === "done")) {
    const restart = await deps.restartDaemon(opts.cliEntry, deps.version);
    if (restart === "restarted") log("Restarted the running artisign so it matches this version.");
    if (restart === "failed") {
      error("The running artisign is older than this version and could not be stopped. Run `artisign stop`, then `artisign`.");
      restartFailed = true;
    }
  }
  if (restartFailed || [...results, ...skills].some((r) => r.status === "failed")) return 1;
  if ([...results, ...skills].some((r) => r.status === "done")) for (const line of NEXT_STEPS) log(line);
  return 0;
}

type SkillStepResult = { name: string; status: "done" | "skipped" | "failed" };

/** The skill step: for each detected tool with a skills folder, offers to install (or refresh) the artisign skill. `r` reads it first. */
async function installSkills(opts: SetupOptions, deps: SetupDeps): Promise<SkillStepResult[]> {
  const { log, error } = deps;
  const clients = await skillClients(deps.env, deps.clients);
  if (clients.length === 0) return [];
  const content = await readSkill();
  const results: SkillStepResult[] = [];
  for (const client of clients) {
    try {
      const { status, path } = await skillStatus(client, deps.env, content);
      if (status === "installed") {
        log(`The artisign skill in ${client.name} is up to date.`);
        continue;
      }
      let yes = opts.yes === true;
      while (!yes) {
        const answer = (await deps.ask(`Install the artisign skill for ${client.name}? [Y/n/r] `)).trim();
        if (/^r/i.test(answer)) log(content.replace(/\n$/, ""));
        else if (/^n/i.test(answer)) break;
        else yes = true;
      }
      if (!yes) {
        log(`Skipped the artisign skill for ${client.name}.`);
        results.push({ name: client.name, status: "skipped" });
        continue;
      }
      await installSkill(client, deps.env, content);
      log(`${status === "outdated" ? "Updated" : "Installed"} the artisign skill for ${client.name} (${path ?? skillFile(client, deps.env)}).`);
      results.push({ name: client.name, status: "done" });
    } catch (err) {
      error(`${client.name}: ${err instanceof Error ? err.message : String(err)}`);
      results.push({ name: client.name, status: "failed" });
    }
  }
  return results;
}
