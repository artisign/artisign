import { initProject } from "../init/init-project.js";
import { runServe } from "./serve.js";
import { runMcp } from "./mcp.js";
import { runDaemonForeground } from "./daemon-foreground.js";
import { runStart, type StartOptions } from "./start.js";
import { runStop } from "./stop.js";
import { runStatus } from "./status.js";
import { parseStartArgs } from "./args.js";

export const USAGE = [
  "Usage: artisign [start] [--port N] [--no-open] [dir...]",
  "       artisign <init|stop|status|serve|mcp> [options] [dir]",
  "",
  "  (no command)                same as start",
  "  init [dir]                  scaffold a new project",
  "  start [--port N] [--no-open] [dir...]",
  "                              start the daemon in the background and open the preview in the",
  "                              browser (--no-open or ARTISIGN_NO_OPEN=1 to skip)",
  "  status                      pid, port, open projects",
  "  stop                        stop the daemon",
  "  serve [--port N] [dir...]   run the daemon in the foreground",
  "  mcp [dir]                   stdio MCP server for Claude Desktop / Claude Code",
  "",
  "Without --port the port comes from the config in ARTISIGN_HOME, else 4711.",
].join("\n");

export type CliDeps = {
  initProject: (dir: string) => Promise<unknown>;
  runServe: typeof runServe;
  runMcp: (dir: string) => Promise<void>;
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
  const [command, ...rest] = argv;

  // Anywhere in the line, not just as the command — `serve --help` is at
  // least as likely a way to discover the flags as `artisign --help`, and
  // the option guard in parseStartArgs would otherwise reject it.
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.log(USAGE);
    return 0;
  }

  if (command === undefined || command.startsWith("-")) {
    const { port, projects, noOpen } = parseStart(argv);
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
      await deps.runMcp(rest[0] ?? ".");
      return 0;
    case "start": {
      const { port, projects, noOpen } = parseStart(rest);
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
      deps.error(USAGE);
      return 1;
  }
}
