import type { Store, TokensDocument } from "../store/index.js";
import {
  loadRegistry,
  parseScreen,
  parseComponentDefinition,
  serializeScreen,
  computeDriftWarnings,
  resolveTokenRef,
  tokenRefPaths,
  type ScreenDocument,
  type TokenRef,
} from "../model/index.js";
import { loadScreen } from "./context.js";
import { loadAllDocuments } from "./definitions.js";
import { parseNodeRef, formatNodeRef, requireScreenNodeRef } from "./node-ref.js";
import { syncScreenFlows } from "./flows.js";
import { diffScreenDocuments } from "./diff.js";
import { findBySelector, spliceFragment, removeNode } from "./patch.js";
import { convertToComponentInstance, revertComponentInstanceToElement } from "./node-convert.js";
import { isBlockingIssue, issueToWarning } from "./issue-filter.js";
import { slotStylingWarnings } from "./definition-checks.js";
import { assertValidEntityName } from "./name-validation.js";
import { patchDefinitionHtml, updateRefsDefinition } from "./definition-patch.js";
import {
  ToolError,
  commitFields,
  RESERVED_SET_ATTR_NAMES,
  reservedSetAttrMessage,
  type ResponseMode,
  type Warning,
  type PublicFlow,
  type TokenValue,
} from "./types.js";

function shapeWriteResponse(
  base: Record<string, unknown>,
  doc: ScreenDocument | null,
  before: ScreenDocument | null,
  responseMode: ResponseMode,
): Record<string, unknown> {
  if (responseMode === "summary" || !doc) return base;
  const diff = diffScreenDocuments(before, doc);
  if (responseMode === "diff") return { ...base, diff };
  const nodes = Object.values(doc.nodes).map((n) => ({ id: n.id, tag: n.tag, parent_id: n.parentId }));
  return { ...base, diff, nodes };
}

// ---------------------------------------------------------------------------
// W1 write_html
// ---------------------------------------------------------------------------

export type WriteHtmlInput = {
  screen: string;
  mode: "create" | "replace";
  title?: string;
  html_aug: string;
  kind?: "screen" | "component" | "pattern";
  response_mode?: ResponseMode;
};

/**
 * Writes a `design-system/components/<name>.html` or `.../patterns/<name>.html`
 * definition file — a default variant plus optional sibling
 * `<template data-variant="x">` blocks. Unlike a screen write, definitions
 * are never canonicalized: the raw html_aug is written verbatim, since
 * re-serializing would inject generated ids and destroy the <template>
 * structure. Variants intentionally repeat ids (promote_to_system output
 * does the same), so cross-variant id uniqueness is not enforced here.
 */
async function writeDefinition(
  store: Store,
  input: WriteHtmlInput,
  kind: "component" | "pattern",
): Promise<Record<string, unknown>> {
  assertValidEntityName(kind, input.screen);
  const existingNames = kind === "component" ? await store.listComponents() : await store.listPatterns();
  const exists = existingNames.includes(input.screen);

  if (input.mode === "create") {
    if (exists) throw new ToolError("conflict", `${kind} "${input.screen}" already exists`);
  } else if (!exists) {
    throw new ToolError("not_found", `${kind} "${input.screen}" was not found`);
  }
  if (input.title) throw new ToolError("validation_failed", 'title applies only to kind "screen"');

  const path = `design-system/${kind}s/${input.screen}.html`;
  const definition = parseComponentDefinition(input.screen, input.html_aug);
  if (definition.variants.length === 0) {
    return {
      kind,
      screen: input.screen,
      path,
      commit: null,
      errors: [{ code: "validation_failed", message: "definition must contain a default-variant root element" }],
      warnings: [],
    };
  }
  const seenVariantNames = new Set<string>();
  for (const variant of definition.variants) {
    if (seenVariantNames.has(variant.name)) {
      return {
        kind,
        screen: input.screen,
        path,
        commit: null,
        errors: [{ code: "validation_failed", message: `duplicate variant name "${variant.name}"` }],
        warnings: [],
      };
    }
    seenVariantNames.add(variant.name);
  }

  const registry = await loadRegistry(store);
  const warnings: Warning[] = [];
  const variantDocs: ScreenDocument[] = [];
  for (const variant of definition.variants) {
    const target = `${input.screen}#${variant.name}`;
    const { doc, errors } = parseScreen(variant.htmlAug, input.screen, registry);
    const blockingErrors = errors.filter(isBlockingIssue);
    if (blockingErrors.length > 0) {
      return { kind, screen: input.screen, path, commit: null, errors: blockingErrors, warnings: [] };
    }
    for (const e of errors.filter((e) => !isBlockingIssue(e))) warnings.push(issueToWarning(e, target));
    // Only components get their slots substituted — a pattern is never
    // expanded into an instance, so its slot styling survives.
    if (kind === "component") warnings.push(...slotStylingWarnings(doc, target));
    variantDocs.push(doc);
  }

  // Self-reference: the renderer has no recursion guard for a component
  // instance that refers to its own definition.
  if (kind === "component") {
    for (const doc of variantDocs) {
      for (const node of Object.values(doc.nodes)) {
        if (node.refs.component === input.screen) {
          throw new ToolError("validation_failed", `component "${input.screen}" cannot reference itself`);
        }
      }
    }
  }

  if (kind === "component") await store.writeComponent(input.screen, input.html_aug);
  else await store.writePattern(input.screen, input.html_aug);
  const commitResult = await store.commit(`write_html: ${kind}:${input.screen}`);

  return {
    kind,
    name: input.screen,
    path,
    ...commitFields(commitResult),
    variants: definition.variants.map((v) => v.name),
    warnings,
  };
}

