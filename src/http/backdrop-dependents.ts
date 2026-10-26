import type { Store } from "../store/index.js";
import { readBackdropRoot } from "../tools/backdrop.js";

export type BackdropDependents = {
  /** Re-reads `screen` (absent file: drops it) and returns every screen that depends on it through `data-backdrop`, transitively, nearest first, each once, `screen` itself never included. Calls are serialized, so a burst answers in call order from a consistent map. */
  update: (screen: string) => Promise<string[]>;
  /** Drops the map; the next `update` rebuilds it from the screen files (it may have gone stale while nobody listened). */
  reset: () => void;
};

/**
 * `screen -> backdrop target` (ADR-008), held in memory only: built by a full
 * scan on first need, then kept current one screen at a time. The reverse
 * direction is derived per query. A missing target or a cycle on disk are
 * plain edges — the visited set ends a walk through one.
 */
export function createBackdropDependents(store: Store): BackdropDependents {
  let targets: Map<string, string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function scan(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const screen of await store.listScreens()) {
      const root = await readBackdropRoot(store, screen);
      if (root) map.set(screen, root.target);
    }
    return map;
  }

  async function run(screen: string): Promise<string[]> {
    if (targets === undefined) targets = await scan();
    else {
      const root = await readBackdropRoot(store, screen);
      if (root) targets.set(screen, root.target);
      else targets.delete(screen);
    }
    const order = [screen];
    const seen = new Set(order);
    for (let i = 0; i < order.length; i++) {
      for (const [dependent, target] of targets) {
        if (target !== order[i] || seen.has(dependent)) continue;
        seen.add(dependent);
        order.push(dependent);
      }
    }
    return order.slice(1);
  }

  return {
    reset: () => {
      targets = undefined;
    },
    update: (screen) => {
      const result = queue.then(() => run(screen));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
