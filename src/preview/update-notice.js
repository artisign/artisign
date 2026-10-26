// Update notice (CHR-927, `shell-update-notice`): a toast in the upper right corner, right below the settings trigger (CHR-929) when the daemon reports a newer release. Closing it hides that version for the rest of the local calendar day; the pref (`<day>|<version>`) is daemon-stored, so it holds in every browser, and a newer release shows again at once. Copy only — updating is `artisign update` in a terminal.

import { readStringPref, writeStringPref } from "./prefs.js";
import { createCopyChip } from "./clipboard.js";

export const UPDATE_DISMISSED_KEY = "artisign.updateNoticeDismissedOn";
export const UPDATE_COMMAND = "artisign update";

/**
 * The browser-local calendar day as `YYYY-MM-DD`.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * @param {{ toastEl: HTMLElement, titleEl: HTMLElement, commandEl: HTMLElement, closeEl: HTMLElement, storage: Storage | null }} els `commandEl` receives the copy chip
 * @returns {{ render: (about: { updateAvailable: boolean, latest?: string } | null) => void }}
 */
export function createUpdateNotice({ toastEl, titleEl, commandEl, closeEl, storage }) {
  commandEl.replaceChildren(createCopyChip(UPDATE_COMMAND));
  /** @type {{ updateAvailable: boolean, latest?: string } | null} */
  let current = null;

  /** Applies the rule to the latest daemon facts: shown only for an available update that was not dismissed today. Called again by the hourly re-read, so a notice dismissed yesterday reappears after midnight. */
  function render(about) {
    current = about;
    const dismissed = Boolean(about?.latest) && readStringPref(storage, UPDATE_DISMISSED_KEY, null) === `${localDay()}|${about.latest}`;
    const show = Boolean(about?.updateAvailable && about.latest) && !dismissed;
    if (show) titleEl.textContent = `Artisign ${about.latest} is available`;
    toastEl.hidden = !show;
  }

  closeEl.addEventListener("click", () => {
    if (current?.latest) writeStringPref(storage, UPDATE_DISMISSED_KEY, `${localDay()}|${current.latest}`);
    render(current);
  });

  return { render };
}

