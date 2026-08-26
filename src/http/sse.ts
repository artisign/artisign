import type { ServerResponse } from "node:http";
import type { Store, ChangeCategory } from "../store/index.js";

export type ChangeSseEvent = {
  type: "change";
  kind: ChangeCategory;
  name: string;
};

/**
 * Project lifecycle events — unlike `ChangeSseEvent`, which is
 * scoped to one project's own `SseHub`, these are broadcast daemon-wide (see
 * `createLifecycleHub` below): a client watching project A's `change`
 * stream still needs to learn that the daemon's active project switched to
 * B, or that a new project C was opened, since neither is a file change
 * inside any one project.
 */
export type LifecycleSseEvent =
  | { type: "project-switched"; root: string }
  | { type: "project-opened"; root: string }
  | { type: "project-closed"; root: string };

export type SseEvent = ChangeSseEvent | LifecycleSseEvent;

const HEARTBEAT_MS = 25_000;

/**
 * File stem, e.g. "screens/checkout.html" -> "checkout", "design-system/tokens.json" -> "tokens",
 * "screens/checkout.meta.json" -> "checkout". The `.meta.json` suffix is stripped first so a
 * screen's metadata sidecar broadcasts under the same name as the screen itself.
 *
 * A mockup's variant/meta files live one level deeper (`mockups/<name>/<variant>.html`,
 * `mockups/<name>/mockup.json`) than every other category, so the file stem alone would
 * broadcast under the variant id or "mockup" instead of the mockup itself — the `name` here
 * needs to be the directory, not the last path segment.
 */
function baseName(path: string): string {
  const segments = path.split("/");
  if (segments[0] === "mockups" && segments[1]) return segments[1];
  const stem = segments.pop() ?? path;
  if (stem.endsWith(".meta.json")) return stem.slice(0, -".meta.json".length);
  return stem.replace(/\.(html|json|jsonl)$/, "");
}

/**
 * Shared client-tracking + guarded-write primitive for every SSE broadcast
 * target: a project's own change stream (`SseHub`) and the daemon-wide
 * lifecycle stream (`LifecycleHub`) a `/events` connection is always also
 * part of. Registering a client attaches the pruning
 * listener right here, on `res`'s own `"close"` event, rather than relying
 * on the caller to separately wire one up — a broadcast racing an
 * already-closed-but-not-yet-unregistered response would otherwise
 * write-after-end. A client whose socket buffer is full (`res.write()`
 * returned `false`) is skipped until it drains, instead of piling up
 * unbounded writes behind a slow/stalled connection — dropping a heartbeat
 * or a lifecycle event to a paused client is harmless, since both are tiny
 * and either repeats (heartbeat) or is superseded by the next state anyway.
 */
type SseClientSet = {
  add: (res: ServerResponse) => () => void;
  broadcast: (payload: string) => void;
  /** Ends and forgets every currently registered client. */
  endAll: () => void;
};

function createSseClientSet(): SseClientSet {
  const clients = new Map<ServerResponse, { paused: boolean }>();

  function add(res: ServerResponse): () => void {
    clients.set(res, { paused: false });
    const onClose = (): void => {
      clients.delete(res);
    };
    res.once("close", onClose);
    return () => {
      res.off("close", onClose);
      clients.delete(res);
    };
  }

  function broadcast(payload: string): void {
    for (const [res, state] of clients) {
      // A single /events connection is registered in two independent
      // client sets at once — its project's own SseHub and the daemon-wide
      // LifecycleHub (see handleSseConnection). If the other set already
      // ended this response (e.g. ProjectRegistry.evict()'s close() calls
      // sseHub.close() -> endAll()), it stays in *this* set until its
      // asynchronous "close" event fires and prunes it — a broadcast
      // landing in that gap would write() to an already-ended response,
      // which Node turns into an unhandled "error" event on `res` and
      // crashes the process (ERR_STREAM_WRITE_AFTER_END).
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      if (state.paused) continue;
      const ok = res.write(payload);
      if (!ok) {
        state.paused = true;
        res.once("drain", () => {
          state.paused = false;
        });
      }
    }
  }

  function endAll(): void {
    for (const res of clients.keys()) res.end();
    clients.clear();
  }

  return { add, broadcast, endAll };
}

