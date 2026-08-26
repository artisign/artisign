import { createHash } from "node:crypto";
import type { Store } from "../store/index.js";
import { FsStore } from "../store/index.js";
import { initProject } from "../init/init-project.js";
import { CONFIG_FILENAME } from "../init/artisign-config.js";
import {
  loadRegistry,
  parseScreen,
  parseComponentDefinition,
  serializeScreen,
  serializeDetachedSubtree,
  rewriteLiteralStyleValueInDefinition,
  type Node as InternalNode,
  type NodeSubtree,
  type ScreenDocument,
} from "../model/index.js";
import { loadScreen } from "./context.js";
import { loadAllDocuments } from "./definitions.js";
import { parseNodeRef, formatNodeRef, requireScreenNodeRef } from "./node-ref.js";
import { syncScreenFlows, belongsToScreen } from "./flows.js";
import { nodeToSubtree, convertToComponentInstance, subtreesStructurallyEqual } from "./node-convert.js";
import { deleteMockupEntity } from "./mockups.js";
import { slotStylingWarnings } from "./definition-checks.js";
import { assertValidEntityName } from "./name-validation.js";
import { ToolError, commitFields, type Warning, type ToolHandlerContext } from "./types.js";

function contentHash(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}

function subtreeHasInlineStyleValue(subtree: NodeSubtree, value: string): boolean {
  if (Object.values(subtree.inlineStyles).includes(value)) return true;
  return subtree.children.some((child) => subtreeHasInlineStyleValue(child, value));
}

/**
 * True if `value` appears as an inline style value anywhere in `doc` —
 * document nodes *and* component-instance slot-override content, which
 * lives outside `doc.nodes` (in each such node's `slotOverrides`) and is
 * therefore invisible to a plain `Object.values(doc.nodes)` scan. Slot
 * content is never assigned a node id of its own (`buildSubtree` in
 * model/parser.ts doesn't touch the id allocator), so a match found only
 * there can inform *whether* a file needs rewriting but can never be named
 * in `rewritten_nodes` — a structural gap in the canonical model, not
 * something this scan can paper over.
 */
function docHasInlineStyleValue(doc: ScreenDocument, value: string): boolean {
  for (const node of Object.values(doc.nodes)) {
    if (Object.values(node.inlineStyles).includes(value)) return true;
    if (node.slotOverrides && Object.values(node.slotOverrides).some((s) => subtreeHasInlineStyleValue(s, value))) {
      return true;
    }
  }
  return false;
}

/**
 * Promotes every literal style declaration matching `value` inside a slot
 * subtree to a `$path` ref, in place — the same treatment a screen's own
 * `doc.nodes` get, extended to slot-override content.
 * Returns whether anything changed. No node id exists for slot content
 * (see docHasInlineStyleValue's doc comment), so a match here still can't
 * be named in `rewritten_nodes` — only the enclosing screen is marked
 * affected.
 */
function promoteInlineStyleInSubtree(subtree: NodeSubtree, value: string, path: string): boolean {
  let changed = false;
  for (const [p, v] of Object.entries(subtree.inlineStyles)) {
    if (v !== value) continue;
    delete subtree.inlineStyles[p];
    subtree.refs.tokens[p] = path;
    changed = true;
  }
  for (const child of subtree.children) {
    if (promoteInlineStyleInSubtree(child, value, path)) changed = true;
  }
  return changed;
}

