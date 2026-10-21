import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { connectClients } from "../setup/connect.js";
import { isNewer, readVersion } from "../version.js";
import { restartStaleDaemon } from "./setup.js";

type Run = { code: number; stdout: string; stderr: string };

/** Everything `runUpdate` touches outside itself, so tests need no network, npm or terminal. */
export type UpdateDeps = {
  currentVersion: string;
  /** Real path of the running CLI entry — tells npm, pnpm, bun, yarn and npx installs apart. */
  entryPath: string;
  /** Runs npm; `stream` forwards its output to stderr while it runs. */
  npm: (args: string[], stream: boolean) => Promise<Run>;
  /** Runs `artisign __repin` from the newly installed entry — the old code must not write the entries. */
  repin: (newEntry: string) => Promise<number>;
  log: (line: string) => void;
  error: (line: string) => void;
};

function run(command: string, args: string[], stream: boolean): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      if (stream) process.stderr.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
      if (stream) process.stderr.write(d);
    });
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function defaultDeps(): UpdateDeps {
  const entry = process.argv[1] ?? "";
  return {
    currentVersion: readVersion(),
    entryPath: (() => {
      try {
        return realpathSync(entry);
      } catch {
        return entry;
      }
    })(),
    npm: (args, stream) => run("npm", args, stream),
    repin: async (newEntry) => (await run(process.execPath, [newEntry, "__repin"], true)).code,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

const FIX =
  "Fix: use a Node install you own (nvm), or `npm config set prefix ~/.npm-global` and put ~/.npm-global/bin on your PATH. " +
  "Do not use sudo.";

/** How the running CLI was installed, best effort from its real path. */
function otherInstaller(entryPath: string): { name: string; command: string } | "npx" | undefined {
  if (entryPath.includes("_npx")) return "npx";
  if (entryPath.includes("/pnpm/")) return { name: "pnpm", command: "pnpm add -g artisign@latest" };
  if (entryPath.includes("/.bun/")) return { name: "bun", command: "bun add -g artisign@latest" };
  if (entryPath.includes("/yarn/"))
    return { name: "yarn", command: "yarn global add artisign@latest" };
  return undefined;
}

/** `artisign update`: installs the latest version globally, then re-pins the existing entries from the new code. */
export async function runUpdate(deps: UpdateDeps = defaultDeps()): Promise<number> {
  const other = otherInstaller(deps.entryPath);
  if (other === "npx") {
    deps.error(
      "Running through npx: npx always fetches the version pinned in the AI tool's entry, so there is nothing to update here.",
    );
    deps.error(
      "Install Artisign globally with `npm install -g artisign`, then run `artisign setup`.",
    );
    return 1;
  }
  if (other) {
    deps.log(`Artisign was installed with ${other.name}. Update it with:`);
    deps.log(`  ${other.command}`);
    deps.log("then run `artisign setup` to re-pin your AI tool entries.");
    return 0;
  }

  const view = await deps.npm(["view", "artisign", "version"], false);
  const latest = view.stdout.trim();
  if (view.code !== 0 || latest === "") {
    deps.error("Could not look up the latest version of artisign (is the network up?).");
    return 1;
  }
  if (!isNewer(latest, deps.currentVersion)) {
    deps.log(`artisign ${deps.currentVersion} is already the latest version.`);
    return 0;
  }

  deps.log(`Updating artisign ${deps.currentVersion} -> ${latest} ...`);
  const install = await deps.npm(["install", "-g", "artisign@latest"], true);
  if (install.code !== 0) {
    deps.error(
      `npm could not install artisign@latest${/EACCES/.test(install.stderr) ? " (permission denied)" : ""}. Nothing was changed.`,
    );
    deps.error(FIX);
    return 1;
  }

  const root = await deps.npm(["root", "-g"], false);
  if (root.code !== 0 || root.stdout.trim() === "") {
    deps.error(
      "Installed, but could not locate the new version to re-pin your AI tool entries. Run `artisign setup`.",
    );
    return 1;
  }
  const code = await deps.repin(join(root.stdout.trim(), "artisign", "dist", "cli", "index.js"));
  if (code !== 0) deps.error("Installed, but re-pinning the entries failed. Run `artisign setup`.");
  return code;
}

/** `artisign __repin`, run by the NEW version after an update: re-pins existing entries, restarts an older daemon. */
export async function runRepin(cliEntry: string): Promise<number> {
  const version = readVersion();
  let failed = false;
  for (const r of await connectClients({ version, onlyExisting: true })) {
    if (r.status === "done") console.log(`Re-pinned ${r.name} to artisign@${version}.`);
    else if (r.status === "failed") {
      console.error(`${r.name}: ${r.error}`);
      failed = true;
    }
  }
  const restart = await restartStaleDaemon(cliEntry, version);
  if (restart === "restarted") console.log("Restarted the running Artisign.");
  if (restart === "failed") {
    console.error("The running Artisign could not be stopped. Run `artisign stop`, then `artisign`.");
    return 1;
  }
  return failed ? 1 : 0;
}
