// What's New (CHR-928, `shell-whats-new`): the CHANGELOG sections of the releases since the last one this user saw, once after an update, and every release on demand from the settings menu. The last seen version is the daemon-stored pref `artisign.whatsNewSeen`; with nothing stored (a fresh install, or the first start of the version that brings this dialog) the running version is only recorded. CHR-1272: a native modal <dialog> in the floating look (float-dialog.js): Escape, the scrim, the close and Close buttons close it, the browser traps Tab, focus goes back to the opener. Release bodies render through markdown.js, which never parses HTML.

import { createModal } from "./float-dialog.js";
import { renderMarkdown } from "./markdown.js";

export const WHATS_NEW_SEEN_KEY = "artisign.whatsNewSeen";

/** @param {string} v */
function parts(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * What to do on boot: `"show"` when the running version is newer than the last seen one, `"record"` when nothing (or something unusable, or a newer version after a downgrade) is stored, `"none"` when it is the running version already.
 *
 * @param {string | null} seen
 * @param {string} running
 * @returns {"show" | "record" | "none"}
 */
export function whatsNewAction(seen, running) {
  if (seen === running) return "none";
  const a = parts(running);
  const b = seen === null ? null : parts(seen);
  if (!a || !b) return "record";
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? "show" : "record";
  return "none";
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {{ version: string, date: string | null, body: string }} release @param {string | null} running the version this daemon runs: its release carries the "Installed" chip */
function releaseSection(release, running) {
  const article = el("article", "whats-new-release");
  const heading = el("h2", "whats-new-heading");
  heading.append(el("span", "whats-new-version", release.version));
  if (release.date) heading.append(el("span", "whats-new-date", release.date));
  if (running !== null && release.version === running) heading.append(el("span", "whats-new-installed", "Installed"));
  const body = el("div", "md whats-new-body");
  body.appendChild(renderMarkdown(release.body));
  article.append(heading, body);
  return article;
}

/**
 * @param {{ dialogEl: HTMLDialogElement, bodyEl: HTMLElement, summaryEl: HTMLElement, closeEl: HTMLElement, doneEl: HTMLElement, fallbackFocusEl?: HTMLElement }} els
 * @returns {{ show: (releases: { version: string, date: string | null, body: string }[], options?: { running?: string | null, onClose?: () => void }) => void, hide: () => void, isOpen: () => boolean }} `running`: the version the daemon runs, for the "Installed" chip
 */
export function createWhatsNewDialog({ dialogEl, bodyEl, summaryEl, closeEl, doneEl, fallbackFocusEl }) {
  /** @type {(() => void) | null} */
  let onCloseOnce = null;

  // Closing by any route runs what the boot check wanted done (recording the version), once, and drops the notes: nothing stale stays in the DOM.
  const modal = createModal(dialogEl, {
    fallbackFocusEl,
    onClosed: () => {
      const done = onCloseOnce;
      onCloseOnce = null;
      bodyEl.replaceChildren();
      summaryEl.textContent = "";
      done?.();
    },
  });

  function show(releases, { running = null, onClose } = {}) {
    if (modal.isOpen()) {
      // Already open (from the menu): closing it still has to record what the boot check wanted recorded.
      if (onClose) onCloseOnce = onClose;
      return;
    }
    bodyEl.replaceChildren(...(releases.length ? releases.map((r) => releaseSection(r, running)) : [el("p", "whats-new-empty", "No release notes are available for this version.")]));
    summaryEl.textContent = releases.length ? `Showing ${releases.length} release${releases.length === 1 ? "" : "s"}. The full history is in CHANGELOG.md.` : "";
    bodyEl.scrollTop = 0;
    onCloseOnce = onClose ?? null;
    modal.show();
  }

  closeEl.addEventListener("click", () => modal.hide());
  doneEl.addEventListener("click", () => modal.hide());

  return { show, hide: modal.hide, isOpen: modal.isOpen };
}