export async function writeHtml(store: Store, input: WriteHtmlInput): Promise<Record<string, unknown>> {
  if (input.kind === "component" || input.kind === "pattern") {
    return writeDefinition(store, input, input.kind);
  }
  const responseMode = input.response_mode ?? "summary";
  const existingNames = await store.listScreens();
  const exists = existingNames.includes(input.screen);

  if (input.mode === "create") {
    assertValidEntityName("screen", input.screen);
    if (exists) throw new ToolError("conflict", `screen "${input.screen}" already exists`);
    if (!input.title) throw new ToolError("validation_failed", "title is required when mode is \"create\"");
  } else if (!exists) {
    throw new ToolError("not_found", `screen "${input.screen}" was not found`);
  }

  const before = exists ? (await loadScreen(store, input.screen)).doc : null;

  const registry = await loadRegistry(store);
  const { doc, errors } = parseScreen(input.html_aug, input.screen, registry);
  if (input.title) doc.title = input.title;

  const path = `screens/${input.screen}.html`;
  // unresolved_ref and suspicious_attr degrade to a warning rather than
  // blocking (see issue-filter.ts): a token or component can go missing for
  // reasons unrelated to this write, and blocking the *entire* screen on a
  // stale ref (or a likely-misspelled data-* attribute) elsewhere in it
  // would mean an agent can no longer round-trip an otherwise-untouched
  // file. Every other error kind (malformed HTML, duplicate ids, ...)
  // still blocks.
  const blockingErrors = errors.filter(isBlockingIssue);
  if (blockingErrors.length > 0) {
    return { screen: input.screen, path, commit: null, errors: blockingErrors, warnings: [] };
  }
  const refWarnings: Warning[] = errors
    .filter((e) => !isBlockingIssue(e))
    .map((e) => issueToWarning(e, formatNodeRef(input.screen, e.nodeId ?? doc.rootNodeId)));

  await store.writeScreen(input.screen, serializeScreen(doc));
  await syncScreenFlows(store, doc);
  const commitResult = await store.commit(`write_html: ${input.screen}`);

  const tokens = await store.readTokens();
  const driftWarnings: Warning[] = computeDriftWarnings(doc, tokens).map((w) => ({
    kind: "drift",
    target: formatNodeRef(input.screen, w.nodeId ?? doc.rootNodeId),
    message: w.message,
    suggestion: w.suggestion,
  }));
  const warnings = [...refWarnings, ...driftWarnings];

  const base = {
    screen: input.screen,
    path,
    ...commitFields(commitResult),
    root_node_id: doc.rootNodeId,
    node_count: Object.keys(doc.nodes).length,
    warnings,
  };
  return shapeWriteResponse(base, doc, before, responseMode);
}

// ---------------------------------------------------------------------------
// W2 patch_html
// ---------------------------------------------------------------------------

