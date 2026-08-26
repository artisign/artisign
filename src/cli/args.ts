export type ParsedStartArgs = {
  port?: number;
  projects: string[];
};

/** Parses `[--port N] [dir...]` — used by both `start` and the internal `__daemon` command. */
export function parseStartArgs(argv: string[]): ParsedStartArgs {
  const projects: string[] = [];
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--port") {
      i++;
      const value = argv[i];
      const parsed = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("--port requires a non-negative integer value");
      }
      port = parsed;
    } else {
      projects.push(arg);
    }
  }

  return { port, projects };
}
