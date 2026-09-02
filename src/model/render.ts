import type { TokensDocument } from "../store/index.js";
import { parseScreen } from "./parser.js";
import { isMixedTokenValue } from "./token-ref.js";
import { VOID_ELEMENTS, escapeAttr, escapeText } from "./html-syntax.js";
import type { DesignSystemRegistry } from "./registry.js";
import type { ComponentDefinitionSummary } from "./component.js";
import type { Flow, ModifierFn, NodeSubtree, ScreenDocument, TokenRef, TokenRefAtom } from "./types.js";

/**
 * The `html` render adapter (Tool-Palette-Schemas `output_format: "html"`):
 * resolves augmented HTML into plain, render-ready HTML. No $-refs survive —
 * token refs become concrete CSS values, component instances are expanded
 * into their active variant's markup with slot overrides applied. Per PRD,
 * "the preview renders exactly the source HTML/CSS" — this is a textual
 * substitution step, not a second render engine; the browser still does all
 * actual rendering (including evaluating CSS Color 4 functions like
 * `color-mix()` used below for modifier functions).
 *
 * Node ids and `data-flow-target`/`data-flow-trigger` are preserved in the
 * output — the preview needs stable ids for flow-mode click-through and
 * (later) comment anchoring.
 */
export type RenderContext = {
  tokens: TokensDocument;
  registry: DesignSystemRegistry;
  componentDefs: Map<string, ComponentDefinitionSummary>;
  /** Set by callers that know — `false` flags `.icon` usage with the unresolved-icon-font diagnostic. `undefined`/omitted renders no diagnostic, matching every existing call site that doesn't set it. */
  iconFontAvailable?: boolean;
};

type AttrSource = {
  attributes: Record<string, string>;
  refs: { tokens: Record<string, TokenRef>; variant?: string };
  inlineStyles: Record<string, string>;
  kind: string;
};

function resolveTokenPath(path: string, tokens: TokensDocument, unresolved?: string[]): string {
  const dot = path.indexOf(".");
  if (dot === -1) {
    unresolved?.push(path);
    return `/* unresolved: $${path} */`;
  }
  const value = tokens[path.slice(0, dot)]?.[path.slice(dot + 1)];
  if (value === undefined || typeof value === "object") {
    unresolved?.push(path);
    return `/* unresolved: $${path} */`;
  }
  return String(value);
}

/** A missing/non-numeric fraction never reaches the CSS output as `NaN%` — `alpha($ref)` with no fraction degrades to `fallback` (opaque, i.e. a no-op) instead. */
function toPercent(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n * 100 : fallback;
}

/**
 * alpha()/oklab()/mix() are re-expressed as standards-track CSS Color 4
 * functions (`color-mix()`, relative-color `oklab()`) rather than computed
 * here — the browser does the actual color math from a textual value,
 * keeping this step a substitution, not a color engine of our own.
 */
function resolveModifier(fn: ModifierFn, args: string[]): string {
  switch (fn) {
    case "alpha": {
      const [color, fraction] = args;
      return `color-mix(in srgb, ${color} ${toPercent(fraction, 100)}%, transparent)`;
    }
    case "oklab": {
      // Schema-Spec defines oklab(ref) as color-space conversion only — no
      // channel overrides — so the relative-color *identity* (component
      // values unchanged) is the deliberately correct reading, not a stub.
      const [color] = args;
      return `oklab(from ${color} l a b)`;
    }
    case "mix": {
      const [colorA, colorB, weight] = args;
      if (weight === undefined) return `color-mix(in srgb, ${colorA}, ${colorB})`;
      const pct = toPercent(weight, 50);
      return `color-mix(in srgb, ${colorA} ${pct}%, ${colorB} ${100 - pct}%)`;
    }
  }
}

function resolveTokenRefAtom(atom: TokenRefAtom, tokens: TokensDocument, unresolved?: string[]): string {
  if (typeof atom === "string") return resolveTokenPath(atom, tokens, unresolved);
  const args = atom.args.map((arg) => (typeof arg === "number" ? String(arg) : resolveTokenPath(arg, tokens, unresolved)));
  return resolveModifier(atom.fn, args);
}

/** `parts` alternates literal/atom/literal/... (see MixedTokenValue) — literal chunks pass through verbatim, atoms resolve individually so one unresolved ref never blocks its neighbors. */
export function resolveTokenRef(ref: TokenRef, tokens: TokensDocument, unresolved?: string[]): string {
  if (isMixedTokenValue(ref)) {
    return ref.parts
      .map((part, i) => (i % 2 === 0 ? (part as string) : resolveTokenRefAtom(part as TokenRefAtom, tokens, unresolved)))
      .join("");
  }
  return resolveTokenRefAtom(ref, tokens, unresolved);
}

