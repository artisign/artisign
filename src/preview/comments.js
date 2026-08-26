// Comment mode: click an element in the iframe to anchor a new comment to
// it (or click the screen's root/background to anchor at the screen level,
// node_id: null), and a panel listing existing comments for the current
// screen. Reading/creating goes through api.js; this module is pure DOM
// wiring + rendering, mirroring flows.js.
//
// Comments use the storage-facing record shape (node_id/text/resolved/ts,
// see api.js and src/tools/comments.ts), not the MCP-facing PublicComment
// shape — "resolved" is per-record, so a thread counts as resolved when
// its root OR any reply carries resolved:true (comments.jsonl is
// append-only, so resolution is an event, not a mutation).

const COMMENT_SELECTED_STYLE = "outline: 2px solid #d97706; outline-offset: 1px; cursor: pointer;";
const COMMENT_MARKER_STYLE = "outline: 2px dashed #d97706; outline-offset: 1px; cursor: pointer;";

/**
 * A comment's `node_id` is a full `<screen>.<node-id>` ref (see
 * `formatNodeRef`/`parseNodeRef` in src/tools/node-ref.ts and
 * `createComment` in src/tools/comments.ts) — but DOM element ids inside
 * the iframe are always bare (`el.id` has no dots). Every comparison
 * against a DOM id goes through this.
 * @param {string | null} nodeId
 * @returns {string | null}
 */
function bareNodeId(nodeId) {
  if (nodeId === null) return null;
  const dot = nodeId.indexOf(".");
  return dot === -1 ? nodeId : nodeId.slice(dot + 1);
}

/** @param {{ id: string, parent_id: string | null, node_id: string | null, resolved: boolean }[]} comments */
function threadIsResolved(comments, rootId) {
  return comments.some((c) => (c.id === rootId || c.parent_id === rootId) && c.resolved);
}

/**
 * Bare (DOM-matching) node ids anchoring at least one open (unresolved) thread.
 * @param {{ id: string, parent_id: string | null, node_id: string | null, resolved: boolean }[]} comments
 * @returns {Set<string>}
 */
export function openNodeIds(comments) {
  const roots = comments.filter((c) => c.parent_id === null && c.node_id !== null);
  return new Set(
    roots.filter((root) => !threadIsResolved(comments, root.id)).map((root) => /** @type {string} */ (bareNodeId(root.node_id))),
  );
}

/**
 * Marks elements that anchor an open thread and wires clicks to `onSelect`
 * when comment mode is on. `doc.body.firstElementChild` — the single
 * top-level element every rendered screen has — stands in for "the screen
 * root/background"; clicking it (rather than a nested element) anchors at
 * the screen level (`node_id: null`).
 *
 * @param {Document} doc
 * @param {boolean} enabled
 * @param {Set<string>} openIds — node ids with an open thread (see openNodeIds)
 * @param {(nodeId: string | null) => void} onSelect
 * @returns {() => void} cleanup, removes listeners and outlines
 */
export function applyCommentMode(doc, enabled, openIds, onSelect) {
  if (!enabled) return () => {};

  const root = doc.body.firstElementChild;

  /** @param {Event} evt */
  function handleClick(evt) {
    const el = /** @type {HTMLElement} */ (evt.target).closest("[id]");
    if (!el) return;
    evt.preventDefault();
    onSelect(el === root ? null : el.id);
  }
  doc.addEventListener("click", handleClick, true);

  const markedElements = root ? Array.from(doc.querySelectorAll("[id]")).filter((el) => openIds.has(el.id)) : [];
  const originalStyles = markedElements.map((el) => el.getAttribute("style"));
  for (const el of markedElements) {
    const original = el.getAttribute("style");
    el.setAttribute("style", original ? `${original}; ${COMMENT_MARKER_STYLE}` : COMMENT_MARKER_STYLE);
  }

  return () => {
    doc.removeEventListener("click", handleClick, true);
    markedElements.forEach((el, i) => {
      const original = originalStyles[i];
      if (original === null) el.removeAttribute("style");
      else el.setAttribute("style", original);
    });
  };
}

/**
 * Decides what a comment-mode selection becomes after an SSE-triggered
 * iframe reload. A selection only survives a reload of the SAME
 * screen it was made on (`selectionScreen === reloadedScreen`) — node ids
 * are only unique within one screen, so a reload of a DIFFERENT screen must
 * drop it even if a same-named id happens to exist there too. This also
 * covers a screen switch racing a click on the still-attached old screen's
 * document: that click tags the selection with the screen it actually
 * fired on (see app.js's selectCommentTarget/restoreSelection), not
 * whichever screen the app has since switched to, so the mismatch is
 * caught here rather than only by app.js eagerly clearing on switch. Within
 * the same screen, a screen-level target (`null`) always survives — the
 * screen root itself is never gone — a node target survives only if its id
 * is still present in the reloaded document, and "nothing was selected"
 * (`undefined`) stays that way.
 * @param {{
 *   selectedNode: string | null | undefined,
 *   selectionScreen: string | null,
 *   reloadedScreen: string | null,
 *   nodeExists: boolean, // whether `selectedNode` (when a string) is still present in the reloaded document; ignored otherwise
 * }} params
 * @returns {string | null | undefined}
 */
