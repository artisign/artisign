import { startDaemon, type StartDaemonOptions } from "../daemon/start.js";

/**
 * Runs the daemon in the foreground until SIGINT/SIGTERM. Used directly by
 * `serve` and, detached, as the process body spawned by `start` (as the
 * hidden `__daemon` subcommand).
 */
export async function runDaemonForeground(opts: StartDaemonOptions): Promise<void> {
  try {
    const daemon = await startDaemon(opts);
    console.log(`artisign serving on http://127.0.0.1:${daemon.port}`);

    const shutdown = (): void => {
      void daemon.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
