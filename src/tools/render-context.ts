import type { Store } from "../store/index.js";
import type { TokensDocument } from "../store/index.js";
import {
  loadRegistry,
  parseComponentDefinition,
  parseScreen,
  renderScreen,
  wrapRenderedHtml,
  extractFontFamilies,
  ensureFontsCached,
  buildFontFaceCss,
  isMaterialSymbolsAvailable,
  resolveTokenRef,
  type ComponentDefinitionSummary,
  type RenderContext,
  type ScreenDocument,
  type Node as InternalNode,
  type TokenRef,
} from "../model/index.js";
import { ToolError } from "./types.js";
import { loadDefinitionSource } from "./definitions.js";
import type { DefinitionNodeRef } from "./node-ref.js";

/**
 * Ensures the project's webfonts (from typography tokens, plus Material
 * Symbols Rounded) are cached and returns the `@font-face` CSS to inject
 * into a rendered document. Never throws — a fetch failure (offline, no
 * such family) falls back to an empty string, i.e. system fonts. Shared by
 * `renderScreenDocument` below, `renderMockupDocument`, and
 * `/api/design-system` (`preview-routes.ts`) — the one place this logic
 * lives, so all three stay on the same font-resolution behaviour.
 *
 * `fontMode: "url"` points `@font-face` at `/api/fonts/*` (for a page loaded
 * over HTTP, e.g. the preview iframe); `"inline"` embeds fonts as `data:`
 * URIs (for `page.setContent`, which has no HTTP base URL to resolve
 * relative font URLs against).
 */
export async function resolveFontFaceCss(store: Store, tokens: TokensDocument, mode: "url" | "inline"): Promise<string> {
  try {
    await ensureFontsCached(store, extractFontFamilies(tokens));
    return await buildFontFaceCss(store.projectDir, { mode });
  } catch {
    return "";
  }
}

/** Assembles everything the `html` render adapter needs from the project's current on-disk state. */
export async function buildRenderContext(store: Store): Promise<RenderContext> {
  const [tokens, registry, componentNames] = await Promise.all([
    store.readTokens(),
    loadRegistry(store),
    store.listComponents(),
  ]);

  const componentDefs = new Map<string, ComponentDefinitionSummary>();
  for (const name of componentNames) {
    const html = await store.readComponent(name);
    componentDefs.set(name, parseComponentDefinition(name, html));
  }

  return { tokens, registry, componentDefs };
}

export type RenderedScreenDocument = {
  /** The full, standalone HTML document — same shape the preview iframe and screenshot tool render. */
  documentHtml: string;
  doc: ScreenDocument;
  ctx: RenderContext;
};

/**
 * Reads and renders a screen to a standalone HTML document: parse ->
 * resolve refs -> wrap with `@font-face` CSS. Shared by `/api/render/*`
 * (preview iframe) and `get_screenshot` (headless render), and by the
 * opt-in `rendered_html` field on `get_screen`. Propagates `store.readScreen`'s
 * ENOENT for the caller to translate into its own not-found response.
 *
 * `fontMode: "url"` points `@font-face` at `/api/fonts/*` (for a page loaded
 * over HTTP, e.g. the preview iframe); `"inline"` embeds fonts as `data:`
 * URIs (for `page.setContent`, which has no HTTP base URL to resolve
 * relative font URLs against). Font resolution is failure-tolerant either
 * way — offline/uncached falls back to system fonts rather than throwing.
 */
export async function renderScreenDocument(
  store: Store,
  screen: string,
  options: { fontMode: "url" | "inline" },
): Promise<RenderedScreenDocument> {
  const html = await store.readScreen(screen);
  const ctx = await buildRenderContext(store);
  const { doc } = parseScreen(html, screen, ctx.registry);

  const fontFaceCss = await resolveFontFaceCss(store, ctx.tokens, options.fontMode);
  ctx.iconFontAvailable = isMaterialSymbolsAvailable(store.projectDir);

  const documentHtml = wrapRenderedHtml(renderScreen(doc, ctx), { fontFaceCss });
  return { documentHtml, doc, ctx };
}

export type RenderedMockupDocument = { documentHtml: string };

/**
 * Reads and renders a mockup variant to a standalone HTML document. Unlike
 * `renderScreenDocument`, there is no ref model to resolve — mockups are raw
 * HTML, never re-serialized (ADR-003). A variant that already is a full
 * document (`<html ...>`) is returned verbatim; a fragment is wrapped with
 * the same deterministic baseline (`wrapRenderedHtml`) screens use, so
 * mockups get the same baseline CSS/icons/fonts. Propagates
 * `store.readMockupVariant`'s ENOENT for the caller to translate into its
 * own not-found response.
 */
const FULL_DOCUMENT_RE = /^\s*(<!doctype[^>]*>\s*)?<html[\s>]/i;

