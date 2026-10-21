import { initProject } from "../init/init-project.js";
import { runServe } from "./serve.js";
import { runMcp } from "./mcp.js";
import { runDaemonForeground } from "./daemon-foreground.js";
import { runStart, type StartOptions } from "./start.js";
import { runStop } from "./stop.js";
import { runStatus } from "./status.js";
import { parseStartArgs } from "./args.js";
import { runSetup, type SetupOptions } from "./setup.js";
import { runUpdate, runRepin } from "./update.js";
import { offerSetup } from "./offer-setup.js";
import { readVersion } from "../version.js";

export const USAGE = [
  "Artisign: a local design tool your AI tool drives and you review in the browser.",
  "",
  "Get started:",
  "  1. Install once:   npm install -g artisign",
  "  2. Run `artisign`  (starts Artisign and, on first run, connects your AI tool)",
  "  3. Ask your AI tool to create or open a project",
  "",
  "Update: `artisign update`",
  "",
  "Usage: artisign [command] [options]",
  "",
  "Commands:",
  "  start [--port N] [--no-open] [dir...]   start in the background and open the preview (the default)",
  "  status                                  pid, port, open projects",
  "  stop                                    stop the background process",
  "  serve [--port N] [dir...]               run in the foreground",
  "  init [dir]                              scaffold a new project",
  "  setup [--yes] [--remove]                connect your AI tools to Artisign (or disconnect them)",
  "  update                                  install the latest version and re-pin your AI tool entries",
  "  mcp                                     stdio connection for AI tools; starts Artisign if needed",
  "  help [command]                          show this help, or the help of one command",
  "",
  "Options:",
  "  -h, --help      show help (also: artisign <command> --help)",
  "  -v, --version   print the version",
  "",
  "A project is a folder holding your screens, design system and comments as plain files.",
  "Without --port the port comes from the config in ARTISIGN_HOME, else 4711.",
].join("\n");

/** Per-command help, keyed by command name. A command that has no entry here falls back to the top-level help. */
export const COMMAND_HELP: Record<string, string> = {
  start: [
    "Usage: artisign start [--port N] [--no-open] [dir...]",
    "",
    "Start Artisign in the background and open the preview in the browser. This is what a bare",
    "`artisign` does. Each dir is a project to open; without one, the preview opens with the project list.",
    "",
    "Options:",
    "  --port N     listen on this port (default: the port from the config, else 4711)",
    "  --no-open    do not open the browser (or set ARTISIGN_NO_OPEN=1)",
    "",
    "Example:",
    "  artisign start --no-open ./my-project",
  ].join("\n"),
  serve: [
    "Usage: artisign serve [--port N] [dir...]",
    "",
    "Run Artisign in the foreground, logging to the terminal. Stop it with Ctrl+C.",
    "",
    "Options:",
    "  --port N     listen on this port (default: the port from the config, else 4711)",
    "",
    "Example:",
    "  artisign serve --port 4800 ./my-project",
  ].join("\n"),
  init: [
    "Usage: artisign init [dir]",
    "",
    "Scaffold an empty project (artisign.json, design system, screens) in dir, default the current folder.",
    "",
    "Example:",
    "  artisign init ./my-project",
  ].join("\n"),
  mcp: [
    "Usage: artisign mcp",
    "",
    "Stdio connection for AI tools such as Claude Desktop and Claude Code. It forwards every MCP message to",
    "the running Artisign and starts it if it is not running. Your AI tool launches this; you rarely run it.",
    "It takes no project directory: the project is named per tool call.",
    "",
    "Example:",
    "  npx -y artisign@<version> mcp   (the entry `artisign setup` writes into your AI tool's config)",
  ].join("\n"),
  setup: [
    "Usage: artisign setup [--yes] [--remove]",
    "",
    "Connect your AI tools to Artisign (Claude Code, Claude Desktop, Cursor, Codex CLI, VS Code, opencode). For each one found, asks, then writes a user-level",
    "entry named `artisign` that runs `npx -y artisign@<version> mcp`, pinned to the version running setup.",
    "Run it again after an update to re-pin. Other entries and settings are left untouched.",
    "",
    "Options:",
    "  --yes      connect every tool found without asking (needed without a terminal)",
    "  --remove   remove the `artisign` entries instead",
    "",
    "Example:",
    "  artisign setup",
  ].join("\n"),
  update: [
    "Usage: artisign update",
    "",
    "Install the latest artisign globally (`npm install -g artisign@latest`), then re-pin the `artisign` entries",
    "in your AI tools to it and restart a running Artisign. Does nothing when you are already on the latest version.",
    "Also available as `artisign --update`. Installed with pnpm, bun or yarn, it prints the matching command instead.",
    "",
    "Example:",
    "  artisign update",
  ].join("\n"),
  status: [
    "Usage: artisign status",
    "",
    "Print the pid, the port and the open projects of the running background process.",
    "",
    "Example:",
    "  artisign status",
  ].join("\n"),
  stop: [
    "Usage: artisign stop",
    "",
    "Stop the background process started by `artisign start`.",
    "",
    "Example:",
    "  artisign stop",
  ].join("\n"),
};

const HINT = "Run `artisign help` for usage.";

