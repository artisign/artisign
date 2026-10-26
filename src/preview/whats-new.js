// What's New (CHR-928, `shell-whats-new`): the CHANGELOG sections of the releases since the last one this user saw, once after an update, and every release on demand from the settings menu. The last seen version is the daemon-stored pref `artisign.whatsNewSeen`; with nothing stored (a fresh install, or the first start of the version that brings this dialog) the running version is only recorded. Same modal conventions as the "Connect AI tools" dialog: Escape, scrim click, the close and Close buttons close it, Tab is trapped, focus goes back to the opener. Release bodies render through markdown.js, which never parses HTML.

import { isShown, trapFocus } from "./menu-keys.js";
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

/** @param {{ version: string, date: string | null, body: string }} release */
function releaseSection(release) {
  const section = el("section", "whats-new-release");
  const heading = el("h2", "whats-new-heading");
  heading.append(el("span", "whats-new-version", release.version));
  if (release.date) heading.append(el("span", "whats-new-date", release.date));
  const body = el("div", "md whats-new-body");
  body.appendChild(renderMarkdown(release.body));
  section.append(heading, body);
  return section;
}

/**
 * @param {{ scrimEl: HTMLElement, bodyEl: HTMLElement, summaryEl: HTMLElement, closeEl: HTMLElement, doneEl: HTMLElement, fallbackFocusEl?: HTMLElement }} els
 * @returns {{ show: (releases: { version: string, date: string | null, body: string }[], onClose?: () => void) => void, hide: () => void, isOpen: () => boolean }}
 */
export function createWhatsNewDialog({ scrimEl, bodyEl, summaryEl, closeEl, doneEl, fallbackFocusEl }) {
  const dialogEl = /** @type {HTMLElement} */ (scrimEl.querySelector("#whats-new-dialog"));
  /** @type {Element | null} */
  let returnFocusTo = null;
  /** @type {(() => void) | null} */
  let onCloseOnce = null;

  const isOpen = () => !scrimEl.hidden;

  function show(releases, onClose) {
    if (isOpen()) return;
    bodyEl.replaceChildren(...(releases.length ? releases.map(releaseSection) : [el("p", "whats-new-empty", "No release notes are available for this version.")]));
    summaryEl.textContent = releases.length ? `Showing ${releases.length} release${releases.length === 1 ? "" : "s"} · full history in CHANGELOG.md` : "";
    bodyEl.scrollTop = 0;
    onCloseOnce = onClose ?? null;
    returnFocusTo = document.activeElement;
    scrimEl.hidden = false;
    dialogEl.focus();
  }

  function hide() {
    if (!isOpen()) return;
    scrimEl.hidden = true;
    (returnFocusTo instanceof HTMLElement && isShown(returnFocusTo) ? returnFocusTo : (fallbackFocusEl ?? document.body)).focus();
    returnFocusTo = null;
    const done = onCloseOnce;
    onCloseOnce = null;
    done?.();
  }

  closeEl.addEventListener("click", hide);
  doneEl.addEventListener("click", hide);
  scrimEl.addEventListener("click", (evt) => {
    if (evt.target === scrimEl) hide();
  });
  document.addEventListener("keydown", (evt) => {
    if (!isOpen()) return;
    trapFocus(evt, dialogEl);
    if (evt.key === "Escape") {
      evt.preventDefault();
      evt.stopImmediatePropagation();
      hide();
    }
  });

  return { show, hide, isOpen };
}
