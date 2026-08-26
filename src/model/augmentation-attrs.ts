/**
 * The full set of `data-*` (plus `id`) attributes the augmentation grammar
 * recognizes. Used to flag a likely-misspelled augmentation attribute
 * without touching ordinary `data-*` attributes an agent adds for
 * its own purposes (e.g. `data-testid`) — those must pass through silently.
 */
export const KNOWN_AUGMENTATION_ATTRS: readonly string[] = [
  "data-slot",
  "data-variant",
  "data-flow-target",
  "data-flow-trigger",
  "data-section",
  "data-title",
  "data-node-id",
  "data-component",
  "data-component-id",
];

const SUSPICIOUS_DISTANCE_THRESHOLD = 2;

/** Classic Levenshtein edit distance — no dependency, small inputs only. */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

/**
 * Returns the known augmentation attribute `name` most likely meant to be,
 * or `undefined` when `name` isn't a `data-*` attribute, is already known,
 * or is too far (edit distance > 2) from every known attribute to be a
 * plausible typo — e.g. an agent's own `data-testid` never matches.
 */
export function findSuspiciousAttr(name: string): string | undefined {
  if (!name.startsWith("data-") || KNOWN_AUGMENTATION_ATTRS.includes(name)) return undefined;

  let best: string | undefined;
  let bestDistance = Infinity;
  for (const known of KNOWN_AUGMENTATION_ATTRS) {
    const distance = levenshtein(name, known);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = known;
    }
  }
  return bestDistance <= SUSPICIOUS_DISTANCE_THRESHOLD ? best : undefined;
}
