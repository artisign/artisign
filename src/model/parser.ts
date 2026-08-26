import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { findSuspiciousAttr } from "./augmentation-attrs.js";
import { NodeIdAllocator } from "./node-id.js";
import { tokenRefPaths } from "./token-ref.js";
import type { DesignSystemRegistry } from "./registry.js";
import type {
  Flow,
  FlowTriggerEvent,
  ModifierFn,
  Node,
  NodeId,
  NodeKind,
  NodeRefs,
  NodeSubtree,
  ParseResult,
  ScreenDocument,
  TokenRef,
  TokenRefAtom,
  ValidationErrorCode,
  ValidationIssue,
} from "./types.js";

type P5Element = DefaultTreeAdapterTypes.Element;
type P5ChildNode = DefaultTreeAdapterTypes.ChildNode;
type P5Template = DefaultTreeAdapterTypes.Template;

const KNOWN_MODIFIERS: readonly ModifierFn[] = ["alpha", "oklab", "mix"];
const PATH_RE = /^\$([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)$/;
const CALL_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/;
// Used to tokenize a value that mixes refs with literal text: a
// known modifier call, or a bare $path — anywhere in the string, not
// anchored to the whole value like PATH_RE/CALL_RE above.
const MIXED_TOKEN_RE = /(alpha|oklab|mix)\([^)]*\)|\$[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*/g;
const ALLOWED_FLOW_TRIGGERS: readonly FlowTriggerEvent[] = ["tap", "hover", "longpress", "swipe-left", "swipe-right"];

const RESERVED_ATTRS = new Set([
  "id",
  "data-node-id",
  "class",
  "style",
  "data-variant",
  "data-flow-target",
  "data-flow-trigger",
  "data-section",
  "data-component-id",
  "data-component",
]);

function isElementLike(node: P5ChildNode): node is P5Element {
  return node.nodeName !== "#text" && node.nodeName !== "#comment" && node.nodeName !== "#documentType";
}

function isTemplateElement(el: P5Element): el is P5Template {
  return el.tagName === "template" && "content" in el;
}

/**
 * A `<template>` element's real children live in its `.content` document
 * fragment, not `.childNodes` (which parse5 always leaves empty for it) —
 * the same content-model a real `<template>` has in a browser, where table-
 * row/cell and list-item elements are preserved without needing a
 * `<table>`/`<ul>` ancestor. `definitions.ts` relies on this to wrap a
 * definition file for parsing without losing `<tr>`/`<td>`/`<th>`/`<li>`
 * (or anything else) to HTML's ordinary tree-construction rules.
 */
function childNodesOf(el: P5Element): P5ChildNode[] {
  return isTemplateElement(el) ? el.content.childNodes : el.childNodes;
}

export type TokenValueParse =
  | { kind: "ref"; ref: TokenRef }
  | { kind: "literal"; value: string }
  | { kind: "error"; code: ValidationErrorCode };

/** Parses a modifier call's comma-separated args into $refs/numbers; `null` on the first arg that's neither. */
function parseModifierArgs(argsRaw: string): (string | number)[] | null {
  const args: (string | number)[] = [];
  for (const rawArg of argsRaw.split(",")) {
    const arg = rawArg.trim();
    const argPathMatch = PATH_RE.exec(arg);
    if (argPathMatch) {
      args.push(argPathMatch[1]!);
      continue;
    }
    const num = Number(arg);
    if (arg !== "" && !Number.isNaN(num)) {
      args.push(num);
      continue;
    }
    return null;
  }
  return args;
}

/**
 * Tokenizes a value that mixes one or more $refs (plain or a known modifier
 * call) with literal text, e.g. `1px solid $color.border` or
 * `$spacing.sm $spacing.lg`. Returns `null` on a malformed modifier call's
 * args (multi_ref_value) or when no ref was found at all (the caller falls
 * back to treating the whole value as a literal).
 *
 * The returned `parts` strictly alternates literal/atom/literal/..., always
 * starting and ending on a literal chunk (possibly `""`) — see MixedTokenValue.
 */
function tokenizeMixedValue(value: string): (string | TokenRefAtom)[] | "malformed" | "no_refs" {
  const parts: (string | TokenRefAtom)[] = [];
  let lastIndex = 0;
  let sawRef = false;
  MIXED_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MIXED_TOKEN_RE.exec(value)) !== null) {
    parts.push(value.slice(lastIndex, match.index));
    const whole = match[0];
    const fnName = match[1];
    if (fnName) {
      const argsRaw = whole.slice(fnName.length + 1, -1);
      const args = parseModifierArgs(argsRaw);
      if (args === null) return "malformed";
      parts.push({ fn: fnName as ModifierFn, args });
    } else {
      parts.push(whole.slice(1)); // strip the leading "$"
    }
    sawRef = true;
    lastIndex = MIXED_TOKEN_RE.lastIndex;
  }
  parts.push(value.slice(lastIndex));
  return sawRef ? parts : "no_refs";
}

