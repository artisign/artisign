import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { escapeAttr } from "./html-syntax.js";
import { NodeIdAllocator } from "./node-id.js";
import { classifyElement } from "./parser.js";
import type { DesignSystemRegistry } from "./registry.js";

type P5ChildNode = DefaultTreeAdapterTypes.ChildNode;
type P5Element = DefaultTreeAdapterTypes.Element;
type P5Template = DefaultTreeAdapterTypes.Template;

function isElementLike(node: P5ChildNode): node is P5Element {
  return node.nodeName !== "#text" && node.nodeName !== "#comment" && node.nodeName !== "#documentType";
}

function isTemplate(node: P5Element): node is P5Template {
  return node.tagName === "template";
}

/**
 * A `<template>`'s real children live in `.content.childNodes`, not
 * `.childNodes` (always empty for it) — same content-model
 * `rewrite-literal-style.ts`/`parser.ts` rely on.
 */
function childNodesOf(el: P5Element): P5ChildNode[] {
  return isTemplate(el) ? el.content.childNodes : el.childNodes;
}

function attrValue(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function attrsMap(el: P5Element): Map<string, string> {
  return new Map(el.attrs.map((a) => [a.name, a.value]));
}

/**
 * Every top-level element belonging to one variant, matching
 * `parseComponentDefinition`'s own classification (`component.ts`): a bare
 * top-level element (outside any `<template>`) belongs to variant
 * "default"; a `<template data-variant="x">`'s *content* children belong to
 * variant "x" (a `<template>` with no `data-variant` attribute also
 * defaults to "default", same as `component.ts` — a duplicate "default"
 * source is a `loadAllDocuments`-level concern, not this function's).
 *
 * `variant === undefined` means "the whole file is one scope" — a pattern,
 * which has no `<template data-variant>` semantics at all.
 */
function variantScope(topLevel: P5Element[], variant: string | undefined): P5Element[] {
  if (variant === undefined) return topLevel;
  const scope: P5Element[] = [];
  for (const el of topLevel) {
    if (!isTemplate(el)) {
      if (variant === "default") scope.push(el);
      continue;
    }
    if ((attrValue(el, "data-variant") ?? "default") === variant) {
      scope.push(...el.content.childNodes.filter(isElementLike));
    }
  }
  return scope;
}

/** Mirrors `parser.ts`'s private `collectExplicitIds` — same rule (recurse via `childNodesOf`, `id`/`data-node-id` wins), scoped to just the elements handed in rather than a whole document. */
function collectExplicitIds(nodes: P5ChildNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (!isElementLike(node)) continue;
    const id = attrValue(node, "id") ?? attrValue(node, "data-node-id");
    if (id) out.add(id);
    collectExplicitIds(childNodesOf(node), out);
  }
}

/**
 * Assigns ids to every element in `scope`, exactly the way `parser.ts`'s
 * `buildElement` would when this scope is a definition variant's top-level
 * content (ADR-004 §2): pre-order, explicit `id`/`data-node-id` wins, a
 * fresh `NodeIdAllocator` seeded with every explicit id in scope so an
 * auto-generated id never collides with one used later in document order.
 *
 * `classifyElement` (`parser.ts`) — the *same* function `buildElement` calls
 * — decides whether an element is a component instance, whose children
 * become opaque slot content and must not be walked for id allocation
 * (`buildElement` never calls the allocator for `collectSlotOverrides`'s
 * subtree either); its SVG-context check is why `inSvg` is threaded through
 * this walk exactly like `buildElement` threads it — a `data-component`/
 * `$class` element inside `<svg>` is never a component instance, and
 * getting that wrong desyncs every id allocated after it. Text nodes are
 * skipped entirely — `NodeIdAllocator.allocateTextId`
 * keeps a fully separate counter from element ids, so ignoring text here
 * changes no element's id.
 */
function assignIds(scope: P5Element[], registry: DesignSystemRegistry): Map<string, P5Element> {
  const explicitIds = new Set<string>();
  collectExplicitIds(scope, explicitIds);
  const allocator = new NodeIdAllocator();
  allocator.seedUsed(explicitIds);

  const byId = new Map<string, P5Element>();
  const visit = (el: P5Element, inSvg: boolean): void => {
    const id = allocator.allocateElementId(attrValue(el, "id") ?? attrValue(el, "data-node-id"));
    byId.set(id, el);

    const classification = classifyElement(attrsMap(el), el.tagName, inSvg, registry);
    if (classification.kind === "component_instance") return;

    const childInSvg = classification.kind === "svg" || classification.kind === "svg_path";
    for (const child of childNodesOf(el)) {
      if (isElementLike(child)) visit(child, childInSvg);
    }
  };
  for (const el of scope) visit(el, false);
  return byId;
}

/**
 * The ids inside `variant`'s scope that come from an explicit `id`/
 * `data-node-id` attribute in source — the id-stability signal ADR-004 §2/§3
 * need: a node id *not* in this set is allocator-generated and only
 * reliably addressable for one call (see `assignIds`'s doc comment above).
 * Shared by `find_nodes`'s derived-id marker and `patch_html`/`update_refs`'s
 * `missing_id` warning so neither reimplements the explicit-id scan. No
 * registry needed — unlike `assignIds`, this doesn't need to classify
 * component instances, since an id is either explicit in source or it isn't,
 * regardless of what kind of element carries it.
 */
export function explicitNodeIds(html: string, variant?: string): Set<string> {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const topLevel = fragment.childNodes.filter(isElementLike);
  const scope = variantScope(topLevel, variant);
  const explicitIds = new Set<string>();
  collectExplicitIds(scope, explicitIds);
  return explicitIds;
}

