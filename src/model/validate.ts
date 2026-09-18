import type { TokensDocument } from "../store/index.js";
import type { ScreenDocument, ValidationWarning } from "./types.js";

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/**
 * Normalizes a value for drift comparison: hex colors compare
 * case-insensitively (`#3366FF` and `#3366ff` are the same color to every
 * consumer of CSS), everything else compares as an exact trimmed string —
 * spacing/typography/etc. values are free-form and it isn't safe to guess
 * an equivalence rule for them.
 */
function normalizeForComparison(value: string): string {
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

      const parts = splitShorthandParts(value);
      const resolved = parts.map((part) => resolvePart(part, affinityBuckets, byNormalizedValue));
      if (!resolved.some((r) => r.path)) continue; // no part matched any candidate bucket

      const suggestion = resolved.map((r) => (r.path ? `$${r.path}` : r.text)).join(" ");
      // Multi-part shorthands (`padding: 14px 20px`) always say "tokens",
      // even when only one part matched — the suggestion is still a
      // multi-value string, not a single `$path`.
      const noun = parts.length > 1 ? "tokens" : "token";

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