/**
 * Parses a single CSS-value-shaped string per the full-value-substitution
 * grammar (Schema-Spec v0.1). Exported for `definition-patch.ts`'s
 * `update_refs` path: removing a `token_refs`
 * binding on a definition needs to recognize the *same* ref shapes
 * (a bare `$path`, a modifier call, a mixed literal+ref value) the screen
 * path's `resolveTokenRef` already resolves, via the same parse — not a
 * second, narrower reimplementation that only handles a bare `$path`.
 */
export function parseTokenValue(rawValue: string): TokenValueParse {
  const value = rawValue.trim();

  const pathMatch = PATH_RE.exec(value);
  if (pathMatch) {
    return { kind: "ref", ref: pathMatch[1]! };
  }

  // Only values that actually reference a token are candidates for the
  // modifier-call grammar — plain CSS functions (rgb(), calc(), var(),
  // url(), rotate(), …) are ordinary literal values and must pass through
  // untouched.
  if (!value.includes("$")) {
    return { kind: "literal", value };
  }

  const callMatch = CALL_RE.exec(value);
  if (callMatch) {
    const fnName = callMatch[1]!;
    const argsRaw = callMatch[2]!;
    if (!KNOWN_MODIFIERS.includes(fnName as ModifierFn)) {
      return { kind: "error", code: "unknown_modifier" };
    }
    const args = parseModifierArgs(argsRaw);
    if (args === null) return { kind: "error", code: "multi_ref_value" };
    return { kind: "ref", ref: { fn: fnName as ModifierFn, args } };
  }

  // A $ appears but not as the entire value or a recognized whole-value
  // modifier call — mix of literal text and one or more refs.
  const tokenized = tokenizeMixedValue(value);
  if (tokenized === "malformed") return { kind: "error", code: "multi_ref_value" };
  if (tokenized === "no_refs") return { kind: "literal", value };
  return { kind: "ref", ref: { parts: tokenized } };
}

function parseStyleAttribute(
  styleAttr: string,
  nodeId: NodeId,
  errors: ValidationIssue[],
): { tokens: Record<string, TokenRef>; inlineStyles: Record<string, string> } {
  const tokens: Record<string, TokenRef> = {};
  const inlineStyles: Record<string, string> = {};

  for (const decl of styleAttr.split(";")) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) continue;
    const prop = trimmed.slice(0, sep).trim();
    const rawValue = trimmed.slice(sep + 1).trim();
    if (!prop) continue;

    const parsed = parseTokenValue(rawValue);
    if (parsed.kind === "ref") {
      tokens[prop] = parsed.ref;
    } else if (parsed.kind === "literal") {
      inlineStyles[prop] = parsed.value;
    } else {
      // A parse error must never destroy data — keep the raw value so the
      // agent can see and fix it, instead of it vanishing on the next write.
      inlineStyles[prop] = rawValue;
      const hint =
        parsed.code === "multi_ref_value" ? " — a modifier call's args must each be a $ref or a number" : "";
      errors.push({ code: parsed.code, message: `${parsed.code} in style "${prop}: ${rawValue}"${hint}`, nodeId });
    }
  }

  return { tokens, inlineStyles };
}

type ClassRefResolution = "component" | "token-class" | "ambiguous" | "unresolved";

function resolveClassRef(refName: string, registry: DesignSystemRegistry): ClassRefResolution {
  const isComponent = registry.componentNames.has(refName);
  const isTokenClass = refName.includes(".")
    ? registry.tokenPaths.has(refName)
    : registry.tokenFlatNames.has(refName);
  if (isComponent && isTokenClass) return "ambiguous";
  if (isComponent) return "component";
  if (isTokenClass) return "token-class";
  return "unresolved";
}

