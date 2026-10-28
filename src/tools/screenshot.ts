// Tool-Palette v1.1 — `get_screenshot` is the 16th tool, reinstated for
// the agent's visual review loop (write -> screenshot -> adjust).
// Not in the original 15-tool surface.

import type { Store } from "../store/index.js";
import { backdropHint } from "./backdrop.js";
import { renderScreenForBrowser, renderMockupDocument, renderDefinitionForBrowser } from "./render-context.js";
import { parseNodeRef, formatNodeRef, type DefinitionNodeRef } from "./node-ref.js";
import { ToolError } from "./types.js";
import { getBrowser, type Browser, type BrowserKind, type Page } from "./browser.js";

export { __setBrowserForTests, __resetBrowserForTests } from "./browser.js";
export { resolveViewport, type Viewport } from "./render-context.js";

export type GetScreenshotInput = {
  /** Exactly one of `screen` or `mockup`+`variant` is required. */
  screen?: string;
  /**
   * Node ref, same addressing as every other tool: `"<screen>.<node-id>"`
   * (its screen must match `screen`), or `"component:<name>#<variant>.<node-id>"`
   * / `"pattern:<name>.<node-id>"` for a design-system definition — the
   * latter stands alone and takes neither `screen` nor `mockup`/`variant`.
   * Crops to that element's bounding box plus `NODE_SCREENSHOT_PADDING_PX`
   * on each side.
   */
  node?: string;
  /** deviceScaleFactor, clamped to 1-3. Higher = sharper but more tokens once the image reaches a model. */
  scale?: number;
  mockup?: string;
  variant?: string;
  /** Mockup viewport width in px, default 390. Not valid with `screen`. */
  width?: number;
  /** Which installed browser renders the capture (cross-browser check); default is the first one discovered. */
  browser?: BrowserKind;
};

export type ScreenshotResult = {
  /** Marker read by the MCP server to emit an image content block instead of JSON text. */
  __image: { data: string; mimeType: "image/png" };
  width: number;
  height: number;
  /** Browser name and version that rendered the image — engines differ slightly in pixels. */
  browser: string;
};

function clampScale(scale: number | undefined): number {
  if (scale === undefined) return 1;
  return Math.min(3, Math.max(1, scale));
}

const MIN_MOCKUP_WIDTH = 200;
const MAX_MOCKUP_WIDTH = 3000;

/** Validates and clamps `width` (mockup viewport only) — NaN/non-finite is a caller error, out-of-range silently clamps like `clampScale` does for `scale`. Exported for direct unit testing, same as `computeNodeClip`. */
export function clampWidth(width: number | undefined): number {
  if (width === undefined) return DEFAULT_MOCKUP_WIDTH;
  if (!Number.isFinite(width)) {
    throw new ToolError("validation_failed", `width must be a finite number, got ${width}`);
  }
  return Math.round(Math.min(MAX_MOCKUP_WIDTH, Math.max(MIN_MOCKUP_WIDTH, width)));
}

/** Padding added around a node's bounding box before clipping, in CSS px. */
export const NODE_SCREENSHOT_PADDING_PX = 8;

export type ClipRect = { x: number; y: number; width: number; height: number };

/**
 * Expands `box` by `padding` on each side. Left/top are clamped to 0 — a
 * node's box is never scrolled past the document origin right after
 * `setContent` — but right/bottom are left unclamped, even past the current
 * viewport: a node below the fold must still be captured in full, so the
 * caller grows the viewport to fit the result instead of this function
 * truncating it. Pure — no browser involved, so it's unit-testable on its
 * own.
 */
export function computeNodeClip(box: ClipRect, padding: number): ClipRect {
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  return { x, y, width: box.x + box.width + padding - x, height: box.y + box.height + padding - y };
}

