import { createInterface } from "node:readline/promises";
import { defaultClientEnv, CLIENTS, type Client, type ClientEnv } from "../setup/clients.js";
import { detectClients } from "../setup/connect.js";
import { readGlobalConfig, writeGlobalConfig } from "../daemon/global-config.js";
import { runSetup } from "./setup.js";

export type OfferSetupDeps = {
  env: ClientEnv;
  clients: Client[];
  /** Both ends are a terminal: there is somebody to ask. */
  isTTY: boolean;
  processEnv: NodeJS.ProcessEnv;
  ask: (question: string) => Promise<string>;
  runSetup: (cliEntry: string) => Promise<unknown>;
  isDeclined: () => Promise<boolean>;
  rememberDecline: () => Promise<void>;
};

const defaultDeps: OfferSetupDeps = {
  env: defaultClientEnv(),
  clients: CLIENTS,
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  processEnv: process.env,
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  runSetup: (cliEntry) => runSetup({ yes: true, cliEntry }),
  isDeclined: async () => (await readGlobalConfig()).setupDeclined === true,
  rememberDecline: async () =>
    writeGlobalConfig({ ...(await readGlobalConfig()), setupDeclined: true }),
};

function names(list: string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function ciSet(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

/**
 * On `start`: when a terminal is attached, CI is off, an AI tool is installed but none has an `artisign` entry, and the
 * user has not said no before, asks once whether to connect them. "No" is remembered in the global config.
 */
export async function offerSetup(
  cliEntry: string,
  deps: OfferSetupDeps = defaultDeps,
): Promise<void> {
  if (!deps.isTTY || ciSet(deps.processEnv) || (await deps.isDeclined())) return;
  const detected = await detectClients(deps.env, deps.clients);
  if (detected.length === 0 || detected.some((d) => d.hasEntry)) return;
  const answer = await deps.ask(
    `Connect Artisign to ${names(detected.map((d) => d.client.name))} now? [Y/n] `,
  );
  if (/^n/i.test(answer.trim())) await deps.rememberDecline();
  else await deps.runSetup(cliEntry);
}
