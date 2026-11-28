// Open/init project dialogs: a modal folder browser (no path typing — a plain browser page can't expose absolute paths any other way). CHR-1272: each is a native <dialog> in the floating look (float-dialog.js) — Escape, the scrim and the close / Cancel buttons close it, the browser traps Tab and focus goes back to the opener. Browsing data comes from GET /api/fs/dirs (see api.js); the actual open/init POST is owned by app.js, same split as comments.js's reply affordance — this module is DOM wiring + directory-tree state only.
//
// The folder list is a listbox of options (design `chrome-list-row`): one tab stop, ↑/↓/Home/End move, Enter / Space / a click act. Open mode: a folder that holds a project is selected by activating it, any other folder is entered. New project: the folder the "New folder" row just made is the selected parent; every other folder is entered, project folders are inert.

import { fetchFsDirs, createFsDir } from "./api.js";
import { captureFocus, handleListArrowKeys, setRovingTabindex, tabbableWithin } from "./menu-keys.js";
import { createModal } from "./float-dialog.js";

/** The name shown in the New project field while it is empty. */
const NAME_PLACEHOLDER = "my-new-project";

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} name */
function icon(name) {
  const node = el("span", "icon", name);
  node.setAttribute("aria-hidden", "true");
  return node;
}

/** The message for an action that failed without an answer (the request itself broke). @param {unknown} err */
function failureMessage(err) {
  return err instanceof Error && err.message ? err.message : "Could not reach artisign. Try again.";
}

/**
 * Wires one dialog (open or init) to the shared `/api/fs/dirs` browsing logic.
 *
 * @param {HTMLElement} dialogEl
 * @param {{ mode: "open" | "init", onConfirm: (target: { dir: string, name?: string }) => Promise<{ ok: true } | { ok: false, message: string }>, onCancel: () => void }} options
 */