export async function getScreenshot(store: Store, input: GetScreenshotInput): Promise<ScreenshotResult> {
  const hasScreen = input.screen !== undefined;
  const hasMockup = input.mockup !== undefined || input.variant !== undefined;
  const ref = input.node !== undefined ? parseNodeRef(input.node) : undefined;

  // A component/pattern node ref is self-addressing (its ref carries the
  // name/variant loadAllDocuments needs) — it stands alone instead of
  // pairing with `screen`, the way a screen node ref must.
  if (ref?.kind === "mockup") {
    throw new ToolError("validation_failed", "get_screenshot takes a mockup as mockup+variant, not a mockup node ref");
  }
  if (ref !== undefined && ref.kind !== "screen") {
    if (hasScreen) throw new ToolError("validation_failed", `node "${input.node}" addresses a component/pattern definition, not screen "${input.screen}"`);
    if (hasMockup) throw new ToolError("validation_failed", "node addressing a component/pattern definition is not valid together with mockup");
    if (input.width !== undefined) throw new ToolError("validation_failed", "width is only valid together with mockup, not a definition node");
    return screenshotDefinition(store, ref, clampScale(input.scale), input.browser);
  }

  if (hasScreen === hasMockup) {
    throw new ToolError("validation_failed", "exactly one of screen or mockup+variant is required");
  }

  if (hasMockup) {
    if (input.mockup === undefined || input.variant === undefined) {
      throw new ToolError("validation_failed", "mockup and variant are both required together");
    }
    if (input.node !== undefined) {
      throw new ToolError("validation_failed", "node is only valid together with screen, not mockup");
    }
    return screenshotMockup(store, input.mockup, input.variant, clampWidth(input.width), clampScale(input.scale), input.browser);
  }

  if (input.width !== undefined) {
    throw new ToolError(
      "validation_failed",
      "width is only valid together with mockup, not screen — a screen renders at its root element's declared " +
        "width/height (e.g. style=\"width: 1440px\" on the root, or a $token), default 390x844 when undeclared",
    );
  }
  return screenshotScreen(store, input.screen!, input.node, clampScale(input.scale), input.browser);
}

/**
 * Opens `documentHtml` in a fresh context of the selected browser, hands the
 * loaded page to `capture`, and always closes the context again.
 */
async function withPage<T>(
  documentHtml: string,
  viewport: { width: number; height: number },
  scale: number,
  kind: BrowserKind | undefined,
  capture: (page: Page, browser: Browser) => Promise<T>,
): Promise<T> {
  const browser = await getBrowser(kind);
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
  try {
    const page = await context.newPage();
    await page.setContent(documentHtml);
    return await capture(page, browser);
  } finally {
    await context.close();
  }
}

