import type { Store } from "../store/index.js";
import {
  parseScreen,
  parseComponentDefinition,
  type DesignSystemRegistry,
  type ScreenDocument,
} from "../model/index.js";
import { isBlockingIssue } from "./issue-filter.js";
import { ToolError, type Warning } from "./types.js";
import type { DefinitionNodeRef } from "./node-ref.js";

export type SourceKind = "screen" | "component" | "pattern";

/**
 * One parsed document that can hold node refs: a screen, a single component
 * variant, or a pattern. `address` is the node-ref prefix for this source —
 * `formatNodeRef(source.address, nodeId)` yields an addressable node ref for
 * every kind, since a component's address already carries its variant
 * (`component:<name>#<variant>`) per ADR-004 §1's addressing scheme.
 */
export type SourceDoc = {
  kind: SourceKind;
  name: string;
  variant?: string;
  address: string;
  doc: ScreenDocument;
};

export type LoadAllDocumentsOptions = {
  /**
   * Restrict which screens are read and parsed. Components and patterns are
   * always loaded in full regardless — they're project-wide design-system
   * sources, not screen-scoped (see find_nodes's `screens` param). Every
   * name is read directly via `store.readScreen`, so an unknown screen name
   * throws (the same not-found behavior an unfiltered call always had),
   * rather than silently contributing zero screen sources.
   */
  screens?: string[];
  /**
   * Component names to skip loading entirely. Used by delete_entity so the
   * component being deleted is never itself a reason the deletion can't
   * proceed — its own (possibly broken) file doesn't need to be read at all
   * to check whether *other* sources reference it by name.
   */
  excludeComponents?: string[];
  /**
   * Skip components and patterns entirely, loading screens only. Used by
   * find_nodes when every predicate in the query is has_comments or
   * has_flow — both are keyed by screen-based node refs (comments.jsonl,
   * flows.json), so a component/pattern node can never match either one,
   * and reading+parsing the whole design system to search for something it
   * structurally cannot contain would be pure waste.
   */
  definitions?: boolean;
};

export type LoadAllDocumentsResult = {
  docs: SourceDoc[];
  /**
   * One warning per source that couldn't be loaded — a blocking parse issue,
   * or (for a component) a duplicate variant name — and was skipped rather
   * than aborting every caller project-wide. Design-system source files are
   * hand-edited and expected to occasionally be broken; find_nodes,
   * set_tokens, promote_to_system, and delete_entity must all still work on
   * everything *else* in the project when one file is broken. Callers fold
   * these into their own `warnings` response.
   */
  warnings: Warning[];
};

// Explicit id for the synthetic wrapper — anything but the auto-generated
// "n<counter>" shape, so it can never collide with a real explicit id in
// the document, and (more importantly) so it consumes *this* string from
// the id allocator instead of "n1", leaving the definition's real first
// unlabeled element with the same id an unwrapped parse would give it.
const WRAPPER_ID = "__artisign_definition_wrapper__";

/**
 * A component's `default` variant (bare markup outside any `<template>`) is
 * legitimately multi-rooted (`parseComponentDefinition` joins every
 * top-level piece with `\n`), and a hand-edited pattern file has no
 * single-root requirement at all. `parseScreen` only keeps a document's
 * first top-level element, silently dropping the rest behind a
 * `malformed_html` issue this module must not swallow — so every definition
 * is parsed inside a synthetic `<template>` wrapper that guarantees exactly
 * one root, unwrapped again by `unwrapDefinitionRoot` before the doc is
 * handed to callers.
 *
 * `<template>` specifically, not `<div>`: HTML's tree-construction rules (the same ones a real
 * browser follows) silently drop table-row/cell and list-item elements that
 * appear without their required ancestor context, and a tag-by-tag special
 * case for `<tr>`/`<td>`/`<th>`/`<li>` still missed `<tbody>`/`<thead>`/
 * `<caption>`/`<colgroup>`/`<col>` and broke on a leading comment. A
 * `<template>`'s content model has none of these restrictions — every
 * element is preserved regardless of context — so one wrapper choice covers
 * all of them. `parser.ts` (`childNodesOf`) already builds a `<template>`'s
 * children from its `.content`, not its (always-empty) `.childNodes`.
 */
function wrapDefinitionMarkup(html: string): string {
  return `<template id="${WRAPPER_ID}">${html}</template>`;
}

/**
 * Inverse of `wrapDefinitionMarkup`. Drops the synthetic wrapper and
 * re-parents its former children to the document root — *except* when the
 * definition is empty (no children at all), where the wrapper node is
 * dropped entirely rather than left behind as a phantom root with no
 * counterpart on disk — no current
 * consumer (find_nodes/set_tokens/promote_to_system/delete_entity)
 * dereferences `rootNodeId` for a definition's doc, all four iterate
 * `doc.nodes` directly, so the empty `""` sentinel this leaves behind is
 * safe. When there is more than one real top-level element, only the first
 * becomes `rootNodeId`; the others stay reachable in `doc.nodes` but not by
 * walking `rootNodeId` -> `childIds`. Documented here rather than solved
 * structurally: `ScreenDocument` has exactly one root by design, matching a
 * real screen file, and no current or obviously-upcoming consumer needs
 * true multi-root traversal.
 */
function unwrapDefinitionRoot(doc: ScreenDocument): void {
  const wrapper = doc.nodes[doc.rootNodeId];
  if (!wrapper) return;
  delete doc.nodes[doc.rootNodeId];
  if (wrapper.childIds.length === 0) {
    doc.rootNodeId = "";
    return;
  }
  for (const childId of wrapper.childIds) {
    const child = doc.nodes[childId];
    if (child) child.parentId = null;
  }
  doc.rootNodeId = wrapper.childIds[0]!;
}