export type ElementClassification =
  | { kind: "svg" | "svg_path" }
  | { kind: "component_instance"; component: string; instanceSyntax: "class" | "data-attr"; conflictingClassToken?: string }
  | { kind: "token_class"; classRef: string }
  | { kind: "ambiguous_class"; classRef: string }
  | { kind: "unresolved_class"; classRef: string }
  | { kind: "element" };

/**
 * The element-kind decision `buildElement` needs before it can build
 * anything else about a node: SVG context wins first — a `data-component`/
 * `$class` token found inside `<svg>` is inert, never a component instance,
 * exactly matching a real browser's SVG content model — then
 * `data-component`, then a `$class` token resolved against the
 * design-system registry.
 *
 * Exported so `patch-definition.ts`'s id-locating traversal makes the exact
 * same recursion decision (a component instance's children are opaque —
 * never allocated an id, matching how `buildElement` routes them into
 * `slot_overrides` instead of the flat node map) without re-parsing through
 * `parseScreen`. The two must never diverge on this decision again: an
 * earlier, separately-reimplemented version of this check in
 * `patch-definition.ts` had no SVG-context guard at all, so a
 * `data-component`/`$class` element inside `<svg>` was wrongly treated as
 * opaque there, silently shifting every id allocated after it.
 */
export function classifyElement(
  attrs: Map<string, string>,
  tag: string,
  inSvg: boolean,
  registry: DesignSystemRegistry,
): ElementClassification {
  const isSvgRoot = tag === "svg";
  if (inSvg || isSvgRoot) return { kind: isSvgRoot ? "svg" : "svg_path" };

  const classAttr = attrs.get("class");
  const refToken = classAttr
    ?.split(/\s+/)
    .filter(Boolean)
    .find((p) => p.startsWith("$"));

  const dataComponent = attrs.get("data-component");
  if (dataComponent) {
    return { kind: "component_instance", component: dataComponent, instanceSyntax: "data-attr", conflictingClassToken: refToken };
  }

  if (!refToken) return { kind: "element" };

  const refName = refToken.slice(1);
  const resolution = resolveClassRef(refName, registry);
  if (resolution === "component") return { kind: "component_instance", component: refName, instanceSyntax: "class" };
  if (resolution === "token-class") return { kind: "token_class", classRef: refName };
  if (resolution === "ambiguous") return { kind: "ambiguous_class", classRef: refName };
  return { kind: "unresolved_class", classRef: refName };
}

function guessFlowTargetKind(flowTarget: string): "screen" | "node" {
  return flowTarget.includes(".") ? "node" : "screen";
}

/** Checks style/SVG token refs (dot-paths, including modifier-fn args) against the DS registry. */
function checkTokenRefsResolved(
  tokens: Record<string, TokenRef>,
  registry: DesignSystemRegistry,
  nodeId: NodeId | undefined,
  errors: ValidationIssue[],
): void {
  for (const ref of Object.values(tokens)) {
    for (const path of tokenRefPaths(ref)) {
      if (!registry.tokenPaths.has(path)) {
        errors.push({ code: "unresolved_ref", message: `"$${path}" does not resolve in the design system`, nodeId });
      }
    }
  }
}

/**
 * Builds the un-indexed subtree used for `slot_overrides` content. Slot
 * content nodes are not entered into the flat `ScreenDocument.nodes` map —
 * they live inline inside the instance's `slot_overrides`, per Schema-Spec.
 */
