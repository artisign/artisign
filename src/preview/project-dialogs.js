// Open/init project dialogs: a shared modal folder browser (no path typing
// — a plain browser page can't expose absolute paths any other way). Both
// dialogs share the scrim; only one section is shown at a time. Browsing
// data comes from GET /api/fs/dirs (see api.js); the actual open/init POST
// is owned by app.js, same split as comments.js's reply affordance — this
// module is DOM wiring + directory-tree state only.

import { fetchFsDirs, createFsDir } from "./api.js";
import { captureFocus, handleListArrowKeys, tabbableWithin, trapFocus } from "./menu-keys.js";

/**
 * Wires one dialog section (open or init) to the shared `/api/fs/dirs`
 * browsing logic.
 *
 * @param {HTMLElement} sectionEl
 * @param {{ mode: "open" | "init", onConfirm: (target: { dir: string, name?: string }) => Promise<{ ok: true } | { ok: false, message: string }>, onCancel: () => void }} options
 */
function createBrowser(sectionEl, { mode, onConfirm, onCancel }) {
  const quickChips = sectionEl.querySelectorAll(".quick-chip");
  const breadcrumbsEl = sectionEl.querySelector(".breadcrumbs");
  const dirListEl = sectionEl.querySelector(".dir-list");
  const selectionPathEl = sectionEl.querySelector(".selection-path");
  const errorEl = sectionEl.querySelector(".dialog-error");
  const confirmButton = sectionEl.querySelector(".btn-confirm");
  const cancelButton = sectionEl.querySelector(".btn-cancel");
  const nameInput = sectionEl.querySelector(".field-name-input");
  const newFolderButton = sectionEl.querySelector(".btn-new-folder");

  let currentPath = null;
  let homePath = null;
  let workspacePath = null; // ~/Workspace — null until checked, false once checked-and-absent
  let selectedProjectPath = null; // "open" mode only: a badged row the user picked
  let createdFolderPath = null; // the folder "New folder" just made: badged "new" and highlighted until the user navigates away
  let newFolderRowEl = null; // the inline create row while it is open

  /** @param {string} path */
  function displayPath(path) {
    if (homePath && path === homePath) return "~";
    if (homePath && path.startsWith(`${homePath}/`)) return `~${path.slice(homePath.length)}`;
    return path;
  }

  function updateHint() {
    if (mode === "open") {
      selectionPathEl.textContent = selectedProjectPath ? displayPath(selectedProjectPath) : "—";
      confirmButton.disabled = !selectedProjectPath;
    } else {
      const target = initTargetDir();
      selectionPathEl.textContent = target ? displayPath(target) : "—";
      confirmButton.disabled = !nameInput.value.trim();
    }
  }

  /**
   * The folder /api/projects/init scaffolds into: a folder named after the
   * project, inside the folder "New folder" just made and selected, else
   * inside the current one. `name` alone never creates a subfolder server-side.
   * @returns {string | null}
   */
  function initTargetDir() {
    const name = nameInput.value.trim();
    if (!name) return null;
    const parent = createdFolderPath ?? currentPath;
    // The parent is "/" at the filesystem root — joining naively would give "//name".
    return `${parent === "/" ? "" : parent}/${name}`;
  }

  function renderQuickChips() {
    for (const chip of quickChips) {
      const target = chip.dataset.quick === "home" ? homePath : chip.dataset.quick === "workspace" ? workspacePath : `${homePath}/Desktop`;
      chip.hidden = chip.dataset.quick === "workspace" && !workspacePath;
      chip.setAttribute("aria-current", String(target === currentPath));
    }
  }

  function renderBreadcrumbs() {
    breadcrumbsEl.innerHTML = "";
    // The chain starts at the filesystem root, not at the first segment of
    // currentPath — without a root crumb every path outside the home tree
    // (/private/tmp, /Volumes, an external drive) is unreachable, since the
    // browser is the only way to name an absolute path.
    const crumbs = [{ label: "/", path: "/" }];
    let acc = "";
    for (const segment of currentPath.split("/").filter(Boolean)) {
      acc += `/${segment}`;
      crumbs.push({ label: segment, path: acc });
    }
    crumbs.forEach(({ label, path }, i) => {
      // No separator after the root crumb — it already reads as one.
      if (i > 1) {
        const sep = document.createElement("span");
        sep.className = "crumb-sep icon";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "chevron_right";
        breadcrumbsEl.appendChild(sep);
      }
      // The current crumb is plain text; the ones above it are buttons (Tab-reachable).
      const isCurrent = i === crumbs.length - 1;
      const crumb = document.createElement(isCurrent ? "span" : "button");
      if (!isCurrent) crumb.type = "button";
      crumb.className = "crumb";
      crumb.textContent = label;
      if (isCurrent) {
        crumb.classList.add("crumb-current");
      } else {
        crumb.addEventListener("click", () => loadPath(path));
      }
      breadcrumbsEl.appendChild(crumb);
    });
  }

  /** @param {{ name: string, path: string, isArtisignProject: boolean }[]} entries */
  function renderDirList(entries) {
    // The rows are rebuilt (navigating into a folder, picking a project): focus that was on a row stays on the same folder, or goes to the first row of the new list so the arrows keep working.
    const wasInList = dirListEl.contains(document.activeElement);
    const restoreFocus = captureFocus(dirListEl, "data-key", () => /** @type {HTMLElement | undefined} */ (dirListEl.querySelector(".dir-row:not(:disabled)") ?? undefined));
    dirListEl.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dir-list-empty";
      empty.textContent = "No subfolders.";
      dirListEl.appendChild(empty);
      // Focus was on a row that is gone: no rows to land on, so the first sensible control (the New folder button, else the first tabbable) — never <body>.
      if (restoreFocus() === undefined && wasInList) (newFolderButton.disabled ? tabbableWithin(sectionEl)[0] : newFolderButton)?.focus();
      return;
    }
    for (const entry of entries) {
      // A button, so every row is reachable and shows the focus ring; the inert ones (init mode project folders) are disabled.
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dir-row";
      row.dataset.key = entry.path;

      const icon = document.createElement("span");
      icon.className = "dir-row-icon icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "folder";
      row.appendChild(icon);

      const name = document.createElement("span");
      name.className = "dir-row-name";
      name.textContent = entry.name;
      row.appendChild(name);

      if (entry.isArtisignProject) {
        const badge = document.createElement("span");
        badge.className = "dir-row-badge";
        badge.textContent = "project";
        row.appendChild(badge);
      }

      // "open" mode: a project folder is the thing you pick, not a folder
      // you drill into. "init" mode: a project folder can't be a target
      // (per spec) — so it's inert, neither selectable nor navigable.
      if (entry.path === createdFolderPath) {
        row.classList.add("dir-row-selected", "dir-row-created");
        // The created row stays selected until the user clicks away; Enter/Space on it (it holds focus after creating) must not navigate into it.
        const swallowActivation = (evt) => {
          if (evt.key === "Enter" || evt.key === " ") evt.preventDefault();
        };
        row.addEventListener("keydown", swallowActivation);
        row.addEventListener("keyup", swallowActivation);
        const badge = document.createElement("span");
        badge.className = "dir-row-badge dir-row-badge-new";
        badge.textContent = "new";
        row.appendChild(badge);
      }

      if (mode === "open" && entry.isArtisignProject) {
        row.classList.add("dir-row-selectable");
        if (selectedProjectPath === entry.path) row.classList.add("dir-row-selected");
        row.addEventListener("click", () => {
          selectedProjectPath = entry.path;
          renderDirList(entries);
          updateHint();
        });
      } else if (!entry.isArtisignProject) {
        row.classList.add("dir-row-navigable");
        row.addEventListener("click", () => loadPath(entry.path));
      } else {
        row.disabled = true;
      }

      dirListEl.appendChild(row);
    }
    restoreFocus();
  }

  function basename(path) {
    return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  }

  /** @param {string} name @param {{ code?: string, message: string }} failure */
  function newFolderErrorText(name, failure) {
    if (failure.code === "already_exists") return `A folder named \u201C${name}\u201D already exists here.`;
    if (failure.code === "validation_failed") {
      return "Folder names can\u2019t start with \u201C.\u201D, contain / or \\, or be empty.";
    }
    if (failure.code === "permission_denied") {
      return `Can\u2019t create a folder in ${basename(currentPath)}: permission denied.`;
    }
    return failure.message;
  }

  function closeNewFolderRow() {
    newFolderRowEl?.remove();
    newFolderRowEl = null;
    newFolderButton.setAttribute("aria-pressed", "false");
  }

  /** Inline row at the top of the list; creates exactly one level inside `currentPath`. */
  function openNewFolderRow() {
    if (newFolderRowEl) {
      newFolderRowEl.querySelector(".new-folder-input").focus();
      return;
    }
    const row = document.createElement("div");
    row.className = "new-folder-row";
    row.innerHTML = `
      <div class="new-folder-line">
        <span class="new-folder-icon icon" aria-hidden="true">chevron_right</span>
        <input type="text" class="new-folder-input chrome-field" placeholder="Folder name" autocomplete="off" aria-label="New folder name" />
        <button type="button" class="new-folder-create chrome-btn chrome-btn--compact">Create</button>
        <button type="button" class="new-folder-cancel chrome-btn chrome-btn--ghost chrome-btn--compact">Cancel</button>
      </div>
      <div class="new-folder-message" hidden></div>`;
    const input = row.querySelector(".new-folder-input");
    const messageEl = row.querySelector(".new-folder-message");
    const createButton = row.querySelector(".new-folder-create");

    let creating = false;
    async function create() {
      if (creating) return;
      creating = true;
      input.disabled = true;
      createButton.disabled = true;
      const name = input.value.trim();
      const result = await createFsDir(currentPath, name);
      if (!result.ok) {
        creating = false;
        input.disabled = false;
        createButton.disabled = false;
        messageEl.textContent = newFolderErrorText(name, result);
        messageEl.hidden = false;
        row.classList.add("new-folder-row-error");
        input.focus();
        return;
      }
      await loadPath(currentPath, { created: result.path });
      dirListEl.querySelector(".dir-row-created")?.focus();
    }

    function dismiss() {
      closeNewFolderRow();
      newFolderButton.focus();
    }

    input.addEventListener("input", () => {
      messageEl.hidden = true;
      row.classList.remove("new-folder-row-error");
    });
    // On the row, not the input: Esc with focus on Create/Cancel must close
    // only the row too — the dialog-level Escape must not also fire.
    row.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && evt.target === input) {
        evt.preventDefault();
        create();
      } else if (evt.key === "Escape") {
        evt.stopPropagation();
        dismiss();
      }
    });
    createButton.addEventListener("click", create);
    row.querySelector(".new-folder-cancel").addEventListener("click", dismiss);

    dirListEl.prepend(row);
    newFolderRowEl = row;
    newFolderButton.setAttribute("aria-pressed", "true");
    input.focus();
  }

  /** @param {string} [path] @param {{ created?: string }} [options] */
  async function loadPath(path, { created = null } = {}) {
    errorEl.hidden = true;
    const result = await fetchFsDirs(path);
    if (!result.ok) {
      errorEl.textContent = result.message;
      errorEl.hidden = false;
      return;
    }
    currentPath = result.path;
    homePath = result.home;
    selectedProjectPath = null;
    createdFolderPath = created;
    newFolderRowEl = null;
    newFolderButton.setAttribute("aria-pressed", "false");

    if (workspacePath === null) {
      const candidate = `${homePath}/Workspace`;
      const check = await fetchFsDirs(candidate);
      workspacePath = check.ok ? candidate : false;
    }

    renderQuickChips();
    renderBreadcrumbs();
    renderDirList(result.entries);
    updateHint();
  }

  for (const chip of quickChips) {
    chip.addEventListener("click", () => {
      const target = chip.dataset.quick === "home" ? homePath : chip.dataset.quick === "workspace" ? workspacePath : `${homePath}/Desktop`;
      if (target) loadPath(target);
    });
  }

  newFolderButton.addEventListener("click", () => {
    if (currentPath) openNewFolderRow();
  });
  nameInput?.addEventListener("input", updateHint);
  // ↑/↓ (Home/End) walk the folder rows, Enter / Space activate the focused one as before. The folder rows stay buttons (CHR-920: a listbox role would fight them); keys typed in the inline "New folder" row are left alone.
  dirListEl.addEventListener("keydown", (evt) => {
    if (!(evt.target instanceof Element) || !evt.target.closest(".dir-row")) return;
    handleListArrowKeys(evt, [...dirListEl.querySelectorAll(".dir-row")].filter((row) => !row.disabled), { wrap: false });
  });
  cancelButton.addEventListener("click", () => onCancel());
  sectionEl.querySelector(".dialog-close")?.addEventListener("click", () => onCancel());

  confirmButton.addEventListener("click", async () => {
    const target = mode === "open" ? { dir: selectedProjectPath } : { dir: initTargetDir(), name: nameInput.value.trim() };
    confirmButton.disabled = true;
    const result = await onConfirm(target);
    confirmButton.disabled = false;
    if (!result.ok) {
      errorEl.textContent = result.message;
      errorEl.hidden = false;
      return;
    }
  });

  /** Resets to a fresh browse from home and shows the section. */
  function reset() {
    errorEl.hidden = true;
    selectedProjectPath = null;
    createdFolderPath = null;
    if (nameInput) nameInput.value = "";
    updateHint();
    loadPath(homePath ?? undefined);
  }

  return { reset };
}

