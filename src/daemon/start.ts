import type { Server } from "node:http";
import { createServer } from "../http/server.js";
import { findRunningDaemon, writeLock, removeLock } from "./lock.js";
import { readGlobalConfig } from "./global-config.js";
import { ProjectRegistry, type ProjectHandle } from "./project-registry.js";
import { DEFAULT_PORT } from "../init/artisign-config.js";

export class DaemonAlreadyRunningError extends Error {
  readonly pid: number;
  readonly port: number;

  constructor(pid: number, port: number) {
    super(`Daemon already running (pid ${pid}, port ${port})`);
    this.pid = pid;
    this.port = port;
  }
}

export type StartDaemonOptions = {
  /** OS-assigned port when 0. Falls back to the global config, then DEFAULT_PORT. */
  port?: number;
  /** Project directories to open on start. Omitted or empty starts the daemon with no project open (server up, /health OK, everything else 503s). */
  projects?: string[];
};

export type DaemonHandle = {
  /** The actually-bound port — meaningful even when `port: 0` was requested. */
  port: number;
  registry: ProjectRegistry;
  stop: () => Promise<void>;
};

async function resolvePort(opts: StartDaemonOptions): Promise<number> {
  if (opts.port !== undefined) return opts.port;
  const globalConfig = await readGlobalConfig();
  return globalConfig.port ?? DEFAULT_PORT;
}

async function warnIfLegacyPortConfigured(handle: ProjectHandle): Promise<void> {
  const config = await handle.store.readArtisignConfig();
  if (config.settings.port !== undefined) {
    // Deprecated: the daemon now owns its own port (global config / opts.port).
    console.warn(`artisign.json settings.port is deprecated and ignored (project: ${handle.root})`);
  }
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const port = await resolvePort(opts);

  const running = await findRunningDaemon();
  if (running) {
    throw new DaemonAlreadyRunningError(running.pid, running.port);
  }

  // Everything from here on holds a resource (open project watchers/SSE
  // hubs, a listening socket) that a mid-startup failure — an invalid
  // second project, EADDRINUSE, a writeLock failure — must not leak: any
  // project already opened stays watching and its SSE hub stays open
  // forever with no `stop()` handle for the caller to release it through.
  const registry = new ProjectRegistry();
  let server: Server | undefined;
  try {
    // Bind the port before opening any project: a project
    // open can be a slow cold start (full index build), and there's no
    // reason that should hold the port closed — /health and the static
    // preview already work with zero projects open, and /mcp + /api/tools/*
    // work in bootstrap mode. Projects still open
    // sequentially, in `opts.projects` order, so `activeProject` (the first
    // one) stays deterministic.
    ({ server } = createServer(registry));
    const boundServer = server;

    const boundPort = await new Promise<number>((res, reject) => {
      boundServer.once("error", reject);
      boundServer.listen(port, "127.0.0.1", () => {
        const address = boundServer.address();
        res(typeof address === "object" && address ? address.port : port);
      });
    });

    // Stays sequential (not Promise.all): opening in parallel would make
    // `activeProject` (set to whichever project's `openNew()` finishes
    // first) nondeterministic instead of always the first entry in
    // `opts.projects`, and a mid-startup failure here would leave some
    // opens still `pending` — `closeAll()` in the catch block below only
    // iterates already-registered projects, not in-flight ones. Revisit
    // once real multi-project cold starts (many `opts.projects` entries)
    // make sequential open latency actually matter.
    for (const dir of opts.projects ?? []) {
      const handle = await registry.open(dir);
      await warnIfLegacyPortConfigured(handle);
    }

    await writeLock({ pid: process.pid, port: boundPort });

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      // Must happen before server.close(): an open SSE connection (e.g. a
      // preview tab left open) never ends on its own, and server.close()'s
      // callback waits for every connection to end — otherwise this hangs
      // forever, the lock file never clears, and the next `serve` sees a
      // "daemon already running" that isn't. ProjectRegistry.closeAll() stops
      // each project's index watcher, then its SSE hub, in that order;
      // registry.lifecycle.close() stops the daemon-wide heartbeat and ends
      // any /events connection that never had a project attached (which
      // closeAll() never touches, since it only iterates open projects).
      await registry.closeAll();
      registry.lifecycle.close();
      boundServer.closeAllConnections();
      await new Promise<void>((res) => boundServer.close(() => res()));
      await removeLock();
    };

    return { port: boundPort, registry, stop };
  } catch (err) {
    await registry.closeAll();
    registry.lifecycle.close();
    const openedServer = server;
    if (openedServer) {
      openedServer.closeAllConnections();
      await new Promise<void>((res) => openedServer.close(() => res()));
    }
    throw err;
  }
}
