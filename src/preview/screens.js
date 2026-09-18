// Sidebar screen list: search-filterable, each row shows the screen name
// and its tags as chips. Filter state lives in app.js — this module only
// filters/renders what it's given.

// The `$pin-button` design-system component's inline map-pin glyph (CHR-624)
// — a static SVG, not an emoji (poor contrast on the accent fill, and
// inconsistent rendering across OSes, per the component's own usage note).
// Exported so board-view.js's board-tile pin buttons render the identical
// glyph without a second copy of this markup.
export const PIN_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"></path></svg>';

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
 * @param {{ pinned?: Set<string>, onTogglePin?: (screen: string) => void }} [pins]
 *   CHR-624 — omitted entirely (the default) renders no pin button at all,
 *   so every OTHER caller of this widely-used function (and its existing
 *   tests) is unaffected. `pinned` only needs to cover screens actually
 *   rendered here — the sidebar only ever shows filter MATCHES (never a
 *   pinned-but-non-matching screen; that distinction is the board's own
 *   `outside-filter` tile treatment, per the approved design's `board-view`
 *   screen notes — the sidebar list one level up doesn't attempt it).
 */
export function renderScreenList(listEl, screens, activeScreen, onSelect, filter = "", { pinned, onTogglePin } = {}) {
  listEl.innerHTML = "";
  for (const screen of filterScreens(screens, filter)) {
    const li = document.createElement("li");
    li.className = "screen-item-row";

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

    if (onTogglePin) {
      const isPinned = pinned?.has(screen.name) ?? false;
      // A sibling of `button.screen-item`, not a child — two nested
      // interactive elements would be invalid HTML (and unfocusable via
      // keyboard for the inner one in most browsers).
      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = "screen-item-pin pin-button";
      pinButton.classList.toggle("pinned", isPinned);
      pinButton.setAttribute("aria-label", isPinned ? `Unpin ${screen.name}` : `Pin ${screen.name}`);
      pinButton.setAttribute("aria-pressed", String(isPinned));
      pinButton.innerHTML = PIN_ICON_SVG;
      pinButton.addEventListener("click", (evt) => {
        // NOT guarding `button.screen-item`'s own select handler — it's a
        // SIBLING of this button, not an ancestor, so bubbling from here
        // could never reach it regardless. This stops the click at `li`
        // instead, in case a delegated click handler is ever added on the
        // row or the list (review fix 7).
        evt.stopPropagation();
        onTogglePin(screen.name);
      });
      li.appendChild(pinButton);
    }

    listEl.appendChild(li);
  }
}
