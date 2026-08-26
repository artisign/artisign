import type { Store } from "../store/index.js";
import {
  loadRegistry,
  parseScreen,
  parseComponentDefinition,
  serializeScreen,
  serializeNodeSubtree,
  tokenRefPaths,
  explicitNodeIds,
  type Node as InternalNode,
  type ScreenDocument,
  type TokenRef,
} from "../model/index.js";
import { loadScreen } from "./context.js";
import { readMockupMetaOrDefault } from "./mockups.js";
import { loadAllDocuments, loadDefinitionSource, type SourceDoc } from "./definitions.js";
import { renderScreenDocument } from "./render-context.js";
import { parseNodeRef, formatNodeRef } from "./node-ref.js";
import { readAllFlows, readScreenFlows, toPublicFlowRecord } from "./flows.js";
import { readCommentRecords, readCommentRecordsWithStats, groupThreads, threadStatus, toPublicComment, type CommentRecord } from "./comments.js";
import { selectFields } from "./fields.js";
import { ToolError, type View, type Predicate, type PublicComment } from "./types.js";

// mtime/since are approximated for now. Neither is
// covered by the acceptance criteria, and a real implementation needs a
// Store-level stat/diff primitive that isn't justified by anything using it
// yet.
function now(): string {
  return new Date().toISOString();
}

function refCount(node: InternalNode): number {
  return Object.keys(node.refs.tokens).length + (node.refs.component ? 1 : 0);
}

/** Depth-first document-order traversal from the screen root, following `childIds` (already parse-order). */
function nodesInDocumentOrder(doc: ScreenDocument): InternalNode[] {
  const result: InternalNode[] = [];
  const visit = (id: string): void => {
    const node = doc.nodes[id];
    if (!node) return;
    result.push(node);
    for (const childId of node.childIds) visit(childId);
  };
  visit(doc.rootNodeId);
  return result;
}

/** Same shape as get_node's summary `refs` — reused so get_screen's full view never drifts from it. */
function serializeNodeRefs(node: InternalNode): Record<string, unknown> {
  const refs: Record<string, unknown> = {};
  if (node.refs.component) refs.component_ref = node.refs.component;
  if (node.refs.variant) refs.variant = node.refs.variant;
  if (Object.keys(node.refs.tokens).length > 0) refs.token_refs = node.refs.tokens;
  return refs;
}

function tokenRefMatchesPath(ref: TokenRef, path: string): boolean {
  return tokenRefPaths(ref).includes(path);
}

function countTokenPaths(tokens: Record<string, Record<string, unknown>>): number {
  let count = 0;
  for (const members of Object.values(tokens)) count += Object.keys(members).length;
  return count;
}