/**
 * @param {{ scrimEl: HTMLElement, openSectionEl: HTMLElement, initSectionEl: HTMLElement, fallbackFocusEl?: HTMLElement }} elements `fallbackFocusEl`: where focus goes on close when the element that opened the dialog is gone or hidden
 * @param {{
 *   onOpen: (dir: string) => Promise<{ ok: true } | { ok: false, message: string }>,
 *   onInit: (dir: string, name: string) => Promise<{ ok: true } | { ok: false, message: string }>,
 * }} callbacks
 */
export function createProjectDialogs({ scrimEl, openSectionEl, initSectionEl, fallbackFocusEl }, { onOpen, onInit }) {
  /** Where focus goes back to when the dialog closes: whatever had it when the dialog opened (CHR-920). */
  /** @type {Element | null} */
  let returnFocusTo = null;

  function hide() {
    scrimEl.hidden = true;
    openSectionEl.hidden = true;
    initSectionEl.hidden = true;
    // The opener can be gone or hidden by now (the empty-state button after a successful open): fall back to the project picker.
    const opener = returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected && !returnFocusTo.closest("[hidden]") && returnFocusTo.checkVisibility?.() !== false ? returnFocusTo : fallbackFocusEl;
    opener?.focus();
    returnFocusTo = null;
  }

  function rememberOpener() {
    const active = document.activeElement;
    returnFocusTo = active && active !== document.body && !scrimEl.contains(active) ? active : returnFocusTo;
  }

  const openBrowser = createBrowser(openSectionEl, {
    mode: "open",
    onConfirm: async ({ dir }) => {
      const result = await onOpen(dir);
      if (result.ok) hide();
      return result;
    },
    onCancel: hide,
  });

  const initBrowser = createBrowser(initSectionEl, {
    mode: "init",
    onConfirm: async ({ dir, name }) => {
      const result = await onInit(dir, name);
      if (result.ok) hide();
      return result;
    },
    onCancel: hide,
  });

  function showOpenDialog() {
    rememberOpener();
    scrimEl.hidden = false;
    openSectionEl.hidden = false;
    initSectionEl.hidden = true;
    openBrowser.reset();
    openSectionEl.querySelector(".quick-chip")?.focus();
  }

  function showInitDialog() {
    rememberOpener();
    scrimEl.hidden = false;
    initSectionEl.hidden = false;
    openSectionEl.hidden = true;
    initBrowser.reset();
    initSectionEl.querySelector(".field-name-input")?.focus();
  }

  scrimEl.addEventListener("click", (evt) => {
    if (evt.target === scrimEl) hide();
  });
  // Modal: Tab and Shift+Tab cycle inside the visible dialog. On the document, not the scrim: focus can be on <body> (a re-render dropped it) and Tab must still come back in.
  document.addEventListener("keydown", (evt) => {
    if (scrimEl.hidden) return;
    const section = [openSectionEl, initSectionEl].find((el) => !el.hidden);
    if (section) trapFocus(evt, section);
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && !scrimEl.hidden) {
      evt.preventDefault(); // consumed: the global shortcut handler must not also leave the mode
      hide();
    }
  });

  return { showOpenDialog, showInitDialog, hide };
}