export function resolveSelectionAfterReload({ selectedNode, selectionScreen, reloadedScreen, nodeExists }) {
  if (selectedNode === undefined) return undefined;
  if (selectionScreen !== reloadedScreen) return undefined;
  if (selectedNode === null) return null;
  return nodeExists ? selectedNode : undefined;
}

/**
 * Highlights the currently selected comment target (the element the
 * compose form will post to) so the human can see what they're commenting
 * on. Returns a cleanup that restores the element's original style.
 *
 * @param {Document} doc
 * @param {string | null} nodeId — null highlights the screen root
 * @returns {() => void}
 */
export function highlightSelection(doc, nodeId) {
  const root = doc.body.firstElementChild;
  const el = nodeId === null ? root : doc.getElementById(nodeId);
  if (!el) return () => {};
  const original = el.getAttribute("style");
  el.setAttribute("style", original ? `${original}; ${COMMENT_SELECTED_STYLE}` : COMMENT_SELECTED_STYLE);
  return () => {
    if (original === null) el.removeAttribute("style");
    else el.setAttribute("style", original);
  };
}

/**
 * Builds the (initially hidden) inline reply form for a root comment's
 * thread, and the toggle button that shows it. `onReply` is called with
 * the thread's root id and the trimmed reply text on submit; the caller
 * (app.js) owns the actual POST and decides how to surface a failure.
 *
 * @param {string} rootId
 * @param {(rootId: string, text: string, onError: (message: string) => void) => void} onReply
 * @returns {HTMLElement}
 */
function renderReplyAffordance(rootId, onReply) {
  const wrapper = document.createElement("div");
  wrapper.className = "comment-reply-affordance";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "comment-reply-toggle";
  toggle.textContent = "Reply";
  wrapper.appendChild(toggle);

  const form = document.createElement("form");
  form.className = "comment-reply-form";
  form.hidden = true;

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Write a reply…";
  textarea.required = true;
  form.appendChild(textarea);

  const error = document.createElement("p");
  error.className = "comment-reply-error";
  error.hidden = true;
  form.appendChild(error);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Reply";
  form.appendChild(submit);

  wrapper.appendChild(form);

  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) textarea.focus();
  });

  form.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    error.hidden = true;
    onReply(rootId, text, (message) => {
      error.textContent = message;
      error.hidden = false;
    });
  });

  return wrapper;
}

/** @param {{ author: string, text: string, node_id: string | null, resolved: boolean }} comment */
function renderCommentItem(comment, isReply, threadResolved) {
  const item = document.createElement("li");
  item.className = isReply ? "comment-item comment-reply" : "comment-item";

  const meta = document.createElement("div");
  meta.className = "comment-meta";
  const target = comment.node_id ? `on ${bareNodeId(comment.node_id)}` : "on screen";
  meta.textContent = `${comment.author} · ${isReply ? "reply" : target} · ${threadResolved ? "resolved" : "open"}`;
  item.appendChild(meta);

  const body = document.createElement("div");
  body.className = "comment-body";
  body.textContent = comment.text;
  item.appendChild(body);

  return item;
}

/**
 * Renders the comment panel for one screen: root comments with their
 * replies indented one level, in the order comments.jsonl was written
 * (append order), not re-sorted. Each thread gets a "Reply" affordance —
 * humans can reply too now that POST /api/comments accepts parent_id; only
 * replying (not resolving/editing/deleting) from the UI, per ticket scope.
 *
 * @param {HTMLElement} listEl
 * @param {{ id: string, parent_id: string | null, node_id: string | null, author: string, text: string, resolved: boolean }[]} comments
 * @param {(rootId: string, text: string, onError: (message: string) => void) => void} [onReply]
 */
export function renderCommentsPanel(listEl, comments, onReply) {
  listEl.innerHTML = "";
  if (comments.length === 0) {
    const empty = document.createElement("li");
    empty.className = "comments-empty";
    empty.textContent = "No comments yet.";
    listEl.appendChild(empty);
    return;
  }

  const repliesByParent = new Map();
  for (const comment of comments) {
    if (comment.parent_id === null) continue;
    const replies = repliesByParent.get(comment.parent_id) ?? [];
    replies.push(comment);
    repliesByParent.set(comment.parent_id, replies);
  }

  for (const root of comments.filter((c) => c.parent_id === null)) {
    const resolved = threadIsResolved(comments, root.id);
    listEl.appendChild(renderCommentItem(root, false, resolved));
    for (const reply of repliesByParent.get(root.id) ?? []) {
      listEl.appendChild(renderCommentItem(reply, true, resolved));
    }
    // The reply affordance comes after the replies it answers, not before —
    // otherwise a thread with existing replies reads oddly (compose box
    // wedged between the question and its answers).
    if (onReply) {
      const affordance = renderReplyAffordance(root.id, onReply);
      affordance.classList.add("comment-reply");
      listEl.appendChild(affordance);
    }
  }
}
