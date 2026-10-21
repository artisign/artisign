// Open/init project dialogs: a shared modal folder browser (no path typing
// — a plain browser page can't expose absolute paths any other way). Both
// dialogs share the scrim; only one section is shown at a time. Browsing
// data comes from GET /api/fs/dirs (see api.js); the actual open/init POST
// is owned by app.js, same split as comments.js's reply affordance — this
// module is DOM wiring + directory-tree state only.

import { fetchFsDirs, createFsDir } from "./api.js";

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
  let createdFolderPath = null; // the folder "+ New folder" just made: badged "new" and highlighted until the user navigates away
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
      const name = nameInput.value.trim();
      // currentPath is "/" at the filesystem root —
      // joining naively would render the hint as "//my-project".
      const prefix = currentPath === "/" ? "" : currentPath;
      selectionPathEl.textContent = name ? displayPath(`${prefix}/${name}`) : "—";
      confirmButton.disabled = !name;
    }
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
        sep.className = "crumb-sep";
        sep.textContent = "/";
        breadcrumbsEl.appendChild(sep);
      }
      const crumb = document.createElement("span");
      crumb.className = "crumb";
      crumb.textContent = label;
      if (i === crumbs.length - 1) {
        crumb.classList.add("crumb-current");
      } else {
        crumb.addEventListener("click", () => loadPath(path));
      }
      breadcrumbsEl.appendChild(crumb);
    });
  }

  /** @param {{ name: string, path: string, isArtisignProject: boolean }[]} entries */
  function renderDirList(entries) {
    dirListEl.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dir-list-empty";
      empty.textContent = "No subfolders.";
      dirListEl.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "dir-row";

      const icon = document.createElement("span");
      icon.className = "dir-row-icon";
      icon.textContent = "\u{1F4C1}"; // 📁
      row.appendChild(icon);

      const name = document.createElement("span");
      name.className = "dir-row-name";
      name.textContent = entry.name;
      row.appendChild(name);

      if (entry.isArtisignProject) {
        const badge = document.createElement("span");
        badge.className = "dir-row-badge";
        badge.textContent = "artisign project";
        row.appendChild(badge);
      }

      // "open" mode: a project folder is the thing you pick, not a folder
      // you drill into. "init" mode: a project folder can't be a target
      // (per spec) — so it's inert, neither selectable nor navigable.
      if (entry.path === createdFolderPath) {
        row.classList.add("dir-row-selected");
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
      }

      dirListEl.appendChild(row);
    }
  }

  function basename(path) {
    return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  }

  /** @param {string} name @param {{ code?: string, message: string }} failure */
  function newFolderErrorText(name, failure) {
    if (failure.code === "already_exists") return `A folder named \u201C${name}\u201D already exists here.`;
    if (failure.code === "validation_failed") {
      return "Folder names can\u2019t contain / or \\ and can\u2019t be empty, \u201C.\u201D or \u201C..\u201D.";
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
        <span class="new-folder-icon">\u25B8</span>
        <input type="text" class="new-folder-input" placeholder="Folder name" autocomplete="off" aria-label="New folder name" />
        <button type="button" class="new-folder-create">Create</button>
        <button type="button" class="new-folder-cancel">Cancel</button>
      </div>
      <div class="new-folder-message" hidden></div>`;
    const input = row.querySelector(".new-folder-input");
    const messageEl = row.querySelector(".new-folder-message");

    async function create() {
      const name = input.value.trim();
      const result = await createFsDir(currentPath, name);
      if (!result.ok) {
        messageEl.textContent = newFolderErrorText(name, result);
        messageEl.hidden = false;
        row.classList.add("new-folder-row-error");
        return;
      }
      await loadPath(currentPath, { created: result.path });
    }

    input.addEventListener("input", () => {
      messageEl.hidden = true;
      row.classList.remove("new-folder-row-error");
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        create();
      } else if (evt.key === "Escape") {
        // Only the row closes — the dialog-level Escape must not also fire.
        evt.stopPropagation();
        closeNewFolderRow();
      }
    });
    row.querySelector(".new-folder-create").addEventListener("click", create);
    row.querySelector(".new-folder-cancel").addEventListener("click", closeNewFolderRow);

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
  cancelButton.addEventListener("click", () => onCancel());

  confirmButton.addEventListener("click", async () => {
    const target = mode === "open" ? { dir: selectedProjectPath } : { dir: currentPath, name: nameInput.value.trim() };
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
 * @param {{ scrimEl: HTMLElement, openSectionEl: HTMLElement, initSectionEl: HTMLElement }} elements
 * @param {{
 *   onOpen: (dir: string) => Promise<{ ok: true } | { ok: false, message: string }>,
 *   onInit: (dir: string, name: string) => Promise<{ ok: true } | { ok: false, message: string }>,
 * }} callbacks
 */
export function createProjectDialogs({ scrimEl, openSectionEl, initSectionEl }, { onOpen, onInit }) {
  function hide() {
    scrimEl.hidden = true;
    openSectionEl.hidden = true;
    initSectionEl.hidden = true;
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
    scrimEl.hidden = false;
    openSectionEl.hidden = false;
    initSectionEl.hidden = true;
    openBrowser.reset();
  }

  function showInitDialog() {
    scrimEl.hidden = false;
    initSectionEl.hidden = false;
    openSectionEl.hidden = true;
    initBrowser.reset();
  }

  scrimEl.addEventListener("click", (evt) => {
    if (evt.target === scrimEl) hide();
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && !scrimEl.hidden) hide();
  });

  return { showOpenDialog, showInitDialog, hide };
}
