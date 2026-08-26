import type { Flow, Node, NodeSubtree, ScreenDocument, TokenRef, TokenRefAtom } from "./types.js";
import { isMixedTokenValue } from "./token-ref.js";
import { VOID_ELEMENTS, escapeAttr, escapeText } from "./html-syntax.js";

function serializeTokenRefAtom(atom: TokenRefAtom): string {
  if (typeof atom === "string") return `$${atom}`;
  const args = atom.args.map((arg) => (typeof arg === "number" ? String(arg) : `$${arg}`));
  return `${atom.fn}(${args.join(", ")})`;
}

/** `parts` alternates literal/atom/literal/... (see MixedTokenValue) — literal chunks concatenate verbatim, atoms get re-`$`-prefixed/re-called. */
function serializeTokenRef(ref: TokenRef): string {
  if (isMixedTokenValue(ref)) {
    return ref.parts.map((part, i) => (i % 2 === 0 ? (part as string) : serializeTokenRefAtom(part as TokenRefAtom))).join("");
  }
  return serializeTokenRefAtom(ref);
}

/**
 * `fill`/`stroke` are only pulled out of the style declarations when the
 * node is in the SVG domain, where they're serialized as dedicated
 * presentation attributes instead. On non-SVG nodes they're ordinary CSS
 * properties and belong in `style="..."` like any other.
 */
function styleAttrValue(
  tokens: Record<string, TokenRef>,
  inlineStyles: Record<string, string>,
  isSvgDomain: boolean,
): string | undefined {
  const decls: string[] = [];
  for (const [prop, ref] of Object.entries(tokens)) {
    if (prop === "class") continue;
    if (isSvgDomain && (prop === "fill" || prop === "stroke")) continue;
    decls.push(`${prop}: ${serializeTokenRef(ref)}`);
  }
  for (const [prop, value] of Object.entries(inlineStyles)) {
    decls.push(`${prop}: ${value}`);
  }
  return decls.length > 0 ? decls.join("; ") : undefined;
}

