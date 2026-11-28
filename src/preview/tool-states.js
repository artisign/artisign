// CHR-1268 — which tools of the side tool bar apply where. A tool that does not apply is greyed out (`aria-disabled`, still focusable) and its hint says why; nothing is hidden. Pure: app.js hands in the view state and applies the answer.

/**
 * @typedef {{ disabled: boolean, reason: string, name?: string, hint?: string }} ToolState `name` replaces the tool's accessible name and `hint` its tooltip text, for the tools whose words the design spells out (the Board's).
 * @typedef {{ commentsOn: boolean, tileCount: number, openCount: number, edgesOn: boolean, clustersOn: boolean, anyExpanded: boolean }} BoardToolView `commentsOn`: the tile pins are on; `tileCount`: screens on the board; `openCount`: open threads on them; `edgesOn`: flow arrows; `anyExpanded`: a cluster is expanded
 */

const OK = { disabled: false, reason: "" };
const no = (reason, hint) => (hint === undefined ? { disabled: true, reason } : { disabled: true, reason, name: reason, hint });

/** The Board's tools, in the design's words (`board-view*`, `board-comments*`): which apply, and what each says. */
function boardToolStates({ commentsOn, tileCount, openCount, clustersOn, anyExpanded }) {
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
    showResolved: empty
      ? no("Show resolved comments, nothing on the board", nothing)
      : commentsOn
        ? { ...OK, name: "Show resolved comments" }
        : no("Show resolved comments, turn on comments first", "Show resolved comments, turn on comments first"),
    flow: { ...OK, name: "Flow arrows" },
    designSystem: unavailable("Design system"),
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
 * @returns {Record<"comment" | "inspect" | "notes" | "comments" | "flow" | "designSystem", ToolState> & Partial<Record<"showResolved" | "clusters" | "collapseAll", ToolState>>}
 */
export function toolStates({ view, showMockup, comparing, hasScreen, board }) {
  if (view === "usecases" || view === "design-system") {
    const reason = "Not available in this view";
    return { comment: no(reason), inspect: no(reason), notes: no(reason), comments: no(reason), flow: no(reason), designSystem: OK };
  }
  if (view === "board") return boardToolStates(board ?? { commentsOn: false, tileCount: 0, openCount: 0, edgesOn: true, clustersOn: true, anyExpanded: false });
  if (showMockup) {
    const reason = "Not available for mockups";
    return { comment: OK, inspect: no(reason), notes: no(reason), comments: OK, flow: no(reason), designSystem: no(reason) };
  }
  if (comparing) {
    const reason = "Not available while comparing variants";
    return { comment: no(reason), inspect: no(reason), notes: OK, comments: no(reason), flow: OK, designSystem: OK };
  }
  if (!hasScreen) {
    const reason = "No screen is open";
    return { comment: no(reason), inspect: no(reason), notes: no(reason), comments: no(reason), flow: no(reason), designSystem: OK };
  }
  return { comment: OK, inspect: OK, notes: OK, comments: OK, flow: OK, designSystem: OK };
}
