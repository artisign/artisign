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

/**
 * Maps a CSS property to the token bucket an equal-value match should be
 * attributed to, so `font-size: 16px` never suggests `$spacing.md` just
 * because both happen to be "16px". A property with no bucket affinity here
 * — including positioning offsets (top/left/right/bottom/inset), which are
 * layout coordinates, not spacing tokens, and coincide with spacing values
 * far too often to suggest one — is never matched at all: conservative
 * silence beats a wrong cross-bucket suggestion.
 */
function bucketForProperty(prop: string): string | undefined {
  const p = prop.toLowerCase();
  if (p === "color" || p.includes("color") || p.startsWith("background")) return "color";
  if (["padding", "margin", "gap"].some((k) => p === k || p.startsWith(`${k}-`))) return "spacing";
  if (p.startsWith("font") || p === "line-height" || p === "letter-spacing" || p === "word-spacing") return "typography";
  if (p.includes("radius")) return "radius";
  if (p.includes("shadow")) return "shadow";
  if (p.startsWith("transition") || p.startsWith("animation")) return "motion";
  return undefined;
}

type TokenCandidate = { bucket: string; member: string; value: string };

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
      const candidates = byNormalizedValue.get(normalizeForComparison(value));
      if (!candidates || candidates.length === 0) continue;

      const affinity = bucketForProperty(prop);
      if (!affinity) continue; // no bucket affinity — conservative, never cross-suggest
      const pool = candidates.filter((c) => c.bucket === affinity);
      if (pool.length === 0) continue; // no same-bucket candidate — don't cross-suggest

      // Deterministic pick among ties: an exact (pre-normalization) string
      // match wins over one that only matches after case-folding, then
      // lexicographic path order breaks whatever's left — never "whichever
      // token happened to be inserted last".
      const exact = pool.filter((c) => c.value === value);
      const ranked = [...(exact.length > 0 ? exact : pool)].sort((a, b) =>
        `${a.bucket}.${a.member}`.localeCompare(`${b.bucket}.${b.member}`),
      );
      const path = `${ranked[0]!.bucket}.${ranked[0]!.member}`;

      warnings.push({
        kind: "drift",
        message: `inline value "${value}" for "${prop}" matches token $${path}`,
        nodeId: node.id,
        suggestion: `$${path}`,
      });
    }
  }
  return warnings;
}
