import { resolve } from "node:path";
import { FsStore } from "../store/index.js";
import { watchAndReindex, type WatchAndReindexHandle } from "../model/index.js";
import { clearFontMemo } from "../model/fonts.js";
import { createSseHub, createLifecycleHub, type SseHub, type LifecycleHub } from "../http/sse.js";
import { readGlobalConfig, writeGlobalConfig } from "./global-config.js";
import type { ArtisignConfig } from "../init/artisign-config.js";
import { CONFIG_FILENAME } from "../init/artisign-config.js";

export type ProjectHandle = {
  root: string;
  store: FsStore;
  sseHub: SseHub;
  /** Cached from `artisign.json`, kept live via `watchAndReindex`'s `onChange` hook — see `openNew()` — so routes that list open projects (`GET /api/projects`) never re-read the file per request. */
  name: string;
};

const RECENT_PROJECTS_CAP = 10;

type OpenProject = {
  handle: ProjectHandle;
  index: WatchAndReindexHandle;
};

/**
 * Holds every project the daemon currently has open, keyed by resolved
 * project root. One concrete class (no speculative interface — ADR-001
 * permits only the `Store` abstraction on spec); route-level project
 * selection (`?project=`, `/api/projects`) is layered on top of it.
 */
export class ProjectRegistry {
  private readonly projects = new Map<string, OpenProject>();
  // In-flight open() calls per root, so two concurrent opens of the same
  // (not-yet-open) root share one build instead of each constructing its
  // own Store/watcher/SSE hub — the loser would otherwise leak all three,
  // since only the winner's handle ends up in `projects`.
  private readonly pending = new Map<string, Promise<ProjectHandle>>();
  // Serializes recentProjects' read-modify-write of the global config.json
  // — concurrent opens racing an unserialized read-modify-write would
  // silently drop entries.
  private recentChain: Promise<void> = Promise.resolve();
  private active: string | undefined;
  /** Daemon-wide project lifecycle broadcaster (project-opened/-switched) — see http/sse.ts. */
  readonly lifecycle: LifecycleHub = createLifecycleHub();

  /**
   * Opens `dir` as a project: validates `artisign.json`, builds/refreshes
   * `.artisign/index.json` and keeps it live, and starts the project's SSE
   * hub.
   * Idempotent — re-opening an already-open root returns the existing
   * handle without touching the watcher or SSE hub. Sets `activeProject` if
   * nothing is active yet.
   */
  async open(dir: string): Promise<ProjectHandle> {
    const root = resolve(dir);
    const existing = this.projects.get(root);
    if (existing) {
      await this.rememberRecent(root);
      return existing.handle;
    }

    const inFlight = this.pending.get(root);
    if (inFlight) return inFlight;

    const openPromise = this.openNew(root).finally(() => {
      this.pending.delete(root);
    });
    this.pending.set(root, openPromise);
    return openPromise;
  }