function classAttrValue(node: Node): string | undefined {
  const parts: string[] = [];
  if (node.kind === "component_instance" && node.refs.component) {
    if (node.instanceSyntax !== "data-attr") parts.push(`$${node.refs.component}`);
  } else if (node.refs.tokens.class) {
    parts.push(`$${serializeTokenRef(node.refs.tokens.class).slice(1)}`);
  }
  const plain = node.attributes.class;
  if (plain) parts.push(...plain.split(/\s+/).filter(Boolean));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function openTagAttrs(node: Node, doc: ScreenDocument, flowsByTrigger: Map<string, Flow>): string {
  const attrs: [string, string][] = [["id", node.id]];

  if (node.id === doc.rootNodeId) {
    if (doc.sectionId) attrs.push(["data-section", doc.sectionId]);
    // Only re-emit data-title when it was explicitly set — parseScreen
    // falls back to the screen id, and echoing that back as a literal
    // attribute would fabricate one on every subsequent parse.
    if (doc.title !== doc.id) attrs.push(["data-title", doc.title]);
  }

  if (node.kind === "component_instance" && node.refs.component && node.instanceSyntax === "data-attr") {
    attrs.push(["data-component", node.refs.component]);
  }

  const cls = classAttrValue(node);
  if (cls) attrs.push(["class", cls]);

  const isSvgDomain = node.kind === "svg" || node.kind === "svg_path";
  const style = styleAttrValue(node.refs.tokens, node.inlineStyles, isSvgDomain);
  if (style) attrs.push(["style", style]);

  if (node.refs.variant) attrs.push(["data-variant", node.refs.variant]);

  const flow = flowsByTrigger.get(node.id);
  if (flow) {
    attrs.push(["data-flow-target", flow.targetId]);
    if (flow.triggerEvent !== "tap") attrs.push(["data-flow-trigger", flow.triggerEvent]);
  }

  if (isSvgDomain) {
    if (node.refs.tokens.fill) attrs.push(["fill", serializeTokenRef(node.refs.tokens.fill)]);
    if (node.refs.tokens.stroke) attrs.push(["stroke", serializeTokenRef(node.refs.tokens.stroke)]);
  }

  for (const [key, value] of Object.entries(node.attributes)) {
    if (key === "class") continue;
    attrs.push([key, value]);
  }

  return attrs.map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(" ");
}

/**
 * Serializes one slot-override subtree. `slotKey`, given only for the root
 * of a slot override (not its descendants), is re-emitted as `data-slot` so
 * the exact same slot name survives a parse -> serialize -> parse cycle
 * instead of degrading to a positional key.
 */
function subtreeClassAttrValue(sub: NodeSubtree): string | undefined {
  const parts: string[] = [];
  if (sub.kind === "component_instance" && sub.refs.component) {
    parts.push(`$${sub.refs.component}`);
  } else if (sub.refs.tokens.class) {
    parts.push(`$${serializeTokenRef(sub.refs.tokens.class).slice(1)}`);
  }
  const plain = sub.attributes.class;
  if (plain) parts.push(...plain.split(/\s+/).filter(Boolean));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function serializeSubtree(sub: NodeSubtree, slotKey?: string): string {
  if (sub.kind === "text") return escapeText(sub.text ?? "");

  const isSvgDomain = sub.kind === "svg" || sub.kind === "svg_path";
  const attrs: [string, string][] = [];
  if (slotKey !== undefined) attrs.push(["data-slot", slotKey]);
  const cls = subtreeClassAttrValue(sub);
  if (cls) attrs.push(["class", cls]);
  const style = styleAttrValue(sub.refs.tokens, sub.inlineStyles, isSvgDomain);
  if (style) attrs.push(["style", style]);
  if (sub.refs.variant) attrs.push(["data-variant", sub.refs.variant]);
  if (isSvgDomain && sub.refs.tokens.fill) {
    attrs.push(["fill", serializeTokenRef(sub.refs.tokens.fill)]);
  }
  if (isSvgDomain && sub.refs.tokens.stroke) {
    attrs.push(["stroke", serializeTokenRef(sub.refs.tokens.stroke)]);
  }
  for (const [key, value] of Object.entries(sub.attributes)) {
    if (key === "class") continue;
    attrs.push([key, value]);
  }

  const attrStr = attrs.map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(" ");
  const tag = sub.tag ?? "div";
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrStr ? ` ${attrStr}` : ""}>`;
  const inner =
    sub.kind === "component_instance"
      ? Object.entries(sub.slotOverrides ?? {})
          .map(([key, child]) => serializeSubtree(child, key))
          .join("")
      : sub.children.map((child) => serializeSubtree(child)).join("");
  return `<${tag}${attrStr ? ` ${attrStr}` : ""}>${inner}</${tag}>`;
}

function serializeNode(nodeId: string, doc: ScreenDocument, flowsByTrigger: Map<string, Flow>): string {
  const node = doc.nodes[nodeId];
  if (!node) return "";
  if (node.kind === "text") return escapeText(node.text ?? "");

  const tag = node.tag ?? "div";
  const attrStr = openTagAttrs(node, doc, flowsByTrigger);

  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrStr ? ` ${attrStr}` : ""}>`;

  let inner: string;
  if (node.kind === "component_instance") {
    inner = Object.entries(node.slotOverrides ?? {})
      .map(([key, sub]) => serializeSubtree(sub, key))
      .join("");
  } else {
    inner = node.childIds.map((childId) => serializeNode(childId, doc, flowsByTrigger)).join("");
  }

  return `<${tag}${attrStr ? ` ${attrStr}` : ""}>${inner}</${tag}>`;
}

/** Serializes the canonical model back to augmented HTML (the `html_aug` adapter). */
export function serializeScreen(doc: ScreenDocument): string {
  const flowsByTrigger = new Map(doc.flows.map((flow) => [flow.triggerNodeId, flow]));
  return serializeNode(doc.rootNodeId, doc, flowsByTrigger);
}

/** Serializes a single node's subtree (used by `get_node.full`'s `html_aug`), not the whole screen. */
export function serializeNodeSubtree(doc: ScreenDocument, nodeId: string): string {
  const flowsByTrigger = new Map(doc.flows.map((flow) => [flow.triggerNodeId, flow]));
  return serializeNode(nodeId, doc, flowsByTrigger);
}

/**
 * Serializes a detached `NodeSubtree` (no screen, no node id) — used when
 * lifting a node into a design-system component/pattern definition file,
 * where the screen-local node id has no meaning and must not leak in.
 */
export function serializeDetachedSubtree(sub: NodeSubtree): string {
  return serializeSubtree(sub);
}
