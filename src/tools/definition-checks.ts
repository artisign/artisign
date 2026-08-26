import { slotsWithDiscardedStyling, type ScreenDocument } from "../model/index.js";
import type { Warning } from "./types.js";

/**
 * Slot substitution replaces the placeholder element wholesale, so
 * style/class/component refs on a `data-slot` element never reach the render
 * — the definition would quietly lie about how it looks.
 *
 * Shared by both paths that can put a component definition on disk —
 * `write_html`'s `writeDefinition` and `promote_to_system` — so a promotion
 * cannot reach the same on-disk state without the same warning.
 */
export function slotStylingWarnings(variantDoc: ScreenDocument, target: string): Warning[] {
  return slotsWithDiscardedStyling(variantDoc).map((slot) => ({
    kind: "suspicious_attr",
    target,
    message: `slot "${slot.name}" carries its own style/class/component ref, which an instance filling this slot discards`,
    suggestion:
      "style a wrapper around the slot instead — and keep instances naming their slots (data-slot=...), because a wrapper directly under the definition root is itself a positional slot",
  }));
}