function styleAttrValue(source: AttrSource, tokens: TokensDocument, unresolved: string[]): string | undefined {
  const isSvgDomain = source.kind === "svg" || source.kind === "svg_path";
  const decls: string[] = [];
  for (const [prop, ref] of Object.entries(source.refs.tokens)) {
    if (prop === "class") continue;
    if (isSvgDomain && (prop === "fill" || prop === "stroke")) continue;
    decls.push(`${prop}: ${resolveTokenRef(ref, tokens, unresolved)}`);
  }
  for (const [prop, value] of Object.entries(source.inlineStyles)) decls.push(`${prop}: ${value}`);
  return decls.length > 0 ? decls.join("; ") : undefined;
}

function classAttrValue(source: AttrSource): string | undefined {
  const parts: string[] = [];
  const classRef = source.refs.tokens.class;
  if (typeof classRef === "string") parts.push(classRef);
  const plain = source.attributes.class;
  if (plain) parts.push(...plain.split(/\s+/).filter(Boolean));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Whether `cls` (the node's fully-resolved `class` attribute value) carries the `.icon` ligature class render-document.ts styles. */
function hasIconClass(cls: string | undefined): boolean {
  return cls !== undefined && cls.split(/\s+/).includes("icon");
}

/**
 * Attribute list for one node, excluding `id` (callers own id assignment —
 * a live node's own vs. a namespaced template-instance id). A token ref
 * that fails to resolve gets `data-unresolved-token="<path>[,<path>...]"`
 * on top of the `/* unresolved: $path *\/` CSS comment — the
 * comment alone isn't queryable, so the preview/baseline CSS (render-document.ts)
 * can't target the affected element without this attribute. `.icon` usage
 * gets the analogous `data-unresolved-icon-font` when the caller
 * knows the icon font itself never resolved — otherwise a missing font
 * silently degrades to literal ligature text (e.g. "search") with no
 * visual signal at all.
 */
function buildAttrs(source: AttrSource, tokens: TokensDocument, flow: Flow | undefined, iconFontAvailable: boolean | undefined): [string, string][] {
  const isSvgDomain = source.kind === "svg" || source.kind === "svg_path";
  const attrs: [string, string][] = [];
  const unresolved: string[] = [];

  const cls = classAttrValue(source);
  if (cls) attrs.push(["class", cls]);

  const style = styleAttrValue(source, tokens, unresolved);
  if (style) attrs.push(["style", style]);

  if (source.refs.variant) attrs.push(["data-variant", source.refs.variant]);

  if (flow) {
    attrs.push(["data-flow-target", flow.targetId]);
    if (flow.triggerEvent !== "tap") attrs.push(["data-flow-trigger", flow.triggerEvent]);
  }

  if (isSvgDomain) {
    if (source.refs.tokens.fill) attrs.push(["fill", resolveTokenRef(source.refs.tokens.fill, tokens, unresolved)]);
    if (source.refs.tokens.stroke) attrs.push(["stroke", resolveTokenRef(source.refs.tokens.stroke, tokens, unresolved)]);
  }

  if (unresolved.length > 0) attrs.push(["data-unresolved-token", unresolved.join(",")]);
  if (iconFontAvailable === false && hasIconClass(cls)) attrs.push(["data-unresolved-icon-font", "Material Symbols Rounded"]);

  for (const [key, value] of Object.entries(source.attributes)) {
    if (key === "class" || key === "data-slot") continue;
    attrs.push([key, value]);
  }

  return attrs;
}

function attrsToString(attrs: [string, string][]): string {
  return attrs.map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(" ");
}

/**
 * Where a piece of authored markup comes from — the screen itself, or the
 * template of a component currently being expanded. Two things follow from
 * it, and both matter for slot fills, which are rendered where they are
 * *substituted* rather than where they were *written*:
 *
 * - `path`: the component names being expanded at the authoring point. It is
 *   the cycle guard for an instance found in that markup. A screen's own
 *   `<div class="$card">` filling another `$card`'s slot is finite nesting,
 *   not recursion, so screen-authored content starts from an empty path;
 *   only content written inside a component's template can loop back into
 *   that component, and there the path already holds it.
 * - `idPrefix`: the namespace authored ids live in. Screen ids are the
 *   screen's own; ids inside a template are namespaced under the expansion
 *   root, exactly like the template's other nodes.
 */
type Origin = { path: ReadonlySet<string>; idPrefix?: string };
const SCREEN_ORIGIN: Origin = { path: new Set() };

/** Allocates ids for slot-fill instances that carry none of their own, namespaced under the expansion they fill. */
type FillIds = { base: string; count: number };

/** What `renderComponentInstance` reads off an instance — the same fields on a live node and on a slot-fill subtree. */
type InstanceSource = Pick<NodeSubtree, "kind" | "attributes" | "refs" | "inlineStyles" | "slotOverrides">;

/**
 * Renders slot-fill content. A `component_instance` in it expands exactly like
 * one anywhere else (CHR-581) — before this branch existed, such an instance
 * fell through to the plain-element path below and its `$ref` leaked into
 * the output as a literal class. The fill's authored ids are emitted too,
 * namespaced by where the fill was written (`origin`).
 */
function renderSubtree(sub: NodeSubtree, ctx: RenderContext, origin: Origin, fillIds: FillIds): string {
  if (sub.kind === "text") return escapeText(sub.text ?? "");

  const authoredId = sub.id === undefined ? undefined : origin.idPrefix === undefined ? sub.id : `${origin.idPrefix}--${sub.id}`;

  if (sub.kind === "component_instance") {
    fillIds.count += 1;
    const rootId = authoredId ?? `${fillIds.base}--fill${fillIds.count}`;
    return renderComponentInstance(sub, ctx, undefined, origin, rootId);
  }

  const tag = sub.tag ?? "div";
  const attrs: [string, string][] = [
    ...(authoredId === undefined ? [] : [["id", authoredId] as [string, string]]),
    ...buildAttrs(sub, ctx.tokens, undefined, ctx.iconFontAvailable),
  ];
  const attrStr = attrsToString(attrs);
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrStr ? ` ${attrStr}` : ""}>`;
  const inner = sub.children.map((child) => renderSubtree(child, ctx, origin, fillIds)).join("");
  return `<${tag}${attrStr ? ` ${attrStr}` : ""}>${inner}</${tag}>`;
}

function renderNode(nodeId: string, doc: ScreenDocument, ctx: RenderContext, flowsByTrigger: Map<string, Flow>): string {
  const node = doc.nodes[nodeId];
  if (!node) return "";
  if (node.kind === "text") return escapeText(node.text ?? "");
  if (node.kind === "component_instance") {
    return renderComponentInstance(node, ctx, flowsByTrigger.get(node.id), SCREEN_ORIGIN, node.id);
  }

  const tag = node.tag ?? "div";
  const attrs: [string, string][] = [["id", node.id], ...buildAttrs(node, ctx.tokens, flowsByTrigger.get(node.id), ctx.iconFontAvailable)];
  const attrStr = attrsToString(attrs);
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrStr ? ` ${attrStr}` : ""}>`;
  const inner = node.childIds.map((childId) => renderNode(childId, doc, ctx, flowsByTrigger)).join("");
  return `<${tag}${attrStr ? ` ${attrStr}` : ""}>${inner}</${tag}>`;
}

/**
 * Whether this element carries a look of its own — styling, or a whole
 * component instance. On a template's slot element all of it is dropped the
 * moment an instance fills that slot: substitution replaces the element
 * wholesale (see `renderTemplateNode`), so the definition's own look never
 * reaches the render. `write_html` warns about it rather than the renderer
 * changing behaviour.
 *
 * The slot's *tag* is discarded by the same replacement (`<h3 data-slot>`
 * filled by a `<span>` renders as a `<span>`) and is deliberately not
 * covered: which tag an instance supplies is unknowable at definition time,
 * so every semantic slot tag would warn. The guide states that one instead.
 */
function carriesOwnLook(source: AttrSource & { refs: { component?: string } }): boolean {
  // A `class="$card"` slot parses as a component_instance, so the ref lands
  // in refs.component rather than in class/tokens — and losing a nested
  // component definition is the costliest discard of the lot.
  if (source.refs.component !== undefined) return true;
  if (classAttrValue(source) !== undefined) return true;
  if (Object.keys(source.inlineStyles).length > 0) return true;
  return Object.keys(source.refs.tokens).some((prop) => prop !== "class");
}

/** A template element carrying `data-slot`, found by a pre-order walk of the template tree, in document order. */
function collectExplicitTemplateSlots(nodeId: string, templateDoc: ScreenDocument, out: { nodeId: string; name: string }[]): void {
  const node = templateDoc.nodes[nodeId];
  if (!node || node.kind === "text") return;
  const name = node.attributes["data-slot"];
  if (name !== undefined) out.push({ nodeId, name });
  for (const childId of node.childIds) collectExplicitTemplateSlots(childId, templateDoc, out);
}

/**
 * Named slots carrying a look of their own, in document order — the input to
 * `write_html`'s slot-styling warning. Explicit `data-slot` elements only.
 *
 * Implicit positional slots (the root's own children) lose their styling in
 * exactly the same way, but they are excluded on purpose: the established
 * fix for a styled slot is to wrap it, and those wrappers usually sit
 * directly under the root. Warning there would flag the remedy itself on
 * nearly every component. The trade-off is real and named in the guide —
 * a root-level wrapper is only safe while instances name their slots.
 */
export function slotsWithDiscardedStyling(templateDoc: ScreenDocument): { nodeId: string; name: string }[] {
  const slots: { nodeId: string; name: string }[] = [];
  collectExplicitTemplateSlots(templateDoc.rootNodeId, templateDoc, slots);
  return slots.filter((slot) => {
    const node = templateDoc.nodes[slot.nodeId];
    return node !== undefined && carriesOwnLook(node);
  });
}

/**
 * Every substitutable placeholder in a component template: nodes carrying
 * an explicit `data-slot` (found at any depth — hand-authored components
 * can nest a named slot anywhere), plus the template ROOT's own direct
 * children that don't carry one, treated as implicit positional slots
 * "slot-0", "slot-1", … in document order — the same fallback
 * `collectSlotOverrides` (parser.ts) and `convertToComponentInstance`
 * (node-convert.ts) already apply on the *instance* side when a screen's
 * children carry no explicit `data-slot`. Without this, a promoted node's
 * own default content — which can never carry a literal `data-slot` on a
 * bare text child, since text nodes have no attributes — would have zero
 * substitutable slots, and every instance would render the template's own
 * original content verbatim regardless of what it actually authored.
 */
function collectTemplateSlots(templateDoc: ScreenDocument): { nodeId: string; name: string }[] {
  const explicit: { nodeId: string; name: string }[] = [];
  collectExplicitTemplateSlots(templateDoc.rootNodeId, templateDoc, explicit);
  const explicitIds = new Set(explicit.map((s) => s.nodeId));

  const positional: { nodeId: string; name: string }[] = [];
  const root = templateDoc.nodes[templateDoc.rootNodeId];
  if (root) {
    root.childIds.forEach((childId, i) => {
      if (!explicitIds.has(childId)) positional.push({ nodeId: childId, name: `slot-${i}` });
    });
  }

  return [...explicit, ...positional];
}

/**
 * Matches an instance's `slotOverrides` onto the template's `data-slot`
 * placeholders. `slotOverrides` keys are positional ("slot-0", "slot-1", …)
 * whenever the screen's own markup didn't name its slots explicitly — which
 * is the normal case (Schema-Spec's parser only assigns a name when the
 * screen author wrote `data-slot="..."` themselves). Matching by literal
 * key equality alone would silently drop the screen's real content and
 * fall back to the template's placeholder defaults every time. Instead:
 * exact name matches win first, then whatever's left on both sides is
 * zipped together in document order.
 */
function resolveSlotSubstitutions(templateDoc: ScreenDocument, instance: Pick<NodeSubtree, "slotOverrides">): Map<string, NodeSubtree> {
  const templateSlots = collectTemplateSlots(templateDoc);
  const overrideEntries = Object.entries(instance.slotOverrides ?? {});

  const substitutions = new Map<string, NodeSubtree>();
  const usedSlotIds = new Set<string>();
  const usedOverrideKeys = new Set<string>();

  for (const slot of templateSlots) {
    const match = overrideEntries.find(([key]) => key === slot.name && !usedOverrideKeys.has(key));
    if (match) {
      substitutions.set(slot.nodeId, match[1]);
      usedSlotIds.add(slot.nodeId);
      usedOverrideKeys.add(match[0]);
    }
  }

  const remainingSlots = templateSlots.filter((s) => !usedSlotIds.has(s.nodeId));
  const remainingOverrides = overrideEntries.filter(([key]) => !usedOverrideKeys.has(key));
  for (let i = 0; i < Math.min(remainingSlots.length, remainingOverrides.length); i++) {
    substitutions.set(remainingSlots[i]!.nodeId, remainingOverrides[i]![1]);
  }

  return substitutions;
}

/**
 * Expands a `component_instance` node into its active variant's markup.
 * Descendant template elements get namespaced ids (`<rootId>--<templateNodeId>`)
 * so multiple instances of the same component on one screen never collide;
 * the expanded root itself gets `rootId` (comments/flows anchor there).
 *
 * `rootId` is the id the caller has already namespaced for this expansion —
 * the instance's own id at the top level, or `<outerRootId>--<node.id>` when
 * this instance is itself nested inside another component's template
 * (`renderTemplateNode` below). It is *not* always `instance.id`: for a
 * nested instance, `instance.id` is only the template-local id from the
 * component's own source file, which collides across sibling expansions of
 * the same component if used directly.
 *
 * `origin.path` is the set of component names being expanded where this
 * instance was authored — a component (directly or transitively)
 * instantiating itself would otherwise recurse until the stack overflows.
 * On re-entry, a marker element is rendered instead of recursing further.
 * See `Origin` for why a slot fill carries its author's path, not the
 * template's.
 */
/** Attribute values that accumulate across a merge instead of one replacing the other, and the separator each accumulates with. */
const MERGED_ATTRS = new Map([
  ["style", "; "],
  ["class", " "],
  ["data-unresolved-token", ","],
]);

/**
 * Merges the attributes authored on an instance element onto the component's
 * expanded root. Without this they are dropped: `renderTemplateNode` renders
 * the definition's own look and nothing the screen wrote around it — so
 * `<a class="$footer-link" href="/imprint">` renders as a link to nowhere.
 *
 * Precedence: the instance wins over the definition, being the more specific
 * of the two. `style`, `class` and `data-unresolved-token` accumulate rather
 * than replace, because the definition's look is the base an instance adjusts
 * rather than discards; the instance's style declarations come last, which is
 * what makes them win in the inline cascade.
 *
 * `data-variant` and the flow attributes are deliberately not merged, and the
 * caller passes no flow when building the instance's attributes: the variant
 * the instance names is already resolved into *which* template got expanded,
 * and the flow is already applied to the root by `renderTemplateNode`. Taking
 * either again would emit the attribute twice.
 *
 * The instance's *tag* is still discarded — the definition's root tag wins, as
 * it always has. Which tag a component renders as is the definition's call,
 * not the screen's.
 */
function mergeInstanceAttrs(templateAttrs: [string, string][], instanceAttrs: [string, string][]): [string, string][] {
  const merged: [string, string][] = templateAttrs.map(([key, value]): [string, string] => [key, value]);
  const indexOf = new Map<string, number>(merged.map(([key], i): [string, number] => [key, i]));

  for (const [key, value] of instanceAttrs) {
    if (key === "data-variant" || key === "data-flow-target" || key === "data-flow-trigger") continue;

    const existing = indexOf.get(key);
    if (existing === undefined) {
      indexOf.set(key, merged.length);
      merged.push([key, value]);
      continue;
    }

    const entry = merged[existing];
    if (entry === undefined) continue;

    const separator = MERGED_ATTRS.get(key);
    if (separator === undefined) {
      entry[1] = value;
      continue;
    }

    const parts = [...entry[1].split(separator), ...value.split(separator)].map((part) => part.trim()).filter(Boolean);
    entry[1] = [...new Set(parts)].join(separator);
  }

  return merged;
}

function renderComponentInstance(
  instance: InstanceSource,
  ctx: RenderContext,
  flow: Flow | undefined,
  origin: Origin,
  rootId: string,
): string {
  const componentName = instance.refs.component ?? "";

  if (origin.path.has(componentName)) {
    return `<div id="${escapeAttr(rootId)}" data-recursive-component="${escapeAttr(componentName)}"></div>`;
  }

  const def = ctx.componentDefs.get(componentName);
  if (!def) {
    return `<div id="${escapeAttr(rootId)}" data-unresolved-component="${escapeAttr(componentName)}"></div>`;
  }

  const variantName = instance.refs.variant ?? def.defaultVariant;
  const variant = def.variants.find((v) => v.name === variantName) ?? def.variants[0];
  if (!variant) {
    return `<div id="${escapeAttr(rootId)}" data-empty-component="${escapeAttr(def.name)}"></div>`;
  }

  const { doc: templateDoc, errors } = parseScreen(variant.htmlAug, "__component__", ctx.registry);
  // Only a structurally-broken template (unparseable markup, or not exactly
  // one root element) fails the whole component. Everything else the
  // parser reports (unresolved_ref, ambiguous_class_ref, duplicate ids, a
  // malformed style value, …) still yields a usable tree — the same way an
  // unresolved token ref degrades to a `/* unresolved: $path */` comment at
  // screen level rather than blocking the whole render.
  if (errors.some((e) => e.code === "malformed_html")) {
    return `<div id="${escapeAttr(rootId)}" data-invalid-component="${escapeAttr(def.name)}"></div>`;
  }

  const substitutions = resolveSlotSubstitutions(templateDoc, instance);
  const nextPath = new Set(origin.path);
  nextPath.add(componentName);
  // No flow here: `renderTemplateNode` already applies it to the expanded
  // root, and `mergeInstanceAttrs` would otherwise emit it a second time.
  const instanceAttrs = buildAttrs(instance, ctx.tokens, undefined, ctx.iconFontAvailable);
  // The slot fills were authored where the instance sits, not inside the
  // template they are substituted into — so they render under `origin`, the
  // instance's own authoring context, while the template renders under the
  // extended path. Id-less instances among them get ids under this root.
  const fillIds: FillIds = { base: rootId, count: 0 };
  return renderTemplateNode(templateDoc.rootNodeId, templateDoc, ctx, rootId, variantName, flow, substitutions, nextPath, instanceAttrs, origin, fillIds);
}

function renderTemplateNode(
  nodeId: string,
  templateDoc: ScreenDocument,
  ctx: RenderContext,
  rootId: string,
  variantName: string,
  flow: Flow | undefined,
  substitutions: Map<string, NodeSubtree>,
  expansionPath: ReadonlySet<string>,
  instanceAttrs: [string, string][],
  fillOrigin: Origin,
  fillIds: FillIds,
): string {
  const node = templateDoc.nodes[nodeId];
  if (!node) return "";

  // A slotted placeholder is *replaced* by the override's own content, not
  // wrapped inside the placeholder's tag — the override subtree already
  // carries its own tag/attributes (as authored in the screen), so
  // rendering it as this node's children would nest it inside the
  // template's marker element instead (e.g. <span><h3>...</h3></span>).
  // Checked before the text-node case below: a template's own top-level
  // text child can itself be an (implicit, positional) slot — text nodes
  // have no attributes to carry a data-slot marker, so this is the only
  // way a promoted <button>Click me</button>'s text is ever substitutable.
  const override = substitutions.get(nodeId);
  if (override !== undefined) return renderSubtree(override, ctx, fillOrigin, fillIds);

  if (node.kind === "text") return escapeText(node.text ?? "");

  const isRoot = nodeId === templateDoc.rootNodeId;
  const renderedId = isRoot ? rootId : `${rootId}--${node.id}`;

  // Components composing other components: render exactly like a top-level
  // instance, but namespaced under `renderedId` — the same namespacing this
  // node would get as a plain element (below) — so a nested instance root
  // never collides with a sibling expansion of the same component.
  // Its own slot fills were written in this template, so they carry this
  // expansion's path (the cycle guard) and live in its id namespace.
  if (node.kind === "component_instance") {
    return renderComponentInstance(node, ctx, undefined, { path: expansionPath, idPrefix: rootId }, renderedId);
  }

  const tag = node.tag ?? "div";

  const templateAttrs = buildAttrs(node, ctx.tokens, isRoot ? flow : undefined, ctx.iconFontAvailable);
  const attrs: [string, string][] = [
    ["id", renderedId],
    ...(isRoot ? mergeInstanceAttrs(templateAttrs, instanceAttrs) : templateAttrs),
  ];
  // buildAttrs already emitted data-variant if the template's own root
  // happens to declare one — only add the selected variant's name if it didn't.
  if (isRoot && !node.refs.variant) attrs.push(["data-variant", variantName]);
  const attrStr = attrsToString(attrs);
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrStr ? ` ${attrStr}` : ""}>`;

  const inner = node.childIds
    .map((childId) =>
      renderTemplateNode(childId, templateDoc, ctx, rootId, variantName, flow, substitutions, expansionPath, instanceAttrs, fillOrigin, fillIds),
    )
    .join("");

  return `<${tag}${attrStr ? ` ${attrStr}` : ""}>${inner}</${tag}>`;
}

export function renderScreen(doc: ScreenDocument, ctx: RenderContext): string {
  const flowsByTrigger = new Map(doc.flows.map((flow) => [flow.triggerNodeId, flow]));
  return renderNode(doc.rootNodeId, doc, ctx, flowsByTrigger);
}
