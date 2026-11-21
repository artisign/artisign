import type { Warning } from "../tools/types.js";
import type { UseCase } from "./schema.js";

const LISTS = ["steps", "branches", "variants"] as const;

/**
 * `items_removed` warnings of one rewritten case: one per list (main-flow `steps`, case-level `branches`, `variants`) that dropped at least
 * one stored id, naming every removed id in stored order. Each list is compared only with itself; steps inside a branch and ops inside a
 * variant are not compared. A new case (`stored` undefined), an omitted key and a list that still holds every stored id (grow, reorder)
 * stay silent. Never blocking; the target is the case as a whole.
 */
export function itemsRemovedWarnings(stored: UseCase | undefined, written: UseCase): Warning[] {
  if (!stored) return [];
  const warnings: Warning[] = [];
  for (const list of LISTS) {
    const kept = new Set((written[list] ?? []).map((item) => item.id));
    const removed = (stored[list] ?? []).map((item) => item.id).filter((id) => !kept.has(id));
    if (removed.length === 0) continue;
    warnings.push({ kind: "items_removed", target: `use_case:${written.id}`, message: `removed from ${list}: ${removed.map((id) => `"${id}"`).join(", ")}` });
  }
  return warnings;
}
