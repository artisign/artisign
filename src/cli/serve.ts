import { runDaemonForeground } from "./daemon-foreground.js";

export async function runServe(dir: string): Promise<void> {
  await runDaemonForeground({ projects: [dir] });
}