  private async openNew(root: string): Promise<ProjectHandle> {
    const config = await validateProjectRoot(root);

    const store = new FsStore(root);
    // sseHub has its own store.watch() subscription (src/http/sse.ts) and
    // doesn't depend on the index, so it's fine to build ahead of it — doing
    // so here lets `handle` exist, with a real `sseHub`, before
    // watchAndReindex's `onChange` closure (below) can possibly fire.
    const sseHub = createSseHub(store);
    const handle: ProjectHandle = { root, store, sseHub, name: config.name };

    // Builds .artisign/index.json (absent, or stale from a previous daemon
    // run) and keeps it live from then on — see src/model/live-index.ts.
    // Reuses that same watcher subscription (via `onChange`) to also keep
    // `handle.name` live across an on-disk rename of artisign.json's "name"
    // field, rather than opening a third recursive chokidar watcher over the
    // same project tree just for that. A broken artisign.json (bad hand
    // edit) must never invalidate the cached name or reject anything — it
    // just keeps showing the last-known good name until the file is fixed.
    let nameSeq = 0;
    const index = watchAndReindex(
      store,
      undefined,
      (err) => {
        console.error(`index rebuild failed (${root}):`, err instanceof Error ? err.message : err);
      },
      (event) => {
        if (event.category !== "config") return;
        // Two edits far enough apart to survive the watcher debounce start
        // two independent reads; without this token an out-of-order
        // resolution would leave the older name in place until the next
        // edit, since nothing here re-reads on its own.
        const seq = ++nameSeq;
        store
          .readArtisignConfig()
          .then((cfg) => {
            if (seq !== nameSeq) return;
            handle.name = cfg.name;
          })
          .catch((err) => {
            // Same staleness guard as the success path above, and for the
            // same reason: two config edits close enough together start two
            // independent reads that can resolve out of order (e.g. the
            // older read's ENOENT lands after a newer read already
            // succeeded, under libuv threadpool contention during a large
            // index rebuild). Without it, a stale ENOENT here would evict a
            // project whose config file demonstrably still exists.
            if (seq !== nameSeq) return;
            // artisign.json is written atomically (temp file, then rename),
            // so a normal in-place edit never makes it briefly ENOENT — this
            // means the project root (or at least artisign.json) is
            // genuinely gone, e.g. the directory was deleted out from under
            // the daemon. Any other error (a broken hand-edit) keeps showing
            // the last-known-good name, unchanged from before.
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              // Runs in a watcher callback, with no request handler above it
              // to catch a rejection — index.stop() or sseHub.close() (via
              // res.end() on an already-broken socket) failing here would
              // otherwise be an unhandled rejection and, on Node >= 15, kill
              // the daemon: exactly the crash class this eviction path
              // exists to prevent.
              this.evict(root).catch((evictErr) => {
                console.error(`failed to evict ${root}:`, evictErr instanceof Error ? evictErr.message : evictErr);
              });
              return;
            }
            console.error(`failed to refresh project name (${root}):`, err instanceof Error ? err.message : err);
          });
      },
    );
    await index.ready;

    this.projects.set(root, { handle, index });
    this.lifecycle.broadcast({ type: "project-opened", root });
    // Routed through the public setter (not a direct field write) so the
    // very first project a daemon opens also broadcasts project-switched —
    // it just became what the preview UI shows, same as any later activate.
    if (this.active === undefined) this.activeProject = root;

    await this.rememberRecent(root);

