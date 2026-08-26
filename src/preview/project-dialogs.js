// Open/init project dialogs: a shared modal folder browser (no path typing
// — a plain browser page can't expose absolute paths any other way). Both
// dialogs share the scrim; only one section is shown at a time. Browsing
// data comes from GET /api/fs/dirs (see api.js); the actual open/init POST
// is owned by app.js, same split as comments.js's reply affordance — this
// module is DOM wiring + directory-tree state only.

import { fetchFsDirs } from "./api.js";

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

  let currentPath = null;
  let homePath = null;
  let workspacePath = null; // ~/Workspace — null until checked, false once checked-and-absent
  let selectedProjectPath = null; // "open" mode only: a badged row the user picked

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

  /** @param {string} [path] */
  async function loadPath(path) {
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
