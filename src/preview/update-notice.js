// Update notice (CHR-927, `shell-update-notice`): a toast in the upper right corner, right below the settings trigger (CHR-929) when the daemon reports a newer release. CHR-1272: a `popover="manual"` in the "Notifications" region (top layer, no light dismiss, never takes focus) where the browser has the API, a plain fixed box where it does not; the announcement is a polite status node that only changes when the announced version does. Closing it hides that version for the rest of the local calendar day; the pref (`<day>|<version>`) is daemon-stored, so it holds in every browser, and a newer release shows again at once. Copy only — updating is `artisign update` in a terminal.

import { readStringPref, writeStringPref } from "./prefs.js";
import { createCodeField } from "./clipboard.js";

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
 * @param {{ toastEl: HTMLElement, titleEl: HTMLElement, commandEl: HTMLElement, closeEl: HTMLElement, liveEl: HTMLElement, storage: Storage | null, fallbackFocusEl?: HTMLElement }} els `commandEl` receives the code field; `liveEl` is the always-present polite status node the announcement goes through; `fallbackFocusEl`: where focus goes when the toast closes with focus inside it
 * @returns {{ render: (about: { updateAvailable: boolean, latest?: string } | null) => void }}
 */
export function createUpdateNotice({ toastEl, titleEl, commandEl, closeEl, liveEl, storage, fallbackFocusEl }) {
  const native = typeof toastEl.showPopover === "function";
  commandEl.replaceChildren(createCodeField(UPDATE_COMMAND, { variant: "compact" }));
  /** @type {{ updateAvailable: boolean, latest?: string } | null} */
  let current = null;

  const isShown = () => (native ? toastEl.matches(":popover-open") : toastEl.hasAttribute("data-open"));

  /** @param {boolean} show */
  function setShown(show) {
    if (show === isShown()) return;
    if (native) {
      if (show) toastEl.showPopover();
      else toastEl.hidePopover();
    } else toastEl.toggleAttribute("data-open", show);
  }

  /** Applies the rule to the latest daemon facts: shown only for an available update that was not dismissed today. Called again by the hourly re-read, so a notice dismissed yesterday reappears after midnight. The announcement changes only when the notice appears or names another version, never on a re-read that finds the same. */
  function render(about) {
    current = about;
    const dismissed = Boolean(about?.latest) && readStringPref(storage, UPDATE_DISMISSED_KEY, null) === `${localDay()}|${about.latest}`;
    const show = Boolean(about?.updateAvailable && about.latest) && !dismissed;
    const title = show ? `artisign ${about.latest} is available` : "";
    if (show && titleEl.textContent !== title) titleEl.textContent = title;
    if (liveEl.textContent !== title) liveEl.textContent = title;
    setShown(show);
  }

  closeEl.addEventListener("click", () => {
    if (current?.latest) writeStringPref(storage, UPDATE_DISMISSED_KEY, `${localDay()}|${current.latest}`);
    const hadFocus = toastEl.contains(document.activeElement);
    render(current);
    if (hadFocus) fallbackFocusEl?.focus(); // the focused control is gone with the toast: focus must not fall to <body>
  });

  return { render };
}