/** A string expression (evaluated in the page, not this Node process) so this file doesn't need the DOM lib. */
function nodeBoxScript(nodeId: string): string {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(nodeId)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`;
}

/**
 * Clips to `nodeId`'s bounding box plus `NODE_SCREENSHOT_PADDING_PX`. The
 * padded box can extend below/right of the initial viewport (a node past
 * the fold) — the viewport grows to cover it instead of the clip being
 * clamped and the image silently truncated.
 */
async function captureNode(
  page: Page,
  browser: Browser,
  nodeId: string,
  nodeRef: string,
  viewport: { width: number; height: number },
  notFoundHint = "",
): Promise<ScreenshotResult> {
  const box = (await page.evaluate(nodeBoxScript(nodeId))) as ClipRect | null;
  if (!box) {
    throw new ToolError("not_found", `node "${nodeRef}" was not found${notFoundHint}`);
  }
  const clip = computeNodeClip(box, NODE_SCREENSHOT_PADDING_PX);
  if (clip.width <= 0 || clip.height <= 0) {
    throw new ToolError("invalid_state", `node "${nodeRef}" has no visible area to screenshot`);
  }
  const neededWidth = Math.ceil(clip.x + clip.width);
  const neededHeight = Math.ceil(clip.y + clip.height);
  if (neededWidth > viewport.width || neededHeight > viewport.height) {
    await page.setViewportSize({
      width: Math.max(viewport.width, neededWidth),
      height: Math.max(viewport.height, neededHeight),
    });
  }
  return pngResult(await page.screenshot({ clip }), browser);
}

/**
 * width/height come straight from the PNG header (IHDR, bytes 16-23):
 * engines round a fractional clip differently (Chromium rounds, Firefox
 * truncates), so the image itself is the only exact source.
 */
function pngResult(buffer: Buffer, browser: Browser): ScreenshotResult {
  return {
    __image: { data: buffer.toString("base64"), mimeType: "image/png" },
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    browser: browser.name,
  };
}

async function screenshotScreen(
  store: Store,
  screen: string,
  nodeRef: string | undefined,
  scale: number,
  kind: BrowserKind | undefined,
): Promise<ScreenshotResult> {
  let nodeId: string | undefined;
  if (nodeRef) {
    const ref = parseNodeRef(nodeRef);
    // getScreenshot only reaches this function for a screen-kind ref (or no
    // ref at all) — a definition ref is dispatched to screenshotDefinition
    // before screen/nodeRef are ever passed down here.
    if (ref.kind !== "screen") {
      throw new ToolError("validation_failed", `node "${nodeRef}" does not address a node in screen "${screen}"`);
    }
    if (ref.screen !== screen) {
      throw new ToolError("validation_failed", `node "${nodeRef}" belongs to screen "${ref.screen}", not "${screen}"`);
    }
    nodeId = ref.nodeId;
  }

  const { doc, documentHtml, viewport } = await renderScreenForBrowser(store, screen, nodeId);
  // The layer is id-less, so an id that lives in the backdrop is never found — say where it lives.
  const hint = backdropHint(doc);

  return withPage(documentHtml, viewport, scale, kind, async (page, browser) => {
    if (nodeId) return captureNode(page, browser, nodeId, nodeRef!, viewport, hint);
    return pngResult(await page.screenshot(), browser);
  });
}

/**
 * Screenshots a node inside a component variant or pattern definition
 * (ADR-004 §1). Always clips to `ref.nodeId` — there is no "whole document"
 * case the way a bare screen screenshot has, since a definition ref always
 * names a specific node; clipping to the definition's own root node captures
 * the whole rendered variant/pattern.
 */
async function screenshotDefinition(
  store: Store,
  ref: DefinitionNodeRef,
  scale: number,
  kind: BrowserKind | undefined,
): Promise<ScreenshotResult> {
  const { documentHtml, viewport } = await renderDefinitionForBrowser(store, ref);
  const nodeRef = formatNodeRef(ref.address, ref.nodeId);
  return withPage(documentHtml, viewport, scale, kind, (page, browser) => captureNode(page, browser, ref.nodeId, nodeRef, viewport));
}

const DEFAULT_MOCKUP_WIDTH = 390;
const MOCKUP_VIEWPORT_HEIGHT = 844;

/**
 * A mockup variant has no ref model to derive a declared width/height from
 * (ADR-003) — the viewport is always `width`x844 (width defaulting to 390,
 * same as a screen's fallback viewport), and the screenshot is always
 * full-page so content taller than that viewport is still captured in full
 * rather than clipped, matching the mockup's whole point (comparing variants
 * side by side without truncation).
 */
async function screenshotMockup(
  store: Store,
  mockup: string,
  variant: string,
  width: number,
  scale: number,
  kind: BrowserKind | undefined,
): Promise<ScreenshotResult> {
  let documentHtml: string;
  try {
    ({ documentHtml } = await renderMockupDocument(store, mockup, variant, { fontMode: "inline" }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError("not_found", `mockup "${mockup}" variant "${variant}" was not found`);
    }
    throw err;
  }

  const viewport = { width, height: MOCKUP_VIEWPORT_HEIGHT };
  return withPage(documentHtml, viewport, scale, kind, async (page, browser) => {
    // Full-page content can be taller (or, for a desktop-width variant,
    // wider) than the viewport; pngResult reports the size actually captured.
    return pngResult(await page.screenshot({ fullPage: true }), browser);
  });
}