function flattenTokenPaths(tokens: Record<string, Record<string, unknown>>): string[] {
  const paths: string[] = [];
  for (const [bucket, members] of Object.entries(tokens)) {
    for (const member of Object.keys(members)) paths.push(`${bucket}.${member}`);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// R1 get_project
// ---------------------------------------------------------------------------

export type GetProjectInput = {
  view?: View;
  fields?: string[];
  tags?: string[];
};

/** OR-match, case-insensitive exact compare against a screen's tags — matches the preview frontend's tag filter. */
function matchesAnyTag(tags: string[], requested: string[]): boolean {
  const requestedLower = new Set(requested.map((t) => t.toLowerCase()));
  return tags.some((t) => requestedLower.has(t.toLowerCase()));
}

const PROJECT_ALWAYS = [
  "name",
  "root",
  "screen_count",
  "token_count",
  "component_count",
  "mockup_count",
  "flow_count",
  "open_comment_count",
  "head",
  "head_reason",
  "last_write_at",
];
const PROJECT_OPTIONAL = ["screens", "design_system", "flows", "mockups"];

export async function getProject(store: Store, input: GetProjectInput): Promise<Record<string, unknown>> {
  const view = input.view ?? "summary";

  const [config, screenNames, tokens, componentNames, mockupNames, flowRecords, commentRecords, head] = await Promise.all([
    store.readArtisignConfig(),
    store.listScreens(),
    store.readTokens(),
    store.listComponents(),
    store.listMockups(),
    store.readFlows(),
    readCommentRecords(store),
    store.headCommit(),
  ]);

  const openThreads = groupThreads(commentRecords).filter((t) => threadStatus(t) === "open");
  const openCommentCount = openThreads.length;
  const openCommentCountByScreen = new Map<string, number>();
  for (const thread of openThreads) {
    openCommentCountByScreen.set(thread.root.screen, (openCommentCountByScreen.get(thread.root.screen) ?? 0) + 1);
  }

  const summary: Record<string, unknown> = {
    name: config.name,
    root: store.projectDir,
    screen_count: screenNames.length,
    token_count: countTokenPaths(tokens),
    component_count: componentNames.length,
    mockup_count: mockupNames.length,
    flow_count: flowRecords.length,
    open_comment_count: openCommentCount,
    head: head.sha,
    ...(head.head_reason !== undefined ? { head_reason: head.head_reason } : {}),
    last_write_at: now(),
  };

  // Tags queries hit even at summary tier — a minimal { screen, tags } list
  // rather than the richer tiered screens array, to stay within the ≤500
  // token cold-start budget when the caller didn't ask for view: "tree".
  if (view === "summary") {
    if (input.tags && input.tags.length > 0) {
      const requestedTags = input.tags;
      const metas = await Promise.all(screenNames.map((name) => store.readScreenMeta(name)));
      const matches = screenNames
        .map((name, i) => ({ screen: name, tags: metas[i]!.tags }))
        .filter((s) => matchesAnyTag(s.tags, requestedTags));
      summary.screen_count = matches.length;
      summary.screens = matches;

      const mockupMetas = await Promise.all(mockupNames.map((name) => readMockupMetaOrDefault(store, name)));
      const mockupMatches = mockupNames
        .map((name, i) => ({ mockup: name, tags: mockupMetas[i]!.tags ?? [] }))
        .filter((m) => matchesAnyTag(m.tags, requestedTags));
      summary.mockup_count = mockupMatches.length;
      summary.mockups = mockupMatches;
    }
    return selectFields(summary, PROJECT_ALWAYS, PROJECT_OPTIONAL, input.fields);
  }

  const registry = await loadRegistry(store);
  let screens = await Promise.all(
    screenNames.map(async (name) => {
      const html = await store.readScreen(name);
      const { doc } = parseScreen(html, name, registry);
      const meta = await store.readScreenMeta(name);
      return {
        screen: name,
        path: `screens/${name}.html`,
        node_count: Object.keys(doc.nodes).length,
        open_comment_count: openCommentCountByScreen.get(name) ?? 0,
        tags: meta.tags,
      };
    }),
  );
  let mockups = await Promise.all(
    mockupNames.map(async (name) => {
      const meta = await readMockupMetaOrDefault(store, name);
      return { mockup: name, variant_count: meta.variants.length, tags: meta.tags ?? [] };
    }),
  );
  if (input.tags && input.tags.length > 0) {
    const requestedTags = input.tags;
    screens = screens.filter((s) => matchesAnyTag(s.tags, requestedTags));
    mockups = mockups.filter((m) => matchesAnyTag(m.tags, requestedTags));
    summary.screen_count = screens.length;
    summary.mockup_count = mockups.length;
  }
  const tree: Record<string, unknown> = { ...summary, screens, mockups };
  if (view === "tree") return selectFields(tree, PROJECT_ALWAYS, PROJECT_OPTIONAL, input.fields);

  const components = await Promise.all(
    componentNames.map(async (name) => {
      const html = await store.readComponent(name);
      const def = parseComponentDefinition(name, html);
      return { name, variants: def.variants.map((v) => v.name) };
    }),
  );
  const full: Record<string, unknown> = {
    ...tree,
    design_system: {
      tokens: flattenTokenPaths(tokens),
      components,
      patterns: await store.listPatterns(),
    },
    flows: flowRecords.map(toPublicFlowRecord),
  };
  return selectFields(full, PROJECT_ALWAYS, PROJECT_OPTIONAL, input.fields);
}

// ---------------------------------------------------------------------------
// R2 get_screen
// ---------------------------------------------------------------------------

export type GetScreenInput = {
  screen: string;
  view?: View;
  fields?: string[];
  output_format?: "html" | "jsx";
};

const SCREEN_ALWAYS = ["screen", "path", "node_count", "ref_count", "flow_count", "open_comment_count", "last_commit", "mtime", "tags"];
const SCREEN_OPTIONAL = ["nodes", "html_aug", "refs", "flows", "comments", "notes", "rendered_html"];

export async function getScreen(store: Store, input: GetScreenInput): Promise<Record<string, unknown>> {
  if (input.output_format === "jsx") {
    throw new ToolError("validation_failed", "output_format \"jsx\" is not implemented (non-goal for v1 per PRD)");
  }

  const view = input.view ?? "summary";
  const { doc } = await loadScreen(store, input.screen);
  const nodes = nodesInDocumentOrder(doc);
  const [screenFlows, commentRecords, lastCommit, meta] = await Promise.all([
    readScreenFlows(store, input.screen),
    readCommentRecords(store),
    store.headCommit(),
    store.readScreenMeta(input.screen),
  ]);
  const openCommentCount = groupThreads(commentRecords).filter(
    (t) => t.root.screen === input.screen && threadStatus(t) === "open",
  ).length;

  const summary: Record<string, unknown> = {
    screen: input.screen,
    path: `screens/${input.screen}.html`,
    node_count: nodes.length,
    ref_count: nodes.reduce((sum, n) => sum + refCount(n), 0),
    flow_count: screenFlows.length,
    open_comment_count: openCommentCount,
    last_commit: lastCommit.sha,
    mtime: now(),
    tags: meta.tags,
  };
  if (view === "summary") return selectFields(summary, SCREEN_ALWAYS, SCREEN_OPTIONAL, input.fields);

  const tree: Record<string, unknown> = {
    ...summary,
    nodes: nodes.map((n) => ({ id: n.id, tag: n.tag, parent_id: n.parentId, ref_count: refCount(n) })),
  };
  if (view === "tree") return selectFields(tree, SCREEN_ALWAYS, SCREEN_OPTIONAL, input.fields);

  const full: Record<string, unknown> = {
    ...summary,
    nodes: nodes.map((n) => {
      const refs = serializeNodeRefs(n);
      return {
        id: n.id,
        tag: n.tag,
        parent_id: n.parentId,
        ref_count: refCount(n),
        ...(Object.keys(refs).length > 0 ? { refs } : {}),
      };
    }),
    html_aug: serializeScreen(doc),
    flows: screenFlows.map(toPublicFlowRecord),
    notes: meta.notes,
  };
  if (input.fields?.includes("comments")) {
    full.comments = commentsForScreen(commentRecords, input.screen, true);
  }
  if (input.fields?.includes("rendered_html")) {
    // Only rendered on explicit request — a resolved DOM is far heavier
    // than the augmented source, so it must never ride along in a default
    // summary/tree/full response (PRD §9 token budgets).
    const { documentHtml } = await renderScreenDocument(store, input.screen, { fontMode: "url" });
    full.rendered_html = documentHtml;
  }
  return selectFields(full, SCREEN_ALWAYS, SCREEN_OPTIONAL, input.fields);
}

function commentsForScreen(records: CommentRecord[], screen: string, includeReplies: boolean): PublicComment[] {
  const threads = groupThreads(records).filter((t) => t.root.screen === screen);
  const out: PublicComment[] = [];
  for (const thread of threads) {
    out.push(toPublicComment(thread.root, thread.replies.length));
    if (includeReplies) {
      for (const reply of thread.replies) out.push(toPublicComment(reply, 0));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// R3 get_node
// ---------------------------------------------------------------------------

export type GetNodeInput = {
  node: string;
  view?: View;
  fields?: string[];
};

const NODE_ALWAYS = ["node", "screen", "tag", "parent", "refs"];
const NODE_OPTIONAL = ["children", "html_aug", "flow", "comments"];

export async function getNode(store: Store, input: GetNodeInput): Promise<Record<string, unknown>> {
  const view = input.view ?? "summary";
  const ref = parseNodeRef(input.node);
  const nodeId = ref.nodeId;

  let doc: ScreenDocument;
  let address: string;
  if (ref.kind === "screen") {
    ({ doc } = await loadScreen(store, ref.screen));
    address = ref.screen;
  } else {
    const registry = await loadRegistry(store);
    ({ doc } = await loadDefinitionSource(store, registry, ref));
    address = ref.address;
  }

  const node = doc.nodes[nodeId];
  if (!node) throw new ToolError("not_found", `node "${input.node}" was not found`);

  const refs = serializeNodeRefs(node);

  const summary: Record<string, unknown> = {
    node: input.node,
    screen: address,
    tag: node.tag,
    parent: node.parentId ? formatNodeRef(address, node.parentId) : null,
    refs,
  };
  if (view === "summary") return selectFields(summary, NODE_ALWAYS, NODE_OPTIONAL, input.fields);

  const tree: Record<string, unknown> = {
    ...summary,
    children: node.childIds.map((childId) => formatNodeRef(address, childId)),
  };
  if (view === "tree") return selectFields(tree, NODE_ALWAYS, NODE_OPTIONAL, input.fields);

  const full: Record<string, unknown> = {
    ...tree,
    html_aug: serializeNodeSubtree(doc, nodeId),
  };
  // Flows and comments only ever anchor to a screen node (flows.json,
  // comments.jsonl) — a component/pattern definition node structurally
  // cannot have either, so both stay omitted for a definition ref, same as
  // they'd be omitted for a screen node with none.
  if (ref.kind === "screen") {
    const flowRecords = await readScreenFlows(store, ref.screen);
    const flow = flowRecords.find((f) => f.from === input.node);
    if (flow) full.flow = toPublicFlowRecord(flow);
    if (input.fields?.includes("comments")) {
      const commentRecords = await readCommentRecords(store);
      const threads = groupThreads(commentRecords).filter((t) => t.root.node_id === input.node);
      full.comments = threads.flatMap((t) => [
        toPublicComment(t.root, t.replies.length),
        ...t.replies.map((r) => toPublicComment(r, 0)),
      ]);
    }
  }
  return selectFields(full, NODE_ALWAYS, NODE_OPTIONAL, input.fields);
}

// ---------------------------------------------------------------------------
// R4 get_design_system
// ---------------------------------------------------------------------------

export type GetDesignSystemInput = {
  view?: View;
  fields?: string[];
};

const DS_ALWAYS = ["token_count", "component_count", "pattern_count", "paths", "last_commit", "decision_count"];
const DS_OPTIONAL = ["tokens", "components", "patterns", "token_values", "component_definitions", "pattern_definitions", "idea", "decisions"];

export async function getDesignSystem(store: Store, input: GetDesignSystemInput): Promise<Record<string, unknown>> {
  const view = input.view ?? "summary";
  const [tokens, componentNames, patternNames, lastCommit, meta] = await Promise.all([
    store.readTokens(),
    store.listComponents(),
    store.listPatterns(),
    store.headCommit(),
    store.readDesignSystemMeta(),
  ]);

  const summary: Record<string, unknown> = {
    token_count: countTokenPaths(tokens),
    component_count: componentNames.length,
    pattern_count: patternNames.length,
    paths: {
      tokens: "design-system/tokens.json",
      components: "design-system/components/",
      patterns: "design-system/patterns/",
    },
    last_commit: lastCommit.sha,
    decision_count: meta.decisions.length,
  };
  if (view === "summary") return selectFields(summary, DS_ALWAYS, DS_OPTIONAL, input.fields);

  const componentDefs = await Promise.all(
    componentNames.map(async (name) => {
      const html = await store.readComponent(name);
      return { name, def: parseComponentDefinition(name, html) };
    }),
  );

  const tree: Record<string, unknown> = {
    ...summary,
    idea: meta.idea,
    // No body at tree tier — decisions can be large; the full text is only
    // worth the tokens once the caller has drilled in.
    decisions: meta.decisions.map(({ id, date, title, status }) => ({ id, date, title, status })),
    tokens: Object.entries(tokens).flatMap(([bucket, members]) =>
      Object.keys(members).map((member) => ({ path: `${bucket}.${member}`, kind: bucket })),
    ),
    components: componentDefs.map(({ name, def }) => ({
      name,
      file: `design-system/components/${name}.html`,
      variants: def.variants.map((v) => v.name),
      ...(meta.component_usage[name] !== undefined ? { usage: meta.component_usage[name] } : {}),
    })),
    // No on-disk marker distinguishes layout vs. interaction patterns yet —
    // "layout" is the safe default until M5 defines pattern kinds properly.
    patterns: patternNames.map((name) => ({
      name,
      file: `design-system/patterns/${name}.html`,
      kind: "layout",
      ...(meta.pattern_usage[name] !== undefined ? { usage: meta.pattern_usage[name] } : {}),
    })),
  };
  if (view === "tree") return selectFields(tree, DS_ALWAYS, DS_OPTIONAL, input.fields);

  const full: Record<string, unknown> = {
    ...tree,
    decisions: meta.decisions,
    token_values: Object.entries(tokens).flatMap(([bucket, members]) =>
      Object.entries(members).map(([member, value]) => ({ path: `${bucket}.${member}`, value })),
    ),
    component_definitions: componentDefs.map(({ name, def }) => ({
      name,
      file: `design-system/components/${name}.html`,
      variants: def.variants.map((v) => ({ name: v.name, html_aug: v.htmlAug })),
      html_aug: def.variants.find((v) => v.name === def.defaultVariant)?.htmlAug ?? "",
      ...(meta.component_usage[name] !== undefined ? { usage: meta.component_usage[name] } : {}),
    })),
    pattern_definitions: await Promise.all(
      patternNames.map(async (name) => ({
        name,
        file: `design-system/patterns/${name}.html`,
        html_aug: await store.readPattern(name),
        ...(meta.pattern_usage[name] !== undefined ? { usage: meta.pattern_usage[name] } : {}),
      })),
    ),
  };
  return selectFields(full, DS_ALWAYS, DS_OPTIONAL, input.fields);
}

// ---------------------------------------------------------------------------
// R5 find_nodes
// ---------------------------------------------------------------------------

export type FindNodesInput = {
  where: Predicate[];
  screens?: string[];
  view?: "summary" | "full";
  cursor?: string;
  limit?: number;
};

/** True if any descendant TEXT node of `node` (not `node` itself) contains `pattern`. */
function hasDescendantTextMatch(doc: ScreenDocument, node: InternalNode, pattern: string): boolean {
  for (const childId of node.childIds) {
    const child = doc.nodes[childId];
    if (!child) continue;
    if (child.kind === "text" && (child.text ?? "").includes(pattern)) return true;
    if (hasDescendantTextMatch(doc, child, pattern)) return true;
  }
  return false;
}

function matchesPredicate(
  predicate: Predicate,
  node: InternalNode,
  screen: string,
  doc: ScreenDocument,
  commentsByNode: Map<string, boolean>,
  flowFroms: Set<string>,
): boolean {
  switch (predicate.kind) {
    case "style_ref": {
      const path = predicate.ref_path.startsWith("$") ? predicate.ref_path.slice(1) : predicate.ref_path;
      return Object.entries(node.refs.tokens).some(([key, ref]) => key !== "class" && tokenRefMatchesPath(ref, path));
    }
    case "component_ref":
      return node.refs.component === predicate.component_name;
    case "variant":
      return node.refs.variant === predicate.variant;
    case "has_comments":
      return commentsByNode.get(formatNodeRef(screen, node.id)) === true;
    case "text_match":
      // Matches the containing element, not the text node itself — a
      // find_nodes result should be an addressable, patchable node, and
      // text nodes AND'd with any other predicate (which never matches a
      // text node) would always return empty.
      return node.kind !== "text" && hasDescendantTextMatch(doc, node, predicate.pattern);
    case "has_flow":
      return flowFroms.has(formatNodeRef(screen, node.id));
    default:
      return false;
  }
}

export async function findNodes(store: Store, input: FindNodesInput): Promise<Record<string, unknown>> {
  const view = input.view ?? "summary";
  const limit = input.limit ?? 100;
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;

  const registry = await loadRegistry(store);
  const [commentRecords, flowRecords] = await Promise.all([readCommentRecords(store), readAllFlows(store)]);
  const commentedNodes = new Map<string, boolean>();
  for (const record of commentRecords) {
    if (record.node_id) commentedNodes.set(record.node_id, true);
  }
  const flowFroms = new Set(flowRecords.map((f) => f.from));

  // `screens` narrows which screens are searched — components and patterns
  // are project-wide design-system sources, not screen-scoped, so they're
  // always included regardless of this filter. Passed straight through to
  // loadAllDocuments so a scoped query only reads the named screens, not
  // the whole project, and an unknown screen name throws instead of
  // silently contributing zero matches.
  //
  // Exception: has_comments/has_flow are keyed by screen-based node refs
  // (comments.jsonl, flows.json) — a component/pattern node can never match
  // either, so a query made up entirely of those predicates skips loading
  // definitions at all.
  const onlyScreenScopedPredicates =
    input.where.length > 0 && input.where.every((p) => p.kind === "has_comments" || p.kind === "has_flow");
  const { docs: sources, warnings: loadWarnings } = await loadAllDocuments(store, registry, {
    screens: input.screens,
    definitions: !onlyScreenScopedPredicates,
  });

  // Lazy, address-keyed cache of a definition source's explicit-id set — read
  // and computed at most once per matched source (component variant or
  // pattern), not once per project source, since most sources in a project
  // never produce a match at all.
  const explicitIdsCache = new Map<string, Promise<Set<string>>>();
  function explicitIdsForSource(source: SourceDoc): Promise<Set<string>> {
    let cached = explicitIdsCache.get(source.address);
    if (!cached) {
      const html = source.kind === "component" ? store.readComponent(source.name) : store.readPattern(source.name);
      cached = html.then((h) => explicitNodeIds(h, source.variant));
      explicitIdsCache.set(source.address, cached);
    }
    return cached;
  }

  const matches: Record<string, unknown>[] = [];
  for (const source of sources) {
    for (const node of Object.values(source.doc.nodes)) {
      if (input.where.every((p) => matchesPredicate(p, node, source.address, source.doc, commentedNodes, flowFroms))) {
        matches.push({
          node: formatNodeRef(source.address, node.id),
          screen: source.kind === "screen" ? source.name : null,
          source: source.kind,
          ...(source.kind === "component" ? { component: source.name, variant: source.variant } : {}),
          ...(source.kind === "pattern" ? { pattern: source.name } : {}),
          // A component/pattern match's node ref IS addressable by
          // get_node/update_refs/patch_html (ADR-004 §1/§2) — but a
          // definition is never canonicalized, so its id is only durably
          // stable across a later write when the node carries an explicit
          // `id` in source. "derived" means allocator-generated: reliable
          // for this one call, no guarantee beyond it (NodeIdAllocator's
          // doc comment, model/node-id.ts) — including after a write that
          // itself touches this source. reply_comment stays screen-only
          // regardless (comments anchor to what the browser renders).
          ...(source.kind !== "screen"
            ? { id_stability: (await explicitIdsForSource(source)).has(node.id) ? "explicit" : "derived" }
            : {}),
          tag: node.tag,
          matched_predicates: input.where.map((p) => p.kind),
          ...(view === "full" ? { refs: node.refs, inline_styles: node.inlineStyles } : {}),
        });
      }
    }
  }

  const page = matches.slice(offset, offset + limit);
  const response: Record<string, unknown> = { nodes: page };
  if (offset + limit < matches.length) response.next_cursor = String(offset + limit);
  if (loadWarnings.length > 0) response.warnings = loadWarnings;
  return response;
}

// ---------------------------------------------------------------------------
// R6 list_comments
// ---------------------------------------------------------------------------

export type ListCommentsInput = {
  screen?: string;
  node?: string;
  status?: "open" | "resolved" | "any";
  include_replies?: boolean;
  cursor?: string;
  limit?: number;
};

export async function listComments(store: Store, input: ListCommentsInput): Promise<Record<string, unknown>> {
  const status = input.status ?? "open";
  const includeReplies = input.include_replies ?? false;
  const limit = input.limit ?? 50;
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;

  const { records, skippedMalformedLines } = await readCommentRecordsWithStats(store);
  let threads = groupThreads(records);
  if (input.node) {
    threads = threads.filter((t) => t.root.node_id === input.node);
  } else if (input.screen) {
    threads = threads.filter((t) => t.root.screen === input.screen);
  }
  if (status !== "any") {
    threads = threads.filter((t) => threadStatus(t) === status);
  }

  const flattened: PublicComment[] = [];
  for (const thread of threads) {
    flattened.push(toPublicComment(thread.root, thread.replies.length));
    if (includeReplies) {
      for (const reply of thread.replies) flattened.push(toPublicComment(reply, 0));
    }
  }

  const page = flattened.slice(offset, offset + limit);
  const response: Record<string, unknown> = { comments: page };
  if (offset + limit < flattened.length) response.next_cursor = String(offset + limit);
  if (skippedMalformedLines > 0) response.skipped_malformed_lines = skippedMalformedLines;
  return response;
}
