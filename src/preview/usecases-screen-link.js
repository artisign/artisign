// Use Cases tab — the reverse entry: on a screen in the Screens view, the use cases whose steps map to it (list_use_cases
// {screen}). Drawn into the Context panel; only ever shown for a project that has use cases and after the Use Cases tab
// has loaded them once, so a project without them never pays for it.

import { h, icon, fill } from "./usecases-dom.js";
import { statusDot } from "./usecases-parts.js";
import { formatCount } from "./usecases-data.js";

/**
 * @param {HTMLElement} el
 * @param {{ total: number, items: { id: string, title: string, status: string }[], screen: string, onOpen: (id: string) => void, onShowAll: () => void }} data
 */
export function renderScreenUseCases(el, { total, items, screen, onOpen, onShowAll }) {
  el.hidden = total === 0;
  if (total === 0) return;
  fill(
    el,
    h("h2", { class: "screen-usecases-title" }, icon("article"), "Use cases", h("span", { class: "screen-usecases-count" }, formatCount(total))),
    h("p", { class: "screen-usecases-sub" }, `Steps that map to ${screen}`),
    h("ul", { class: "screen-usecases-list" }, items.map((item) => h("li", null, h("button", { type: "button", class: "screen-usecases-row", onClick: () => onOpen(item.id) }, statusDot(item.status), h("span", { class: "screen-usecases-name" }, item.title))))),
    total > items.length ? h("button", { type: "button", class: "uc-link-btn screen-usecases-all", onClick: onShowAll }, `Show all ${formatCount(total)} in Use Cases`) : null,
  );
}
