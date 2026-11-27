// CHR-1268 — the Comments tool's thread list (design `comments-panel`): the shown scope's threads in the right column, Open | Resolved, a row per thread; a row opens that thread's pin popover on the canvas. Pure rendering — app.js owns the data and hands in `onOpen`.

import { icon } from "./icons.js";
import { authorLabel, bareId, numberThreads, relativeTime, threadKind } from "./comment-canvas.js";

/**
 * @typedef {{ id: string, node_id: string | null, author: "human" | "agent", agent?: string, status: "open" | "resolved", detached: boolean, variant?: string }} PanelThread
 * @typedef {{ id: string, text: string, author: "human" | "agent", agent?: string, parent_id: string | null, ts: string }} PanelComment
 * @typedef {{ id: string, number: number, kind: "open" | "detached" | "resolved", author: "human" | "agent", node: string | null, time: string, preview: string, variant: string | null, label: string }} PanelRow
 */

/**
 * The list rows of one tab. Detached threads come first (they need attention), then the log order; a thread keeps its number across tabs.
 * @param {PanelThread[]} threads in log order
 * @param {PanelComment[]} comments every message of the scope, in log order
 * @param {"open" | "resolved"} tab
 * @param {{ now?: number, variantLabel?: (variant: string) => string }} [opts] `variantLabel` names a mockup variant (its column letter)
 * @returns {PanelRow[]}
 */
export function panelRows(threads, comments, tab, { now = Date.now(), variantLabel } = {}) {
  const numbers = numberThreads(threads);
  const rows = threads
    .filter((t) => (tab === "resolved" ? t.status === "resolved" : t.status === "open"))
    .map((t) => {
      const messages = comments.filter((c) => c.id === t.id || c.parent_id === t.id);
      const last = messages[messages.length - 1];
      const kind = threadKind(t);
      const variant = t.variant !== undefined && variantLabel ? variantLabel(t.variant) : null;
      const node = bareId(t.node_id);
      return {
        id: t.id,
        number: /** @type {number} */ (numbers.get(t.id)),
        kind,
        author: t.author,
        node,
        time: relativeTime(last?.ts, now),
        preview: last ? `${authorLabel(last)}: ${last.text}` : "",
        variant,
        label: `Comment ${numbers.get(t.id)}${variant ? ` in variant ${variant}` : ""} on ${node ?? "the whole screen"}${kind === "detached" ? ", detached" : ""}${kind === "resolved" ? ", resolved" : ""}`,
      };
    });
  return [...rows.filter((r) => r.kind === "detached"), ...rows.filter((r) => r.kind !== "detached")];
}

/**
 * The foot line under the list: what a row does, and what detached means.
 * @param {PanelRow[]} rows
 * @param {"open" | "resolved"} tab
 * @returns {string}
 */
export function panelFootText(rows, tab) {
  if (tab === "resolved") return "Resolved threads show as check pins on the canvas. Open one to reopen it.";
  if (rows.some((r) => r.kind === "detached")) return "Detached threads lost their element. Open one to move it or resolve it.";
  return "Select a thread to open it on the canvas. Reply and resolve in its popover.";
}

/**
 * Draws the list.
 * @param {{ tabOpenEl: HTMLElement, tabResolvedEl: HTMLElement, countOpenEl: HTMLElement, countResolvedEl: HTMLElement, listEl: HTMLElement, emptyEl: HTMLElement, footEl: HTMLElement }} els
 * @param {{ threads: PanelThread[], comments: PanelComment[], tab: "open" | "resolved", activeId: string | null, variantLabel?: (variant: string) => string, onOpen: (id: string) => void }} data
 */
export function renderCommentsPanel(els, { threads, comments, tab, activeId, variantLabel, onOpen }) {
  const openCount = threads.filter((t) => t.status === "open").length;
  const resolvedCount = threads.length - openCount;
  els.countOpenEl.textContent = String(openCount);
  els.countResolvedEl.textContent = String(resolvedCount);
  els.tabOpenEl.setAttribute("aria-selected", String(tab === "open"));
  els.tabResolvedEl.setAttribute("aria-selected", String(tab === "resolved"));
  els.tabOpenEl.tabIndex = tab === "open" ? 0 : -1;
  els.tabResolvedEl.tabIndex = tab === "resolved" ? 0 : -1;
  els.listEl.setAttribute("aria-labelledby", tab === "open" ? els.tabOpenEl.id : els.tabResolvedEl.id);

  const rows = panelRows(threads, comments, tab, { variantLabel });
  els.listEl.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "comment-row";
      btn.dataset.thread = row.id;
      btn.dataset.state = row.kind;
      btn.setAttribute("aria-label", `${row.label}: ${row.preview}`);
      btn.setAttribute("aria-current", String(row.id === activeId));
      if (row.id === activeId) btn.classList.add("is-active");

      const num = document.createElement("span");
      num.className = "comment-row-num";
      num.dataset.kind = row.author;
      num.dataset.state = row.kind;
      num.setAttribute("aria-hidden", "true");
      if (row.kind === "resolved") num.append(icon("check"));
      else num.textContent = String(row.number);

      const head = document.createElement("span");
      head.className = "comment-row-head";
      if (row.variant) {
        const letter = document.createElement("span");
        letter.className = "comment-row-variant";
        letter.textContent = row.variant;
        head.append(letter);
      }
      const node = document.createElement("code");
      node.className = "comment-row-node";
      node.textContent = row.node ?? "screen";
      head.append(node);
      if (row.kind === "detached") {
        const tag = document.createElement("span");
        tag.className = "comment-row-tag";
        tag.textContent = "Detached";
        head.append(tag);
      }
      const time = document.createElement("span");
      time.className = "comment-row-time";
      time.textContent = row.time;

      const text = document.createElement("span");
      text.className = "comment-row-text";
      text.textContent = row.preview;

      btn.append(num, head, time, text);
      btn.addEventListener("click", () => onOpen(row.id));
      li.append(btn);
      return li;
    }),
  );

  els.emptyEl.hidden = rows.length > 0;
  els.emptyEl.textContent = tab === "resolved" ? "No resolved comments." : "No open comments. Use Comment to start a thread.";
  els.footEl.hidden = rows.length === 0;
  els.footEl.textContent = panelFootText(rows, tab);
}
