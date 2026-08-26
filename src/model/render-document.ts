/**
 * The single deterministic render environment.
 *
 * Every surface that shows rendered screen content — the preview screens
 * pane, the design-system pane, and the get_screenshot render — wraps the
 * rendered fragment with this exact document. One source, no divergence:
 * the screenshot is pixel-identical to the preview by construction.
 *
 * The baseline is deliberately tiny. It defines the environment agents can
 * rely on (border-box sizing, zero body margin, antialiasing); it is not a
 * CSS framework. Diagnostic-marker outlines and the Material
 * Symbols `.icon` class live here too so they apply everywhere.
 */
export const RENDER_BASELINE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
[data-unresolved-component], [data-invalid-component], [data-recursive-component],
[data-empty-component], [data-unresolved-token], [data-unresolved-icon-font] {
  outline: 2px solid #e5484d;
  outline-offset: -2px;
  min-height: 8px;
}
.icon {
  font-family: "Material Symbols Rounded";
  font-weight: normal;
  font-style: normal;
  line-height: 1;
  letter-spacing: normal;
  text-transform: none;
  display: inline-block;
  white-space: nowrap;
  direction: ltr;
  -webkit-font-feature-settings: "liga";
  font-feature-settings: "liga";
  user-select: none;
}`;

export type WrapRenderedHtmlOptions = {
  /** `@font-face` rules for the project's cached webfonts. */
  fontFaceCss?: string;
};

/**
 * Wrap a rendered screen/variant fragment in the full deterministic
 * document. The screen root stays the first element child of `<body>`
 * with its id preserved — preview scripts rely on that contract.
 */
export function wrapRenderedHtml(bodyHtml: string, options: WrapRenderedHtmlOptions = {}): string {
  const fontStyle = options.fontFaceCss ? `<style>${options.fontFaceCss}</style>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${RENDER_BASELINE_CSS}</style>${fontStyle}</head><body>${bodyHtml}</body></html>`;
}
