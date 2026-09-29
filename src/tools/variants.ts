import type { ScreenMeta } from "../store/index.js";

export type VariantLink = { of: string; kind: NonNullable<ScreenMeta["variant_kind"]> };

/**
 * Screen name -> its parent link, for every screen that declares one and
 * whose parent still exists. A dangling `variant_of` (parent deleted or
 * renamed by hand) is dropped here, so callers treat that screen as a main
 * screen without any further check — reads never throw on it (ADR-006).
 */
export function variantLinks(names: string[], metas: ScreenMeta[]): Map<string, VariantLink> {
  const known = new Set(names);
  const links = new Map<string, VariantLink>();
  names.forEach((name, i) => {
    const meta = metas[i]!;
    if (meta.variant_of && meta.variant_kind && meta.variant_of !== name && known.has(meta.variant_of)) {
      links.set(name, { of: meta.variant_of, kind: meta.variant_kind });
    }
  });
  return links;
}

/** Keys to spread into a screen entry: empty for a main screen. */
export function variantFields(link: VariantLink | undefined): { variant_of?: string; variant_kind?: VariantLink["kind"] } {
  return link ? { variant_of: link.of, variant_kind: link.kind } : {};
}
