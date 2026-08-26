import { runDaemonForeground } from "./daemon-foreground.js";

export async function runServe(opts: { port?: number; projects: string[] }): Promise<void> {
  await runDaemonForeground({
    port: opts.port,
    projects: opts.projects.length > 0 ? opts.projects : ["."],
  });
}
