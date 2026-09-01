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

/** Every distinct `assets/<path>` reference in `html` — an `src` attribute or a CSS `url()` — with the `assets/` prefix stripped. */
function collectAssetRefs(html: string): Set<string> {
  const refs = new Set<string>();
  const srcRe = /\bsrc\s*=\s*(["'])assets\/([^"']+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = srcRe.exec(html))) refs.add(m[2]!);
  const urlRe = /url\(\s*(["']?)assets\/([^"')]+)\1\s*\)/g;
  while ((m = urlRe.exec(html))) refs.add(m[2]!);
  return refs;
}

/** `undefined` when the asset couldn't be resolved (`"inline"` only — `"url"` never touches the filesystem), so the caller leaves the reference as-is. */
async function resolveOneAssetRef(store: Store, relPath: string, mode: "url" | "inline"): Promise<string | undefined> {
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
 * Rewrites `assets/<path>` references — an `src` attribute (`<img>`,
 * `<source>`, ...) or a CSS `url()` (e.g. `background-image`) — into a form
 * the two render paths can actually load. `"url"` mode points at
 * `/api/assets/<path>` (for a page loaded over HTTP: the preview iframe,
 * `/api/render/*`); `"inline"` embeds the file as a `data:` URI (for
 * `page.setContent`, which has no HTTP base URL to resolve a relative path
 * against — the same reason webfonts get the same two-mode treatment, see
 * `resolveFontFaceCss` in `tools/render-context.ts`). A reference that fails
 * to resolve is left unchanged, so the browser's own broken-image handling
 * makes the failure visible instead of silently dropping it.
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
    [...refs].map(async (relPath) => {
      replacements.set(relPath, await resolveOneAssetRef(store, relPath, mode));
    }),
  );

  let out = html.replace(/\bsrc(\s*=\s*)(["'])assets\/([^"']+)\2/g, (full: string, eq: string, quote: string, relPath: string) => {
    const replacement = replacements.get(relPath);
    return replacement === undefined ? full : `src${eq}${quote}${replacement}${quote}`;
  });
  out = out.replace(/url\(\s*(["']?)assets\/([^"')]+)\1\s*\)/g, (full: string, quote: string, relPath: string) => {
    const replacement = replacements.get(relPath);
    if (replacement === undefined) return full;
    const q = quote || "'";
    return `url(${q}${replacement}${q})`;
  });
  return out;
}