function createBrowser(dialogEl, { mode, onConfirm, onCancel }) {
  const quickChips = /** @type {HTMLElement[]} */ ([...dialogEl.querySelectorAll(".quick-chip")]);
  const breadcrumbsEl = /** @type {HTMLElement} */ (dialogEl.querySelector(".breadcrumb-list"));
  const dirListEl = /** @type {HTMLElement} */ (dialogEl.querySelector(".dir-list"));
  const dirEmptyEl = /** @type {HTMLElement} */ (dialogEl.querySelector(".dir-list-empty"));
  const newFolderSlot = /** @type {HTMLElement} */ (dialogEl.querySelector(".new-folder-slot"));
  const hintEl = /** @type {HTMLElement} */ (dialogEl.querySelector(".selection-hint"));
  const errorEl = /** @type {HTMLElement} */ (dialogEl.querySelector(".dialog-error"));
  const confirmButton = /** @type {HTMLButtonElement} */ (dialogEl.querySelector(".btn-confirm"));
  const cancelButton = /** @type {HTMLElement} */ (dialogEl.querySelector(".btn-cancel"));
  const nameInput = /** @type {HTMLInputElement | null} */ (dialogEl.querySelector(".text-field-input"));
  const newFolderButton = /** @type {HTMLButtonElement} */ (dialogEl.querySelector(".btn-new-folder"));

  let currentPath = null;
  let homePath = null;
  let workspacePath = null; // ~/Workspace — null until checked, false once checked-and-absent
  let selectedProjectPath = null; // "open" mode only: a badged row the user picked
  let createdFolderPath = null; // the folder "New folder" just made: marked created and selected until the user navigates away
  let newFolderRowEl = null; // the inline create row while it is open
  let busy = false; // an open / init request is in flight
  let loadSeq = 0; // a later load (or a close) supersedes an earlier one still in flight

  /** @param {string} path */
  function displayPath(path) {
    if (homePath && path === homePath) return "~";
    if (homePath && path.startsWith(`${homePath}/`)) return `~${path.slice(homePath.length)}`;
    return path;
  }

  /**
   * The folder /api/projects/init scaffolds into: a folder named after the project, inside the folder "New folder" just made and selected, else inside the current one. `name` alone never creates a subfolder server-side.
   * @param {string} name
   * @returns {string | null}
   */
  function initTargetDir(name) {
    if (!name) return null;
    const parent = createdFolderPath ?? currentPath;
    if (!parent) return null;
    // The parent is "/" at the filesystem root — joining naively would give "//name".
    return `${parent === "/" ? "" : parent}/${name}`;
  }

  /** The hint is a live region (open): it only changes when what it says changes. @param {string} key @param {(Node | string)[]} parts */
  function setHint(key, parts) {
    if (hintEl.dataset.key === key) return;
    hintEl.dataset.key = key;
    hintEl.replaceChildren(...parts);
  }

  function strong(text) {
    return el("b", "selection-path", text);
  }

  function updateHint() {
    if (mode === "open") {
      const picked = selectedProjectPath ?? createdFolderPath ?? currentPath;
      if (!picked) {
        setHint("", []);
      } else {
        const tail = selectedProjectPath
          ? " Folders that already hold a project carry the Project badge."
          : createdFolderPath
            ? " No project here yet. Browse into a folder that holds one, or create a project from the empty state."
            : " No project here yet.";
        setHint(`${picked}|${tail}`, ["Selected: ", strong(displayPath(picked)), `.${tail}`]);
      }
      confirmButton.disabled = busy || !selectedProjectPath;
      return;
    }
    const name = nameInput?.value.trim() ?? "";
    const parent = createdFolderPath ?? currentPath;
    if (!parent) {
      setHint("", []);
    } else {
      const base = displayPath(parent === "/" ? "" : parent);
      // The placeholder stands in while the name is empty, as the design shows it; the typed name is the strong part.
      setHint(`${base}|${name}`, name ? [`Will create: ${base}/`, strong(name)] : [`Will create: ${base}/${NAME_PLACEHOLDER}`]);
    }
    confirmButton.disabled = busy || !name;
  }

  function renderQuickChips() {
    for (const chip of quickChips) {
      const target = chip.dataset.quick === "home" ? homePath : chip.dataset.quick === "workspace" ? workspacePath : `${homePath}/Desktop`;
      chip.hidden = chip.dataset.quick === "workspace" && !workspacePath;
      chip.setAttribute("aria-pressed", String(target === currentPath));
    }
  }

  function renderBreadcrumbs() {
    breadcrumbsEl.replaceChildren();
    // The chain starts at the filesystem root, not at the first segment of currentPath — without a root crumb every path outside the home tree (/private/tmp, /Volumes, an external drive) is unreachable, since the browser is the only way to name an absolute path.
    const crumbs = [{ label: "/", path: "/" }];
    let acc = "";
    for (const segment of currentPath.split("/").filter(Boolean)) {
      acc += `/${segment}`;
      crumbs.push({ label: segment, path: acc });
    }
    crumbs.forEach(({ label, path }, i) => {
      // The current crumb is plain text; the ones above it are buttons (Tab-reachable). The chevrons between crumbs are drawn by CSS (none after the root crumb: it already reads as a separator).
      const isCurrent = i === crumbs.length - 1;
      const item = el("li", i > 1 ? "crumb-item crumb-item--sep" : "crumb-item");
      if (isCurrent) {
        item.setAttribute("aria-current", "location");
        item.classList.add("crumb-current");
        item.textContent = label;
      } else {
        const button = el("button", "crumb", label);
        button.type = "button";
        button.addEventListener("click", () => void loadPath(path));
        item.append(button);
      }
      breadcrumbsEl.append(item);
    });
    // A deep path overflows the row: it scrolls to its end, where the current folder is.
    breadcrumbsEl.parentElement.scrollLeft = breadcrumbsEl.parentElement.scrollWidth;
  }

  /** @returns {HTMLElement[]} the options a key can land on */
  const optionRows = () => /** @type {HTMLElement[]} */ ([...dirListEl.querySelectorAll('[role="option"]:not([aria-disabled="true"])')]);

  /** @param {{ name: string, path: string, isArtisignProject: boolean }[]} entries */
  function renderDirList(entries) {
    // The rows are rebuilt (navigating into a folder, picking a project): focus that was on a row stays on the same folder, or goes to the first row of the new list so the arrows keep working.
    const wasInList = dirListEl.contains(document.activeElement);
    const restoreFocus = captureFocus(dirListEl, "data-key", () => optionRows()[0]);
    dirListEl.replaceChildren();
    dirListEl.hidden = entries.length === 0;
    dirEmptyEl.hidden = entries.length > 0;
    if (entries.length === 0) {
      // Focus was on a row that is gone: no rows to land on, so the first sensible control (the New folder button, else the first tabbable) — never <body>.
      if (wasInList) focusFallback();
      return;
    }
    for (const entry of entries) {
      const created = entry.path === createdFolderPath;
      const selected = created || (mode === "open" && entry.isArtisignProject && selectedProjectPath === entry.path);
      // A row is an option of the listbox; focus moves between them with the arrows (roving tab stop, set below).
      const row = el("div", "dir-row");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(selected));
      row.dataset.key = entry.path;
      if (selected) row.classList.add("is-selected");
      row.append(icon("folder"), el("span", "dir-row-name", entry.name));

      if (created) {
        row.classList.add("is-created");
        const badge = el("span", "dir-row-badge dir-row-badge--created");
        badge.append(icon("check"), "Created");
        row.append(badge);
      } else if (entry.isArtisignProject) {
        const badge = el("span", "dir-row-badge");
        badge.append(icon("deployed_code"), "Project");
        row.append(badge);
      }

      // "open" mode: a project folder is the thing you pick, not a folder you drill into. "init" mode: a project folder can't be a target (per spec) — so it's inert, neither selectable nor navigable.
      if (mode === "open" && entry.isArtisignProject) {
        row.classList.add("is-actionable");
        row.addEventListener("click", () => {
          selectedProjectPath = entry.path;
          renderDirList(entries);
          updateHint();
        });
      } else if (!entry.isArtisignProject) {
        row.classList.add("is-actionable");
        row.addEventListener("click", () => void loadPath(entry.path));
      } else {
        row.setAttribute("aria-disabled", "true");
      }
      if (created) {
        // The created row stays selected until the user clicks away; Enter/Space on it (it holds focus after creating) must not navigate into it.
        const swallowActivation = (evt) => {
          if (evt.key === "Enter" || evt.key === " ") evt.preventDefault();
        };
        row.addEventListener("keydown", swallowActivation);
        row.addEventListener("keyup", swallowActivation);
      }
      dirListEl.append(row);
    }
    // The tab stop is set first: an option without a tabindex cannot take the focus the restore below hands it.
    const rows = optionRows();
    setRovingTabindex(rows, rows.find((r) => r.getAttribute("aria-selected") === "true") ?? rows[0]);
    const restored = restoreFocus();
    if (restored) setRovingTabindex(rows, restored);
    else if (wasInList) focusFallback();
  }

  /** Focus was inside the list (a row, or the inline New folder row) and its element is gone: the first folder row, else the New folder button, else the first tabbable — never <body>. */
  function focusFallback() {
    const firstRow = optionRows()[0];
    (firstRow ?? (newFolderButton.disabled ? tabbableWithin(dialogEl)[0] : newFolderButton))?.focus();
  }

  function basename(path) {
    return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  }

  /** @param {string} name @param {{ code?: string, message: string }} failure */
  function newFolderErrorText(name, failure) {
    if (failure.code === "already_exists") return `A folder named “${name}” already exists here.`;
    if (failure.code === "validation_failed") return "Folder names can’t contain / or \\ and can’t be empty, “.” or “..”.";
    if (failure.code === "permission_denied") return `Can’t create a folder in ${basename(currentPath)}: permission denied.`;
    return failure.message;
  }

  function closeNewFolderRow() {
    newFolderRowEl?.remove();
    newFolderRowEl = null;
    newFolderButton.setAttribute("aria-expanded", "false");
  }

  /** Inline row above the list (design `new-folder-row`); creates exactly one level inside `currentPath`. */
  function openNewFolderRow() {
    if (newFolderRowEl) {
      /** @type {HTMLInputElement} */ (newFolderRowEl.querySelector(".new-folder-input")).focus();
      return;
    }
    const row = el("div", "new-folder-row");
    const line = el("div", "new-folder-line");
    const input = el("input", "new-folder-input");
    input.type = "text";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "New folder name");
    const createButton = el("button", "new-folder-create", "Create");
    createButton.type = "button";
    const cancelNew = el("button", "new-folder-cancel", "Cancel");
    cancelNew.type = "button";
    line.append(icon("create_new_folder"), input, createButton, cancelNew);
    const messageEl = el("div", "new-folder-message");
    messageEl.id = `${dialogEl.id}-new-folder-message`;
    messageEl.hidden = true;
    row.append(line, messageEl);

    let creating = false;
    async function create() {
      if (creating) return;
      creating = true;
      const seq = loadSeq;
      input.disabled = true;
      createButton.disabled = true;
      const name = input.value.trim();
      let failure = null;
      try {
        const result = await createFsDir(currentPath, name);
        if (seq !== loadSeq) return; // the dialog was closed (or the folder changed) meanwhile
        if (result.ok) {
          await loadPath(currentPath, { created: result.path });
          dirListEl.querySelector(".is-created")?.focus();
          return;
        }
        failure = newFolderErrorText(name, result);
      } catch (err) {
        failure = failureMessage(err);
      } finally {
        // Never stuck: the row's controls come back on every way out (a created folder replaced the row altogether).
        creating = false;
        if (newFolderRowEl === row) {
          input.disabled = false;
          createButton.disabled = false;
        }
      }
      if (failure === null || newFolderRowEl !== row) return;
      messageEl.replaceChildren(icon("error"), el("span", "new-folder-message-text", failure));
      messageEl.hidden = false;
      row.classList.add("is-error");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", messageEl.id);
      input.focus();
    }

    function dismiss() {
      closeNewFolderRow();
      newFolderButton.focus();
    }

    input.addEventListener("input", () => {
      messageEl.hidden = true;
      messageEl.replaceChildren();
      row.classList.remove("is-error");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    });
    // On the row, not the input: Esc with focus on Create/Cancel must close only the row too — the dialog's own Escape must not also fire.
    row.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && evt.target === input) {
        evt.preventDefault();
        void create();
      } else if (evt.key === "Escape") {
        evt.preventDefault(); // keeps the browser from also closing the dialog
        evt.stopPropagation();
        dismiss();
      }
    });
    createButton.addEventListener("click", () => void create());
    cancelNew.addEventListener("click", dismiss);

    newFolderSlot.append(row);
    newFolderRowEl = row;
    newFolderButton.setAttribute("aria-expanded", "true");
    input.focus();
  }

  /** @param {string} [path] @param {{ created?: string }} [options] */
  async function loadPath(path, { created = null } = {}) {
    const seq = ++loadSeq;
    errorEl.hidden = true;
    try {
      const result = await fetchFsDirs(path);
      if (seq !== loadSeq) return;
      if (!result.ok) {
        errorEl.textContent = result.message;
        errorEl.hidden = false;
        return;
      }
      if (workspacePath === null) {
        const candidate = `${result.home}/Workspace`;
        const check = await fetchFsDirs(candidate);
        if (seq !== loadSeq) return;
        workspacePath = check.ok ? candidate : false;
      }
      currentPath = result.path;
      homePath = result.home;
      selectedProjectPath = null;
      createdFolderPath = created;
      // The new-folder row goes with the old folder; focus that was inside it must land on the new list, not on <body>.
      const rowHadFocus = Boolean(newFolderRowEl?.contains(document.activeElement));
      closeNewFolderRow();
      dirListEl.setAttribute("aria-label", `Folders in ${basename(currentPath)}`);
      renderQuickChips();
      renderBreadcrumbs();
      renderDirList(result.entries);
      if (rowHadFocus && !dialogEl.contains(document.activeElement)) focusFallback();
      updateHint();
    } catch (err) {
      if (seq !== loadSeq) return;
      errorEl.textContent = failureMessage(err);
      errorEl.hidden = false;
    }
  }

  for (const chip of quickChips) {
    chip.addEventListener("click", () => {
      const target = chip.dataset.quick === "home" ? homePath : chip.dataset.quick === "workspace" ? workspacePath : `${homePath}/Desktop`;
      if (target) void loadPath(target);
    });
  }

  newFolderButton.addEventListener("click", () => {
    if (!currentPath) return;
    if (newFolderRowEl) {
      closeNewFolderRow(); // the button toggles: a second press folds the row away
      return;
    }
    openNewFolderRow();
  });
  nameInput?.addEventListener("input", updateHint);
  // ↑/↓ (Home/End) walk the folder options and Enter / Space act on the focused one; keys typed elsewhere are left alone.
  dirListEl.addEventListener("keydown", (evt) => {
    if (!(evt.target instanceof Element) || !evt.target.closest('[role="option"]')) return;
    if ((evt.key === "Enter" || evt.key === " ") && !evt.defaultPrevented) {
      evt.preventDefault();
      /** @type {HTMLElement} */ (evt.target.closest('[role="option"]')).click();
      return;
    }
    handleListArrowKeys(evt, optionRows(), { wrap: false });
  });
  // Roving tab stop: the option that has focus is the one a Tab stop lands on next time.
  dirListEl.addEventListener("focusin", (evt) => {
    const option = evt.target instanceof Element ? evt.target.closest('[role="option"]') : null;
    if (option) setRovingTabindex(optionRows(), /** @type {HTMLElement} */ (option));
  });
  cancelButton.addEventListener("click", () => onCancel());
  dialogEl.querySelector(".dialog-close")?.addEventListener("click", () => onCancel());

  confirmButton.addEventListener("click", async () => {
    if (busy) return;
    const name = nameInput?.value.trim() ?? "";
    const target = mode === "open" ? { dir: selectedProjectPath } : { dir: initTargetDir(name), name };
    if (!target.dir) return;
    busy = true;
    errorEl.hidden = true;
    updateHint();
    /** @type {{ ok: true } | { ok: false, message: string }} */
    let result;
    try {
      result = await onConfirm(/** @type {{ dir: string, name?: string }} */ (target));
    } catch (err) {
      result = { ok: false, message: failureMessage(err) };
    } finally {
      busy = false; // never stuck: the button comes back whether the request answered, failed or threw
    }
    updateHint();
    if (!result.ok) {
      errorEl.textContent = result.message;
      errorEl.hidden = false;
    }
  });

  /** Resets to a fresh browse from home. */
  function reset() {
    clear();
    void loadPath(homePath ?? undefined);
  }

  /** Back to nothing: no stale folders, name, hint or message stay behind a closed dialog, and a request still in flight cannot paint into it. */
  function clear() {
    loadSeq++;
    busy = false;
    currentPath = null;
    selectedProjectPath = null;
    createdFolderPath = null;
    closeNewFolderRow();
    errorEl.hidden = true;
    errorEl.textContent = "";
    if (nameInput) nameInput.value = "";
    dirListEl.replaceChildren();
    dirListEl.hidden = true;
    dirEmptyEl.hidden = true;
    breadcrumbsEl.replaceChildren();
    setHint("", []);
    confirmButton.disabled = true;
  }

  return { reset, clear };
}