function buildSubtree(
  node: P5ChildNode,
  inSvg: boolean,
  registry: DesignSystemRegistry,
  errors: ValidationIssue[],
): NodeSubtree {
  if (node.nodeName === "#text") {
    return {
      kind: "text",
      text: (node as DefaultTreeAdapterTypes.TextNode).value,
      attributes: {},
      refs: { tokens: {} },
      inlineStyles: {},
      children: [],
    };
  }
  if (!isElementLike(node)) {
    return { kind: "text", text: "", attributes: {}, refs: { tokens: {} }, inlineStyles: {}, children: [] };
  }

  const attrs = new Map(node.attrs.map((a) => [a.name, a.value]));
  const tag = node.tagName;
  const isSvgRoot = tag === "svg";
  const svgDomain = inSvg || isSvgRoot;
  const kind: NodeKind = svgDomain ? (isSvgRoot ? "svg" : "svg_path") : "element";

  const styleAttr = attrs.get("style");
  const styleResult = styleAttr
    ? parseStyleAttribute(styleAttr, "slot-content", errors)
    : { tokens: {}, inlineStyles: {} };
  attrs.delete("style");

  const tokens: Record<string, TokenRef> = { ...styleResult.tokens };
  if (kind === "svg" || kind === "svg_path") {
    for (const attrName of ["fill", "stroke"] as const) {
      const value = attrs.get(attrName);
      if (value === undefined || !value.includes("$")) continue;
      const parsed = parseTokenValue(value);
      if (parsed.kind === "ref") {
        tokens[attrName] = parsed.ref;
        attrs.delete(attrName);
      } else if (parsed.kind === "error") {
        // Keep the raw attribute value on error — never destroy data.
        errors.push({ code: parsed.code, message: `${parsed.code} in ${attrName}="${value}"` });
      }
    }
  }
  attrs.delete("id");
  attrs.delete("data-node-id");
  attrs.delete("data-slot");

  checkTokenRefsResolved(tokens, registry, undefined, errors);

  const children = node.childNodes.map((child) => buildSubtree(child, svgDomain, registry, errors));

  return {
    kind,
    tag,
    attributes: Object.fromEntries(attrs),
    refs: { tokens },
    inlineStyles: styleResult.inlineStyles,
    children,
  };
}

/**
 * Maps a component instance's direct children onto `slot_overrides`. Full
 * slot-name resolution requires the component's declared slot list, which
 * is out of M1 scope (Schema-Spec open question #9); a child's own
 * `data-slot="<name>"` is used when present, otherwise children fill
 * positional slots (`slot-0`, `slot-1`, …) in document order.
 */
function collectSlotOverrides(
  children: P5ChildNode[],
  inSvg: boolean,
  registry: DesignSystemRegistry,
  errors: ValidationIssue[],
): Record<string, NodeSubtree> {
  const overrides: Record<string, NodeSubtree> = {};
  let index = 0;
  for (const child of children) {
    if (child.nodeName === "#text" && (child as DefaultTreeAdapterTypes.TextNode).value.trim() === "") continue;
    const explicitSlot = isElementLike(child)
      ? new Map(child.attrs.map((a) => [a.name, a.value])).get("data-slot")
      : undefined;

    let key: string;
    if (explicitSlot) {
      key = explicitSlot;
    } else {
      // Skip past any position that an explicit data-slot already claimed,
      // so a positional key never silently overwrites a named override.
      do {
        key = `slot-${index}`;
        index += 1;
      } while (key in overrides);
    }

    overrides[key] = buildSubtree(child, inSvg, registry, errors);
  }
  return overrides;
}

type BuildContext = {
  screenId: string;
  allocator: NodeIdAllocator;
  registry: DesignSystemRegistry;
  errors: ValidationIssue[];
  nodes: Record<NodeId, Node>;
  flows: Flow[];
};

