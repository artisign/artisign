// Sidebar screen list: search-filterable, each row shows the screen name
// and its tags as chips. Filter state lives in app.js — this module only
// filters/renders what it's given.

/**
 * Case-insensitive substring match over a screen's name and its tags.
 * @param {{ name: string, tags: string[] }[]} screens
 * @param {string} filter
 * @returns {{ name: string, tags: string[] }[]}
 */
export function filterScreens(screens, filter) {
  const needle = filter.trim().toLowerCase();
  if (!needle) return screens;
  return screens.filter(
    (screen) => screen.name.toLowerCase().includes(needle) || screen.tags.some((tag) => tag.toLowerCase().includes(needle)),
  );
}

/**
 * @param {HTMLElement} listEl
 * @param {{ name: string, tags: string[] }[]} screens
 * @param {string | null} activeScreen
 * @param {(screen: string) => void} onSelect
 * @param {string} [filter]
 */
export function renderScreenList(listEl, screens, activeScreen, onSelect, filter = "") {
  listEl.innerHTML = "";
  for (const screen of filterScreens(screens, filter)) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "screen-item";
    button.setAttribute("aria-current", String(screen.name === activeScreen));

    const nameEl = document.createElement("div");
    nameEl.className = "screen-item-name";
    nameEl.textContent = screen.name;
    button.appendChild(nameEl);

    if (screen.tags.length > 0) {
      const tagRow = document.createElement("div");
      tagRow.className = "tag-row";
      for (const tag of screen.tags) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;
        tagRow.appendChild(chip);
      }
      button.appendChild(tagRow);
    }

    button.addEventListener("click", () => onSelect(screen.name));
    li.appendChild(button);
    listEl.appendChild(li);
  }
}
