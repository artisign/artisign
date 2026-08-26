export type ParsedStartArgs = {
  port?: number;
  projects: string[];
};

/** Parses `[--port N] [dir...]` — used by `start`, `serve` and the internal `__daemon` command. */
export function parseStartArgs(argv: string[]): ParsedStartArgs {
  const projects: string[] = [];
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--port") {
      i++;
      const value = argv[i];
      // Digits only: Number("") and Number(" ") are 0, so an unset shell
      // variable would otherwise pass as "port 0" and silently hand the
      // daemon an OS-assigned port nobody can guess.
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error("--port requires a non-negative integer value");
      }
      port = Number(value);
    } else if (arg.startsWith("--")) {
      // Without this an unknown flag would be taken for a project directory,
      // and the daemon binds its port before it ever resolves projects — so
      // the failure would surface as a confusing path error on the wrong port.
      throw new Error(`Unknown option: ${arg}`);
    } else {
      projects.push(arg);
    }
  }

  return { port, projects };
}