    return handle;
  }

  private rememberRecent(root: string): Promise<void> {
    const next = this.recentChain.then(async () => {
      try {
        const config = await readGlobalConfig();
        const recentProjects = [root, ...(config.recentProjects ?? []).filter((p) => p !== root)].slice(
          0,
          RECENT_PROJECTS_CAP,
        );
        // An idempotent re-open of an already-open root recomputes the same
        // front-of-list result every time; skip the atomic write for it
        // rather than costing an I/O round trip on every repeated open().
        const unchanged =
          config.recentProjects !== undefined &&
          config.recentProjects.length === recentProjects.length &&
          config.recentProjects.every((p, i) => p === recentProjects[i]);
        if (unchanged) return;
        await writeGlobalConfig({ ...config, recentProjects });
      } catch (err) {
        // Best-effort metadata — never breaks the chain for the next open(),
        // and never fails open() itself over a recentProjects write.
        console.error(`failed to update recentProjects for ${root}:`, err instanceof Error ? err.message : err);
      }
    });
    this.recentChain = next;
    return next;
  }

  get(root: string): ProjectHandle | undefined {
    return this.projects.get(resolve(root))?.handle;
  }

  list(): ProjectHandle[] {
    return [...this.projects.values()].map((p) => p.handle);
  }

  /** The project root the preview UI currently shows, or undefined if none is open. */
  get activeProject(): string | undefined {
    return this.active;
  }

  set activeProject(root: string | undefined) {
    if (root === undefined) {
      this.active = undefined;
      return;
    }
    const key = resolve(root);
    if (!this.projects.has(key)) {
      throw new Error(`cannot set active project: not open: ${key}`);
    }
    const changed = this.active !== key;
    this.active = key;
    // Broadcasts to every connected /events client regardless of which
    // project's change stream it's on — a client watching project A still
    // needs to learn the daemon switched to B, since that's not a file
    // change inside any one project's own SseHub.
    if (changed) this.lifecycle.broadcast({ type: "project-switched", root: key });
  }

  /**
   * Closes `root`, if open — stops its index watcher, then closes its SSE
   * hub (same ordering `src/daemon/start.ts`'s `stop()` used for the single
   * project it managed: an open SSE connection never ends on its own, so
   * anything that waits on "no more activity" must close it explicitly
   * rather than let it linger). A no-op for a root that isn't open.
   */
  async close(root: string): Promise<void> {
    const key = resolve(root);
    const entry = this.projects.get(key);
    if (!entry) return;

    this.projects.delete(key);
    await entry.index.stop();
    entry.handle.sseHub.close();
    // The font memo is keyed by (projectRoot, family) and otherwise never
    // shrinks for the daemon's lifetime — without this, reopening a project
    // whose fonts previously failed (e.g. offline) would keep serving the
    // stale "failed" status instead of retrying.
    clearFontMemo(key);

    if (this.active === key) {
      this.active = undefined;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.projects.keys()].map((root) => this.close(root)));
  }

  /**
   * Evicts `root` because it disappeared from disk (its config file is gone —
   * see the `onChange` hook in `openNew()`), rather than because a caller
   * asked to close it. Broadcasts `project-closed` first, then tears down
   * via `close()` — `SseHub.close()` ends every attached `/events` response,
   * so the lifecycle event must go out before that happens, not after. A
   * no-op if `root` was already closed/evicted (guards double eviction).
   */
  private async evict(root: string): Promise<void> {
    const key = resolve(root);
    if (!this.projects.has(key)) return;

    const wasActive = this.active === key;
    // Re-seat the active slot synchronously, before "project-closed" goes
    // out — close() below doesn't clear `this.active` until after
    // `index.stop()`'s real filesystem work (tens of ms on a large
    // project), and a client reacting to "project-closed" with an
    // immediate GET /api/projects (as the frontend does) must never
    // observe `active` naming a root that's already gone. Assigned
    // directly, not through the public setter — "project-closed" already
    // carries the active-slot change (every client refreshes /api/projects
    // off it and switches to whatever `active` now is), so a second,
    // separate "project-switched" here would just double every client's
    // project-switch handling for the same state transition.
    if (wasActive) {
      const next = this.list().find((h) => h.root !== key);
      this.active = next?.root;
    }

    this.lifecycle.broadcast({ type: "project-closed", root: key });

    // `this.active` is no longer `key` by this point (either replaced
    // above, or never was), so close()'s own "if (this.active === key)
    // reset" is a no-op here — the value we just set survives it.
    await this.close(key);
  }
}

/**
 * `FsStore.readArtisignConfig()` already shape-validates `artisign.json`
 * (non-null object, string `name`, object `settings` — review fix 2) and
 * names the path in its error; this just translates a missing/invalid
 * config into the "not an Artisign project" framing `open()`'s callers
 * expect, without duplicating the read+parse logic here. Returns the parsed
 * config so `openNew()` can seed `handle.name` without a second read of the
 * same file.
 */
async function validateProjectRoot(root: string): Promise<ArtisignConfig> {
  const configPath = resolve(root, CONFIG_FILENAME);
  try {
    return await new FsStore(root).readArtisignConfig();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`not an Artisign project: ${CONFIG_FILENAME} not found at ${configPath}`);
    }
    throw new Error(`not an Artisign project: ${err instanceof Error ? err.message : String(err)}`);
  }
}
