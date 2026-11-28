// Mockups tab of the left card (CHR-1267): the mockup list in the same pattern as the screen tree — stacked-layers icon, name, tag chips, variant count and a collapsible variant tree. Filter state lives in app.js (shared with the screen filter) — this module only filters/renders what it's given, same split as screens.js.

import { icon } from "./icons.js";

/** The key a mockup's expanded state is stored under in the shared expanded set — prefixed so a mockup named like a screen cannot collide with it. */
export function mockupExpandKey(name) {
  return `mockup:${name}`;
}

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
 * @param {{ name: string, title?: string, tags?: string[], variants: { id: string, title: string }[] }[]} mockups
 * @param {{
 *   activeName: string | null,
 *   activeVariant?: string | null,
 *   onSelect: (name: string) => void,
 *   onSelectVariant?: (name: string, variantId: string) => void,
 *   showTags?: boolean,
 *   expanded?: Set<string>,
 *   onToggleExpand?: (key: string) => void,
 * }} options `expanded` holds `mockupExpandKey(name)` entries. A mockup shows all its variants side by side; a variant row opens its mockup with that variant selected (`activeVariant` marks the selected one of the active mockup).
 */
export function renderMockupList(listEl, mockups, { activeName, activeVariant = null, onSelect, onSelectVariant, showTags = true, expanded = new Set(), onToggleExpand }) {
  listEl.innerHTML = "";
  for (const mockup of mockups) {
    const hasVariants = mockup.variants.length > 0;
    const open = hasVariants && expanded.has(mockupExpandKey(mockup.name));
    const isActive = mockup.name === activeName;
    const li = document.createElement("li");
    li.className = "mockup-item-row screen-item-row";
    li.setAttribute("role", "none");
    li.dataset.depth = "0";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mockup-item screen-item";
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-level", "1");
    // With the tree open the selection sits on the variant row (design `tree-variant-row` selected); the mockup row steps back to plain.
    const variantSelected = isActive && open && activeVariant !== null;
    button.setAttribute("aria-selected", String(isActive && !variantSelected));
    button.setAttribute("aria-current", String(isActive && !variantSelected));
    if (hasVariants) button.setAttribute("aria-expanded", String(open));
    // CHR-631 — lets follow mode cue this row for a mockup activity target.
    button.dataset.mockupName = mockup.name;
    button.appendChild(icon("layers", "kind-icon"));

    const main = document.createElement("div");
    main.className = "screen-item-main";
    const nameEl = document.createElement("div");
    nameEl.className = "screen-item-name mockup-item-name";
    nameEl.textContent = mockup.title ?? mockup.name;
    main.appendChild(nameEl);
    const tags = mockup.tags ?? [];
    if (showTags && tags.length > 0) {
      const tagRow = document.createElement("div");
      tagRow.className = "tag-row";
      for (const tag of tags) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;
        chip.dataset.tooltip = tag;
        tagRow.appendChild(chip);
      }
      main.appendChild(tagRow);
    }
    button.appendChild(main);
    const total = document.createElement("span");
    total.className = "screen-item-total";
    total.textContent = String(mockup.variants.length);
    total.dataset.tooltip = `${mockup.variants.length} variant${mockup.variants.length === 1 ? "" : "s"}`;
    button.appendChild(total);
    button.addEventListener("click", () => onSelect(mockup.name));
    li.appendChild(button);

    if (hasVariants) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "screen-item-toggle";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${mockup.title ?? mockup.name}`);
      toggle.appendChild(icon(open ? "expand_more" : "chevron_right", "icon-xs"));
      toggle.addEventListener("click", (evt) => {
        evt.stopPropagation();
        onToggleExpand?.(mockupExpandKey(mockup.name));
      });
      li.insertBefore(toggle, button);
    }
    listEl.appendChild(li);

    if (!open) continue;
    for (const variant of mockup.variants) {
      const row = document.createElement("li");
      row.className = "mockup-variant-row screen-item-row";
      row.setAttribute("role", "none");
      row.dataset.depth = "1";
      const variantButton = document.createElement("button");
      variantButton.type = "button";
      variantButton.className = "screen-item mockup-variant-item";
      variantButton.setAttribute("role", "treeitem");
      variantButton.setAttribute("aria-level", "2");
      const selected = isActive && variant.id === activeVariant;
      variantButton.setAttribute("aria-selected", String(selected));
      variantButton.setAttribute("aria-current", String(selected));
      variantButton.dataset.variantId = variant.id;
      variantButton.appendChild(icon("layers", "kind-icon"));
      const variantMain = document.createElement("div");
      variantMain.className = "screen-item-main";
      const variantName = document.createElement("div");
      variantName.className = "screen-item-name";
      variantName.textContent = variant.title || variant.id;
      variantMain.appendChild(variantName);
      variantButton.appendChild(variantMain);
      variantButton.addEventListener("click", () => (onSelectVariant ?? ((name) => onSelect(name)))(mockup.name, variant.id));
      row.appendChild(variantButton);
      listEl.appendChild(row);
    }
  }
}
