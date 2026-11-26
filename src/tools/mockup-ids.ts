// The authored `id` attributes of one mockup variant — the only anchors a
// mockup comment may use (ADR-012). Mockups stay outside the ref model, so
// there is no node index: the variant file is parsed on demand.

import { parse, defaultTreeAdapter } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { Store } from "../store/index.js";

export const MOCKUP_NAME_RE = /^[\w-]+$/;

/**
 * Every `id` attribute of an element in the variant's markup. Elements inside
 * `<template>` content do not count — parse5 keeps that content outside
 * `childNodes`, and the browser cannot show it either.
 */
export function authoredIds(html: string): Set<string> {
  const ids = new Set<string>();
  const walk = (node: DefaultTreeAdapterTypes.ParentNode): void => {
    for (const child of node.childNodes) {
      if (!defaultTreeAdapter.isElementNode(child)) continue;
      const id = child.attrs.find((a) => a.name === "id")?.value;
      if (id) ids.add(id);
      walk(child);
    }
  };
  walk(parse(html));
  return ids;
}

/**
 * The authored ids of `mockups/<mockup>/<variant>.html`, or `undefined` when
 * the file does not exist (or the names cannot address one).
 */
export async function readVariantIds(store: Store, mockup: string, variant: string): Promise<Set<string> | undefined> {
  if (!MOCKUP_NAME_RE.test(mockup) || !MOCKUP_NAME_RE.test(variant)) return undefined;
  try {
    return authoredIds(await store.readMockupVariant(mockup, variant));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
