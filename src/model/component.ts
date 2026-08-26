import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

export type ComponentVariant = { name: string; htmlAug: string };

export type ComponentDefinitionSummary = {
  name: string;
  variants: ComponentVariant[];
  defaultVariant: string;
};

function isElementLike(node: DefaultTreeAdapterTypes.ChildNode): node is DefaultTreeAdapterTypes.Element {
  return node.nodeName !== "#text" && node.nodeName !== "#comment" && node.nodeName !== "#documentType";
}

/**
 * Parses a `design-system/components/<name>.html` file. The file's bare
 * top-level markup is the "default" variant; each
 * `<template data-variant="...">` block is a separate named variant (per
 * the PRD's on-disk component format). This is a lightweight raw-slice
 * reader for DS inspection (`get_design_system`) — it does not build a
 * canonical ref model the way screens do, since components aren't written
 * back through this reader in M2.
 */
export function parseComponentDefinition(name: string, html: string): ComponentDefinitionSummary {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const variants: ComponentVariant[] = [];
  const defaultParts: string[] = [];

  for (const node of fragment.childNodes) {
    if (!isElementLike(node)) continue;
    const loc = node.sourceCodeLocation;
    if (!loc) continue;

    if (node.tagName === "template") {
      const variantName = node.attrs.find((a) => a.name === "data-variant")?.value ?? "default";
      const inner = loc.startTag ? html.slice(loc.startTag.endOffset, loc.endTag?.startOffset ?? loc.endOffset) : "";
      variants.push({ name: variantName, htmlAug: inner.trim() });
    } else {
      defaultParts.push(html.slice(loc.startOffset, loc.endOffset));
    }
  }

  if (defaultParts.length > 0) {
    variants.unshift({ name: "default", htmlAug: defaultParts.join("\n").trim() });
  }

  const defaultVariant = variants.find((v) => v.name === "default")?.name ?? variants[0]?.name ?? "default";
  return { name, variants, defaultVariant };
}
