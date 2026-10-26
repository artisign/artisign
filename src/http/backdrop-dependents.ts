import type { Store } from "../store/index.js";
import { loadRegistry, parseScreen } from "../model/index.js";
import { BACKDROP_ATTR, rootBackdrop } from "../tools/backdrop.js";

export type BackdropDependents = {
  /** Every screen that depends on `screen` through `data-backdrop`, transitively, nearest first, each once, `screen` itself never included. */
  of: (screen: string) => Promise<string[]>;
  /** Drops the reverse index; the next `of` rebuilds it from the screen files. */
  invalidate: () => void;
};

/**
 * The reverse of the screens' `data-backdrop` roots (ADR-008), held in memory
 * only: built lazily on first need and dropped on any screen change, never
 * persisted. A target that is missing or a cycle on disk are plain edges of
 * the graph — the visited set ends a walk through one.
 */
export function createBackdropDependents(store: Store): BackdropDependents {
  let index: Promise<Map<string, string[]>> | undefined;

  async function build(): Promise<Map<string, string[]>> {
    const registry = await loadRegistry(store);
    const byTarget = new Map<string, string[]>();
    for (const screen of await store.listScreens()) {
      try {
        const html = await store.readScreen(screen);
        // Cheap prefilter: most screens carry no backdrop, so skip their parse.
        if (!html.includes(BACKDROP_ATTR)) continue;
        const target = rootBackdrop(parseScreen(html, screen, registry).doc);
        if (target !== undefined) byTarget.set(target, [...(byTarget.get(target) ?? []), screen]);
      } catch {
        // An unreadable screen has no known edge.
      }
    }
    return byTarget;
  }

  return {
    invalidate: () => {
      index = undefined;
    },
    of: async (screen) => {
      index ??= build();
      const byTarget = await index;
      const seen = new Set([screen]);
      const order = [screen];
      for (let i = 0; i < order.length; i++) {
        for (const dependent of byTarget.get(order[i]!) ?? []) {
          if (seen.has(dependent)) continue;
          seen.add(dependent);
          order.push(dependent);
        }
      }
      return order.slice(1);
    },
  };
}
