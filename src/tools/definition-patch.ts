import type { Store, TokensDocument } from "../store/index.js";
import {
  loadRegistry,
  patchDefinitionNode,
  explicitNodeIds,
  readDefinitionNodeAttrs,
  resolveTokenRef,
  parseTokenValue,
  type PatchDefinitionOperation,
} from "../model/index.js";
import { formatNodeRef } from "./node-ref.js";
import type { DefinitionNodeRef } from "./node-ref.js";
import {
  ToolError,
  commitFields,
  RESERVED_SET_ATTR_NAMES,
  reservedSetAttrMessage,
  type ResponseMode,
  type Warning,
} from "./types.js";
import type { PatchHtmlInput, UpdateRefsInput } from "./writes.js";

/**
 * `patch_html`'s `response_mode: "diff"/"full"` needs a before/after
 * `ScreenDocument` to diff — a definition file is never canonicalized, so
 * there's no such pair without an extra `loadAllDocuments` scan (the same
 * O(project) cost `set_tokens` already accepts elsewhere) on every
 * definition write, not just ones that ask for a diff. Rather than fabricate
 * a placeholder diff body that's shape-identical to "nothing changed" for a
 * write that did change something, the mode is
 * rejected outright: `response_mode: "summary"` (the default) is the only
 * one a definition target accepts today.
 */
function requireSummaryResponseMode(responseMode: ResponseMode, toolName: string): void {
  if (responseMode !== "summary") {
    throw new ToolError(
      "validation_failed",
      `${toolName} against a component:/pattern: node ref only supports response_mode: "summary" — "diff"/"full" need a canonical document a definition doesn't have`,
    );
  }
}

async function readDefinitionHtml(store: Store, ref: DefinitionNodeRef): Promise<string> {
  try {
    return ref.kind === "component" ? await store.readComponent(ref.name) : await store.readPattern(ref.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError("not_found", `${ref.kind} "${ref.name}" was not found`);
    }
    throw err;
  }
}

function writeDefinitionHtml(store: Store, ref: DefinitionNodeRef, html: string): Promise<void> {
  return ref.kind === "component" ? store.writeComponent(ref.name, html) : store.writePattern(ref.name, html);
}

/** `ref.variant` for a component, `undefined` for a pattern — `patchDefinitionNode`'s scoping convention. */
function scopeVariant(ref: DefinitionNodeRef): string | undefined {
  return ref.kind === "component" ? ref.variant : undefined;
}

/**
 * ADR-004 §3: a definition write touching a node with no explicit `id` in
 * source — checked against the file as it was *before* this write, since
 * that's the id the caller actually addressed. Non-blocking; the caller
 * folds this into its own `warnings` array.
 */
function missingIdWarning(html: string, variant: string | undefined, nodeRef: string, nodeId: string): Warning | null {
  if (explicitNodeIds(html, variant).has(nodeId)) return null;
  return {
    kind: "missing_id",
    target: nodeRef,
    message: `node "${nodeRef}" has no explicit id in source — this address is only reliably stable for this one call`,
    suggestion: `add id="${nodeId}" to this element to keep it addressable across future writes`,
  };
}

// ---------------------------------------------------------------------------
// patch_html
// ---------------------------------------------------------------------------

function buildOperation(input: PatchHtmlInput): PatchDefinitionOperation {
  switch (input.operation) {
    case "delete":
      return { op: "delete" };
    case "set_attr":
      if (!input.attr) throw new ToolError("validation_failed", 'attr is required for operation "set_attr"');
      if (RESERVED_SET_ATTR_NAMES.has(input.attr.name)) {
        throw new ToolError("validation_failed", reservedSetAttrMessage(input.attr.name));
      }
      return { op: "set_attr", name: input.attr.name, value: input.attr.value };
    case "replace":
      if (!input.html_aug) throw new ToolError("validation_failed", 'html_aug is required for operation "replace"');
      return { op: "replace", html: input.html_aug };
    case "insert_before":
    case "insert_after":
      if (!input.html_aug) throw new ToolError("validation_failed", `html_aug is required for operation "${input.operation}"`);
      return { op: input.operation, html: input.html_aug };
  }
}

/**
 * `patch_html` against a `component:`/`pattern:` node ref (ADR-004 §2):
 * dispatches to `patchDefinitionNode` instead of `loadScreen` -> mutate ->
 * `serializeScreen` — a definition file is never canonicalized, so this
 * never round-trips through `parseScreen`/`serializeScreen` either.
 * `target.kind === "selector"` isn't supported for a definition — CSS
 * selector matching needs a canonical `ScreenDocument`, which a definition
 * deliberately never has one of.
 */
