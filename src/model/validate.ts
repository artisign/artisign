import type { TokensDocument } from "../store/index.js";
import type { Node, NodeKind, NodeRefs, ScreenDocument, ScreenId, ValidationWarning } from "./types.js";
import { serializeTokenRef } from "./serializer.js";

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/**
 * Normalizes a value for drift comparison: hex colors compare
 * case-insensitively (`#3366FF` and `#3366ff` are the same color to every
 * consumer of CSS), everything else compares as an exact trimmed string —
 * spacing/typography/etc. values are free-form and it isn't safe to guess
 * an equivalence rule for them. Exported for `normalizedStyleFingerprint`
 * (CHR-635), which reuses the same equivalence rule per-property.
 */
export function normalizeForComparison(value: string): string {
  const trimmed = value.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

const SIZE_PROPS = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height"]);

/**
 * Maps a CSS property to the ORDERED list of token buckets an equal-value
 * match may be attributed to, so `font-size: 16px` never suggests
 * `$spacing.md` just because both happen to be "16px". Bucket names are
 * free-form per project, so a property can name more than one candidate
 * (`letter-spacing` → `tracking` if the project has one, else `typography`)
 * — the first bucket that exists in the project *and* holds a matching
 * value wins. A property with no candidates here — including positioning
 * offsets (top/left/right/bottom/inset), which are layout coordinates, not
 * spacing tokens, and coincide with spacing values far too often to suggest
 * one — is never matched at all: conservative silence beats a wrong
 * cross-bucket suggestion.
 */
function bucketsForProperty(prop: string): string[] {
  const p = prop.toLowerCase();
  if (p === "color" || p.includes("color") || p.startsWith("background")) return ["color"];
  if (["padding", "margin", "gap"].some((k) => p === k || p.startsWith(`${k}-`))) return ["spacing"];
  if (p === "letter-spacing") return ["tracking", "typography"];
  if (p.startsWith("font") || p === "line-height" || p === "word-spacing") return ["typography"];
  if (SIZE_PROPS.has(p)) return ["size"];
  if (p.includes("radius")) return ["radius"];
  if (p.includes("shadow")) return ["shadow"];
  if (p.startsWith("transition") || p.startsWith("animation")) return ["motion"];
  return [];
}

/**
 * Splits a shorthand value (`padding: 14px 20px`) into its space-separated
 * parts so each can be matched against a token independently. A part never
 * splits inside a function call (`calc(1px + 2px)`, `rgb(0, 0, 0)`) or a
 * quoted string — parens/quote depth is tracked and whitespace inside them
 * is left alone. A top-level comma means the value is a list (multiple
 * `box-shadow`s, a `font-family` fallback chain, ...), not an independent-
 * token shorthand, so the whole value is kept as one atomic part rather
 * than guessing where a "part" begins inside a comma-separated group.
 */
function splitShorthandParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (depth === 0 && ch === ",") return [value];
    if (depth === 0 && /\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [value];
}

type TokenCandidate = { bucket: string; member: string; value: string };
type PartMatch = { text: string; path?: string };

/**
 * Resolves one shorthand part against the property's ordered candidate
 * buckets — same tie-break as a whole-value match: an exact (pre-
 * normalization) string match wins over a case-insensitive-only match,
 * then lexicographic path order breaks the rest.
 */
function resolvePart(
  part: string,
  affinityBuckets: string[],
  byNormalizedValue: Map<string, TokenCandidate[]>,
): PartMatch {
  const candidates = byNormalizedValue.get(normalizeForComparison(part));
  if (candidates) {
    for (const bucket of affinityBuckets) {
      const pool = candidates.filter((c) => c.bucket === bucket);
      if (pool.length === 0) continue;
      const exact = pool.filter((c) => c.value === part);
      const ranked = [...(exact.length > 0 ? exact : pool)].sort((a, b) =>
        `${a.bucket}.${a.member}`.localeCompare(`${b.bucket}.${b.member}`),
      );
      return { text: part, path: `${ranked[0]!.bucket}.${ranked[0]!.member}` };
    }
  }
  return { text: part };
}

/**
 * Flags inline style values that happen to equal an existing token's value —
 * a drift signal (the agent could have used `$<path>` instead). Only
 * plain string token values are compared; this covers every bucket whose
 * values are simple CSS-value strings (color, spacing, typography, radius,
 * shadow, motion) without needing a bucket-specific value model.
 */
export function computeDriftWarnings(doc: ScreenDocument, tokens: TokensDocument): ValidationWarning[] {
  const byNormalizedValue = new Map<string, TokenCandidate[]>();
  for (const [bucket, members] of Object.entries(tokens)) {
    for (const [member, value] of Object.entries(members)) {
      if (typeof value !== "string") continue;
      const key = normalizeForComparison(value);
      const list = byNormalizedValue.get(key) ?? [];
      list.push({ bucket, member, value });
      byNormalizedValue.set(key, list);
    }
  }

  const warnings: ValidationWarning[] = [];
  for (const node of Object.values(doc.nodes)) {
    for (const [prop, value] of Object.entries(node.inlineStyles)) {
      const affinityBuckets = bucketsForProperty(prop);
      if (affinityBuckets.length === 0) continue; // no bucket affinity — conservative, never cross-suggest

      // The whole value first: a token may itself hold a multi-part value
      // (every shadow, `motion.fast: "0.2s ease"`, `spacing.gutter: "8px 16px"`),
      // and that exact token beats any per-part replacement. Parts are only
      // the fallback.
      const whole = resolvePart(value.trim(), affinityBuckets, byNormalizedValue);
      const resolved = whole.path
        ? [whole]
        : splitShorthandParts(value).map((part) => resolvePart(part, affinityBuckets, byNormalizedValue));
      if (!resolved.some((r) => r.path)) continue; // neither the value nor any part matched a candidate bucket

      const suggestion = resolved.map((r) => (r.path ? `$${r.path}` : r.text)).join(" ");
      // Multi-part shorthands (`padding: 14px 20px`) always say "tokens",
      // even when only one part matched — the suggestion is still a
      // multi-value string, not a single `$path`.
      const noun = resolved.length > 1 ? "tokens" : "token";

      warnings.push({
        kind: "drift",
        message: `inline value "${value}" for "${prop}" matches ${noun} ${suggestion}`,
        nodeId: node.id,
        suggestion,
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// CHR-635 — repeated_pattern warning. Shared with CHR-637's reuse metric
// (component_coverage/token_coverage): both are built on the same "is this
// an ad-hoc, visually styled element?" predicate, so it — and the
// layout-only gate it's built on — lives here rather than duplicated per
// ticket.
// ---------------------------------------------------------------------------

/**
 * A hand-built element styled with nothing but layout — positioning and
 * spacing, never anything visual — is scaffolding, not a design decision:
 * it's excluded from both `repeated_pattern` (below) and CHR-637's
 * component_coverage, so a hundred structurally-identical `<div
 * style="display:flex; padding:16px">` wrappers never register as
 * duplicated/hand-built "design", the way a hundred identical
 * `background:...` blocks would. Calibrated against a real project's
 * reference figures (CHR-633 review) — `margin` stays excluded (a margin
 * value is exactly the kind of decision this gate should not wave through
 * as "just layout"), and `size` is deliberately NOT in this base set
 * (CHR-637 needs it excluded to match its own reference numbers). `inset`
 * and its logical variants *are* here, alongside top/right/bottom/left —
 * they're positioning offsets, not a size property; the original CHR-633
 * pass had grouped `inset` in with `size` and dropped both together as an
 * unverified sweep, which was simply wrong about what `inset` is (CHR-635
 * review).
 */
export const LAYOUT_ONLY_PROPERTIES: ReadonlySet<string> = new Set([
  "display",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-content",
  "align-self",
  "justify-content",
  "justify-items",
  "justify-self",
  "order",
  "gap",
  "row-gap",
  "column-gap",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "inset-block",
  "inset-block-start",
  "inset-block-end",
  "inset-inline",
  "inset-inline-start",
  "inset-inline-end",
]);

/**
 * `repeated_pattern`-only addition to the layout-only set above (CTO
 * decision, CHR-633 review): a fixed-size ad-hoc spacer/wrapper (`<div
 * style="height: 16px">`) repeated across screens is exactly the kind of
 * warning an agent can't act on — there's no component to name and nothing
 * to promote a bare height to. CHR-637's coverage metric deliberately does
 * NOT get this treatment (its own reference figures depend on treating
 * `height`/`width` as real, countable design decisions) — kept as a private
 * addition consulted only by `isRepeatedPatternCandidate` below, not a
 * general "layout, take 2" set anything else can opt into.
 */
const REPEATED_PATTERN_SIZE_PROPERTIES: ReadonlySet<string> = new Set([
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "box-sizing",
]);

/** True iff `inlineStyles` is empty or every property in it is layout-only (case-insensitive) — `extraProperties`, when given, extends the layout-only set for this one call. */
export function isLayoutOnlyStyle(inlineStyles: Record<string, string>, extraProperties?: ReadonlySet<string>): boolean {
  const props = Object.keys(inlineStyles);
  if (props.length === 0) return true;
  return props.every((p) => {
    const key = p.toLowerCase();
    return LAYOUT_ONLY_PROPERTIES.has(key) || (extraProperties?.has(key) ?? false);
  });
}

type StyleableNode = { kind: NodeKind; refs: NodeRefs; inlineStyles: Record<string, string> };

/**
 * An element (or `svg`/`svg_path`) carrying no component ref, styled with
 * at least one non-layout property — a candidate for CHR-637's
 * `component_coverage`. `kind === "component_instance"` always implies
 * `refs.component` is set (parser invariant); both checks are kept anyway
 * since they're free, and the `kind` check alone also correctly excludes
 * text nodes. Works on a live `Node` or a slot-fill `NodeSubtree` — both
 * carry the same three fields — so a caller walking `slotOverrides` content
 * (screen-supplied markup inside a component instance, which never appears
 * in `doc.nodes` at all) can apply the same predicate to it. `inlineStyles`
 * only — CHR-637's own reference figures were calibrated against literal
 * values alone; `repeated_pattern`'s own candidate gate (below) needs a
 * stricter, differently-scoped rule and does not reuse this one directly.
 */
export function isVisuallyStyledAdHocNode(node: StyleableNode, extraLayoutProperties?: ReadonlySet<string>): boolean {
  return (
    (node.kind === "element" || node.kind === "svg" || node.kind === "svg_path") &&
    node.refs.component === undefined &&
    !isLayoutOnlyStyle(node.inlineStyles, extraLayoutProperties)
  );
}

/**
 * Every CSS declaration a node actually carries — literal values from
 * `inlineStyles` *and* token-ref values from `refs.tokens`, rendered back to
 * their as-authored text via `serializeTokenRef` (the same canonical
 * rendering the serializer uses to write `style="..."` to disk). Without
 * this, a property holding a `$ref` (or a `$ref` mixed with literal text)
 * is invisible to `repeated_pattern` entirely — it lives in `refs.tokens`,
 * never `inlineStyles` — so an element whose only *visual* declaration is a
 * token ref (`background: alpha($color.inverse-surface, 0.32)`) would
 * fingerprint as if that declaration didn't exist at all (CHR-635 review,
 * found via a real project's scrim elements, which are exactly this shape).
 * `"class"` is a component/token-class ref, never a style declaration, and
 * is excluded the same way the serializer excludes it from `style="..."`;
 * `fill`/`stroke` are excluded on an `svg`/`svg_path` node for the same
 * reason — the serializer emits those as presentation attributes there, not
 * CSS. `inlineStyles` wins on a property both dicts could theoretically
 * name (never happens in practice — the parser keeps a property in exactly
 * one of the two, never both).
 */
function styleDeclarations(node: StyleableNode): Record<string, string> {
  const isSvgDomain = node.kind === "svg" || node.kind === "svg_path";
  const decls: Record<string, string> = {};
  for (const [prop, ref] of Object.entries(node.refs.tokens)) {
    if (prop === "class") continue;
    if (isSvgDomain && (prop === "fill" || prop === "stroke")) continue;
    decls[prop] = serializeTokenRef(ref);
  }
  for (const [prop, value] of Object.entries(node.inlineStyles)) {
    decls[prop] = value;
  }
  return decls;
}

/**
 * A candidate for `repeated_pattern` specifically: an element (or
 * `svg`/`svg_path`) carrying no component ref, with at least TWO non-layout
 * declarations — literal or token-ref, per `styleDeclarations` above, size
 * counted as layout (`REPEATED_PATTERN_SIZE_PROPERTIES`). The two-
 * declaration floor (CHR-635 review, raised from CHR-637's shared ≥1) is
 * `repeated_pattern`-only: a single incidental declaration
 * (`text-transform: uppercase` alone, `font-weight: 500` alone) is not a
 * promotable block — on a real, dense project it matched *dozens* of
 * screens purely by coincidence and produced warnings with nothing an
 * agent could act on. `computeRepeatedPatternWarnings`,
 * `tools/style-index.ts`'s occurrence-index builder, and `writes.ts`'s
 * cheap pre-check all share this one function, so the three can never
 * drift out of sync on what counts as a candidate.
 */
export function isRepeatedPatternCandidate(node: StyleableNode): boolean {
  if (!(node.kind === "element" || node.kind === "svg" || node.kind === "svg_path")) return false;
  if (node.refs.component !== undefined) return false;
  const decls = styleDeclarations(node);
  let nonLayoutCount = 0;
  for (const prop of Object.keys(decls)) {
    const key = prop.toLowerCase();
    if (LAYOUT_ONLY_PROPERTIES.has(key) || REPEATED_PATTERN_SIZE_PROPERTIES.has(key)) continue;
    nonLayoutCount += 1;
    if (nonLayoutCount >= 2) return true;
  }
  return false;
}

/**
 * A stable fingerprint for style-equality comparison: sort properties, then
 * normalize each value with the same rule `computeDriftWarnings` uses
 * (`normalizeForComparison` — case-insensitive hex, exact otherwise), and
 * join as `prop:value` pairs with `;`. Operates on the *full* declaration
 * set passed in — layout properties included, never filtered here — the
 * layout-only gate is a caller-side *skip this node entirely* decision
 * (`isVisuallyStyledAdHocNode`/`isRepeatedPatternCandidate`), not a filter
 * inside the fingerprint: two elements matching on every visual property but
 * differing only in, say, `padding` are legitimately different patterns, not
 * the same one with noise removed.
 */
export function normalizedStyleFingerprint(declarations: Record<string, string>): string {
  return Object.keys(declarations)
    .sort()
    .map((prop) => `${prop}:${normalizeForComparison(declarations[prop]!)}`)
    .join(";");
}

/** `normalizedStyleFingerprint(styleDeclarations(node))` — the one function every `repeated_pattern` caller (this file's own `computeRepeatedPatternWarnings`, `tools/style-index.ts`) uses so a node's fingerprint always reflects its whole declared style, never `inlineStyles` alone. */
export function repeatedPatternFingerprint(node: StyleableNode): string {
  return normalizedStyleFingerprint(styleDeclarations(node));
}

/**
 * Project-wide occurrence data `computeRepeatedPatternWarnings` matches a
 * write's own candidate nodes against — built fresh per write by
 * `tools/style-index.ts`'s `buildStyleOccurrenceIndex`, never cached (no
 * `.artisign/index.json` involvement; see that module's doc comment for
 * the cost numbers behind that choice).
 */
export type StyleOccurrenceIndex = {
  /** Fingerprint -> every screen holding a matching ad-hoc node (`doc.nodes` or slot-fill content), current screen included. */
  byScreen: Map<string, Set<ScreenId>>;
  /** Fingerprint -> the (first, deterministically) component whose default-variant root carries a matching style. */
  byComponent: Map<string, string>;
};

/** Depth-first document-order traversal from the screen root, following `childIds` (already parse-order) — the same shape `tools/reads.ts`'s `nodesInDocumentOrder` uses, reimplemented here rather than imported (that one's module-private, and a plain object's key order isn't a safe enough guarantee to rely on for "first in document order" without walking the tree explicitly). */
function nodesInDocumentOrder(doc: ScreenDocument): Node[] {
  const result: Node[] = [];
  const visit = (id: string): void => {
    const node = doc.nodes[id];
    if (!node) return;
    result.push(node);
    for (const childId of node.childIds) visit(childId);
  };
  visit(doc.rootNodeId);
  return result;
}

/**
 * Flags every distinct repeated style pattern in `doc` whose normalized
 * declaration set already occurs on `minOtherScreens` (default 1 — "this
 * write is the second occurrence project-wide") other screens, or matches a
 * component's default-variant root — the programmatic form of the agent
 * guide's "the moment a value or element pattern appears a second time,
 * promote it" rule.
 *
 * Grouped by fingerprint, ONE warning per distinct pattern (CHR-635
 * review): several qualifying nodes in `doc` sharing the same fingerprint
 * produce a single warning targeted at the first of them in document order,
 * with the in-scope node count folded into the message when more than one.
 * Sorted by other-screen occurrence count descending (ties keep document
 * order, `Array.prototype.sort` is stable) — capping to a response budget
 * is the caller's job (`writes.ts`), but the order it caps *from* is
 * decided here, once, rather than re-derived per caller.
 *
 * `scopeNodeIds`, when given, restricts which nodes may contribute to a
 * group AND requires a group to have at least one member inside it to be
 * returned at all — `patch_html`'s scoping mechanism. This can't be a
 * simple post-hoc `warnings.filter(w => affected.has(w.target))` the way
 * `drift`'s scoping is (`writes.ts`'s `scopedDriftWarnings`): once
 * `repeated_pattern` groups several nodes under one target, filtering by
 * that single target after the fact would silently drop the whole warning
 * whenever the *representative* node happens to sit outside the scope even
 * though another group member — the one this call actually touched — sits
 * inside it. Passing the scope in up front, so the representative and the
 * reported node count are picked from the scoped subset itself, is what
 * keeps that case correct.
 *
 * Deliberately `doc.nodes` only, never slot-fill content, regardless of
 * scope: a warning's `target` has to be a node ref an agent can act on
 * (patch it, or `promote_to_system` it), and a slot fill has no node ref of
 * its own (CHR-584) — nothing here invents one. Fill content elsewhere in
 * the project still counts toward `index.byScreen` (built by
 * `buildStyleOccurrenceIndex`, which does walk fills) as an *occurrence*,
 * just never as something this function warns *on*.
 */
export function computeRepeatedPatternWarnings(
  doc: ScreenDocument,
  screenId: ScreenId,
  index: StyleOccurrenceIndex,
  options?: { minOtherScreens?: number; scopeNodeIds?: ReadonlySet<string> },
): ValidationWarning[] {
  const minOtherScreens = options?.minOtherScreens ?? 1;
  const scopeNodeIds = options?.scopeNodeIds;

  const groups = new Map<string, string[]>();
  for (const node of nodesInDocumentOrder(doc)) {
    if (!isRepeatedPatternCandidate(node)) continue;
    const fingerprint = repeatedPatternFingerprint(node);
    const occurrences = index.byScreen.get(fingerprint);
    const otherScreens = occurrences ? [...occurrences].filter((s) => s !== screenId) : [];
    if (otherScreens.length < minOtherScreens) continue;
    const nodeIds = groups.get(fingerprint) ?? [];
    nodeIds.push(node.id);
    groups.set(fingerprint, nodeIds);
  }

  const entries: { fingerprint: string; nodeIds: string[]; otherScreens: string[] }[] = [];
  for (const [fingerprint, nodeIds] of groups) {
    const scopedNodeIds = scopeNodeIds ? nodeIds.filter((id) => scopeNodeIds.has(id)) : nodeIds;
    if (scopedNodeIds.length === 0) continue; // scoped call, and this call never touched any member of the group
    const otherScreens = [...(index.byScreen.get(fingerprint) ?? new Set<string>())].filter((s) => s !== screenId);
    entries.push({ fingerprint, nodeIds: scopedNodeIds, otherScreens });
  }
  entries.sort((a, b) => b.otherScreens.length - a.otherScreens.length);

  return entries.map(({ fingerprint, nodeIds, otherScreens }) => {
    const exampleScreens = [...otherScreens].sort().slice(0, 3);
    const componentName = index.byComponent.get(fingerprint);
    const noun = otherScreens.length === 1 ? "screen" : "screens";
    const countSuffix = nodeIds.length > 1 ? ` (${nodeIds.length} nodes here)` : "";

    return {
      kind: "repeated_pattern",
      nodeId: nodeIds[0],
      message: `inline style repeated on ${otherScreens.length} other ${noun} (${exampleScreens.join(", ")}): "${fingerprint}"${countSuffix}`,
      suggestion: componentName ? `$${componentName}` : "promote_to_system",
    };
  });
}
