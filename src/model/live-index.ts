import type { ProjectChangeEvent, Store } from "../store/index.js";
import { rebuildAndPersistIndex, type ProjectIndex } from "./index-builder.js";

export type WatchAndReindexHandle = {
  /** Resolves once the initial build has settled (success or caught failure). */
  ready: Promise<void>;
  /** Stops watching, then awaits any rebuild still in flight (including a slow initial one). */
  stop: () => Promise<void>;
};

/**
 * Builds `.artisign/index.json` immediately (it may not exist yet, or may be
 * stale from before the process last ran) and keeps it in sync with
 * external edits to the project folder from then on. Each debounced watcher
 * event triggers a full rebuild — screens are cheap enough to reparse in
 * full at this project scale, and a full rebuild is trivially correct.
 *
 * Every rebuild — the initial one and every watcher-triggered one — runs
 * through a single chain rather than firing concurrently: a source file
 * deleted between the watcher event and the read would otherwise reject
 * unhandled (crashing the process on Node >= 20), two overlapping rebuilds
 * could complete out of order and let a stale one clobber a fresh one, and
 * (before the initial build joined this same chain) the initial build could
 * itself race a watcher-triggered one and lose an atomic-write's temp file
 * out from under it. Chaining also guarantees `onUpdate` fires in order.
 *
 * `stop()` stops the watcher (no further rebuilds get queued) and then
 * awaits the chain, so a caller that awaits it is guaranteed no rebuild is
 * still touching disk when it resolves — this matters for tests (and
 * cleanup flows) that delete the project directory right after.
 */
export function watchAndReindex(
  store: Store,
  onUpdate?: (index: ProjectIndex) => void,
  onError?: (error: unknown) => void,
  // Additive, optional: lets a caller (ProjectRegistry) observe the same
  // underlying watcher events this function already subscribes to, rather
  // than opening a second recursive chokidar watcher over the same project
  // tree just to see them.
  onChange?: (event: ProjectChangeEvent) => void,
): WatchAndReindexHandle {
  // Resolves unconditionally (errors are caught inline), so a failed
  // rebuild never breaks the chain for the next trigger, and never rejects
  // unhandled.
  const runRebuild = async (): Promise<void> => {
    try {
      const index = await rebuildAndPersistIndex(store);
      onUpdate?.(index);
    } catch (error) {
      onError?.(error);
    }
  };

  const initial = runRebuild();
  let chain: Promise<void> = initial;
  const stopWatching = store.watch((event) => {
    // Reindex first: the observer is a bystander, so a throwing `onChange`
    // must not be able to swallow the rebuild this event exists for.
    chain = chain.then(runRebuild);
    onChange?.(event);
  });

  return {
    ready: initial,
    stop: async () => {
      stopWatching();
      await chain;
    },
  };
}