function buildElement(el: P5Element, parentId: NodeId | null, inSvg: boolean, ctx: BuildContext): NodeId {
  const attrs = new Map(el.attrs.map((a) => [a.name, a.value]));

  const explicitId = attrs.get("id") ?? attrs.get("data-node-id");
  const id = ctx.allocator.allocateElementId(explicitId);

  const tag = el.tagName;
  const isSvgRoot = tag === "svg";
  const kindIsSvgDomain = inSvg || isSvgRoot;

  const classAttr = attrs.get("class");
  const parts = classAttr ? classAttr.split(/\s+/).filter(Boolean) : [];
  const plainClasses = parts.filter((p) => !p.startsWith("$"));

  let kind: NodeKind;
  let component: string | undefined;
  let instanceSyntax: "class" | "data-attr" | undefined;
  const tokensFromClass: Record<string, TokenRef> = {};

  const classification = classifyElement(attrs, tag, inSvg, ctx.registry);
  switch (classification.kind) {
    case "svg":
    case "svg_path":
      kind = classification.kind;
      break;
    case "component_instance":
      kind = "component_instance";
      component = classification.component;
      instanceSyntax = classification.instanceSyntax;
      if (instanceSyntax === "data-attr") {
        if (!ctx.registry.componentNames.has(component)) {
          ctx.errors.push({
            code: "unresolved_ref",
            message: `component "${component}" (data-component) is not in the design system`,
            nodeId: id,
          });
        }
        if (classification.conflictingClassToken) {
          // data-component wins over a $-class token; the token is kept as a
          // plain class rather than dropped, and the ambiguity is surfaced.
          plainClasses.push(classification.conflictingClassToken);
          ctx.errors.push({
            code: "ambiguous_class_ref",
            message: `data-component="${component}" takes precedence over class="${classification.conflictingClassToken}"; the $-class token is kept as a plain class`,
            nodeId: id,
          });
        }
      }
      break;
    case "token_class":
      kind = "element";
      tokensFromClass.class = classification.classRef;
      break;
    case "ambiguous_class":
      kind = "element";
      ctx.errors.push({
        code: "ambiguous_class_ref",
        message: `"$${classification.classRef}" resolves to both a component and a token`,
        nodeId: id,
      });
      break;
    case "unresolved_class":
      kind = "element";
      ctx.errors.push({
        code: "unresolved_ref",
        message: `"$${classification.classRef}" does not resolve in the design system`,
        nodeId: id,
      });
      break;
    case "element":
      kind = "element";
      break;
  }

  const styleAttr = attrs.get("style");
  const { tokens: styleTokens, inlineStyles } = styleAttr
    ? parseStyleAttribute(styleAttr, id, ctx.errors)
    : { tokens: {}, inlineStyles: {} };

  const tokensFromSvgAttrs: Record<string, TokenRef> = {};
  if (kind === "svg" || kind === "svg_path") {
    for (const attrName of ["fill", "stroke"] as const) {
      const value = attrs.get(attrName);
      if (value === undefined || !value.includes("$")) continue;
      const parsed = parseTokenValue(value);
      if (parsed.kind === "ref") {
        tokensFromSvgAttrs[attrName] = parsed.ref;
        attrs.delete(attrName);
      } else if (parsed.kind === "error") {
        // Keep the raw attribute value on error — never destroy data.
        ctx.errors.push({ code: parsed.code, message: `${parsed.code} in ${attrName}="${value}"`, nodeId: id });
      }
    }
  }

  checkTokenRefsResolved({ ...styleTokens, ...tokensFromSvgAttrs }, ctx.registry, id, ctx.errors);

  const variant = attrs.get("data-variant");
  const sectionId = attrs.get("data-section");
  const flowTarget = attrs.get("data-flow-target");
  const rawFlowTrigger = attrs.get("data-flow-trigger");
  let flowTrigger: FlowTriggerEvent = "tap";
  if (rawFlowTrigger) {
    if ((ALLOWED_FLOW_TRIGGERS as readonly string[]).includes(rawFlowTrigger)) {
      flowTrigger = rawFlowTrigger as FlowTriggerEvent;
    } else {
      ctx.errors.push({
        code: "unknown_flow_trigger",
        message: `"${rawFlowTrigger}" is not a valid data-flow-trigger`,
        nodeId: id,
      });
    }
  }

  if (flowTarget) {
    ctx.flows.push({
      triggerNodeId: id,
      triggerEvent: flowTrigger,
      targetKind: guessFlowTargetKind(flowTarget),
      targetId: flowTarget,
    });
  }

  for (const reserved of RESERVED_ATTRS) attrs.delete(reserved);
  if (plainClasses.length > 0) attrs.set("class", plainClasses.join(" "));

  // A likely-misspelled augmentation attribute (e.g. data-varient) is never
  // destroyed — it stays on the node like any other attribute — but is
  // flagged so the write surfaces it instead of silently rendering wrong.
  for (const attrName of attrs.keys()) {
    const suggestion = findSuspiciousAttr(attrName);
    if (suggestion) {
      ctx.errors.push({
        code: "suspicious_attr",
        message: `attribute "${attrName}" is not part of the augmentation grammar — did you mean "${suggestion}"?`,
        nodeId: id,
      });
    }
  }

  const refs: NodeRefs = {
    tokens: { ...tokensFromClass, ...styleTokens, ...tokensFromSvgAttrs },
  };
  if (component) refs.component = component;
  if (variant) refs.variant = variant;

  const childIds: NodeId[] = [];
  const node: Node = {
    id,
    parentId,
    screenId: ctx.screenId,
    kind,
    tag,
    attributes: Object.fromEntries(attrs),
    refs,
    inlineStyles,
    childIds,
  };
  if (instanceSyntax) node.instanceSyntax = instanceSyntax;
  ctx.nodes[id] = node;

  if (kind === "component_instance") {
    // Component instances are structurally immutable: children live in
    // slot_overrides, not as separate entries in the flat node map.
    node.slotOverrides = collectSlotOverrides(childNodesOf(el), kindIsSvgDomain, ctx.registry, ctx.errors);
  } else {
    for (const child of childNodesOf(el)) {
      if (child.nodeName === "#text") {
        const text = (child as DefaultTreeAdapterTypes.TextNode).value;
        if (text.trim() === "") continue; // pure whitespace between tags — not part of the model
        const textId = ctx.allocator.allocateTextId(id);
        ctx.nodes[textId] = {
          id: textId,
          parentId: id,
          screenId: ctx.screenId,
          kind: "text",
          text,
          attributes: {},
          refs: { tokens: {} },
          inlineStyles: {},
          childIds: [],
        };
        childIds.push(textId);
      } else if (isElementLike(child)) {
        childIds.push(buildElement(child, id, kindIsSvgDomain, ctx));
      }
      // Comments and doctype nodes are not part of the canonical model (v0.1).
    }
  }

  // sectionId is only meaningful at screen root; callers pick it off the root node's attrs.
  if (sectionId) node.attributes["data-section"] = sectionId;

  return id;
}

