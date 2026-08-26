// Pure geometry/id/formatting helpers for the Elements panel — kept apart
// from inspector.js's DOM wiring so the actual logic is unit-testable
// without a DOM.

/**
 * An element's bounding rect expressed relative to the screen root's rect,
 * rounded to whole pixels. Both rects must come from the SAME (unscaled)
 * iframe document — the preview shell's zoom transform lives one level up,
 * on `#screen-holder`, and never enters this math (mirrors canvas.js).
 * @param {{ left: number, top: number, width: number, height: number }} elRect
 * @param {{ left: number, top: number }} rootRect
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function relativeRect(elRect, rootRect) {
  return {
    x: Math.round(elRect.left - rootRect.left),
    y: Math.round(elRect.top - rootRect.top),
    w: Math.round(elRect.width),
    h: Math.round(elRect.height),
  };
}

/**
 * Resolves a rendered DOM id to the model node it belongs to, against the
 * screen's KNOWN model ids (not a blind split): an exact match wins first
 * (an authored id can itself legitimately contain "--", e.g. a BEM-style
 * "card--wide"); otherwise every "--" split point is tried and the
 * LONGEST prefix that is itself a known model id wins — component
 * instance descendants get synthetic ids of the form
 * `<instance>--<slot>` (see render.ts), and a nested instance can produce
 * more than one "--" (`<outer>--<inner>--<slot>`). Falls back to treating
 * the id as its own (unknown) model id when nothing matches.
 * @param {string} domId
 * @param {Set<string>} modelIds
 * @returns {{ modelId: string, isPart: boolean }}
 */
export function resolveModelId(domId, modelIds) {
  if (modelIds.has(domId)) return { modelId: domId, isPart: false };
  const parts = domId.split("--");
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = parts.slice(0, i).join("--");
    if (modelIds.has(candidate)) return { modelId: candidate, isPart: true };
  }
  return { modelId: domId, isPart: false };
}

/**
 * Parses a `data-unresolved-token` attribute value (comma-separated dot
 * paths — see render.ts) into individual paths.
 * @param {string | null} value
 * @returns {string[]}
 */
export function parseUnresolvedPaths(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Converts a computed `rgb()`/`rgba()` color string to a compact hex (or
 * "transparent"/passthrough) form for display. Anything that isn't a plain
 * rgb(a) string (a named color, `currentcolor`, etc) is returned unchanged.
 * @param {string} value
 * @returns {string}
 */
export function rgbToHex(value) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value ?? "");
  if (!m) return value ?? "";
  const [, r, g, b, a] = m;
  if (a !== undefined && Number(a) === 0) return "transparent";
  const hex = "#" + [r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return a !== undefined && Number(a) < 1 ? `${hex} / ${Math.round(Number(a) * 100)}%` : hex;
}

/** @param {string} family a CSS font-family computed value, e.g. `system-ui, -apple-system, sans-serif` */
export function shortFontFamily(family) {
  if (!family) return "";
  return family.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

/** @param {{ x: number, y: number, w: number, h: number }} rect */
export function formatPosition(rect) {
  return `X ${rect.x} · Y ${rect.y} · W ${rect.w} · H ${rect.h}`;
}

/** @param {{ fontFamily: string, fontSize: string, fontWeight: string, lineHeight: string }} computed */
export function formatTypography({ fontFamily, fontSize, fontWeight, lineHeight }) {
  const parts = [shortFontFamily(fontFamily), fontSize, fontWeight].filter(Boolean);
  if (lineHeight && lineHeight !== "normal") parts.push(`lh ${lineHeight}`);
  return parts.join(" · ");
}

/** @param {{ padding: string, margin: string, radius: string }} computed */
export function formatSpacing({ padding, margin, radius }) {
  return `pad ${padding} · margin ${margin} · radius ${radius}`;
}

/**
 * Maps the server's per-node `refs` (the same shape `get_node`'s summary
 * view returns, present on `get_screen`'s "full" view nodes too — see
 * reads.ts) into the Elements panel's entry shape. A node with no `refs`
 * key just gets empty refs.
 * @param {{ id: string, tag: string, refs?: { component_ref?: string, variant?: string, token_refs?: Record<string, unknown> } }[]} nodes
 * @returns {{ id: string, tag: string, componentRef: string | null, variant: string | null, tokenRefs: { property: string, ref: unknown }[] }[]}
 */
export function buildEntries(nodes) {
  return nodes.map((n) => ({
    id: n.id,
    tag: n.tag,
    componentRef: n.refs?.component_ref ?? null,
    variant: n.refs?.variant ?? null,
    tokenRefs: Object.entries(n.refs?.token_refs ?? {}).map(([property, ref]) => ({ property, ref })),
  }));
}