export async function renderMockupDocument(
  store: Store,
  name: string,
  variantId: string,
  options: { fontMode: "url" | "inline" },
): Promise<RenderedMockupDocument> {
  const html = await store.readMockupVariant(name, variantId);
  if (FULL_DOCUMENT_RE.test(html)) {
    return { documentHtml: html };
  }
  let tokens: TokensDocument = {};
  try {
    tokens = await store.readTokens();
  } catch {
    // Missing/broken tokens.json shouldn't break a mockup render — fall back
    // to no tokens, same failure-tolerance as the font resolution below.
    tokens = {};
  }
  const fontFaceCss = await resolveFontFaceCss(store, tokens, options.fontMode);
  return { documentHtml: wrapRenderedHtml(html, { fontFaceCss }) };
}

export type Viewport = { width: number; height: number };

const DEFAULT_VIEWPORT: Viewport = { width: 390, height: 844 };
const PX_PATTERN = /^(\d+(?:\.\d+)?)px$/;

function pxValue(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = PX_PATTERN.exec(raw.trim());
  return match ? Number(match[1]) : undefined;
}

function resolveDimension(prop: "width" | "height", node: InternalNode, tokens: TokensDocument): number | undefined {
  const inline = pxValue(node.inlineStyles[prop]);
  if (inline !== undefined) return inline;

  const ref: TokenRef | undefined = node.refs.tokens[prop];
  if (ref === undefined) return undefined;
  return pxValue(resolveTokenRef(ref, tokens));
}

/** The screen root's declared px width/height (plain or `$token`-resolved), falling back to a default mobile viewport. Pure — no browser involved, so it's unit-testable on its own. */
export function resolveViewport(rootNode: InternalNode, tokens: TokensDocument): Viewport {
  return {
    width: resolveDimension("width", rootNode, tokens) ?? DEFAULT_VIEWPORT.width,
    height: resolveDimension("height", rootNode, tokens) ?? DEFAULT_VIEWPORT.height,
  };
}

export type RenderedScreenForBrowser = RenderedScreenDocument & { rootNode: InternalNode; viewport: Viewport };

/**
 * Shared preamble for the headless-render tools (`get_screenshot`,
 * `inspect_node`): render the screen, translate `store.readScreen`'s ENOENT
 * into a `not_found` ToolError, and resolve the root's viewport. What each
 * tool does with a live Playwright page after this point differs enough
 * (full vs. node-clipped screenshot vs. a single `page.evaluate` geometry
 * read) that it isn't folded in here too.
 */
export async function renderScreenForBrowser(store: Store, screen: string): Promise<RenderedScreenForBrowser> {
  let rendered: RenderedScreenDocument;
  try {
    rendered = await renderScreenDocument(store, screen, { fontMode: "inline" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError("not_found", `screen "${screen}" was not found`);
    }
    throw err;
  }
  const rootNode = rendered.doc.nodes[rendered.doc.rootNodeId];
  if (!rootNode) throw new ToolError("not_found", `screen "${screen}" has no root node`);

  return { ...rendered, rootNode, viewport: resolveViewport(rootNode, rendered.ctx.tokens) };
}

export type RenderedDefinitionForBrowser = { doc: ScreenDocument; documentHtml: string; viewport: Viewport };

/**
 * Renders a component variant or pattern to a standalone HTML document, for
 * the headless-render tools (`get_screenshot`, `inspect_node`) addressing a
 * `component:`/`pattern:` node ref (ADR-004 §1). `renderScreen` takes any
 * `ScreenDocument`, not just a screen's — `loadDefinitionSource`'s doc is
 * rendered exactly like `renderScreenDocument` renders a screen's, just
 * without the parse step (already parsed by `loadAllDocuments`).
 *
 * A definition has no on-disk viewport declaration the way a screen's root
 * can (`resolveViewport` reads it off a real screen root) — the default
 * mobile viewport is used unless the definition's own root declares a
 * width/height, exactly like a screen falls back when it doesn't declare one
 * either.
 */
export async function renderDefinitionForBrowser(store: Store, ref: DefinitionNodeRef): Promise<RenderedDefinitionForBrowser> {
  const ctx = await buildRenderContext(store);
  const source = await loadDefinitionSource(store, ctx.registry, ref);

  const fontFaceCss = await resolveFontFaceCss(store, ctx.tokens, "inline");
  ctx.iconFontAvailable = isMaterialSymbolsAvailable(store.projectDir);

  const documentHtml = wrapRenderedHtml(renderScreen(source.doc, ctx), { fontFaceCss });
  const rootNode = source.doc.nodes[source.doc.rootNodeId];
  const viewport = rootNode ? resolveViewport(rootNode, ctx.tokens) : DEFAULT_VIEWPORT;
  return { doc: source.doc, documentHtml, viewport };
}
