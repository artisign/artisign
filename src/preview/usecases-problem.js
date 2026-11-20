// Use Cases tab — what the tab says when the stored data cannot be read in full, written for the person at the screen
// (the tool errors are written for agents). Two states, both with Retry (the same error-with-Retry pattern as the list's
// "Could not load more" row, CHR-1094):
//   renderLoadProblem — a whole file is unreadable (not JSON, wrong shape): the tab shows this instead of an empty list.
//   renderEntryNotice — single entries of a pool file were skipped: the rest is shown, the notice names what is missing.

import { h, icon } from "./usecases-dom.js";
import { describeLoadProblem, plural } from "./usecases-data.js";

const SHOWN = 5;

/** Fills `el` with the full-panel state for an unreadable file. `onRetry` re-reads everything. */
export function renderLoadProblem(el, { message, onRetry }) {
  const { file, detail } = describeLoadProblem(message);
  el.replaceChildren(
    h(
      "div",
      { class: "uc-problem", role: "alert" },
      icon("warning", "uc-problem-icon"),
      h("h2", { class: "uc-problem-title" }, file ? "A use case file could not be read" : "Use cases could not be loaded"),
      file ? h("p", { class: "uc-problem-file" }, h("code", null, file)) : null,
      h("p", { class: "uc-problem-detail" }, detail),
      h("p", { class: "uc-muted" }, file ? "Nothing is lost. Open the file in a text editor and fix it or remove it, or ask your AI agent to, then press Retry." : "Press Retry. If it keeps failing, look at the terminal where artisign runs."),
      h("button", { type: "button", class: "chrome-btn", dataset: { action: "retry" }, onClick: onRetry }, icon("refresh"), "Retry"),
    ),
  );
}

/** Fills `el` (a notice above the tab's content) for skipped pool entries; hides it when there are none. */
export function renderEntryNotice(el, { warnings, total = warnings.length, onRetry }) {
  el.hidden = warnings.length === 0;
  // A live region is rebuilt only when what it says changes, or a screen reader announces it again on every render.
  const key = JSON.stringify([total, warnings.map((w) => w.message ?? "")]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (warnings.length === 0) {
    el.replaceChildren();
    return;
  }
  const files = [...new Set(warnings.map((w) => /usecases\/[\w./-]+\.json/.exec(w.message ?? "")?.[0]).filter(Boolean))];
  const where = files.length === 1 ? files[0] : "the use case files";
  el.replaceChildren(
    h(
      "div",
      { class: "uc-toast-body" },
      h("strong", null, `${plural(total, "entry", "entries")} in ${where} could not be loaded and ${total === 1 ? "is" : "are"} left out.`),
      h("ul", null, warnings.slice(0, SHOWN).map((w) => h("li", null, w.message ?? String(w)))),
      total > SHOWN ? h("p", { class: "uc-muted" }, `… and ${total - SHOWN} more`) : null,
      h("p", { class: "uc-muted" }, "Everything else still works. Fix or remove the entries in the file (or ask your AI agent to), then press Retry. Saving changes is paused until then."),
    ),
    h("button", { type: "button", class: "uc-link-btn", dataset: { action: "retry" }, onClick: onRetry }, icon("refresh"), "Retry"),
  );
}