export type PatchTarget = { kind: "node"; node: string } | { kind: "selector"; screen: string; css_selector: string };
export type PatchOperation = "replace" | "insert_before" | "insert_after" | "delete" | "set_attr";

export type PatchHtmlInput = {
  target: PatchTarget;
  operation: PatchOperation;
  html_aug?: string;
  attr?: { name: string; value: string | null };
  response_mode?: ResponseMode;
};

export async function patchHtml(store: Store, input: PatchHtmlInput): Promise<Record<string, unknown>> {
  const responseMode = input.response_mode ?? "summary";
  const nodeRef = input.target.kind === "node" ? parseNodeRef(input.target.node) : null;
  if (nodeRef && nodeRef.kind !== "screen") return patchDefinitionHtml(store, nodeRef, input);

  const targetNodeRef = nodeRef ? requireScreenNodeRef(nodeRef, "patch_html") : null;
  const screen = input.target.kind === "node" ? targetNodeRef!.screen : input.target.screen;

  const { doc: before } = await loadScreen(store, screen);
  const doc: ScreenDocument = structuredClone(before);
  const registry = await loadRegistry(store);

  const targetIds: string[] =
    input.target.kind === "node" ? [targetNodeRef!.nodeId] : findBySelector(doc, input.target.css_selector).map((n) => n.id);

  for (const id of targetIds) {
    if (!doc.nodes[id]) throw new ToolError("not_found", `node "${formatNodeRef(screen, id)}" was not found`);
  }
  if (targetIds.length === 0) {
    throw new ToolError("not_found", `no node matched selector "${input.target.kind === "selector" ? input.target.css_selector : ""}"`);
  }

  const affected = new Set<string>();
  const refWarnings: Warning[] = [];

  for (const id of targetIds) {
    // A selector can match both an ancestor and one of its own descendants;
    // deleting the ancestor already removed the descendant's entry.
    const node = doc.nodes[id];
    if (!node) continue;
    switch (input.operation) {
      case "delete": {
        if (!node.parentId) throw new ToolError("validation_failed", "cannot delete the screen's root node");
        removeNode(doc, id);
        affected.add(formatNodeRef(screen, id));
        break;
      }
      case "set_attr": {
        if (!input.attr) throw new ToolError("validation_failed", "attr is required for operation \"set_attr\"");
        if (RESERVED_SET_ATTR_NAMES.has(input.attr.name)) {
          throw new ToolError("validation_failed", reservedSetAttrMessage(input.attr.name));
        }
        if (input.attr.value === null) delete node.attributes[input.attr.name];
        else node.attributes[input.attr.name] = input.attr.value;
        affected.add(formatNodeRef(screen, id));
        break;
      }
      case "replace": {
        if (!input.html_aug) throw new ToolError("validation_failed", "html_aug is required for operation \"replace\"");
        if (!node.parentId) throw new ToolError("validation_failed", "cannot replace the screen's root node");
        const parent = doc.nodes[node.parentId]!;
        const index = parent.childIds.indexOf(id);
        removeNode(doc, id);
        const { ids: newIds, refWarnings: rw } = spliceFragment(doc, input.html_aug, parent.id, registry);
        parent.childIds.splice(index, 0, ...newIds);
        for (const newId of newIds) affected.add(formatNodeRef(screen, newId));
        for (const w of rw) refWarnings.push(issueToWarning(w, formatNodeRef(screen, w.nodeId ?? parent.id)));
        break;
      }
      case "insert_before":
      case "insert_after": {
        if (!input.html_aug) throw new ToolError("validation_failed", `html_aug is required for operation "${input.operation}"`);
        if (!node.parentId) throw new ToolError("validation_failed", "cannot insert as a sibling of the screen's root node");
        const parent = doc.nodes[node.parentId]!;
        const index = parent.childIds.indexOf(id);
        const { ids: newIds, refWarnings: rw } = spliceFragment(doc, input.html_aug, parent.id, registry);
        parent.childIds.splice(input.operation === "insert_before" ? index : index + 1, 0, ...newIds);
        for (const newId of newIds) affected.add(formatNodeRef(screen, newId));
        for (const w of rw) refWarnings.push(issueToWarning(w, formatNodeRef(screen, w.nodeId ?? parent.id)));
        break;
      }
    }
  }

  await store.writeScreen(screen, serializeScreen(doc));
  await syncScreenFlows(store, doc);
  const commitResult = await store.commit(`patch_html: ${screen}`);

  const tokens = await store.readTokens();
  const allDriftWarnings: Warning[] = computeDriftWarnings(doc, tokens).map((w) => ({
    kind: "drift",
    target: formatNodeRef(screen, w.nodeId ?? doc.rootNodeId),
    message: w.message,
    suggestion: w.suggestion,
  }));
  // A patch only touches affected_nodes — cross-screen drift on nodes this
  // call never looked at would be noise, not feedback on this write. The
  // count keeps that pre-existing drift visible without spelling it out.
  const scopedDriftWarnings = allDriftWarnings.filter((w) => affected.has(w.target!));
  const preexistingDriftCount = allDriftWarnings.length - scopedDriftWarnings.length;

  const base = {
    screen,
    path: `screens/${screen}.html`,
    ...commitFields(commitResult),
    affected_nodes: [...affected],
    warnings: [...refWarnings, ...scopedDriftWarnings],
    preexisting_drift_count: preexistingDriftCount,
  };
  return shapeWriteResponse(base, doc, before, responseMode);
}

