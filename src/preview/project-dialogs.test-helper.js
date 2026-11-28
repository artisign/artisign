// The real open / new-project dialogs of index.html, mounted into the test document, so the folder-browser tests drive the markup the user gets instead of a hand-written stand-in.
import html from "./index.html?raw";

/**
 * Parses index.html and appends copies of the two project dialogs (closed) to the document body.
 *
 * @returns {{ openEl: HTMLDialogElement, initEl: HTMLDialogElement }}
 */
export function mountProjectDialogs() {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const openEl = /** @type {HTMLDialogElement} */ (document.importNode(/** @type {Node} */ (parsed.getElementById("open-project-dialog")), true));
  const initEl = /** @type {HTMLDialogElement} */ (document.importNode(/** @type {Node} */ (parsed.getElementById("init-project-dialog")), true));
  document.body.append(openEl, initEl);
  return { openEl, initEl };
}
