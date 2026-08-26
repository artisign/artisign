#!/usr/bin/env node
import { initProject } from "../init/init-project.js";
import { runServe } from "./serve.js";
import { runMcp } from "./mcp.js";
import { runDaemonForeground } from "./daemon-foreground.js";
import { runStart } from "./start.js";
import { runStop } from "./stop.js";
import { runStatus } from "./status.js";
import { parseStartArgs } from "./args.js";

const USAGE = "Usage: artisign <init|start|stop|status|serve|mcp> [dir]";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "init":
      await initProject(rest[0] ?? ".");
      console.log(`Initialized Artisign project in ${rest[0] ?? "."}`);
      break;
    case "serve":
      await runServe(rest[0] ?? ".");
      break;
    case "mcp":
      await runMcp(rest[0] ?? ".");
      break;
    case "start": {
      const { port, projects } = parseStartArgs(rest);
      await runStart({ port, projects, cliEntry: process.argv[1] ?? "" });
      break;
    }
    case "stop":
      await runStop();
      break;
    case "status":
      await runStatus();
      break;
    // Internal: spawned detached by `start`, not for direct use.
    case "__daemon": {
      const { port, projects } = parseStartArgs(rest);
      await runDaemonForeground({ port, projects });
      break;
    }
    default:
      console.error(`Unknown command: ${command ?? "(none)"}`);
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
