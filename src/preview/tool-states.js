// CHR-1268 — which tools of the side tool bar apply where. A tool that does not apply is greyed out (`aria-disabled`, still focusable) and its hint says why; nothing is hidden. Pure: app.js hands in the view state and applies the answer.

/** @typedef {{ disabled: boolean, reason: string }} ToolState */

const OK = { disabled: false, reason: "" };
const no = (reason) => ({ disabled: true, reason });

/**
 * @param {{ view: string, showMockup: boolean, comparing: boolean, hasScreen: boolean }} where `showMockup`: a mockup shows in the Screens view; `comparing`: Compare is on; `hasScreen`: a screen is open
 * @returns {Record<"comment" | "inspect" | "notes" | "comments" | "flow" | "designSystem", ToolState>}
 */
export function toolStates({ view, showMockup, comparing, hasScreen }) {
  if (view === "usecases" || view === "design-system") {
    const reason = "Not available in this view";
    return { comment: no(reason), inspect: no(reason), notes: no(reason), comments: no(reason), flow: no(reason), designSystem: OK };
  }
  if (view === "board") {
    const reason = "Not available on the Board";
    return { comment: no(reason), inspect: no(reason), notes: no(reason), comments: no(reason), flow: OK, designSystem: OK };
  }
  if (showMockup) {
    const reason = "Not available for mockups";
    return { comment: OK, inspect: no(reason), notes: no(reason), comments: OK, flow: no(reason), designSystem: OK };
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