// ---------------------------------------------------------------------------
// W3 update_refs
// ---------------------------------------------------------------------------

export type UpdateRefsInput = {
  node: string;
  refs: {
    component_ref?: string | null;
    variant?: string | null;
    token_refs?: Record<string, string | null>;
  };
};

export async function updateRefs(store: Store, input: UpdateRefsInput): Promise<Record<string, unknown>> {
  const parsedRef = parseNodeRef(input.node);
  if (parsedRef.kind !== "screen") return updateRefsDefinition(store, parsedRef, input);

  const { screen, nodeId } = parsedRef;
  const { doc } = await loadScreen(store, screen);
  const node = doc.nodes[nodeId];
  if (!node) throw new ToolError("not_found", `node "${input.node}" was not found`);

  const registry = await loadRegistry(store);
  const warnings: Warning[] = [];
  const applied: Record<string, unknown> = {};

  if (input.refs.component_ref !== undefined) {
    if (input.refs.component_ref === null) {
      if (node.kind === "component_instance") revertComponentInstanceToElement(doc, node);
      else delete node.refs.component;
    } else {
      if (!registry.componentNames.has(input.refs.component_ref)) {
        warnings.push({ kind: "unknown_ref", target: input.node, message: `component "${input.refs.component_ref}" is not in the design system` });
      }
      if (node.kind === "component_instance") {
        // Already an instance — just rebind which component it's an instance of.
        node.refs.component = input.refs.component_ref;
      } else {
        convertToComponentInstance(doc, node, input.refs.component_ref);
      }
    }
    applied.component_ref = input.refs.component_ref;
  }

  if (input.refs.variant !== undefined) {
    if (input.refs.variant === null) delete node.refs.variant;
    else node.refs.variant = input.refs.variant;
    applied.variant = input.refs.variant;
  }

  if (input.refs.token_refs) {
    const appliedTokens: Record<string, TokenRef | null> = {};
    const hasRemoval = Object.values(input.refs.token_refs).some((path) => path === null);
    const tokens = hasRemoval ? await store.readTokens() : null;
    for (const [prop, path] of Object.entries(input.refs.token_refs)) {
      if (path === null) {
        const currentRef = node.refs.tokens[prop];
        // The agent removed the *ref*, not the styling — write the ref's
        // last resolved value back as a literal so the property (and
        // whatever visual result it produced) survives the removal
        // instead of silently vanishing from the style attribute.
        if (currentRef !== undefined) node.inlineStyles[prop] = resolveTokenRef(currentRef, tokens!);
        delete node.refs.tokens[prop];
      } else {
        if (!registry.tokenPaths.has(path)) {
          warnings.push({ kind: "unknown_ref", target: input.node, message: `"$${path}" does not resolve in the design system` });
        }
        node.refs.tokens[prop] = path;
        // A pre-existing inline literal for this same property must go —
        // the serializer emits token refs before inlineStyles, so leaving
        // it in place means the literal wins on "last declaration wins"
        // and the adopted ref silently never renders.
        delete node.inlineStyles[prop];
      }
      appliedTokens[prop] = path;
    }
    applied.token_refs = appliedTokens;
  }

  await store.writeScreen(screen, serializeScreen(doc));
  const commitResult = await store.commit(`update_refs: ${input.node}`);

  return { node: input.node, ...commitFields(commitResult), applied_refs: applied, warnings };
}

