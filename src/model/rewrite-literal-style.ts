import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { escapeAttr } from "./html-syntax.js";

type P5ChildNode = DefaultTreeAdapterTypes.ChildNode;
type P5Element = DefaultTreeAdapterTypes.Element;
type P5Template = DefaultTreeAdapterTypes.Template;

function isElementLike(node: P5ChildNode): node is P5Element {
  return node.nodeName !== "#text" && node.nodeName !== "#comment" && node.nodeName !== "#documentType";
}

function isTemplate(node: P5Element): node is P5Template {
  return node.tagName === "template";
}

/**
 * Rewrites a decoded style attribute's declarations, replacing any whose
 * (trimmed) value exactly matches `value` with a `$path` token ref — same
 * split-on-`;`/`:` logic as the canonical parser's `parseStyleAttribute`,
 * but working on an already-decoded string (parse5 hands us decoded
 * attribute values directly, so there's no entity-decoding to do here).
 * Returns `null` when nothing matched.
 */
function replaceDeclarationValue(decodedStyle: string, value: string, path: string): string | null {
  let changed = false;
  const rewritten = decodedStyle
    .split(";")
    .map((decl) => {
      const sep = decl.indexOf(":");
      if (sep === -1) return decl;
      const prop = decl.slice(0, sep);
      const rawValue = decl.slice(sep + 1);
      if (rawValue.trim() !== value) return decl;
      const leadingWs = rawValue.match(/^\s*/)![0];
      const trailingWs = rawValue.match(/\s*$/)![0];
      changed = true;
      return `${prop}:${leadingWs}$${path}${trailingWs}`;
    })
    .join(";");
  return changed ? rewritten : null;
}

type Replacement = { start: number; end: number; text: string };

function collectReplacements(nodes: P5ChildNode[], value: string, path: string, out: Replacement[]): void {
  for (const node of nodes) {
    if (!isElementLike(node)) continue;

    const styleAttr = node.attrs.find((a) => a.name === "style");
    const styleLoc = node.sourceCodeLocation?.attrs?.style;
    if (styleAttr && styleLoc) {
      const rewritten = replaceDeclarationValue(styleAttr.value, value, path);
      if (rewritten !== null) {
        out.push({ start: styleLoc.startOffset, end: styleLoc.endOffset, text: `style="${escapeAttr(rewritten)}"` });
      }
    }

    // A <template>'s children live in `.content`, not `.childNodes` — parse5
    // models it after the real HTMLTemplateElement content-document model.
    if (isTemplate(node)) collectReplacements(node.content.childNodes, value, path, out);
    else collectReplacements(node.childNodes, value, path, out);
  }
}

/**
 * Replaces every literal style declaration whose value exactly matches
 * `value` with a `$path` token ref, via a source-preserving rewrite based on
 * parse5's `sourceCodeLocationInfo` — never a parse->serialize round trip
 * (which keeps only a document's first top-level element and re-normalizes
 * every node's formatting/ids) and never a text-based regex scan (which
 * cannot distinguish a real style attribute from one sitting inside a
 * comment or escaped example text, and cannot compare against an
 * HTML-escaped literal without re-implementing an HTML tokenizer).
 *
 * Only the exact byte range of each matching style attribute is replaced —
 * `escapeAttr` is the same escaping `serializeScreen` uses — everything
 * else in `html`, including comments, text content, and untouched
 * attributes/ids, stays byte-for-byte identical.
 */
export function rewriteLiteralStyleValueInDefinition(html: string, value: string, path: string): { html: string; changed: boolean } {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const replacements: Replacement[] = [];
  collectReplacements(fragment.childNodes, value, path, replacements);
  if (replacements.length === 0) return { html, changed: false };

  // Applied back-to-front so an earlier (smaller-offset) replacement's
  // range is never invalidated by a later one shifting the string length.
  replacements.sort((a, b) => b.start - a.start);
  let rewritten = html;
  for (const r of replacements) {
    rewritten = rewritten.slice(0, r.start) + r.text + rewritten.slice(r.end);
  }
  return { html: rewritten, changed: true };
}
