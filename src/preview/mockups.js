// Sidebar mockup list: a separate, always-distinct section below the screen
// list. Filter state lives in app.js (shared with the screen filter) — this
// module only filters/renders what it's given, same split as screens.js.

/**
 * Case-insensitive substring match over a mockup's name, its title and its
 * tags — same shape as `filterScreens` in screens.js.
 * @param {{ name: string, title?: string, tags?: string[] }[]} mockups
 * @param {string} filter
 * @returns {{ name: string, title?: string, tags?: string[] }[]}
 */
export function filterMockups(mockups, filter) {
  const needle = filter.trim().toLowerCase();
  if (!needle) return mockups;
  return mockups.filter(
    (mockup) =>
      mockup.name.toLowerCase().includes(needle) ||
      (mockup.title ?? "").toLowerCase().includes(needle) ||
      (mockup.tags ?? []).some((tag) => tag.toLowerCase().includes(needle)),
  );
}

/**
 * @param {HTMLElement} listEl
 * @param {{ name: string, title?: string, tags?: string[], variants: unknown[] }[]} mockups
 * @param {{ activeName: string | null, onSelect: (name: string) => void }} options
 */
export function renderMockupList(listEl, mockups, { activeName, onSelect }) {
  listEl.innerHTML = "";
  for (const mockup of mockups) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mockup-item";
    button.setAttribute("aria-current", String(mockup.name === activeName));

    const nameRow = document.createElement("div");
    nameRow.className = "mockup-item-name-row";
    const nameEl = document.createElement("span");
    nameEl.className = "mockup-item-name";
    nameEl.textContent = mockup.title ?? mockup.name;
    nameRow.appendChild(nameEl);
    const badge = document.createElement("span");
    badge.className = "mockup-item-badge";
    badge.textContent = "Mockup";
    nameRow.appendChild(badge);
    button.appendChild(nameRow);

    const sub = document.createElement("div");
    sub.className = "mockup-item-sub";
    const count = mockup.variants.length;
    sub.textContent = `${count} variant${count === 1 ? "" : "s"}`;
    button.appendChild(sub);

    const tags = mockup.tags ?? [];
    if (tags.length > 0) {
      const tagRow = document.createElement("div");
      tagRow.className = "tag-row";
      for (const tag of tags) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;
        tagRow.appendChild(chip);
      }
      button.appendChild(tagRow);
    }

    button.addEventListener("click", () => onSelect(mockup.name));
    li.appendChild(button);
    listEl.appendChild(li);
  }
}
