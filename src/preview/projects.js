// Topbar project picker + no-project empty state. Both render off
// the same `/api/projects` shape ({ active, open, recent }) — kept in one
// module since they're never out of sync with each other, unlike the
// dialogs (project-dialogs.js), which browse the filesystem independently.
//
// The menu is an ARIA menu (CHR-920): role="menu", rows role="menuitem" (the open projects "menuitemradio", the current one checked), opening focuses the first actionable row, ↑/↓/Home/End move between rows with a roving tab stop, Escape closes and puts focus back on the trigger.

import { handleListArrowKeys, setRovingTabindex } from "./menu-keys.js";

/** @typedef {{ active: string | null, open: { root: string, name: string }[], recent: string[] }} ProjectsState */

/** @param {string} path @returns {string} last path segment, for a recent entry's display name (recent only carries paths, not names) */
function baseName(path) {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

/**
 * Abbreviated project root for a menu row's hint: the last two segments behind an ellipsis, so two projects sharing a base name stay distinguishable ("/Users/me/work/acme/design" -> ".../acme/design"). The full path is the row's title.
 *
 * @param {string} path
 * @returns {string}
 */
export function shortPath(path) {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 2 ? `\u2026/${segments.slice(-2).join("/")}` : path;
}

/**
 * @param {{
 *   triggerEl: HTMLElement, nameEl: HTMLElement, menuEl: HTMLElement,
 *   openLabelEl: HTMLElement, openListEl: HTMLElement, dividerEl: HTMLElement,
 *   recentLabelEl: HTMLElement, recentListEl: HTMLElement,
 *   actionOpenEl: HTMLElement, actionInitEl: HTMLElement,
 *   noProjectEl: HTMLElement, bodyEl: HTMLElement,
 *   topbarEl: HTMLElement,
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
    topbarEl,
    emptyRecentListEl,
    emptyBtnOpenEl,
    emptyBtnInitEl,
  } = elements;
  const { onSwitch, onOpenRecent, onOpenDialog, onInitDialog } = callbacks;

  let menuOpen = false;
  /** @type {ProjectsState} */
  let state = { active: null, open: [], recent: [] };

  /** The actionable rows, in order: open projects, recent projects, then the two actions. The current project is plain content and not among them. */
  function menuRows() {
    return /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll("button.chrome-menu-item")]).filter((row) => !row.closest("[hidden]"));
  }

  function closeMenu() {
    // Focus inside the menu would be lost with it: hand it back to the trigger.
    const hadFocus = menuEl.contains(document.activeElement);
    menuOpen = false;
    menuEl.hidden = true;
    triggerEl.setAttribute("aria-expanded", "false");
    if (hadFocus) triggerEl.focus();
  }

  function toggleMenu() {
    if (menuOpen) {
      closeMenu();
      return;
    }
    menuOpen = true;
    menuEl.hidden = false;
    triggerEl.setAttribute("aria-expanded", "true");
    const rows = menuRows();
    setRovingTabindex(rows, rows[0]);
    rows[0]?.focus();
  }

  function renderMenuRow(name, path, isActive, onClick, isOpenProject = false) {
    // The current project is not actionable, so it is plain content, not a focusable button that does nothing.
    const row = document.createElement(isActive ? "div" : "button");
    if (!isActive) row.type = "button";
    row.setAttribute("role", isOpenProject ? "menuitemradio" : "menuitem");
    if (isOpenProject) row.setAttribute("aria-checked", String(isActive));
    row.className = "menu-item chrome-menu-item";
    row.title = path;
    if (isActive) {
      row.classList.add("menu-item-active", "is-current");
      row.setAttribute("aria-current", "true");
    }

    const check = document.createElement("span");
    check.className = "menu-item-check chrome-menu-check icon";
    check.setAttribute("aria-hidden", "true");
    check.textContent = isActive ? "check" : "";
    row.appendChild(check);

    const nameEl2 = document.createElement("span");
    nameEl2.className = "menu-item-name";
    nameEl2.textContent = name;
    row.appendChild(nameEl2);
    const pathEl = document.createElement("span");
    pathEl.className = "menu-item-path chrome-menu-hint";
    pathEl.textContent = shortPath(path);
    row.appendChild(pathEl);

    if (onClick) row.addEventListener("click", onClick);
    return row;
  }

  function renderMenu() {
    openListEl.innerHTML = "";
    for (const project of state.open) {
      const isActive = project.root === state.active;
      openListEl.appendChild(
        renderMenuRow(project.name, project.root, isActive, isActive ? undefined : () => onSwitch(project.root), true),
      );
    }
    openLabelEl.hidden = state.open.length === 0;

    const recentOnly = state.recent.filter((path) => !state.open.some((p) => p.root === path));
    recentListEl.innerHTML = "";
    for (const path of recentOnly) {
      recentListEl.appendChild(renderMenuRow(baseName(path), path, false, () => onOpenRecent(path)));
    }
    recentLabelEl.hidden = recentOnly.length === 0;
    dividerEl.hidden = state.open.length === 0 || recentOnly.length === 0;
  }

  function renderEmptyState() {
    const isEmpty = state.active === null;
    noProjectEl.hidden = !isEmpty;
    bodyEl.hidden = isEmpty;
    topbarEl.classList.toggle("is-empty", isEmpty); // hides every .project-only topbar element
    if (!isEmpty) return;

    emptyRecentListEl.innerHTML = "";
    for (const path of state.recent) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "empty-recent-row";
      const chevron = document.createElement("span");
      chevron.className = "empty-recent-icon icon";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "chevron_right";
      const name = document.createElement("span");
      name.className = "empty-recent-name";
      name.textContent = baseName(path);
      const pathEl = document.createElement("span");
      pathEl.className = "empty-recent-path";
      pathEl.textContent = path;
      row.appendChild(chevron);
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
    nameEl.title = nameEl.textContent; // truncated by CSS when long
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
  menuEl.addEventListener("keydown", (evt) => {
    handleListArrowKeys(evt, menuRows());
  });
  menuEl.addEventListener("focusin", (evt) => {
    const rows = menuRows();
    setRovingTabindex(rows, rows.find((row) => row === evt.target));
  });
  // Tabbing out of the menu closes it (focus is already where the user sent it).
  menuEl.addEventListener("focusout", (evt) => {
    const to = /** @type {Node | null} */ (evt.relatedTarget);
    if (menuOpen && to && !menuEl.contains(to) && to !== triggerEl) closeMenu();
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && menuOpen) {
      // This Escape is consumed here: the global shortcut handler must not also read it as "leave the mode".
      evt.preventDefault();
      closeMenu();
    }
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