export async function patchDefinitionHtml(store: Store, ref: DefinitionNodeRef, input: PatchHtmlInput): Promise<Record<string, unknown>> {
  requireSummaryResponseMode(input.response_mode ?? "summary", "patch_html");
  const kind = ref.kind;
  const path = `design-system/${kind}s/${ref.name}.html`;
  const variant = scopeVariant(ref);
  const nodeRef = formatNodeRef(ref.address, ref.nodeId);

  const registry = await loadRegistry(store);
  const html = await readDefinitionHtml(store, ref);
  const operation = buildOperation(input);

  const result = patchDefinitionNode(html, registry, ref.nodeId, operation, variant);
  if (!result.found) throw new ToolError("not_found", `node "${nodeRef}" was not found`);

  const warnings: Warning[] = [];
  const missingId = missingIdWarning(html, variant, nodeRef, ref.nodeId);
  if (missingId) warnings.push(missingId);

  await writeDefinitionHtml(store, ref, result.html);
  const commitResult = await store.commit(`patch_html: ${ref.address}`);

  // No preexisting_drift_count: a real value would need the same
  // O(project) scan the diff-mode rejection above avoids paying on every
  // write; a constant 0 would be indistinguishable from "verified no
  // drift". update_refs never carried this
  // field for screens either — precedent for omitting rather than
  // fabricating.
  return {
    screen: ref.address,
    path,
    ...commitFields(commitResult),
    affected_nodes: [nodeRef],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// update_refs
// ---------------------------------------------------------------------------

function classParts(classAttr: string | undefined): string[] {
  return classAttr ? classAttr.split(/\s+/).filter(Boolean) : [];
}

/**
 * The `set_attr` operations needed to apply a `component_ref` change,
 * expressed as byte-level attribute edits instead of the canonical model's
 * `convertToComponentInstance`/`revertComponentInstanceToElement`
 * (`node-convert.ts`) — a definition is never canonicalized, so those can't
 * run here. Mirrors their behavior instead: rebinding an instance that
 * already uses `data-component` keeps that syntax; otherwise `class="$name"`
 * is the default (matching `convertToComponentInstance`'s own default when
 * converting a plain element), and clearing a ref strips whichever syntax is
 * actually present.
 */
function componentRefOps(currentAttrs: Record<string, string>, newRef: string | null): PatchDefinitionOperation[] {
  const parts = classParts(currentAttrs.class);
  const classToken = parts.find((p) => p.startsWith("$"));
  const plainClasses = parts.filter((p) => !p.startsWith("$"));
  const hasDataComponent = currentAttrs["data-component"] !== undefined;

  if (newRef === null) {
    const ops: PatchDefinitionOperation[] = [];
    if (hasDataComponent) ops.push({ op: "set_attr", name: "data-component", value: null });
    if (classToken) ops.push({ op: "set_attr", name: "class", value: plainClasses.length > 0 ? plainClasses.join(" ") : null });
    return ops;
  }

  if (hasDataComponent) return [{ op: "set_attr", name: "data-component", value: newRef }];
  return [{ op: "set_attr", name: "class", value: [...plainClasses, `$${newRef}`].join(" ") }];
}

type StyleDecl = { prop: string; rawValue: string };

/** Same split-on-`;`/`:` shape as the canonical parser's `parseStyleAttribute` (`model/parser.ts`), operating on the raw decoded attribute value directly. */
function parseStyleDecls(styleAttr: string | undefined): StyleDecl[] {
  if (!styleAttr) return [];
  const decls: StyleDecl[] = [];
  for (const part of styleAttr.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) continue;
    decls.push({ prop: trimmed.slice(0, sep).trim(), rawValue: trimmed.slice(sep + 1).trim() });
  }
  return decls;
}

function formatStyleDecls(decls: StyleDecl[]): string | null {
  return decls.length > 0 ? decls.map((d) => `${d.prop}: ${d.rawValue}`).join("; ") : null;
}

/**
 * Applies `token_refs` changes to a parsed declaration list — setting a prop
 * always replaces its whole declaration wholesale with a bare `$path`,
 * matching `update_refs`'s screen-side "replaces a mixed literal/ref value
 * wholesale" behavior. Removing one (`path === null`) resolves the
 * *existing* declaration's value with the exact same two-step reuse the
 * screen path (`writes.ts`'s `updateRefs`) uses — `parseTokenValue` to read
 * whatever's there (a bare `$path`, a modifier call, a mixed literal+ref
 * value — the full grammar, not a narrower reimplementation) into a
 * `TokenRef`, then `resolveTokenRef` to resolve it — rather than a second,
 * bare-`$path`-only parse that silently left every other shape untouched
 * while still reporting success. A declaration
 * that isn't a ref at all (`kind !== "ref"`) has nothing to remove — the
 * same no-op the screen path has when `node.refs.tokens[prop]` is
 * `undefined`, not a gap.
 */
function applyTokenRefChanges(decls: StyleDecl[], tokenRefs: Record<string, string | null>, tokens: TokensDocument): StyleDecl[] {
  const result = [...decls];
  for (const [prop, path] of Object.entries(tokenRefs)) {
    const idx = result.findIndex((d) => d.prop === prop);
    if (path === null) {
      if (idx === -1) continue;
      const parsed = parseTokenValue(result[idx]!.rawValue);
      if (parsed.kind === "ref") result[idx] = { prop, rawValue: resolveTokenRef(parsed.ref, tokens) };
    } else {
      const rawValue = `$${path}`;
      if (idx === -1) result.push({ prop, rawValue });
      else result[idx] = { prop, rawValue };
    }
  }
  return result;
}

/**
 * `update_refs` against a `component:`/`pattern:` node ref (ADR-004 §2):
 * translates the same `refs` shape screens accept into a small sequence of
 * `patchDefinitionNode` `set_attr` calls instead of mutating a canonical
 * `ScreenDocument`'s `refs`/`inlineStyles` and re-serializing — reusing
 * `patch-definition.ts`'s byte-range splice primitive rather than reaching
 * around it. `component_ref`,
 * `variant` and `token_refs` are independent attribute edits (`class`/
 * `data-component`, `data-variant`, `style`), applied in that order onto the
 * running `html` string so each edit's byte-range splice sees the previous
 * one's result.
 */
export async function updateRefsDefinition(store: Store, ref: DefinitionNodeRef, input: UpdateRefsInput): Promise<Record<string, unknown>> {
  const variant = scopeVariant(ref);
  const nodeRef = formatNodeRef(ref.address, ref.nodeId);

  const registry = await loadRegistry(store);
  const originalHtml = await readDefinitionHtml(store, ref);
  let html = originalHtml;

  const currentAttrs = readDefinitionNodeAttrs(html, registry, ref.nodeId, variant);
  if (!currentAttrs) throw new ToolError("not_found", `node "${nodeRef}" was not found`);

  const warnings: Warning[] = [];
  const applied: Record<string, unknown> = {};

  const apply = (op: PatchDefinitionOperation): void => {
    const result = patchDefinitionNode(html, registry, ref.nodeId, op, variant);
    if (!result.found) throw new ToolError("not_found", `node "${nodeRef}" was not found`);
    html = result.html;
  };

  if (input.refs.component_ref !== undefined) {
    if (input.refs.component_ref !== null && !registry.componentNames.has(input.refs.component_ref)) {
      warnings.push({ kind: "unknown_ref", target: nodeRef, message: `component "${input.refs.component_ref}" is not in the design system` });
    }
    for (const op of componentRefOps(currentAttrs, input.refs.component_ref)) apply(op);
    applied.component_ref = input.refs.component_ref;
  }

  if (input.refs.variant !== undefined) {
    apply({ op: "set_attr", name: "data-variant", value: input.refs.variant });
    applied.variant = input.refs.variant;
  }

  if (input.refs.token_refs) {
    for (const path of Object.values(input.refs.token_refs)) {
      if (path !== null && !registry.tokenPaths.has(path)) {
        warnings.push({ kind: "unknown_ref", target: nodeRef, message: `"$${path}" does not resolve in the design system` });
      }
    }
    const hasRemoval = Object.values(input.refs.token_refs).some((path) => path === null);
    const tokens: TokensDocument = hasRemoval ? await store.readTokens() : {};
    const decls = applyTokenRefChanges(parseStyleDecls(currentAttrs.style), input.refs.token_refs, tokens);
    apply({ op: "set_attr", name: "style", value: formatStyleDecls(decls) });
    applied.token_refs = input.refs.token_refs;
  }

  const missingId = missingIdWarning(originalHtml, variant, nodeRef, ref.nodeId);
  if (missingId) warnings.push(missingId);

  await writeDefinitionHtml(store, ref, html);
  const commitResult = await store.commit(`update_refs: ${nodeRef}`);

  return { node: nodeRef, ...commitFields(commitResult), applied_refs: applied, warnings };
}
