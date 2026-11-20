// Use Cases tab — one popover menu (the chrome-menu look) shared by the filter chips, the sort control and the pickers.
// An ARIA menu: items are radios/checkboxes, Up/Down/Home/End move, Enter picks, Escape and an outside click close it,
// focus returns to the anchor. At most one menu is open at a time.

import { h } from "./usecases-dom.js";

let current = null;

export function closeMenu() {
  current?.close();
}

/**
 * @param {{
 *   anchor: HTMLElement,
 *   label: string,
 *   title?: string,
 *   items: { value: string, label: string, count?: number, checked?: boolean, leading?: Node | null, trailing?: Node | null, command?: boolean, icon?: string, disabled?: boolean }[], // `command`: a plain menuitem (an action, not a choice) with an optional `icon`; `disabled` keeps it in the menu as aria-disabled, skipped by the arrows
 *   onPick: (value: string) => void,
 *   clearLabel?: string,
 *   onClear?: () => void,
 *   filterable?: boolean, // a text field narrows the items (long lists such as screens)
 *   emptyText?: string,
 *   limit?: number, // how many items to draw at once (the rest follow the filter text)
 *   align?: "end", // opens with its right edge under the anchor (kept inside the dialog / window) instead of its left edge
 *   width?: number, // px; with `align` also the minimum width
 *   note?: string, // a hint under the items
 *   allowCustom?: boolean, // the typed text can be picked as a value of its own (a list the facets could not hold completely)
 * }} spec
 */
export function openMenu(spec) {
  closeMenu();
  const { anchor, items, onPick } = spec;
  const menu = h("div", { class: "chrome-menu uc-menu", role: "menu", "aria-label": spec.label });
  const list = h("div", { class: "uc-menu-list", role: "none" });
  let filterText = "";
  let focusIndex = -1;

  const draw = () => {
    list.replaceChildren();
    const needle = filterText.trim().toLowerCase();
    const shown = items.filter((item) => needle === "" || item.label.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle));
    const capped = shown.slice(0, spec.limit ?? 200);
    for (const item of capped) {
      if (item.command) {
        list.append(
          h(
            "button",
            { type: "button", class: "chrome-menu-item uc-menu-item", role: "menuitem", "aria-disabled": item.disabled ? "true" : null, dataset: { value: item.value }, onClick: () => { if (!item.disabled) pick(item.value); } },
            h("span", { class: "icon chrome-menu-icon", "aria-hidden": "true" }, item.icon ?? ""),
            h("span", { class: "uc-menu-label" }, item.label),
          ),
        );
        continue;
      }
      list.append(
        h(
          "button",
          { type: "button", class: "chrome-menu-item uc-menu-item", role: "menuitemradio", "aria-checked": item.checked ? "true" : "false", dataset: { value: item.value }, onClick: () => pick(item.value) },
          item.leading ?? h("span", { class: "icon chrome-menu-check", "aria-hidden": "true" }, item.checked ? "check" : ""),
          h("span", { class: "uc-menu-label" }, item.label),
          item.trailing ?? null,
          item.count !== undefined ? h("span", { class: "chrome-menu-hint" }, Number(item.count).toLocaleString("en-US")) : null,
        ),
      );
    }
    const typed = filterText.trim();
    if (spec.allowCustom && typed !== "" && !items.some((item) => item.value.toLowerCase() === typed.toLowerCase())) {
      list.append(h("button", { type: "button", class: "chrome-menu-item uc-menu-item", role: "menuitemradio", "aria-checked": "false", dataset: { value: typed }, onClick: () => pick(typed) }, h("span", { class: "icon chrome-menu-check", "aria-hidden": "true" }), h("span", { class: "uc-menu-label" }, `Filter by “${typed}”`)));
    } else if (capped.length === 0) list.append(h("p", { class: "chrome-menu-label", role: "presentation" }, spec.emptyText ?? "Nothing to pick."));
    if (capped.length > 0 && shown.length > capped.length) list.append(h("p", { class: "chrome-menu-label", role: "presentation" }, `${shown.length - capped.length} more — type to narrow`));
    focusIndex = -1;
  };

  const itemButtons = () => [...list.querySelectorAll(".uc-menu-item:not([aria-disabled='true'])")];
  const focusItem = (index) => {
    const buttons = itemButtons();
    if (buttons.length === 0) return;
    focusIndex = (index + buttons.length) % buttons.length;
    buttons[focusIndex].focus();
  };

  function pick(value) {
    close();
    onPick(value);
  }

  function close() {
    if (current?.menu !== menu) return;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    try {
      menu.hidePopover?.();
    } catch {
      // not showing (no popover support, or already hidden)
    }
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    current = null;
    if (anchor.isConnected) anchor.focus();
  }

  function onOutside(event) {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  }

  function onKey(event) {
    if (!menu.contains(document.activeElement) && document.activeElement !== anchor) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(focusIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(focusIndex - 1);
    } else if (event.key === "Home" && document.activeElement?.classList.contains("uc-menu-item")) {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End" && document.activeElement?.classList.contains("uc-menu-item")) {
      event.preventDefault();
      focusItem(-1);
    }
  }

  if (spec.title) menu.append(h("p", { class: "chrome-menu-label", role: "presentation" }, spec.title));
  if (spec.filterable) {
    const input = h("input", { type: "text", class: "chrome-field uc-menu-filter", placeholder: "Filter…", "aria-label": `Filter ${spec.label}`, autocomplete: "off" });
    input.addEventListener("input", () => {
      filterText = input.value;
      draw();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        itemButtons()[0]?.click();
      }
    });
    menu.append(input);
  }
  menu.append(list);
  if (spec.note) menu.append(h("p", { class: "chrome-menu-label uc-menu-note", role: "presentation" }, spec.note));
  if (spec.onClear) {
    menu.append(h("div", { class: "chrome-menu-divider", role: "separator" }), h("button", { type: "button", class: "chrome-menu-item uc-menu-item", role: "menuitem", onClick: () => { close(); spec.onClear(); } }, spec.clearLabel ?? "Clear"));
  }
  draw();
  // A manual popover: it lives in the top layer, so it shows above a modal dialog, and it is appended inside the dialog the anchor sits in (a modal makes everything outside of it inert).
  menu.setAttribute("popover", "manual");
  (anchor.closest("dialog") ?? document.body).append(menu);
  if (typeof menu.showPopover === "function") menu.showPopover();
  const rect = anchor.getBoundingClientRect();
  if (spec.align === "end") {
    const bounds = (anchor.closest("dialog") ?? document.body).getBoundingClientRect();
    const width = spec.width ?? 220;
    const right = Math.min(rect.right, bounds.right > 0 ? bounds.right - 8 : Infinity);
    menu.style.width = `${width}px`;
    menu.style.minWidth = "0";
    menu.style.left = `${Math.max(8, right - width)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    const height = menu.getBoundingClientRect().height;
    if (height > 0 && rect.bottom + 4 + height > (window.innerHeight || 768) - 8) menu.style.top = `${Math.max(8, rect.top - height - 4)}px`; // no room below: open above
  } else {
    menu.style.left = `${Math.max(8, Math.min(rect.left, (window.innerWidth || 1024) - 260))}px`;
    menu.style.top = `${rect.bottom + 4}px`;
  }
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  current = { menu, close };
  if (spec.filterable) menu.querySelector(".uc-menu-filter")?.focus();
  else focusItem(Math.max(0, itemButtons().findIndex((button) => button.getAttribute("aria-checked") === "true")));
  return close;
}