// ---------------------------------------------------------------------------
// W4 set_tokens
// ---------------------------------------------------------------------------

export type SetTokensInput = {
  tokens: Record<string, TokenValue | null>;
  mode: "replace" | "patch";
  response_mode?: ResponseMode;
};

function flattenTokenPaths(doc: TokensDocument): Set<string> {
  const paths = new Set<string>();
  for (const [bucket, members] of Object.entries(doc)) {
    for (const member of Object.keys(members)) paths.add(`${bucket}.${member}`);
  }
  return paths;
}

const MALFORMED_TOKEN_PATH_HINT =
  'expected a dotted "<bucket>.<member>" key (e.g. "color.primary") or a nested { "<bucket>": { "<member>": value } } object';

/**
 * Accepts both dotted keys ("color.primary") and nested objects
 * ({ color: { primary: ... } }), matching the on-disk TokensDocument shape,
 * and flattens either (or a mix of both in the same call) to bucket.member
 * paths. A nested `null` deletes that member, same as a dotted null.
 */
function flattenTokenInput(tokens: Record<string, TokenValue | null>): [path: string, value: TokenValue | null][] {
  const result: [string, TokenValue | null][] = [];
  function walk(path: string, value: TokenValue | null): void {
    if (value !== null && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) walk(`${path}.${childKey}`, childValue);
    } else {
      result.push([path, value]);
    }
  }
  for (const [key, value] of Object.entries(tokens)) walk(key, value);
  return result;
}

