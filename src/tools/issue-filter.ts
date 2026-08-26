import type { ValidationErrorCode, ValidationIssue } from "../model/index.js";
import type { Warning } from "./types.js";

/**
 * Parser issue codes that degrade to a write warning instead of blocking the
 * write. `unresolved_ref` was the original case (writes.ts,
 * patch.ts) — a ref can go stale for reasons unrelated to this specific
 * edit. `suspicious_attr` joins it: a likely-misspelled augmentation
 * attribute is a render-breaking mistake worth surfacing, but the data is
 * still valid HTML and shouldn't block the round-trip. Every other issue
 * code still blocks.
 */
export const NONBLOCKING: ReadonlySet<ValidationErrorCode> = new Set(["unresolved_ref", "suspicious_attr"]);

export function isBlockingIssue(issue: ValidationIssue): boolean {
  return !NONBLOCKING.has(issue.code);
}

/** Maps a non-blocking parser issue onto its write-response `Warning` shape. */
export function issueToWarning(issue: ValidationIssue, target: string): Warning {
  return {
    kind: issue.code === "suspicious_attr" ? "suspicious_attr" : "unknown_ref",
    target,
    message: issue.message,
  };
}
