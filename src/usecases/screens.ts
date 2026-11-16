import type { Store } from "../store/index.js";
import { loadRegistry, parseScreen, type DesignSystemRegistry, type NodeSubtree, type ScreenDocument } from "../model/index.js";

export type MappedNode = { id: string; tag: string; text: string };

const TEXT_MAX = 80;

/**
 * Lazy view onto the project's screens for resolving step mappings: the screen
 * list is read once, a screen is only parsed when a node of it is asked for,
 * and each is parsed at most once per lookup.
 */
export class ScreenLookup {
  private names: Set<string> | undefined;
  private registry: Promise<DesignSystemRegistry> | undefined;
  private readonly docs = new Map<string, Promise<ScreenDocument | undefined>>();

  constructor(private readonly store: Store) {}

  async hasScreen(name: string): Promise<boolean> {
    this.names ??= new Set(await this.store.listScreens());
    return this.names.has(name);
  }

  private doc(name: string): Promise<ScreenDocument | undefined> {
    let pending = this.docs.get(name);
    if (!pending) {
      pending = (async () => {
        if (!(await this.hasScreen(name))) return undefined;
        this.registry ??= loadRegistry(this.store);
        try {
          return parseScreen(await this.store.readScreen(name), name, await this.registry).doc;
        } catch {
          return undefined;
        }
      })();
      this.docs.set(name, pending);
    }
    return pending;
  }

  async title(name: string): Promise<string | undefined> {
    return (await this.doc(name))?.title;
  }

  /** `undefined` when the screen or the node does not exist. */
  async node(screen: string, nodeId: string): Promise<MappedNode | undefined> {
    const doc = await this.doc(screen);
    const node = doc && Object.hasOwn(doc.nodes, nodeId) ? doc.nodes[nodeId] : undefined;
    if (!doc || !node) return undefined;
    const own: string[] = [];
    // A component instance keeps its slot content outside the node map.
    const collectSubtree = (subtree: NodeSubtree): void => {
      if (subtree.kind === "text") own.push(subtree.text ?? "");
      subtree.children.forEach(collectSubtree);
    };
    const collect = (id: string): void => {
      const current = doc.nodes[id];
      if (!current) return;
      if (current.kind === "text") own.push(current.text ?? "");
      current.childIds.forEach(collect);
    };
    if (node.kind === "text") own.push(node.text ?? "");
    else node.childIds.forEach(collect);
    Object.values(node.slotOverrides ?? {}).forEach(collectSubtree);
    const text = own.join(" ").replace(/\s+/g, " ").trim();
    return { id: node.id, tag: node.tag ?? node.kind, text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text };
  }
}
