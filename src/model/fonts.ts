import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { CACHE_DIR } from "../init/artisign-config.js";
import { ensureCacheGitignore } from "../store/index.js";
import type { Store, TokensDocument } from "../store/index.js";

/**
 * Webfont caching: families named in a project's typography
 * tokens are fetched once from Google Fonts as woff2, cached under
 * `.artisign/fonts/`, and served back to the preview so the rendered
 * document carries them offline after the first run. Material Symbols
 * Rounded (the icon font backing the `.icon` ligature class in
 * render-document.ts) is always included.
 *
 * `.artisign/` is a derived cache, but it isn't the single JSON blob the `Store`
 * interface's `readCacheIndex`/`writeCacheIndex` model — it's a directory
 * of binary files keyed by name. Rather than growing `Store` into a generic
 * file-IO abstraction for one caller (forbidden — ADR-001 permits exactly
 * one abstraction, on spec), this module talks to `store.projectDir`
 * directly, atomically, the same way `atomicWrite` does for every other
 * on-disk write.
 */

const MATERIAL_SYMBOLS_FAMILY = "Material Symbols Rounded";

// Bundled fallback: the `.icon` ligature class (render-document.ts)
// otherwise depends on a live Google Fonts fetch for Material Symbols
// Rounded — offline or blocked, `.icon` usage silently rendered as literal
// text with no diagnostic. `assets/` sits next to `dist/` (both one level
// under the package root — see package.json "files"), so the same relative
// path resolves whether this module runs from `src/model/` (dev, via tsx)
// or `dist/model/` (built) — `import.meta.url`, not `cwd()`, since a global
// install's cwd is whatever the caller happens to be in.
const BUNDLED_MATERIAL_SYMBOLS_URL = new URL("../../assets/fonts/material-symbols-rounded.woff2", import.meta.url);
const BUNDLED_MATERIAL_SYMBOLS_FILE = "material-symbols-rounded-bundled.woff2";

const GENERIC_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
]);

function isGeneric(family: string): boolean {
  return GENERIC_FAMILIES.has(family.toLowerCase()) || /^ui-/i.test(family);
}

// Matches the size (and optional /line-height) component of a CSS `font`
// shorthand, e.g. "24px" or "24px/1.2" — everything after it is the
// family list.
const SIZE_RE = /\d+(?:\.\d+)?(?:px|rem|em|pt|%)(?:\/[\d.]+(?:px|rem|em|%)?)?/;

