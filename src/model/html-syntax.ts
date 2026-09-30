// HTML void elements never have a closing tag or children. Shared between
// the html_aug (round-trip) and html (resolved render) adapters.
export const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes text-node content unless its parent is `<style>`, whose content is raw text: entities there are not decoded, so escaping would corrupt the CSS. */
export function escapeTextIn(parentTag: string | undefined, value: string): string {
  return parentTag === "style" ? value : escapeText(value);
}