export async function setTokens(store: Store, input: SetTokensInput): Promise<Record<string, unknown>> {
  const tokens = await store.readTokens();
  const pathsBefore = flattenTokenPaths(tokens);
  const appliedPaths: string[] = [];

  if (input.mode === "replace") {
    // "replace" replaces the *bucket*, not the whole tokens.json: any bucket
    // touched by this call keeps only the paths given here, dropping
    // pre-existing members not mentioned — replacing the entire file from a
    // partial path->value map would be destructive in a way nothing in the
    // schema asks for.
    const touchedBuckets = new Set(Object.keys(input.tokens).map((path) => path.split(".")[0]!));
    for (const bucket of touchedBuckets) tokens[bucket] = {};
  }

  for (const [path, value] of flattenTokenInput(input.tokens)) {
    const dot = path.indexOf(".");
    if (dot === -1) throw new ToolError("validation_failed", `malformed token path "${path}" — ${MALFORMED_TOKEN_PATH_HINT}`);
    const bucket = path.slice(0, dot);
    const member = path.slice(dot + 1);
    tokens[bucket] ??= {};
    if (value === null) delete tokens[bucket]![member];
    else tokens[bucket]![member] = value;
    appliedPaths.push(path);
  }

  // Paths present before this call but gone afterward — covers both an
  // explicit null-delete and a "replace" mode bucket wipe dropping a
  // member nobody re-specified. Any node still holding one of these as a
  // ref is now dangling.
  const pathsAfter = flattenTokenPaths(tokens);
  const deletedPaths = [...pathsBefore].filter((p) => !pathsAfter.has(p));

  // Pre-write scan for the dangling-ref check: a class="$..." ref to a path
  // that's about to be deleted only resolves (and lands in refs.tokens at
  // all — resolveClassRef in model/parser.ts) against the registry that
  // still contains it. Scanning after the delete would make the reference
  // parse as unresolved and vanish from refs.tokens, hiding the very thing
  // this check exists to catch.
  // load_failed warnings are dropped from this pass — a blocking parse
  // issue or duplicate variant name doesn't depend on tokens.json, so the
  // post-write scan below reports the same ones; keeping only one set
  // avoids reporting the same broken source twice.
  // Only run at all when something is actually being deleted — this pass
  // exists purely for dangling-ref detection, and re-parsing the whole
  // project on every patch call (the dominant, non-deleting case) for a
  // check with nothing to check is exactly the O(project)-per-call waste
  // this ticket exists to remove.
  const sourcesBefore = deletedPaths.length > 0 ? (await loadAllDocuments(store, await loadRegistry(store))).docs : [];

  await store.writeTokens(tokens);
  const commitResult = await store.commit(`set_tokens: ${appliedPaths.join(", ")}`);

  // Post-write scan for propagation: the mirror image — a class="$..." ref
  // to a path *newly* applied by this call only resolves against the
  // registry that now includes it.
  const registryAfter = await loadRegistry(store);
  const { docs: sourcesAfter, warnings: loadWarningsAfter } = await loadAllDocuments(store, registryAfter);

  const affectedScreens = new Set<string>();
  const affectedComponents = new Set<string>();
  const affectedPatterns = new Set<string>();
  let propagatedNodeCount = 0;
  for (const source of sourcesAfter) {
    for (const node of Object.values(source.doc.nodes)) {
      const refPaths = new Set<string>();
      for (const ref of Object.values(node.refs.tokens)) {
        for (const path of tokenRefPaths(ref)) refPaths.add(path);
      }
      if (appliedPaths.some((p) => refPaths.has(p))) {
        propagatedNodeCount += 1;
        if (source.kind === "screen") affectedScreens.add(source.name);
        else if (source.kind === "component") affectedComponents.add(source.name);
        else affectedPatterns.add(source.name);
      }
    }
  }

  // Dangling-ref reporting is grouped by source kind, not just "screens",
  // since a deleted token can now be discovered dangling in a component or
  // pattern definition too.
  const danglingSourcesByPath = new Map<string, Set<string>>();
  for (const source of sourcesBefore) {
    for (const node of Object.values(source.doc.nodes)) {
      const refPaths = new Set<string>();
      for (const ref of Object.values(node.refs.tokens)) {
        for (const path of tokenRefPaths(ref)) refPaths.add(path);
      }
      for (const deletedPath of deletedPaths) {
        if (!refPaths.has(deletedPath)) continue;
        const sourceLabels = danglingSourcesByPath.get(deletedPath) ?? new Set<string>();
        sourceLabels.add(source.address);
        danglingSourcesByPath.set(deletedPath, sourceLabels);
      }
    }
  }

  const danglingWarnings: Warning[] = [...danglingSourcesByPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, addresses]) => ({
      kind: "unknown_ref",
      message: `"$${path}" was deleted but is still referenced in: ${[...addresses].sort().join(", ")}`,
    }));
  const warnings: Warning[] = [...loadWarningsAfter, ...danglingWarnings];

  return {
    ...commitFields(commitResult),
    path: "design-system/tokens.json",
    applied_tokens: appliedPaths,
    propagated_node_count: propagatedNodeCount,
    affected_screens: [...affectedScreens],
    affected_components: [...affectedComponents],
    affected_patterns: [...affectedPatterns],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// W5 set_flow
// ---------------------------------------------------------------------------

export type SetFlowInput = {
  node: string;
  flow: PublicFlow | null;
};

export async function setFlow(store: Store, input: SetFlowInput): Promise<Record<string, unknown>> {
  const { screen, nodeId } = requireScreenNodeRef(parseNodeRef(input.node), "set_flow");
  const { doc } = await loadScreen(store, screen);
  if (!doc.nodes[nodeId]) throw new ToolError("not_found", `node "${input.node}" was not found`);

  // The edge is written into the trigger node's data-flow-target/-trigger
  // attributes, not flows.json alone — flows.json is a derived mirror kept
  // in sync by syncScreenFlows (same as write_html/patch_html), and HTML is
  // the single source of truth re-parsed on every read. A flows.json-only
  // write would otherwise get silently wiped by the next write_html/
  // patch_html to this screen, which resyncs flows.json from the HTML.
  doc.flows = doc.flows.filter((f) => f.triggerNodeId !== nodeId);
  if (input.flow) {
    doc.flows.push({
      triggerNodeId: nodeId,
      triggerEvent: input.flow.event,
      targetKind: input.flow.to_kind,
      targetId: input.flow.to,
    });
  }

  await store.writeScreen(screen, serializeScreen(doc));
  await syncScreenFlows(store, doc);
  const commitResult = await store.commit(`set_flow: ${input.node}`);

  return { node: input.node, ...commitFields(commitResult), path: "flows.json", applied_flow: input.flow, warnings: [] };
}