/** Recursively collects every explicit `id`/`data-node-id` value in the document, with occurrence counts. */
function collectExplicitIds(nodes: P5ChildNode[], counts: Map<string, number>): void {
  for (const node of nodes) {
    if (!isElementLike(node)) continue;
    const attrs = new Map(node.attrs.map((a) => [a.name, a.value]));
    const explicit = attrs.get("id") ?? attrs.get("data-node-id");
    if (explicit) counts.set(explicit, (counts.get(explicit) ?? 0) + 1);
    collectExplicitIds(childNodesOf(node), counts);
  }
}

export type ParseScreenOptions = {
  /**
   * Extra ids to seed the allocator with, beyond what's found in `html`
   * itself — used by `patch_html` when parsing a fragment that will be
   * spliced into an already-loaded document, so the fragment's
   * auto-generated ids can't collide with the target document's.
   */
  reservedIds?: Iterable<NodeId>;
};

export function parseScreen(
  html: string,
  screenId: string,
  registry: DesignSystemRegistry,
  options?: ParseScreenOptions,
): ParseResult {
  const errors: ValidationIssue[] = [];
  const parseErrorCodes: string[] = [];

  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => parseErrorCodes.push(err.code),
  });

  if (parseErrorCodes.length > 0) {
    errors.push({ code: "malformed_html", message: `HTML parse errors: ${parseErrorCodes.join(", ")}` });
  }

  const topLevelElements = fragment.childNodes.filter(isElementLike);
  if (topLevelElements.length !== 1) {
    errors.push({
      code: "malformed_html",
      message: `screen must have exactly one top-level element, found ${topLevelElements.length}`,
    });
  }

  const explicitIdCounts = new Map<string, number>();
  collectExplicitIds(fragment.childNodes, explicitIdCounts);
  for (const [explicitId, count] of explicitIdCounts) {
    if (count > 1) {
      errors.push({ code: "duplicate_node_id", message: `id "${explicitId}" is used ${count} times` });
    }
  }

  const nodes: Record<NodeId, Node> = {};
  const flows: Flow[] = [];
  const allocator = new NodeIdAllocator();
  // Seed with every explicit id in the document up front, so an
  // auto-generated id can never collide with one seen later in pre-order.
  allocator.seedUsed(explicitIdCounts.keys());
  if (options?.reservedIds) allocator.seedUsed(options.reservedIds);
  const ctx: BuildContext = { screenId, allocator, registry, errors, nodes, flows };

  const rootSource = topLevelElements[0];
  const rootNodeId = rootSource
    ? buildElement(rootSource, null, false, ctx)
    : allocator.allocateElementId(undefined);

  if (!rootSource) {
    nodes[rootNodeId] = {
      id: rootNodeId,
      parentId: null,
      screenId,
      kind: "element",
      tag: "div",
      attributes: {},
      refs: { tokens: {} },
      inlineStyles: {},
      childIds: [],
    };
  }

  const root = nodes[rootNodeId];
  const sectionId = root?.attributes["data-section"] ?? null;
  const title = root?.attributes["data-title"] ?? screenId;
  if (root) {
    delete root.attributes["data-section"];
    delete root.attributes["data-title"];
  }

  const doc: ScreenDocument = {
    id: screenId,
    title,
    sectionId,
    rootNodeId,
    flows,
    nodes,
  };

  return { doc, errors };
}