/**
 * The raw source attributes of one node inside `variant`'s scope, keyed
 * exactly as they appear in the file (before the augmentation grammar strips
 * anything) — `null` if `nodeId` doesn't resolve. Lets a caller (`update_refs`
 * on a definition) inspect what's already there — e.g. whether a component
 * instance uses `class="$name"` or `data-component="name"` syntax — before
 * deciding which `set_attr` operations to apply through `patchDefinitionNode`,
 * without a second, diverging id-location implementation: this locates the
 * node the exact same way `patchDefinitionNode` does.
 */
export function readDefinitionNodeAttrs(
  html: string,
  registry: DesignSystemRegistry,
  nodeId: string,
  variant?: string,
): Record<string, string> | null {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const topLevel = fragment.childNodes.filter(isElementLike);
  const scope = variantScope(topLevel, variant);
  const byId = assignIds(scope, registry);
  const el = byId.get(nodeId);
  if (!el) return null;
  return Object.fromEntries(el.attrs.map((a) => [a.name, a.value]));
}

export type PatchDefinitionOperation =
  | { op: "replace"; html: string }
  | { op: "delete" }
  | { op: "insert_before"; html: string }
  | { op: "insert_after"; html: string }
  | { op: "set_attr"; name: string; value: string | null };

export type PatchDefinitionResult = { found: true; html: string } | { found: false };

/**
 * Locates `nodeId` inside `variant`'s scope of a component/pattern
 * definition file's raw source and applies exactly one byte-range splice
 * derived from the located element's `sourceCodeLocation` — a
 * source-preserving rewrite, never a parse->serialize round trip (which
 * keeps only a document's first top-level element and re-normalizes every
 * node's ids/formatting, the constraint ADR-004 §2 carries forward).
 * `html` is a whole definition file (as
 * `store.readComponent`/`readPattern` return it, every variant included);
 * the returned string is that same whole file, untouched outside the
 * computed range. `variant` is the target `<template data-variant="x">`'s
 * name (or "default" for a component's bare top-level markup), or
 * `undefined` for a pattern, which has no variant scoping at all.
 *
 * `nodeId` is resolved by the exact same `NodeIdAllocator` traversal
 * `loadAllDocuments` (`definitions.ts`) already uses to build a
 * `component:<name>#<variant>`/`pattern:<name>` `SourceDoc` — so a
 * `find_nodes`/`get_node` match's node id always locates the node that
 * match described here too, including an allocator-generated id (no
 * explicit `id` in source), for as long as this one call's traversal order
 * matches the file on disk (`NodeIdAllocator`'s doc comment: derived ids are
 * a pure function of document order, not stable identity).
 */
export function patchDefinitionNode(
  html: string,
  registry: DesignSystemRegistry,
  nodeId: string,
  operation: PatchDefinitionOperation,
  variant?: string,
): PatchDefinitionResult {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const topLevel = fragment.childNodes.filter(isElementLike);
  const scope = variantScope(topLevel, variant);
  const byId = assignIds(scope, registry);

  const el = byId.get(nodeId);
  if (!el?.sourceCodeLocation) return { found: false };

  return { found: true, html: applyOperation(html, el, el.sourceCodeLocation, operation) };
}

function applyOperation(
  html: string,
  el: P5Element,
  loc: NonNullable<P5Element["sourceCodeLocation"]>,
  operation: PatchDefinitionOperation,
): string {
  switch (operation.op) {
    case "delete":
      return html.slice(0, loc.startOffset) + html.slice(loc.endOffset);
    case "replace":
      return html.slice(0, loc.startOffset) + operation.html + html.slice(loc.endOffset);
    case "insert_before":
      return html.slice(0, loc.startOffset) + operation.html + html.slice(loc.startOffset);
    case "insert_after":
      return html.slice(0, loc.endOffset) + operation.html + html.slice(loc.endOffset);
    case "set_attr":
      return setAttr(html, el, loc, operation.name, operation.value);
  }
}

/**
 * Sets/removes one attribute on `el`'s start tag, splicing only that
 * attribute's byte range (or, for a new attribute, a single insertion point
 * just before the start tag's closing `>`/`/>`) — everything else in the
 * start tag, and the rest of the file, stays byte-for-byte identical.
 */
function setAttr(
  html: string,
  el: P5Element,
  loc: NonNullable<P5Element["sourceCodeLocation"]>,
  name: string,
  value: string | null,
): string {
  const attrLoc = loc.attrs?.[name];

  if (value === null) {
    if (!attrLoc) return html; // nothing to remove
    // Strip one adjacent leading space too, so removing an attribute never
    // leaves a double space behind between its neighbors.
    const start = html[attrLoc.startOffset - 1] === " " ? attrLoc.startOffset - 1 : attrLoc.startOffset;
    return html.slice(0, start) + html.slice(attrLoc.endOffset);
  }

  const rendered = `${name}="${escapeAttr(value)}"`;
  if (attrLoc) {
    return html.slice(0, attrLoc.startOffset) + rendered + html.slice(attrLoc.endOffset);
  }

  // New attribute: insert right before the start tag's closing `>` (and any
  // self-closing `/` immediately preceding it).
  const startTagLoc = loc.startTag ?? loc;
  const raw = html.slice(startTagLoc.startOffset, startTagLoc.endOffset);
  const closeOffset = /\/>$/.test(raw) ? startTagLoc.endOffset - 2 : startTagLoc.endOffset - 1;
  return html.slice(0, closeOffset) + ` ${rendered}` + html.slice(closeOffset);
}
