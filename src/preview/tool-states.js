// CHR-1268 — which tools of the side tool bar apply where. A tool that is meant for the current view but cannot act right now is greyed out (`aria-disabled`, still focusable) and its hint says why. A tool that has no function in the view at all is hidden (CHR-1283: `views`). Pure: app.js hands in the view state and applies the answer.

/**
 * The tool bar's config (CHR-1283, CHR-1288), in display order. `group: "canvas"` is for tools that act on the elements of the canvas (the top section), `group: "panel"` for tools that open a panel or switch what a panel shows (the bottom section); the divider sits between the groups. `views` lists the views a tool shows in; without it the tool shows everywhere (greyed where it cannot act). A new tool goes into one of the two groups by the same rule.
 * @typedef {"comment" | "inspect" | "flow" | "clusters" | "collapseAll" | "notes" | "comments" | "showResolved"} ToolKey
 * @type {readonly { key: ToolKey, group: "canvas" | "panel", views?: readonly string[] }[]}
 */
export const TOOLS = [
  { key: "comment", group: "canvas" },
  { key: "inspect", group: "canvas" },
  { key: "flow", group: "canvas" },
  { key: "clusters", group: "canvas", views: ["board"] },
  { key: "collapseAll", group: "canvas", views: ["board"] },
  { key: "notes", group: "panel" },
  { key: "comments", group: "panel" },
  { key: "showResolved", group: "panel", views: ["screens", "board"] },
];

/**
 * Whether a tool shows in a view; a hidden tool takes no space and no key.
 * @param {ToolKey} key
 * @param {string} view "screens" | "board" | "design-system" | "usecases"
 */
export function toolShown(key, view) {
  const tool = TOOLS.find((t) => t.key === key);
  return tool !== undefined && (tool.views === undefined || tool.views.includes(view));
}

/**
 * @typedef {{ disabled: boolean, reason: string, name?: string, hint?: string }} ToolState `name` replaces the tool's accessible name and `hint` its tooltip text, for the tools whose words the design spells out (the Board's).
 * @typedef {{ commentsOn: boolean, tileCount: number, openCount: number, edgesOn: boolean, clustersOn: boolean, anyExpanded: boolean }} BoardToolView `commentsOn`: the tile pins are on; `tileCount`: screens on the board; `openCount`: open threads on them; `edgesOn`: flow arrows; `anyExpanded`: a cluster is expanded
 */

const OK = { disabled: false, reason: "" };
const no = (reason, hint) => (hint === undefined ? { disabled: true, reason } : { disabled: true, reason, name: reason, hint });

/** The Board's tools, in the design's words (`board-view*`, `board-comments*`): which apply, and what each says. */
function boardToolStates({ tileCount, openCount, clustersOn, anyExpanded }) {
  const nothing = "Nothing on the board";
  const unavailable = (tool) => no(`${tool}, not available on the Board`, `${tool}, not available on the Board`);
  const empty = tileCount === 0;
  return {
    comment: no("Comment, read-only on the Board: comment in the Screens view", "Comment, read-only on the Board: comment in the Screens view"),
    inspect: unavailable("Inspect"),
    notes: unavailable("Notes"),
    comments: empty
      ? no("Comments on tiles, nothing on the board", nothing)
      : { ...OK, name: openCount === 0 ? "Comments on tiles" : `Comments on tiles, ${openCount} open` },
    // The toggle is a switch on its own: on or off whatever the data (CHR-1292). Its tooltip (state and count) is app.js's.
    showResolved: { ...OK, name: "Show resolved comments" },
    flow: { ...OK, name: "Flow arrows" },
    clusters: { ...OK, name: "Clusters" },
    collapseAll: empty
      ? no("Collapse all clusters, nothing on the board", nothing)
      : !clustersOn
        ? no("Collapse all clusters, clusters are off", "Clusters are off")
        : !anyExpanded
          ? no("Collapse all clusters, all are collapsed", "All clusters are collapsed")
          : { ...OK, name: "Collapse all clusters" },
  };
}

/**
 * @param {{ view: string, showMockup: boolean, comparing: boolean, hasScreen: boolean, board?: BoardToolView }} where `showMockup`: a mockup shows in the Screens view; `comparing`: Compare is on; `hasScreen`: a screen is open; `board`: the Board's state (only read there)
 * @returns {Record<"comment" | "inspect" | "notes" | "comments" | "flow", ToolState> & Partial<Record<"showResolved" | "clusters" | "collapseAll", ToolState>>}
 */
export function toolStates({ view, showMockup, comparing, hasScreen, board }) {
  if (view === "usecases" || view === "design-system") {
    const reason = "Not available in this view";
    return { comment: no(reason), inspect: no(reason), notes: no(reason), comments: no(reason), flow: no(reason) };
  }
  if (view === "board") return boardToolStates(board ?? { commentsOn: false, tileCount: 0, openCount: 0, edgesOn: true, clustersOn: true, anyExpanded: false });
  if (showMockup) {
    const reason = "Not available for mockups";
    return { comment: OK, inspect: no(reason), notes: no(reason), comments: OK, flow: no(reason), showResolved: OK };
  }
  if (comparing) {
    const reason = "Not available while comparing variants";
    return { comment: no(reason), inspect: no(reason), notes: OK, comments: no(reason), flow: OK, showResolved: no(reason) };
  }
  if (!hasScreen) {
    const reason = "No screen is open";
    return { comment: no(reason), inspect: no(reason), notes: no(reason), comments: no(reason), flow: no(reason), showResolved: no(reason) };
  }
  return { comment: OK, inspect: OK, notes: OK, comments: OK, flow: OK, showResolved: OK };
}
