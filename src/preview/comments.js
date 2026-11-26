// Comment helpers shared with the activity highlight (activity.js). The
// canvas comment UI itself (pins, popover, comment mode) lives in
// comment-canvas.js (CHR-1248).

const COMMENT_SELECTED_STYLE = "outline: 2px solid #d97706; outline-offset: 1px; cursor: pointer;";

/**
 * A comment's `node_id` is a full `<screen>.<node-id>` ref (see
 * `formatNodeRef`/`parseNodeRef` in src/tools/node-ref.ts and
 * `createComment` in src/tools/comments.ts) — but DOM element ids inside
 * the iframe are always bare (`el.id` has no dots). Every comparison
 * against a DOM id goes through this.
 * @param {string | null} nodeId
 * @returns {string | null}
 */
export function bareNodeId(nodeId) {
  if (nodeId === null) return null;
  const dot = nodeId.indexOf(".");
  return dot === -1 ? nodeId : nodeId.slice(dot + 1);
}

/**
 * Highlights an element by capturing its current inline style and appending
 * an outline style on top, returning a cleanup that restores the original.
 * CHR-631's follow-mode activity highlight uses it with its own read/write
 * styles.
 *
 * @param {Document} doc
 * @param {string | null} nodeId — null highlights the screen root
 * @param {string} [style] — defaults to the comment-selection outline
 * @returns {() => void}
 */
export function highlightSelection(doc, nodeId, style = COMMENT_SELECTED_STYLE) {
  const root = doc.body.firstElementChild;
  const el = nodeId === null ? root : doc.getElementById(nodeId);
  if (!el) return () => {};
  const original = el.getAttribute("style");
  el.setAttribute("style", original ? `${original}; ${style}` : style);
  return () => {
    if (original === null) el.removeAttribute("style");
    else el.setAttribute("style", original);
  };
}
