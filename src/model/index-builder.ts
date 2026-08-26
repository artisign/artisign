import type { Store } from "../store/index.js";
import { loadRegistry } from "./registry.js";
import { parseScreen } from "./parser.js";
import { tokenRefPaths } from "./token-ref.js";
import type { NodeKind, ScreenId } from "./types.js";

export type IndexedNode = {
  screenId: ScreenId;
  kind: NodeKind;
  parentId: string | null;
};

export type ProjectIndex = {
  screens: Record<ScreenId, { title: string; sectionId: string | null; nodeCount: number }>;
  /** Keyed by "<screenId>.<nodeId>" — matches the tool-layer node addressing convention. */
  nodes: Record<string, IndexedNode>;
  refGraph: {
    /** token dot-path -> "<screenId>.<nodeId>" refs into it */
    tokens: Record<string, string[]>;
    /** flat token-class name (from `class="$name"`) -> "<screenId>.<nodeId>" refs into it */
    tokenClasses: Record<string, string[]>;
    /** component name -> "<screenId>.<nodeId>" instances of it */
    components: Record<string, string[]>;
  };
};

/**
 * Builds the project index by parsing every screen against the current
 * design-system registry. Pure function of on-disk source — deleting
 * `.artisign/index.json` and rebuilding must reproduce it byte-for-byte.
 */
export async function buildIndex(store: Store): Promise<ProjectIndex> {
  const registry = await loadRegistry(store);
  const screenNames = await store.listScreens();

  const index: ProjectIndex = {
    screens: {},
    nodes: {},
    refGraph: { tokens: {}, tokenClasses: {}, components: {} },
  };

  for (const screenName of screenNames) {
    const html = await store.readScreen(screenName);
    const { doc } = parseScreen(html, screenName, registry);

    index.screens[screenName] = {
      title: doc.title,
      sectionId: doc.sectionId,
      nodeCount: Object.keys(doc.nodes).length,
    };

    for (const node of Object.values(doc.nodes)) {
      const addr = `${screenName}.${node.id}`;
      index.nodes[addr] = { screenId: screenName, kind: node.kind, parentId: node.parentId };

      if (node.refs.component) {
        (index.refGraph.components[node.refs.component] ??= []).push(addr);
      }

      const classRef = node.refs.tokens.class;
      if (typeof classRef === "string") {
        (index.refGraph.tokenClasses[classRef] ??= []).push(addr);
      }

      const tokenPaths = new Set<string>();
      for (const [key, ref] of Object.entries(node.refs.tokens)) {
        if (key === "class") continue;
        for (const path of tokenRefPaths(ref)) tokenPaths.add(path);
      }
      for (const path of tokenPaths) {
        (index.refGraph.tokens[path] ??= []).push(addr);
      }
    }
  }

  return index;
}

export async function rebuildAndPersistIndex(store: Store): Promise<ProjectIndex> {
  const index = await buildIndex(store);
  await store.writeCacheIndex(index);
  return index;
}