async function fetchExternalHtml(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new ToolError("io_error", `failed to fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

function deriveScreenName(seedUrl: string, existing: string[]): string {
  const base = new URL(seedUrl).pathname.split("/").filter(Boolean).pop()?.replace(/\.\w+$/, "") || "imported";
  let name = base;
  let n = 1;
  while (existing.includes(name)) {
    name = `${base}-${n}`;
    n += 1;
  }
  return name;
}

// ---------------------------------------------------------------------------
// L1 init_project
// ---------------------------------------------------------------------------

export type InitProjectSeed =
  | { kind: "empty" }
  | { kind: "html"; html_aug: string; screen: string }
  | { kind: "stitch_export"; url: string };

export type InitProjectInput = {
  dir: string;
  name?: string;
  seed: InitProjectSeed;
  git?: boolean;
};

export async function initProjectTool(input: InitProjectInput, ctx?: ToolHandlerContext): Promise<Record<string, unknown>> {
  await initProject(input.dir);
  const store = new FsStore(input.dir);
  const filesCreated = [
    CONFIG_FILENAME,
    "design-system/tokens.json",
    "flows.json",
    "comments.jsonl",
    ".gitignore",
  ];

  if (input.name) {
    const config = await store.readArtisignConfig();
    config.name = input.name;
    await store.writeArtisignConfig(config);
  }
  if (input.git === false) {
    const config = await store.readArtisignConfig();
    config.settings.autoCommit = false;
    await store.writeArtisignConfig(config);
  }

  const screens: string[] = [];
  if (input.seed.kind !== "empty") {
    const html_aug = input.seed.kind === "html" ? input.seed.html_aug : await fetchExternalHtml(input.seed.url);
    const screenName = input.seed.kind === "html" ? input.seed.screen : deriveScreenName(input.seed.url, []);
    assertValidEntityName("screen", screenName);
    const registry = await loadRegistry(store);
    const { doc } = parseScreen(html_aug, screenName, registry);
    await store.writeScreen(screenName, serializeScreen(doc));
    await syncScreenFlows(store, doc);
    filesCreated.push(`screens/${screenName}.html`);
    screens.push(screenName);
  }

  const commitResult = await store.commit("init_project");

  // Registers the freshly scaffolded project with the daemon's
  // ProjectRegistry so it's servable — over MCP and the preview —
  // without a daemon restart. Absent for the stdio server (no registry);
  // scaffolding-only is the correct, unchanged behavior there.
  await ctx?.openProject?.(store.projectDir);

  return { root: store.projectDir, files_created: filesCreated, screens, ...commitFields(commitResult) };
}

// ---------------------------------------------------------------------------
// L2 import_html
// ---------------------------------------------------------------------------

export type ImportSource = { kind: "html"; html_aug: string; screen?: string } | { kind: "stitch_export"; url: string };

export type ImportHtmlInput = {
  source: ImportSource;
  dedupe?: boolean;
};

export async function importHtml(store: Store, input: ImportHtmlInput): Promise<Record<string, unknown>> {
  const dedupe = input.dedupe ?? true;
  const html_aug = input.source.kind === "html" ? input.source.html_aug : await fetchExternalHtml(input.source.url);

  const existingNames = await store.listScreens();
  const screenName =
    input.source.kind === "html" ? (input.source.screen ?? deriveScreenName(`https://x/${Date.now()}`, existingNames)) : deriveScreenName(input.source.url, existingNames);

  assertValidEntityName("screen", screenName);
  const registry = await loadRegistry(store);
  const { doc, errors } = parseScreen(html_aug, screenName, registry);
  if (errors.length > 0) {
    return { commit: null, imported: [], skipped_duplicate_count: 0, warnings: [], errors };
  }
  // Hash the canonical (parsed + re-serialized) form, not the raw
  // agent-submitted markup — every on-disk screen is already canonical
  // (written via serializeScreen), so a raw-vs-canonical comparison rarely
  // matches even for semantically identical content (whitespace, attribute
  // order, unresolved $refs vs. resolved ones).
  const canonical = serializeScreen(doc);

  if (dedupe) {
    const incomingHash = contentHash(canonical);
    for (const name of existingNames) {
      const existingHtml = await store.readScreen(name);
      if (contentHash(existingHtml) === incomingHash) {
        return { commit: null, imported: [], skipped_duplicate_count: 1, warnings: [] };
      }
    }
  }

  await store.writeScreen(screenName, canonical);
  await syncScreenFlows(store, doc);
  const commitResult = await store.commit(`import_html: ${screenName}`);

  return {
    ...commitFields(commitResult),
    imported: [{ screen: screenName, path: `screens/${screenName}.html` }],
    skipped_duplicate_count: 0,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// L3 promote_to_system
// ---------------------------------------------------------------------------

export type PromoteToSystemInput = {
  node: string;
  kind: "token" | "component" | "pattern";
  name: string;
  variants?: string[];
};

async function promoteToken(store: Store, doc: ScreenDocument, node: InternalNode, name: string): Promise<Record<string, unknown>> {
  const props = Object.keys(node.inlineStyles).sort();
  const prop = props[0];
  if (!prop) {
    throw new ToolError("invalid_state", `node "${formatNodeRef(doc.id, node.id)}" has no inline style value to promote`);
  }
  const value = node.inlineStyles[prop]!;

  const dot = name.replace(/^\$/, "").indexOf(".");
  if (dot === -1) throw new ToolError("validation_failed", `token name must be a dot-path, got "${name}"`);
  const bucket = name.replace(/^\$/, "").slice(0, dot);
  const member = name.replace(/^\$/, "").slice(dot + 1);
  const path = `${bucket}.${member}`;

  // The token is written *first*. Every scan below must resolve $-class
  // refs (class="$color.brand") against the registry that already includes
  // this path — resolveClassRef (model/parser.ts) treats a not-yet-existing
  // path as unresolved, and an unresolved $-class token is dropped from the
  // element's class list while parsing (only the data-component branch
  // keeps an unresolved ref around). A pre-write scan would silently delete
  // any *other* class="$<this-path>" ref sitting in a screen that also
  // happens to get re-serialized here. loadAllDocuments no longer throws, so
  // writing the token first carries none of the "write already committed,
  // then failed to process whole other files" risk that motivated the
  // earlier scan-before-write ordering — there is no delete/dangling
  // concern here at all (this path only ever adds a token, never removes
  // one), so a single post-write scan is strictly sufficient.
  const tokens = await store.readTokens();
  tokens[bucket] ??= {};
  tokens[bucket]![member] = value;
  await store.writeTokens(tokens);

  const registry = await loadRegistry(store);
  const { docs: sources, warnings: loadWarnings } = await loadAllDocuments(store, registry);
  const warnings: Warning[] = [...loadWarnings];

  const rewrittenNodes: string[] = [];
  const affectedScreens = new Set<string>();
  const componentCandidates = new Set<string>();
  const patternCandidates = new Set<string>();

  for (const source of sources) {
    if (source.kind === "screen") {
      // Screens are always canonical (written via serializeScreen) — the
      // parse->serialize round trip that's unsafe for hand-curated
      // definitions is the proven-correct path here.
      let changed = false;
      for (const n of Object.values(source.doc.nodes)) {
        for (const [p, v] of Object.entries(n.inlineStyles)) {
          if (v !== value) continue;
          delete n.inlineStyles[p];
          n.refs.tokens[p] = path;
          rewrittenNodes.push(formatNodeRef(source.address, n.id));
          changed = true;
        }
        if (n.slotOverrides) {
          for (const subtree of Object.values(n.slotOverrides)) {
            if (promoteInlineStyleInSubtree(subtree, value, path)) changed = true;
          }
        }
      }
      if (changed) {
        await store.writeScreen(source.name, serializeScreen(source.doc));
        affectedScreens.add(source.name);
      }
      continue;
    }

    // Slot-override content (a component instance's own children) lives
    // outside doc.nodes and must be scanned too, or a match sitting only
    // there is never even detected as a reason to touch the file — see docHasInlineStyleValue's doc comment
    // for why it still can't appear in rewritten_nodes.
    if (!docHasInlineStyleValue(source.doc, value)) continue;
    if (source.kind === "component") componentCandidates.add(source.name);
    else patternCandidates.add(source.name);
  }

  const affectedComponents = new Set<string>();
  const affectedPatterns = new Set<string>();

  // This third definition-write path deliberately does NOT
  // run the slot-styling check. It only swaps a literal style value for an
  // equivalent token ref on an element that already carried that styling —
  // it can never turn an unstyled slot into a styled one, so it cannot
  // create the condition the warning exists for. (`update_refs` writes no
  // definition file at all.)

  for (const componentName of componentCandidates) {
    const html = await store.readComponent(componentName);
    const { html: rewritten, changed } = rewriteLiteralStyleValueInDefinition(html, value, path);
    if (!changed) {
      // The model-level scan above found a candidate, but the
      // source-preserving rewrite found nothing to touch — should be
      // unreachable now that both use the same decoded-value comparison,
      // but reported rather than silently leaving the value inline if it
      // ever happens.
      warnings.push({
        kind: "unknown_ref",
        target: `design-system/components/${componentName}.html`,
        message: `expected to rewrite "${value}" to "$${path}" in design-system/components/${componentName}.html but found no matching style declaration — value left inline`,
      });
      continue;
    }
    await store.writeComponent(componentName, rewritten);
    affectedComponents.add(componentName);
    // Report is written only for files actually rewritten — node refs come from the canonical scan above,
    // which is only used for addressing here, not for deciding what changed.
    for (const source of sources) {
      if (source.kind !== "component" || source.name !== componentName) continue;
      for (const n of Object.values(source.doc.nodes)) {
        if (Object.values(n.inlineStyles).includes(value)) rewrittenNodes.push(formatNodeRef(source.address, n.id));
      }
    }
  }
  for (const patternName of patternCandidates) {
    const html = await store.readPattern(patternName);
    const { html: rewritten, changed } = rewriteLiteralStyleValueInDefinition(html, value, path);
    if (!changed) {
      warnings.push({
        kind: "unknown_ref",
        target: `design-system/patterns/${patternName}.html`,
        message: `expected to rewrite "${value}" to "$${path}" in design-system/patterns/${patternName}.html but found no matching style declaration — value left inline`,
      });
      continue;
    }
    await store.writePattern(patternName, rewritten);
    affectedPatterns.add(patternName);
    for (const source of sources) {
      if (source.kind !== "pattern" || source.name !== patternName) continue;
      for (const n of Object.values(source.doc.nodes)) {
        if (Object.values(n.inlineStyles).includes(value)) rewrittenNodes.push(formatNodeRef(source.address, n.id));
      }
    }
  }

  const commitResult = await store.commit(`promote_to_system: token ${path}`);

  return {
    ...commitFields(commitResult),
    entity: { kind: "token", name: `$${path}`, path: "design-system/tokens.json" },
    rewritten_nodes: rewrittenNodes,
    rewritten_count: rewrittenNodes.length,
    affected_screens: [...affectedScreens],
    affected_components: [...affectedComponents],
    affected_patterns: [...affectedPatterns],
    warnings,
  };
}

async function promoteComponentOrPattern(
  store: Store,
  doc: ScreenDocument,
  node: InternalNode,
  kind: "component" | "pattern",
  name: string,
  variantNames: string[] | undefined,
): Promise<Record<string, unknown>> {
  // Captured before any mutation — used both to write the definition file
  // and (for components) to find other occurrences project-wide below.
  // Deep-cloned because nodeToSubtree returns references into the live
  // node's attributes/refs/inlineStyles objects, and convertToComponentInstance
  // mutates node.refs in place (adds .component) — without the clone,
  // originalSubtree would silently pick up that mutation too and never
  // match any other (still-unconverted) occurrence.
  const originalSubtree = structuredClone(nodeToSubtree(doc, node.id));
  // Slot placeholders are NOT tagged into this markup — a promoted node's
  // top-level children (which may well be bare text, e.g. <button>Click
  // me</button>) can't all carry a data-slot attribute, and the render
  // side (collectTemplateSlots in render.ts) already treats a template
  // root's un-slotted direct children as implicit positional slots, the
  // same way collectSlotOverrides/convertToComponentInstance already do
  // for an instance's own un-slotted children.
  const defaultHtml = serializeDetachedSubtree(originalSubtree);
  const extraVariants = (variantNames ?? [])
    .filter((v) => v !== "default")
    .map((v) => `<template data-variant="${v}">${defaultHtml}</template>`)
    .join("\n");
  const fileContent = extraVariants ? `${defaultHtml}\n${extraVariants}` : defaultHtml;

  // The same duplicate-variant validation writeDefinition performs, applied to
  // the file this path is about to write. Checked on the parsed
  // result rather than on the input list, because the list is not the whole
  // story: variant names are interpolated into the markup unescaped, so a name
  // carrying a quote can manufacture a duplicate the raw list never shows.
  const seenVariantNames = new Set<string>();
  for (const variant of parseComponentDefinition(name, fileContent).variants) {
    if (seenVariantNames.has(variant.name)) {
      throw new ToolError("validation_failed", `duplicate variant name "${variant.name}"`);
    }
    seenVariantNames.add(variant.name);
  }

  const path =
    kind === "component" ? `design-system/components/${name}.html` : `design-system/patterns/${name}.html`;

  const definitionWarnings: Warning[] = [];

  if (kind === "component") {
    await store.writeComponent(name, fileContent);
  } else {
    await store.writePattern(name, fileContent);
  }

  const rewrittenNodes: string[] = [];
  const affectedScreens = new Set<string>();

  // Components get a live ref binding on every structurally identical
  // occurrence project-wide (Tool-Palette-Schemas: "rewrites every
  // occurrence in screens/ to a ref"). Patterns have no ref/instance
  // mechanism in the canonical model at all (Schema-Spec only defines
  // component_instance) — that's a structural limitation of the model, not
  // a scope cut, so the source node is the only thing a pattern promotion
  // ever touches; see the tool's description in registry.ts.
  if (kind === "component") {
    convertToComponentInstance(doc, node, name);
    rewrittenNodes.push(formatNodeRef(doc.id, node.id));
    affectedScreens.add(doc.id);

    const registry = await loadRegistry(store);

    // Promotion reaches the same on-disk state write_html does, through a
    // different door — so it runs the same definition-level check.
    // Every variant written above is a copy of defaultHtml, so one parse
    // answers for all of them. Patterns are exempt for the reason
    // writeDefinition names: a pattern is never expanded into an instance,
    // so its slot styling survives.
    const { doc: variantDoc } = parseScreen(defaultHtml, name, registry);
    // Duplicates are rejected above, so no slot is reported twice
    // under one target.
    for (const variantName of ["default", ...(variantNames ?? []).filter((v) => v !== "default")]) {
      definitionWarnings.push(...slotStylingWarnings(variantDoc, `${name}#${variantName}`));
    }

    const screenNames = await store.listScreens();
    const touchedDocs = new Map<string, ScreenDocument>([[doc.id, doc]]);

    for (const screenName of screenNames) {
      let screenDoc = touchedDocs.get(screenName);
      if (!screenDoc) {
        const html = await store.readScreen(screenName);
        screenDoc = parseScreen(html, screenName, registry).doc;
      }

      // Snapshot matches before mutating — converting one match deletes its
      // descendant node entries, which could otherwise remove another
      // match's entry out from under this loop if one happened to be
      // nested inside another.
      const matches = Object.values(screenDoc.nodes).filter(
        (n) => n.kind !== "component_instance" && subtreesStructurallyEqual(nodeToSubtree(screenDoc!, n.id), originalSubtree),
      );

      let changed = false;
      for (const match of matches) {
        if (!screenDoc.nodes[match.id]) continue; // already removed by an earlier match's conversion this pass
        convertToComponentInstance(screenDoc, match, name);
        rewrittenNodes.push(formatNodeRef(screenName, match.id));
        affectedScreens.add(screenName);
        changed = true;
      }
      if (changed) touchedDocs.set(screenName, screenDoc);
    }

    for (const [screenName, touchedDoc] of touchedDocs) {
      await store.writeScreen(screenName, serializeScreen(touchedDoc));
      await syncScreenFlows(store, touchedDoc);
    }
  }

  const commitResult = await store.commit(`promote_to_system: ${kind} ${name}`);

  return {
    ...commitFields(commitResult),
    entity: { kind, name, path },
    rewritten_nodes: rewrittenNodes,
    rewritten_count: rewrittenNodes.length,
    affected_screens: [...affectedScreens],
    warnings: definitionWarnings,
  };
}

export async function promoteToSystem(store: Store, input: PromoteToSystemInput): Promise<Record<string, unknown>> {
  const { screen, nodeId } = requireScreenNodeRef(parseNodeRef(input.node), "promote_to_system");
  const { doc } = await loadScreen(store, screen);
  const node = doc.nodes[nodeId];
  if (!node) throw new ToolError("not_found", `node "${input.node}" was not found`);

  if (input.kind === "token") {
    return promoteToken(store, doc, node, input.name);
  }
  assertValidEntityName(input.kind, input.name);
  return promoteComponentOrPattern(store, doc, node, input.kind, input.name, input.variants);
}

// ---------------------------------------------------------------------------
// L4 delete_entity
// ---------------------------------------------------------------------------

export type DeleteEntityInput = { kind: "screen" | "component" | "pattern" | "mockup"; name: string; variant?: string };

async function deleteComponent(store: Store, name: string): Promise<Record<string, unknown>> {
  const path = `design-system/components/${name}.html`;
  if (!(await store.listComponents()).includes(name)) {
    throw new ToolError("not_found", `component "${name}" was not found`);
  }

  const registry = await loadRegistry(store);
  // Screens, other components, and patterns can all hold a component_ref —
  // the component being deleted itself is excluded up front (not parsed at
  // all) so its own file, even if broken, is never a reason the deletion
  // can't proceed.
  const { docs: sources, warnings } = await loadAllDocuments(store, registry, { excludeComponents: [name] });
  // find_nodes/set_tokens/promote_to_system can afford to skip a broken
  // source with a warning — a destructive delete can't. "I can't rule out a
  // reference living in this file" is not a reason to proceed: fail closed, naming the unreadable file(s).
  const loadFailures = warnings.filter((w) => w.kind === "load_failed");
  if (loadFailures.length > 0) {
    throw new ToolError(
      "conflict",
      `cannot safely delete component "${name}" — reference check is incomplete because the following source(s) failed to load: ${loadFailures.map((w) => w.target).join(", ")}`,
    );
  }

  const referencingNodes: string[] = [];
  for (const source of sources) {
    for (const node of Object.values(source.doc.nodes)) {
      if (node.refs.component === name) referencingNodes.push(formatNodeRef(source.address, node.id));
    }
  }
  if (referencingNodes.length > 0) {
    throw new ToolError(
      "conflict",
      `component "${name}" is still referenced by: ${referencingNodes.join(", ")} — clear these refs first (update_refs with component_ref: null)`,
    );
  }

  await store.deleteComponent(name);
  const commitResult = await store.commit(`delete_entity: component:${name}`);
  return { kind: "component", name, path, ...commitFields(commitResult), warnings: [] };
}

async function deletePattern(store: Store, name: string): Promise<Record<string, unknown>> {
  const path = `design-system/patterns/${name}.html`;
  if (!(await store.listPatterns()).includes(name)) {
    throw new ToolError("not_found", `pattern "${name}" was not found`);
  }
  // No reference check needed: NodeRefs (src/model/types.ts) has no
  // `pattern` field, so nothing in the canonical model can ever hold a
  // pattern ref — a pattern's inclusion into a screen or another pattern is
  // opaque, unmarked HTML, not a tracked reference.
  await store.deletePattern(name);
  const commitResult = await store.commit(`delete_entity: pattern:${name}`);
  return { kind: "pattern", name, path, ...commitFields(commitResult), warnings: [] };
}

async function deleteScreenEntity(store: Store, name: string): Promise<Record<string, unknown>> {
  const path = `screens/${name}.html`;
  if (!(await store.listScreens()).includes(name)) {
    throw new ToolError("not_found", `screen "${name}" was not found`);
  }

  const allFlows = await store.readFlows();
  const outgoing = allFlows.filter((r) => belongsToScreen(r, name));
  const incoming = allFlows.filter((r) => !belongsToScreen(r, name) && (r.to === name || r.to.startsWith(`${name}.`)));
  const remaining = allFlows.filter((r) => !belongsToScreen(r, name));
  await store.writeFlows(remaining);

  const warnings: Warning[] = incoming.map((r) => ({
    kind: "dangling_flow",
    target: r.from,
    message: `flow from "${r.from}" still targets deleted screen "${name}"`,
  }));

  await store.deleteScreen(name);
  const commitResult = await store.commit(`delete_entity: screen:${name}`);

  return { kind: "screen", name, path, ...commitFields(commitResult), warnings, removed_flow_count: outgoing.length };
}

export async function deleteEntity(store: Store, input: DeleteEntityInput): Promise<Record<string, unknown>> {
  if (input.kind === "component") return deleteComponent(store, input.name);
  if (input.kind === "pattern") return deletePattern(store, input.name);
  if (input.kind === "mockup") return deleteMockupEntity(store, input.name, input.variant);
  return deleteScreenEntity(store, input.name);
}