export type CliDeps = {
  initProject: (dir: string) => Promise<unknown>;
  runServe: typeof runServe;
  runMcp: (cliEntry: string) => Promise<void>;
  runSetup: (opts: SetupOptions) => Promise<number>;
  runUpdate: () => Promise<number>;
  runRepin: (cliEntry: string) => Promise<void>;
  /** First-run offer to connect an AI tool; asks at most once, only on `start` / bare `artisign`. */
  offerSetup: (cliEntry: string) => Promise<void>;
  runDaemonForeground: typeof runDaemonForeground;
  runStart: (opts: StartOptions) => Promise<void>;
  runStop: () => Promise<void>;
  runStatus: () => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
};

export const defaultCliDeps: CliDeps = {
  initProject,
  runServe,
  runMcp,
  runSetup,
  runUpdate,
  runRepin,
  offerSetup,
  runDaemonForeground,
  runStart,
  runStop,
  runStatus,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Splits `--no-open` out of the arguments `start` takes; everything else goes to `parseStartArgs`. */
function parseStart(argv: string[]): { port?: number; projects: string[]; noOpen: boolean } {
  const noOpen = argv.includes("--no-open");
  const { port, projects } = parseStartArgs(argv.filter((arg) => arg !== "--no-open"));
  return { port, projects, noOpen };
}

/**
 * Runs one CLI invocation and returns the exit code (the entry point sets it). A bare `artisign` — no command, or an
 * option first (`artisign --port 4800 ./proj`) — is `artisign start` with the same arguments; a bare path as the
 * first argument is not, and is an unknown command like any other word.
 */
export async function dispatch(argv: string[], cliEntry: string, deps: CliDeps = defaultCliDeps): Promise<number> {
  const [first, ...rest] = argv;
  const command = first === "--update" ? "update" : first;

  if (command === "--version" || command === "-v") {
    deps.log(readVersion());
    return 0;
  }

  if (command === "help") {
    const topic = rest[0];
    if (topic === undefined) {
      deps.log(USAGE);
      return 0;
    }
    return printCommandHelp(topic, deps);
  }

  // Anywhere in the line, not just as the command — `serve --help` is at
  // least as likely a way to discover the flags as `artisign --help`, and
  // the option guard in parseStartArgs would otherwise reject it.
  if (argv.includes("--help") || argv.includes("-h")) {
    if (command !== undefined && !command.startsWith("-")) return printCommandHelp(command, deps);
    deps.log(USAGE);
    return 0;
  }

  try {
    return await run(command, rest, argv, cliEntry, deps);
  } catch (err) {
    // A mistyped option is a usage mistake, not a crash: one line and a pointer, not a stack or the full usage.
    if (err instanceof Error && err.message.startsWith("Unknown option:")) {
      deps.error(err.message);
      deps.error(HINT);
      return 1;
    }
    throw err;
  }
}

function printCommandHelp(command: string, deps: CliDeps): number {
  const text = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (text === undefined) {
    deps.error(`Unknown command: ${command}`);
    deps.error(HINT);
    return 1;
  }
  deps.log(text);
  return 0;
}

async function run(
  command: string | undefined,
  rest: string[],
  argv: string[],
  cliEntry: string,
  deps: CliDeps,
): Promise<number> {
  if (command === undefined || command.startsWith("-")) {
    const { port, projects, noOpen } = parseStart(argv);
    await deps.offerSetup(cliEntry);
    await deps.runStart({ port, projects, cliEntry, noOpen });
    return 0;
  }

  switch (command) {
    case "init":
      await deps.initProject(rest[0] ?? ".");
      deps.log(`Initialized Artisign project in ${rest[0] ?? "."}`);
      return 0;
    case "serve": {
      const { port, projects } = parseStartArgs(rest);
      await deps.runServe({ port, projects });
      return 0;
    }
    case "mcp":
      if (rest.length > 0) {
        deps.error("`artisign mcp` no longer takes a project directory: the project is named per tool call.");
        deps.error("Run `artisign setup` to connect your AI tool.");
        return 1;
      }
      await deps.runMcp(cliEntry);
      return 0;
    case "setup": {
      const unexpected = rest.find((arg) => arg !== "--yes" && arg !== "--remove");
      if (unexpected !== undefined) {
        deps.error(`Unknown option: ${unexpected}`);
        deps.error(HINT);
        return 1;
      }
      return deps.runSetup({ yes: rest.includes("--yes"), remove: rest.includes("--remove"), cliEntry });
    }
    case "update":
      if (rest.length > 0) {
        deps.error(`Unknown option: ${rest[0]}`);
        deps.error(HINT);
        return 1;
      }
      return deps.runUpdate();
    // Internal: run by the freshly installed version at the end of `update`.
    case "__repin":
      await deps.runRepin(cliEntry);
      return 0;
    case "start": {
      const { port, projects, noOpen } = parseStart(rest);
      await deps.offerSetup(cliEntry);
      await deps.runStart({ port, projects, cliEntry, noOpen });
      return 0;
    }
    case "stop":
      await deps.runStop();
      return 0;
    case "status":
      await deps.runStatus();
      return 0;
    // Internal: spawned detached by `start`, not for direct use.
    case "__daemon": {
      const { port, projects } = parseStartArgs(rest);
      await deps.runDaemonForeground({ port, projects });
      return 0;
    }
    default:
      deps.error(`Unknown command: ${command}`);
      deps.error(HINT);
      return 1;
  }
}