function parseFamilyList(familyListStr: string): string[] {
  return familyListStr
    .split(",")
    .map((segment) => segment.trim().replace(/^['"]|['"]$/g, ""))
    .filter((family) => family.length > 0);
}

/**
 * Collects the non-generic font families referenced by a project's
 * typography tokens (CSS `font` shorthand strings). Dedupes, preserves
 * first-seen order.
 */
export function extractFontFamilies(tokens: TokensDocument): string[] {
  const typography = tokens.typography;
  if (!typography) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of Object.values(typography)) {
    if (typeof value !== "string") continue;
    const sizeMatch = SIZE_RE.exec(value);
    if (!sizeMatch) continue;
    const familyListStr = value.slice(sizeMatch.index + sizeMatch[0].length);
    for (const family of parseFamilyList(familyListStr)) {
      if (isGeneric(family)) continue;
      if (seen.has(family)) continue;
      seen.add(family);
      result.push(family);
    }
  }

  return result;
}

type FontFile = {
  file: string;
  weightRange?: string;
  style?: string;
  unicodeRange?: string;
};

type FontManifestEntry = {
  files: FontFile[];
  css: string;
};

type FontManifest = Record<string, FontManifestEntry>;

type FetchLike = typeof fetch;

let fetchImpl: FetchLike = fetch;

/** Test-only hook to replace the fetch implementation — never hit the network in CI. */
export function __setFetchForTests(impl: FetchLike | undefined): void {
  fetchImpl = impl ?? fetch;
}

/** Test-only hook to clear the per-project, per-family memo between test cases. */
export function __resetFontMemoForTests(): void {
  memo.clear();
}

/** Composite key so two projects fetching the same family don't share a fetched/failed status. */
function memoKey(projectRoot: string, family: string): string {
  return `${projectRoot}\0${family}`;
}

/** Drops every memoized family status for `projectRoot` — call when a project closes, so a stale "failed" status (e.g. from a transient offline fetch) doesn't leak into a later reopen. */
export function clearFontMemo(projectRoot: string): void {
  const prefix = `${projectRoot}\0`;
  for (const key of memo.keys()) {
    if (key.startsWith(prefix)) memo.delete(key);
  }
}

// Chrome UA — Google Fonts only serves woff2 (rather than woff/ttf) to
// browsers it recognises as supporting it.
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** `.artisign/fonts/` for `projectRoot` — also used by the `/api/fonts/<file>` route and tests. */
export function fontsDir(projectRoot: string): string {
  return join(projectRoot, CACHE_DIR, "fonts");
}

function manifestPath(projectRoot: string): string {
  return join(fontsDir(projectRoot), "manifest.json");
}

async function atomicWriteFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}

async function readManifest(projectRoot: string): Promise<FontManifest | undefined> {
  try {
    const raw = await readFile(manifestPath(projectRoot), "utf-8");
    return JSON.parse(raw) as FontManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeManifest(projectRoot: string, manifest: FontManifest): Promise<void> {
  await atomicWriteFile(manifestPath(projectRoot), `${JSON.stringify(manifest, null, 2)}\n`);
}

function slugify(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function familyParam(family: string): string {
  return family
    .split(" ")
    .map((word) => encodeURIComponent(word))
    .join("+");
}

async function fetchGoogleFontsCss(family: string): Promise<string> {
  const url = `https://fonts.googleapis.com/css2?family=${familyParam(family)}&display=swap`;
  const res = await fetchImpl(url, { headers: { "user-agent": CHROME_USER_AGENT } });
  if (!res.ok) throw new Error(`Google Fonts CSS fetch failed for "${family}": ${res.status}`);
  return res.text();
}

type ParsedFontFace = {
  style: string;
  weight: string;
  unicodeRange?: string;
  srcUrl: string;
};

function parseFontFaceBlocks(css: string): ParsedFontFace[] {
  const blocks: ParsedFontFace[] = [];
  const blockRe = /@font-face\s*{([^}]*)}/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(css))) {
    const body = blockMatch[1]!;
    const srcMatch = /url\(([^)]+)\)\s*format\(['"]?woff2['"]?\)/.exec(body);
    if (!srcMatch) continue;
    const styleMatch = /font-style:\s*([^;]+);/.exec(body);
    const weightMatch = /font-weight:\s*([^;]+);/.exec(body);
    const unicodeMatch = /unicode-range:\s*([^;]+);/.exec(body);
    blocks.push({
      style: styleMatch ? styleMatch[1]!.trim() : "normal",
      weight: weightMatch ? weightMatch[1]!.trim() : "400",
      unicodeRange: unicodeMatch ? unicodeMatch[1]!.trim() : undefined,
      srcUrl: srcMatch[1]!.trim().replace(/^['"]|['"]$/g, ""),
    });
  }
  return blocks;
}

async function fetchFamily(projectRoot: string, family: string): Promise<FontManifestEntry> {
  const css = await fetchGoogleFontsCss(family);
  const blocks = parseFontFaceBlocks(css);
  if (blocks.length === 0) throw new Error(`no woff2 @font-face found for "${family}"`);

  const files: FontFile[] = [];
  const cssParts: string[] = [];

  for (const [i, block] of blocks.entries()) {
    const res = await fetchImpl(block.srcUrl);
    if (!res.ok) throw new Error(`woff2 download failed for "${family}": ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const file = `${slugify(family)}-${block.weight.replace(/\s+/g, "_")}-${block.style}-${i}.woff2`;
    await atomicWriteFile(join(fontsDir(projectRoot), file), buffer);

    files.push({ file, weightRange: block.weight, style: block.style, unicodeRange: block.unicodeRange });
    cssParts.push(
      `@font-face {\n  font-family: '${family}';\n  font-style: ${block.style};\n  font-weight: ${block.weight};\n` +
        (block.unicodeRange ? `  unicode-range: ${block.unicodeRange};\n` : "") +
        `  src: url(/api/fonts/${file}) format('woff2');\n}`,
    );
  }

  return { files, css: cssParts.join("\n") };
}

/** Copies the package's bundled Material Symbols Rounded woff2 into `.artisign/fonts/` — the fallback `fetchFamily` reaches for when the live Google Fonts fetch fails (offline, blocked, rate-limited). */
async function bundledMaterialSymbolsEntry(projectRoot: string): Promise<FontManifestEntry> {
  const buffer = await readFile(BUNDLED_MATERIAL_SYMBOLS_URL);
  await atomicWriteFile(join(fontsDir(projectRoot), BUNDLED_MATERIAL_SYMBOLS_FILE), buffer);
  return {
    files: [{ file: BUNDLED_MATERIAL_SYMBOLS_FILE, weightRange: "400", style: "normal" }],
    css:
      `@font-face {\n  font-family: '${MATERIAL_SYMBOLS_FAMILY}';\n  font-style: normal;\n  font-weight: 400;\n` +
      `  src: url(/api/fonts/${BUNDLED_MATERIAL_SYMBOLS_FILE}) format('woff2');\n}`,
  };
}

async function resolveFamily(projectRoot: string, family: string): Promise<FontManifestEntry | undefined> {
  try {
    return await fetchFamily(projectRoot, family);
  } catch {
    if (family !== MATERIAL_SYMBOLS_FAMILY) return undefined;
    // The one family this project can't silently do without — `.icon` usage
    // depends on it, and a missing icon font otherwise degrades to literal
    // ligature text with no visual signal at all.
    return await bundledMaterialSymbolsEntry(projectRoot).catch(() => undefined);
  }
}

type FamilyStatus = "ok" | "failed";

// Keyed by (projectRoot, family) — the daemon now holds several projects
// open at once, and a family fetched/failed for one project must
// not leak its status into another's.
const memo = new Map<string, FamilyStatus>();

/** Whether Material Symbols Rounded resolved (fetched live or from the bundled fallback) the last time `ensureFontsCached` ran for `projectRoot` — used to decide whether `.icon` usage needs the unresolved-icon-font render diagnostic. `undefined` before `ensureFontsCached` has run at all for this project this process. */
export function isMaterialSymbolsAvailable(projectRoot: string): boolean | undefined {
  const status = memo.get(memoKey(projectRoot, MATERIAL_SYMBOLS_FAMILY));
  return status === undefined ? undefined : status === "ok";
}

/**
 * Fetches and caches every family in `families` (plus Material Symbols
 * Rounded, always) that hasn't been resolved yet this process. Failures —
 * offline, unknown family, network error — are swallowed and remembered so
 * a family is never retried within the same process; the manifest simply
 * has no entry for it and the render falls back to system fonts (Material
 * Symbols Rounded excepted — see `bundledMaterialSymbolsEntry`).
 */
export async function ensureFontsCached(store: Store, families: string[]): Promise<void> {
  const wanted = new Set([...families, MATERIAL_SYMBOLS_FAMILY]);
  const toFetch = [...wanted].filter((family) => !memo.has(memoKey(store.projectDir, family)));
  if (toFetch.length === 0) return;

  // Font files land under CACHE_DIR before the manifest write below (and
  // this can be the very first write to it — the index cache may not have
  // been written yet), so the self-ignoring .gitignore has to exist ahead
  // of the fetch loop, not just after.
  await ensureCacheGitignore(store.projectDir);

  const manifest = (await readManifest(store.projectDir)) ?? {};
  let changed = false;

  for (const family of toFetch) {
    const entry = await resolveFamily(store.projectDir, family);
    if (entry) {
      manifest[family] = entry;
      memo.set(memoKey(store.projectDir, family), "ok");
      changed = true;
    } else {
      memo.set(memoKey(store.projectDir, family), "failed");
    }
  }

  if (changed) await writeManifest(store.projectDir, manifest);
}

export type BuildFontFaceCssOptions = {
  /** `url` rewrites `src` to `/api/fonts/<file>`; `inline` embeds base64 `data:font/woff2` (screenshot path). */
  mode: "url" | "inline";
};

/**
 * Assembles the `@font-face` CSS for every cached family, for injection
 * into `wrapRenderedHtml`'s `fontFaceCss`. Empty string when no manifest
 * exists yet (nothing cached, or every fetch has failed so far).
 */
export async function buildFontFaceCss(projectRoot: string, options: BuildFontFaceCssOptions): Promise<string> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) return "";

  const blocks: string[] = [];
  for (const entry of Object.values(manifest)) {
    if (options.mode === "url") {
      blocks.push(entry.css);
      continue;
    }
    let css = entry.css;
    for (const f of entry.files) {
      try {
        const buffer = await readFile(join(fontsDir(projectRoot), f.file));
        const dataUri = `data:font/woff2;base64,${buffer.toString("base64")}`;
        css = css.split(`/api/fonts/${f.file}`).join(dataUri);
      } catch {
        // File missing on disk — leave the url() reference as-is rather
        // than failing the whole family's CSS.
      }
    }
    blocks.push(css);
  }
  return blocks.join("\n");
}
