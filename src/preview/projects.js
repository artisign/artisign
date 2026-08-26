// Topbar project picker + no-project empty state. Both render off
// the same `/api/projects` shape ({ active, open, recent }) — kept in one
// module since they're never out of sync with each other, unlike the
// dialogs (project-dialogs.js), which browse the filesystem independently.

/** @typedef {{ active: string | null, open: { root: string, name: string }[], recent: string[] }} ProjectsState */

/** @param {string} path @returns {string} last path segment, for a recent entry's display name (recent only carries paths, not names) */
function baseName(path) {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

/**
 * @param {{
 *   triggerEl: HTMLElement, nameEl: HTMLElement, menuEl: HTMLElement,
 *   openLabelEl: HTMLElement, openListEl: HTMLElement, dividerEl: HTMLElement,
 *   recentLabelEl: HTMLElement, recentListEl: HTMLElement,
 *   actionOpenEl: HTMLElement, actionInitEl: HTMLElement,
 *   noProjectEl: HTMLElement, bodyEl: HTMLElement,
 *   viewTabsEl: HTMLElement, flowToggleEl: HTMLElement, commentToggleEl: HTMLElement,
 *   emptyRecentListEl: HTMLElement, emptyBtnOpenEl: HTMLElement, emptyBtnInitEl: HTMLElement,
 * }} elements
 * @param {{ onSwitch: (root: string) => void, onOpenRecent: (dir: string) => void, onOpenDialog: () => void, onInitDialog: () => void }} callbacks
 */
export function createProjectUI(elements, callbacks) {
  const {
    triggerEl,
    nameEl,
    menuEl,
    openLabelEl,
    openListEl,
    dividerEl,
    recentLabelEl,
    recentListEl,
    actionOpenEl,
    actionInitEl,
    noProjectEl,
    bodyEl,
    viewTabsEl,
    flowToggleEl,
    commentToggleEl,
    emptyRecentListEl,
    emptyBtnOpenEl,
    emptyBtnInitEl,
  } = elements;
  const { onSwitch, onOpenRecent, onOpenDialog, onInitDialog } = callbacks;

  let menuOpen = false;
  /** @type {ProjectsState} */
  let state = { active: null, open: [], recent: [] };

  function closeMenu() {
    menuOpen = false;
    menuEl.hidden = true;
    triggerEl.setAttribute("aria-expanded", "false");
  }

  function toggleMenu() {
    menuOpen = !menuOpen;
    menuEl.hidden = !menuOpen;
    triggerEl.setAttribute("aria-expanded", String(menuOpen));
  }

  function renderMenuRow(name, path, isActive, onClick) {
    const row = document.createElement("div");
    row.className = "menu-item";
    if (isActive) row.classList.add("menu-item-active");

    const check = document.createElement("span");
    check.className = "menu-item-check";
    check.textContent = isActive ? "✓" : ""; // ✓
    row.appendChild(check);

    const body = document.createElement("span");
    body.className = "menu-item-body";
    const nameEl2 = document.createElement("span");
    nameEl2.className = "menu-item-name";
    nameEl2.textContent = name;
    body.appendChild(nameEl2);
    if (path) {
      const pathEl = document.createElement("span");
      pathEl.className = "menu-item-path";
      pathEl.textContent = path;
      body.appendChild(pathEl);
    }
    row.appendChild(body);

    if (onClick) row.addEventListener("click", onClick);
    return row;
  }

  function renderMenu() {
    openListEl.innerHTML = "";
    for (const project of state.open) {
      const isActive = project.root === state.active;
      openListEl.appendChild(
        renderMenuRow(project.name, project.root, isActive, isActive ? undefined : () => onSwitch(project.root)),
      );
    }
    openLabelEl.hidden = state.open.length === 0;

    const recentOnly = state.recent.filter((path) => !state.open.some((p) => p.root === path));
    recentListEl.innerHTML = "";
    for (const path of recentOnly) {
      recentListEl.appendChild(renderMenuRow(path, null, false, () => onOpenRecent(path)));
    }
    recentLabelEl.hidden = recentOnly.length === 0;
    dividerEl.hidden = state.open.length === 0 || recentOnly.length === 0;
  }

  function renderEmptyState() {
    const isEmpty = state.active === null;
    noProjectEl.hidden = !isEmpty;
    bodyEl.hidden = isEmpty;
    viewTabsEl.hidden = isEmpty;
    flowToggleEl.hidden = isEmpty;
    commentToggleEl.hidden = isEmpty;
    if (!isEmpty) return;

    emptyRecentListEl.innerHTML = "";
    for (const path of state.recent) {
      const row = document.createElement("div");
      row.className = "empty-recent-row";
      const name = document.createElement("span");
      name.className = "empty-recent-name";
      name.textContent = baseName(path);
      const pathEl = document.createElement("span");
      pathEl.className = "empty-recent-path";
      pathEl.textContent = path;
      row.appendChild(name);
      row.appendChild(pathEl);
      row.addEventListener("click", () => onOpenRecent(path));
      emptyRecentListEl.appendChild(row);
    }
  }

  /** @param {ProjectsState} next */
  function render(next) {
    state = next;
    const activeProject = state.open.find((p) => p.root === state.active);
    nameEl.textContent = activeProject ? activeProject.name : "No project open";
    triggerEl.classList.toggle("project-picker-empty", state.active === null);
    renderMenu();
    renderEmptyState();
  }

  triggerEl.addEventListener("click", (evt) => {
    evt.stopPropagation();
    toggleMenu();
  });
  document.addEventListener("click", (evt) => {
    if (menuOpen && !menuEl.contains(evt.target) && evt.target !== triggerEl) closeMenu();
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && menuOpen) closeMenu();
  });
  actionOpenEl.addEventListener("click", () => {
    closeMenu();
    onOpenDialog();
  });
  actionInitEl.addEventListener("click", () => {
    closeMenu();
    onInitDialog();
  });
  emptyBtnOpenEl.addEventListener("click", () => onOpenDialog());
  emptyBtnInitEl.addEventListener("click", () => onInitDialog());

  return { render };
}