/**
 * Parses `html` as a definition, wrapped/unwrapped per the above. Pushes a
 * `load_failed` warning and returns `null` on any blocking parse issue,
 * rather than throwing — a broken hand-edited file must not fail every
 * other consumer's unrelated work.
 */
function tryParseDefinition(
  html: string,
  address: string,
  registry: DesignSystemRegistry,
  describe: string,
  path: string,
  warnings: Warning[],
): ScreenDocument | null {
  const { doc, errors } = parseScreen(wrapDefinitionMarkup(html), address, registry);
  const blocking = errors.filter(isBlockingIssue);
  if (blocking.length > 0) {
    warnings.push({
      kind: "load_failed",
      target: path,
      message: `${describe} failed to parse and was skipped: ${blocking.map((e) => e.message).join("; ")}`,
    });
    return null;
  }
  unwrapDefinitionRoot(doc);
  return doc;
}

/**
 * Parses every screen, component variant, and pattern in the project into
 * one flat list. Tools that need to search or propagate across the whole
 * project (find_nodes, set_tokens, promote_to_system, delete_entity) must
 * use this instead of re-parsing only `store.listScreens()` — components and
 * patterns hold refs too, and a design system built the way this project's
 * own methodology recommends (refs concentrated in the design system rather
 * than inline per screen) makes a screens-only scan increasingly wrong.
 *
 * Deterministic order (screens, then components, then patterns, each sorted
 * by name, variants sorted by name) so callers and tests get stable results.
 */
export async function loadAllDocuments(
  store: Store,
  registry: DesignSystemRegistry,
  options?: LoadAllDocumentsOptions,
): Promise<LoadAllDocumentsResult> {
  // A caller-supplied screens filter is read directly, without first
  // enumerating every screen on disk, so a scoped find_nodes query stays
  // O(scope) for its screens — but components/patterns are always
  // project-wide regardless of `screens` (see that option's doc comment
  // above); only `options.definitions === false` also skips them.
  const screenNames = options?.screens ? [...options.screens].sort() : [...(await store.listScreens())].sort();

  const docs: SourceDoc[] = [];
  const warnings: Warning[] = [];

  for (const name of screenNames) {
    const html = await store.readScreen(name);
    const { doc } = parseScreen(html, name, registry);
    docs.push({ kind: "screen", name, address: name, doc });
  }

  if (options?.definitions === false) return { docs, warnings };

  const [componentNames, patternNames] = await Promise.all([store.listComponents(), store.listPatterns()]);

  for (const name of [...componentNames].sort()) {
    if (options?.excludeComponents?.includes(name)) continue;
    const html = await store.readComponent(name);
    const definition = parseComponentDefinition(name, html);
    const path = `design-system/components/${name}.html`;

    // A duplicate variant name — bare markup plus a same-named <template>,
    // or two <template>s sharing a data-variant (or both lacking one, which
    // defaults to "default") — would otherwise produce two SourceDocs at
    // the same address, double-counting/double-reporting every match.
    // Skip the whole component with a warning rather than aborting every
    // other caller.
    const seenVariantNames = new Set<string>();
    let hasDuplicateVariant = false;
    for (const variant of definition.variants) {
      if (seenVariantNames.has(variant.name)) {
        warnings.push({
          kind: "load_failed",
          target: path,
          message: `component "${name}" has duplicate variant "${variant.name}" in ${path} and was skipped`,
        });
        hasDuplicateVariant = true;
        break;
      }
      seenVariantNames.add(variant.name);
    }
    if (hasDuplicateVariant) continue;

    for (const variant of [...definition.variants].sort((a, b) => a.name.localeCompare(b.name))) {
      const address = `component:${name}#${variant.name}`;
      const doc = tryParseDefinition(variant.htmlAug, address, registry, `component "${name}" variant "${variant.name}"`, path, warnings);
      if (doc) docs.push({ kind: "component", name, variant: variant.name, address, doc });
    }
  }

  for (const name of [...patternNames].sort()) {
    const html = await store.readPattern(name);
    const address = `pattern:${name}`;
    const path = `design-system/patterns/${name}.html`;
    const doc = tryParseDefinition(html, address, registry, `pattern "${name}"`, path, warnings);
    if (doc) docs.push({ kind: "pattern", name, address, doc });
  }

  return { docs, warnings };
}

/**
 * Finds the one `SourceDoc` a `component:`/`pattern:` node ref addresses,
 * scanning the full `loadAllDocuments` result for its `address` (ADR-004
 * §1). A name/variant that isn't found — including one dropped by
 * `loadAllDocuments` because its file failed to parse — fails with
 * `not_found`, not a generic parse failure: the ref itself parsed fine,
 * there's just nothing at that address. Shared by `get_node`, `inspect_node`
 * and `get_screenshot`, the three read-path tools ADR-004 §1 dispatches to a
 * definition.
 */
export async function loadDefinitionSource(
  store: Store,
  registry: DesignSystemRegistry,
  ref: DefinitionNodeRef,
): Promise<SourceDoc> {
  const { docs } = await loadAllDocuments(store, registry);
  const source = docs.find((d) => d.address === ref.address);
  if (!source) {
    const label = ref.kind === "component" ? `component "${ref.name}" variant "${ref.variant}"` : `pattern "${ref.name}"`;
    throw new ToolError("not_found", `${label} was not found`);
  }
  return source;
}
