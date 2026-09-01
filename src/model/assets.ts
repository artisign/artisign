import type { Store } from "../store/index.js";

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

/** The `content-type` for an asset file, by extension — `undefined` for an unrecognised one. */
export function assetContentType(relPath: string): string | undefined {
  const dot = relPath.lastIndexOf(".");
  if (dot === -1) return undefined;
  return ASSET_CONTENT_TYPES[relPath.slice(dot).toLowerCase()];
}

// `src="assets/<path>"` — the attribute's own delimiter is always a literal
// quote (single or double); `escapeAttr` (html-syntax.ts) never turns *that*
// into `&quot;`, only quotes appearing inside the value.
const SRC_RE = /\bsrc\s*=\s*(["'])assets\/([^"']+)\1/g;
// `url("assets/<path>")` / `url('assets/<path>')` — but the whole `style="…"`
// attribute value this sits inside has itself been through `escapeAttr`, so a
// double-quoted url() argument's literal `"` delimiters arrive as `&quot;`,
// not `"`. `\1` backreferences whichever delimiter matched, so a
// `&quot;`-quoted url() only closes on another literal `&quot;`.
const URL_QUOTED_RE = /url\(\s*(["']|&quot;)assets\/([\s\S]*?)\1\s*\)/g;
// `url(assets/<path>)`, with CSS-legal surrounding whitespace
// (`url( assets/hero.png )`) — excluding whitespace/quotes from the captured
// class directly (rather than trimming afterwards) both matches what CSS
// actually permits in an unquoted url() token and stops the capture from
// running into a quote it isn't supposed to see.
const URL_UNQUOTED_RE = /url\(\s*assets\/([^)\s'"]+)\s*\)/g;

/** Reverses `escapeAttr` (html-syntax.ts) on a captured reference — `resolveAssetRefs` runs on already-serialized HTML, so a filename containing `&` or `"` arrives HTML-escaped and has to be undone before it's used as a filesystem path or URL segment. Order matches escapeAttr's in reverse (it escapes `&` first, `"` second). */
function unescapeHtmlAttr(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Every distinct `assets/<path>` reference in `html` — an `src` attribute or a CSS `url()`, quoted or not — with the `assets/` prefix stripped. Still HTML-escaped as captured; unescaped later, in `resolveOneAssetRef`. */
function collectAssetRefs(html: string): Set<string> {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  const srcRe = new RegExp(SRC_RE);
  while ((m = srcRe.exec(html))) refs.add(m[2]!);
  const urlQuotedRe = new RegExp(URL_QUOTED_RE);
  while ((m = urlQuotedRe.exec(html))) refs.add(m[2]!);
  const urlUnquotedRe = new RegExp(URL_UNQUOTED_RE);
  while ((m = urlUnquotedRe.exec(html))) refs.add(m[1]!);
  return refs;
}

/** `undefined` when the asset couldn't be resolved (`"inline"` only — `"url"` never touches the filesystem), so the caller leaves the reference as-is. `rawRelPath` is still HTML-escaped, exactly as captured off the rendered document. */
async function resolveOneAssetRef(store: Store, rawRelPath: string, mode: "url" | "inline"): Promise<string | undefined> {
  const relPath = unescapeHtmlAttr(rawRelPath);
  if (mode === "url") {
    // Per-segment encoding, not the whole path — an ordinary filename like
    // "hero copy.png" (macOS's own default when duplicating a file) or one
    // containing "#"/"?" would otherwise land in the URL unescaped, and the
    // route's `decodeURIComponent` on the way back wouldn't round-trip it
    // (a bare "#" even truncates the path into a fragment, dropping the
    // image silently — the exact failure mode this ticket exists to fix).
    return `/api/assets/${relPath.split("/").map(encodeURIComponent).join("/")}`;
  }
  try {
    const buffer = await store.readAsset(relPath);
    const contentType = assetContentType(relPath) ?? "application/octet-stream";
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * Rewrites `assets/<path>` references — an element's `src` attribute or a
 * CSS `url()` (e.g. `background-image`) — into a form the two render paths
 * can actually load. `"url"` mode points at `/api/assets/<path>` (for a page
 * loaded over HTTP: the preview iframe, `/api/render/*`); `"inline"` embeds
 * the file as a `data:` URI (for `page.setContent`, which has no HTTP base
 * URL to resolve a relative path against — the same reason webfonts get the
 * same two-mode treatment, see `resolveFontFaceCss` in
 * `tools/render-context.ts`). A reference that fails to resolve is left
 * unchanged, so the browser's own broken-image handling makes the failure
 * visible instead of silently dropping it.
 *
 * This is a string pass over the whole rendered document, not an HTML-aware
 * rewrite — the right weight for the job, but it means a literal
 * `src="assets/…"` appearing as visible example text (e.g. a code snippet
 * shown on a screen) gets rewritten too, indistinguishable from a real
 * reference.
 */
export async function resolveAssetRefs(html: string, store: Store, mode: "url" | "inline"): Promise<string> {
  const refs = collectAssetRefs(html);
  if (refs.size === 0) return html;

  const replacements = new Map<string, string | undefined>();
  await Promise.all(
    [...refs].map(async (rawRelPath) => {
      replacements.set(rawRelPath, await resolveOneAssetRef(store, rawRelPath, mode));
    }),
  );

  let out = html.replace(new RegExp(SRC_RE), (full: string, quote: string, rawRelPath: string) => {
    const replacement = replacements.get(rawRelPath);
    return replacement === undefined ? full : `src=${quote}${replacement}${quote}`;
  });
  // Both url() forms always rewrite to a single-quoted replacement,
  // regardless of the original delimiter: the replacement (a `/api/assets/`
  // URL or a `data:` URI) is only ever built from safe characters, and a
  // `&quot;`-delimited match sits inside an already-double-quoted `style="…"`
  // attribute — emitting a literal `"` there would prematurely close it.
  out = out.replace(new RegExp(URL_QUOTED_RE), (full: string, _quote: string, rawRelPath: string) => {
    const replacement = replacements.get(rawRelPath);
    return replacement === undefined ? full : `url('${replacement}')`;
  });
  out = out.replace(new RegExp(URL_UNQUOTED_RE), (full: string, rawRelPath: string) => {
    const replacement = replacements.get(rawRelPath);
    return replacement === undefined ? full : `url('${replacement}')`;
  });
  return out;
}
