import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../store/index.js";
import { getDesignSystem } from "../tools/reads.js";
import { buildRenderContext, renderScreenDocument, renderMockupDocument, resolveFontFaceCss } from "../tools/render-context.js";
import { readMockupMetaOrDefault } from "../tools/mockups.js";
import { readAllFlows, toPublicFlowRecord } from "../tools/flows.js";
import {
  parseScreen,
  renderScreen,
  parseComponentDefinition,
  wrapRenderedHtml,
  isMaterialSymbolsAvailable,
  fontsDir,
  resolveAssetRefs,
  assetContentType,
} from "../model/index.js";
import { sendJson } from "./json.js";

const FONT_FILENAME_RE = /^[\w.-]+\.woff2$/;

type ComponentDefinitionJson = {
  name: string;
  file: string;
  html_aug: string;
  variants: { name: string; html_aug: string }[];
};

type PatternDefinitionJson = {
  name: string;
  file: string;
  html_aug: string;
};

/**
 * Thin GET routes for the preview frontend: screen list, a screen's
 * resolved (rendered) HTML, and the design system with every component
 * variant rendered. Everything here is a wrapper over the existing
 * tool-layer / model code — no logic lives here beyond routing and shaping
 * the response for the browser. Returns `false` when `req` doesn't match
 * any of these routes, so the caller can fall through to its next handler.
 *
 * /api/flows exposes flows.json (via the tool layer's `readAllFlows`) for
 * the Board view, which lists click paths across screens rather than
 * inspecting one rendered screen's DOM at a time.
 */
export async function handlePreviewRoutes(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method !== "GET") return false;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/api/screens") {
    const names = await store.listScreens();
    const screens = await Promise.all(
      names.map(async (name) => {
        const meta = await store.readScreenMeta(name);
        return { name, tags: meta.tags, notes: meta.notes };
      }),
    );
    sendJson(res, 200, { screens });
    return true;
  }

  if (url.pathname === "/api/flows") {
    const records = await readAllFlows(store);
    sendJson(res, 200, { flows: records.map(toPublicFlowRecord) });
    return true;
  }

  if (url.pathname === "/api/mockups") {
    const names = await store.listMockups();
    const mockups = await Promise.all(
      names.map(async (name) => {
        const meta = await readMockupMetaOrDefault(store, name);
        return { name, title: meta.title, description: meta.description, tags: meta.tags ?? [], variants: meta.variants };
      }),
    );
    sendJson(res, 200, { mockups });
    return true;
  }

  const mockupRenderMatch = /^\/api\/render\/mockup\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
  if (mockupRenderMatch) {
    const [, name, variantId] = mockupRenderMatch;
    let documentHtml: string;
    try {
      ({ documentHtml } = await renderMockupDocument(store, name!, variantId!, { fontMode: "url" }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(res, 404, { code: "not_found", message: `mockup "${name}" variant "${variantId}" was not found` });
        return true;
      }
      throw err;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(documentHtml);
    return true;
  }

  const renderMatch = /^\/api\/render\/([\w-]+)$/.exec(url.pathname);
  if (renderMatch) {
    const screen = renderMatch[1]!;
    let documentHtml: string;
    try {
      ({ documentHtml } = await renderScreenDocument(store, screen, { fontMode: "url" }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(res, 404, { code: "not_found", message: `screen "${screen}" was not found` });
        return true;
      }
      throw err;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(documentHtml);
    return true;
  }

  if (url.pathname === "/api/design-system") {
    const [summary, ctx] = await Promise.all([
      getDesignSystem(store, { view: "full" }),
      buildRenderContext(store),
    ]);
    const fontFaceCss = await resolveFontFaceCss(store, ctx.tokens, "url");
    ctx.iconFontAvailable = isMaterialSymbolsAvailable(store.projectDir);
    const renderVariants = (name: string, variants: { name: string; html_aug: string }[]) =>
      Promise.all(
        variants.map(async (variant) => {
          const { doc } = parseScreen(variant.html_aug, `__preview_${name}_${variant.name}__`, ctx.registry);
          const rendered_html = await resolveAssetRefs(wrapRenderedHtml(renderScreen(doc, ctx), { fontFaceCss }), store, "url");
          return { ...variant, rendered_html };
        }),
      );

    const componentDefinitions = (summary.component_definitions as ComponentDefinitionJson[] | undefined) ?? [];
    const rendered = await Promise.all(
      componentDefinitions.map(async (component) => ({
        ...component,
        variants: await renderVariants(component.name, component.variants),
      })),
    );

    // The tool layer returns a pattern as its raw file contents — patterns have
    // no variant model of their own. The pane still has to show them, so the
    // same `<template data-variant>` grammar is applied here, at the preview
    // edge only, leaving the MCP response shape untouched.
    const patternDefinitions = (summary.pattern_definitions as PatternDefinitionJson[] | undefined) ?? [];
    const renderedPatterns = await Promise.all(
      patternDefinitions.map(async (pattern) => {
        const def = parseComponentDefinition(pattern.name, pattern.html_aug);
        const variants = def.variants.map((v) => ({ name: v.name, html_aug: v.htmlAug }));
        return { ...pattern, variants: await renderVariants(pattern.name, variants) };
      }),
    );

    sendJson(res, 200, { ...summary, component_definitions: rendered, pattern_definitions: renderedPatterns });
    return true;
  }

  const fontMatch = /^\/api\/fonts\/([^/]+)$/.exec(url.pathname);
  if (fontMatch) {
    const filename = fontMatch[1]!;
    if (!FONT_FILENAME_RE.test(filename)) {
      sendJson(res, 404, { code: "not_found", message: "font file was not found" });
      return true;
    }
    try {
      const body = await readFile(join(fontsDir(store.projectDir), filename));
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=31536000, immutable" });
      res.end(body);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(res, 404, { code: "not_found", message: "font file was not found" });
        return true;
      }
      throw err;
    }
    return true;
  }

  const assetMatch = /^\/api\/assets\/(.+)$/.exec(url.pathname);
  if (assetMatch) {
    let relPath: string;
    try {
      relPath = decodeURIComponent(assetMatch[1]!);
    } catch {
      sendJson(res, 404, { code: "not_found", message: "asset was not found" });
      return true;
    }
    try {
      const body = await store.readAsset(relPath);
      const contentType = assetContentType(relPath) ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": contentType,
        // A project asset can be an SVG a user downloaded from the web and
        // dropped into `assets/` — served bare, it would run as script on
        // the daemon's own origin (same-origin requests reach the full tool
        // API, per `isAllowedOrigin`). These two headers close that off:
        // `sandbox` (no scripts, no same-origin) if it's ever opened as a
        // top-level navigation, `nosniff` so a non-image extension never
        // gets sniffed into something executable.
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    } catch {
      // `store.readAsset` throws both for a missing file (ENOENT) and for a
      // path that escapes `assets/` (e.g. `../..`) — either way, 404 rather
      // than leaking which one it was.
      sendJson(res, 404, { code: "not_found", message: "asset was not found" });
    }
    return true;
  }

  return false;
}
