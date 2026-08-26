// A text (not vision) read for geometry/alignment/color questions
// — "is this button 44px tall?", "do these two elements align?" — that
// don't need a full screenshot round-trip through a model's vision tokens.
// Explicitly distinct from reporting geometry on every write (rejected for
// payload bloat + per-write render cost): this is an on-demand
// read, so the render cost is only paid when an agent actually asks.

import type { Store } from "../store/index.js";
import { renderScreenForBrowser, renderDefinitionForBrowser } from "./render-context.js";
import { parseNodeRef } from "./node-ref.js";
import { ToolError } from "./types.js";
import { getBrowser } from "./browser.js";

export type InspectNodeInput = {
  /** Node ref, `"<screen>.<node-id>"` — same addressing as every other tool. */
  node: string;
};

export type NodeBox = { x: number; y: number; width: number; height: number };

export type NodeComputedStyles = {
  display: string;
  position: string;
  margin: string;
  padding: string;
  border: string;
  border_radius: string;
  font_size: string;
  line_height: string;
  font_weight: string;
  color: string;
  background_color: string;
  overflow: string;
};

export type InspectNodeResult = {
  box: NodeBox;
  styles: NodeComputedStyles;
};

/**
 * `CSSStyleDeclaration` key -> response key, curated for geometry/alignment/
 * color checks — the same set `readComputedDetails` in
 * src/preview/inspector.js reads, plus `border` and `overflow`, which that
 * panel doesn't surface but a layout check needs.
 * Deliberately small: response compactness is the point of this tool.
 */
const COMPUTED_STYLE_KEYS: ReadonlyArray<readonly [string, keyof NodeComputedStyles]> = [
  ["display", "display"],
  ["position", "position"],
  ["margin", "margin"],
  ["padding", "padding"],
  ["border", "border"],
  ["borderRadius", "border_radius"],
  ["fontSize", "font_size"],
  ["lineHeight", "line_height"],
  ["fontWeight", "font_weight"],
  ["color", "color"],
  ["backgroundColor", "background_color"],
  ["overflow", "overflow"],
];

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

type PageInspectResult = { box: NodeBox; styles: Record<string, string> } | null;

/** A string expression (evaluated in the page, not this Node process) so this file doesn't need the DOM lib just to reference `document`/`getComputedStyle`. */
function buildInspectScript(nodeId: string): string {
  const cssKeys = COMPUTED_STYLE_KEYS.map(([cssKey]) => cssKey);
  return `(() => {
    const el = document.getElementById(${JSON.stringify(nodeId)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    for (const key of ${JSON.stringify(cssKeys)}) styles[key] = cs[key];
    return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles };
  })()`;
}

export async function inspectNode(store: Store, input: InspectNodeInput): Promise<InspectNodeResult> {
  const ref = parseNodeRef(input.node);
  const nodeId = ref.nodeId;

  const { doc, documentHtml, viewport } =
    ref.kind === "screen" ? await renderScreenForBrowser(store, ref.screen) : await renderDefinitionForBrowser(store, ref);
  // Validated against the parsed model before touching the browser at all —
  // an unknown node never pays the render cost.
  if (!doc.nodes[nodeId]) {
    throw new ToolError("not_found", `node "${input.node}" was not found`);
  }

  const browser = await getBrowser();
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(documentHtml);
    await page.evaluate("document.fonts.ready");

    const result = (await page.evaluate(buildInspectScript(nodeId))) as PageInspectResult;
    if (!result) {
      throw new ToolError("not_found", `node "${input.node}" was not found in the rendered document`);
    }

    const styles = {} as NodeComputedStyles;
    for (const [cssKey, key] of COMPUTED_STYLE_KEYS) styles[key] = result.styles[cssKey] ?? "";

    return {
      box: {
        x: round(result.box.x),
        y: round(result.box.y),
        width: round(result.box.width),
        height: round(result.box.height),
      },
      styles,
    };
  } finally {
    await context.close();
  }
}