export type SseHub = {
  /** Registers an already-open `/events` connection for this project's change events. Returns the unregister function. */
  addClient: (res: ServerResponse) => () => void;
  /** Stops the store watcher and ends every client registered with this hub — a client watching a project that goes away must not hang forever (see src/daemon/project-registry.ts `close()`). */
  close: () => void;
};

/**
 * Broadcasts one project's file changes to every `/events` connection
 * attached to it, so the preview can refetch and re-render without a
 * manual reload. Uses its own `store.watch()` subscription — a second,
 * independent one alongside `watchAndReindex`'s (`Store.watch` supports
 * multiple subscribers) — rather than threading a callback through the
 * index-rebuild pipeline, keeping "keep the index fresh" and "notify the
 * browser" as separate concerns over the same underlying watcher primitive.
 *
 * Does not write response headers or run a heartbeat itself — the
 * `handleSseConnection` below owns the one shared connection lifecycle every
 * `/events` request goes through, project-attached or not.
 */
export function createSseHub(store: Store): SseHub {
  const clients = createSseClientSet();

  const unwatch = store.watch((event) => {
    const sseEvent: ChangeSseEvent = { type: "change", kind: event.category, name: baseName(event.path) };
    clients.broadcast(`data: ${JSON.stringify(sseEvent)}\n\n`);
  });

  function close(): void {
    unwatch();
    clients.endAll();
  }

  return { addClient: clients.add, close };
}

export type LifecycleHub = {
  /** Registers an already-open `/events` connection for daemon-wide lifecycle events. Returns the unregister function. */
  addClient: (res: ServerResponse) => () => void;
  broadcast: (event: LifecycleSseEvent) => void;
  /** Stops the daemon-wide heartbeat and ends every remaining client — called once, on daemon shutdown. */
  close: () => void;
};

/**
 * Daemon-wide (not per-project) SSE hub — one instance lives on the
 * `ProjectRegistry` for the whole daemon lifetime. Every `/events`
 * connection registers here regardless of whether a project resolved for
 * it, which is also why the single shared heartbeat
 * lives here rather than on each project's `SseHub`: one timer for the
 * whole daemon instead of one per project, and it still reaches a
 * connection that has zero projects open, which a project-scoped heartbeat
 * never could.
 */
export function createLifecycleHub(): LifecycleHub {
  const clients = createSseClientSet();

  const heartbeat = setInterval(() => clients.broadcast(": heartbeat\n\n"), HEARTBEAT_MS);
  heartbeat.unref();

  function broadcast(event: LifecycleSseEvent): void {
    clients.broadcast(`data: ${JSON.stringify(event)}\n\n`);
  }

  function close(): void {
    clearInterval(heartbeat);
    clients.endAll();
  }

  return { addClient: clients.add, broadcast, close };
}

/**
 * Handles a `GET /events` connection at the daemon level: writes the SSE
 * headers once, always registers with `lifecycle` —
 * so a client learns about project-opened/-switched regardless of which
 * project's change stream it's also on, or whether one resolved at all —
 * and, only when a project resolved for this connection, also registers
 * with that project's own `SseHub`. With zero projects open the stream
 * still stays open, carrying heartbeats and lifecycle events only, so the
 * empty-state UI can learn the moment a project is opened.
 */
export function handleSseConnection(res: ServerResponse, lifecycle: LifecycleHub, projectHub: SseHub | undefined): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(":ok\n\n");

  lifecycle.addClient(res);
  projectHub?.addClient(res);
}
