import { startDaemon, type StartDaemonOptions } from "../daemon/start.js";

/**
 * Runs the daemon in the foreground until SIGINT/SIGTERM. Used directly by
 * `serve` and, detached, as the process body spawned by `start` (as the
 * hidden `__daemon` subcommand).
 */
export async function runDaemonForeground(opts: StartDaemonOptions): Promise<void> {
  try {
    // Only declared here, assigned below: the request handler can fire only after startDaemon resolved.
    let shutdown = (): void => {};
    const daemon = await startDaemon({ ...opts, onShutdownRequest: () => shutdown() });
    console.log(`artisign serving on http://127.0.0.1:${daemon.port}`);

    shutdown = (): void => {
      void daemon.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Windows: Ctrl+Break. (Ctrl+C arrives as SIGINT there too.)
    if (process.platform === "win32") process.on("SIGBREAK", shutdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