/**
 * @param {{ openDialogEl: HTMLDialogElement, initDialogEl: HTMLDialogElement, fallbackFocusEl?: HTMLElement }} elements `fallbackFocusEl`: where focus goes on close when the element that opened the dialog is gone or hidden
 * @param {{
 *   onOpen: (dir: string) => Promise<{ ok: true } | { ok: false, message: string }>,
 *   onInit: (dir: string, name: string) => Promise<{ ok: true } | { ok: false, message: string }>,
 * }} callbacks
 */
export function createProjectDialogs({ openDialogEl, initDialogEl, fallbackFocusEl }, { onOpen, onInit }) {
  // Whatever way a dialog closes (Escape, scrim, buttons, a finished open), what it showed is dropped.
  const openModal = createModal(openDialogEl, { fallbackFocusEl, onClosed: () => openBrowser.clear() });
  const initModal = createModal(initDialogEl, { fallbackFocusEl, onClosed: () => initBrowser.clear() });

  const openBrowser = createBrowser(openDialogEl, {
    mode: "open",
    onConfirm: async ({ dir }) => {
      const result = await onOpen(dir);
      if (result.ok) openModal.hide();
      return result;
    },
    onCancel: () => openModal.hide(),
  });

  const initBrowser = createBrowser(initDialogEl, {
    mode: "init",
    onConfirm: async ({ dir, name }) => {
      const result = await onInit(dir, name ?? "");
      if (result.ok) initModal.hide();
      return result;
    },
    onCancel: () => initModal.hide(),
  });

  function showOpenDialog() {
    if (openModal.show()) openBrowser.reset();
  }

  function showInitDialog() {
    if (initModal.show()) initBrowser.reset();
  }

  function hide() {
    openModal.hide();
    initModal.hide();
  }

  return { showOpenDialog, showInitDialog, hide, isOpen: () => openModal.isOpen() || initModal.isOpen() };
}
