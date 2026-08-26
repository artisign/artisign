import type { Store } from "../store/index.js";

export type DesignSystemRegistry = {
  /** Component names, from `design-system/components/*.html` filenames. */
  componentNames: Set<string>;
  /** Full dot-paths, e.g. "color.primary" — bucket names come from tokens.json's own keys. */
  tokenPaths: Set<string>;
  /** Bare member names across all buckets, for flat `$name` class-ref lookup. */
  tokenFlatNames: Set<string>;
};

/**
 * Loads the design-system registry (tokens + component names) used to
 * resolve `$ref` augmentations during parsing. Bucket names are read from
 * whatever top-level keys exist in `tokens.json` rather than a hardcoded
 * enum — this keeps the parser agnostic to how many/which buckets a project
 * defines.
 */
export async function loadRegistry(store: Store): Promise<DesignSystemRegistry> {
  const tokens = await store.readTokens();
  const tokenPaths = new Set<string>();
  const tokenFlatNames = new Set<string>();

  for (const [bucket, members] of Object.entries(tokens)) {
    for (const member of Object.keys(members)) {
      tokenPaths.add(`${bucket}.${member}`);
      tokenFlatNames.add(member);
    }
  }

  const componentNames = new Set(await store.listComponents());

  return { componentNames, tokenPaths, tokenFlatNames };
}
