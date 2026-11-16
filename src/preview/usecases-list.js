// Use Cases tab — the left panel of the use-case list: search, filter chips, result line with sort, and the virtual tree.
// Only the rows in (or near) the viewport exist as DOM; the flat row array comes from usecases-data.js (flattenTree /
// flattenFlat). Group counts come from the facets, rows from paged queries — the panel never holds thousands of nodes.

import { h, icon } from "./usecases-dom.js";
import { filterChip } from "./usecases-parts.js";
import { statusDot } from "./usecases-parts.js";
import { rowTops, visibleWindow, treeKeyNav, ROW_HEIGHT, SORTS, STATUS_LABELS, formatCount, plural, hasActiveFilters } from "./usecases-data.js";

const FALLBACK_VIEWPORT = 600;
const SEARCH_DEBOUNCE_MS = 250;

function rowDomId(key) {
  return `uc-row-${key.replace(/[^a-zA-Z0-9-]/g, "_")}`;
}

/**
 * @param {HTMLElement} el the panel's container (filled once)
 * @param {{
 *   onQuery: (text: string) => void,
 *   onFilterMenu: (kind: string, anchor: HTMLElement) => void,
 *   onClearFilter: (kind: string) => void,
 *   onToggleHasVariants: () => void,
 *   onSortMenu: (anchor: HTMLElement) => void,
 *   onOpenCase: (id: string) => void,
 *   onToggleGroup: (path: string) => void,
 *   onMore: (path: string | null) => void,
 *   onActive: (key: string | null) => void,
 *   onNeedMore: () => void, // scrolled near the end of a flat list
 *   onRetry: () => void, // the page request failed: try again (nothing retries by itself)
 * }} handlers
 */
export function createListPanel(el, handlers) {
  let model = null;
  let layout = { tops: [], total: 0 };
  let timer = null;

  const search = h("input", { type: "search", class: "chrome-field uc-search-input", placeholder: "Search title, trigger, steps…", "aria-label": "Search use cases", autocomplete: "off" });
  const filters = h("div", { class: "uc-filters" });
  const result = h("div", { class: "uc-result" });
  const spacer = h("div", { class: "uc-tree-spacer" });
  const windowEl = h("div", { class: "uc-tree-window" });
  const tree = h("div", { class: "uc-tree", role: "tree", tabindex: "0", "aria-label": "Use cases" }, spacer, windowEl);
  const status = h("p", { class: "uc-list-status", role: "status", hidden: true });

  el.append(
    h("div", { class: "uc-search" }, icon("search"), search),
    filters,
    result,
    status,
    tree,
  );

  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => handlers.onQuery(search.value), SEARCH_DEBOUNCE_MS);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && search.value !== "") {
      search.value = "";
      clearTimeout(timer);
      handlers.onQuery("");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      tree.focus();
    }
  });
  tree.addEventListener("scroll", () => {
    drawWindow();
    maybeNeedMore();
  });
  tree.addEventListener("keydown", (event) => {
    if (!model || !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    const next = treeKeyNav(model.rows, model.activeKey, event.key);
    if (next.activeKey !== model.activeKey) {
      model.activeKey = next.activeKey;
      handlers.onActive(next.activeKey);
      scrollToKey(next.activeKey);
      drawWindow();
    }
    const action = next.action;
    if (action?.type === "toggle") handlers.onToggleGroup(action.path);
    else if (action?.type === "open") handlers.onOpenCase(action.id);
    else if (action?.type === "more") handlers.onMore(action.path);
  });

  function viewportHeight() {
    return tree.clientHeight || FALLBACK_VIEWPORT;
  }

  function maybeNeedMore() {
    if (!model?.rows.some((row) => row.kind === "more" && row.path === null)) return;
    if (tree.scrollTop + viewportHeight() > layout.total - ROW_HEIGHT.case * 6) handlers.onNeedMore();
  }

  function scrollToKey(key) {
    const index = model?.rows.findIndex((row) => row.key === key) ?? -1;
    if (index < 0) return;
    const top = layout.tops[index];
    const height = ROW_HEIGHT[model.rows[index].kind];
    if (top < tree.scrollTop) tree.scrollTop = top;
    else if (top + height > tree.scrollTop + viewportHeight()) tree.scrollTop = top + height - viewportHeight();
  }

  function rowEl(row, index) {
    const pad = 8 + row.depth * 14;
    const common = { role: "treeitem", id: rowDomId(row.key), dataset: { key: row.key }, "aria-level": String(row.depth + 1), "aria-setsize": null, style: { top: `${layout.tops[index]}px`, height: `${ROW_HEIGHT[row.kind]}px`, "padding-left": `${pad}px` } };
    const active = model.activeKey === row.key;
    if (row.kind === "group" || row.kind === "ungrouped") {
      return h(
        "div",
        { ...common, class: `uc-group-row${active ? " is-active" : ""}`, "aria-expanded": row.open ? "true" : "false", onClick: () => { handlers.onActive(row.key); handlers.onToggleGroup(row.path); } },
        icon(row.open ? "expand_more" : "chevron_right", "uc-group-chevron"),
        icon(row.open ? "folder_open" : "folder", "uc-group-folder"),
        h("span", { class: "uc-group-name" }, row.name),
        h("span", { class: "uc-group-count" }, formatCount(row.count)),
      );
    }
    if (row.kind === "case") {
      const u = row.u;
      const selected = model.selectedId === u.id;
      const meta = [
        statusDot(u.status),
        h("span", null, STATUS_LABELS[u.status] ?? u.status),
        ...(u.variants ? [h("span", { "aria-hidden": "true" }, "·"), h("span", null, plural(u.variants, "variant"))] : []),
      ];
      return h(
        "div",
        { ...common, class: `uc-list-row${selected ? " is-selected" : ""}${active ? " is-active" : ""}`, "aria-selected": selected ? "true" : "false", onClick: () => { handlers.onActive(row.key); handlers.onOpenCase(u.id); } },
        h("div", { class: "uc-list-title", title: u.title }, u.title),
        h("div", { class: "uc-list-meta" }, meta),
      );
    }
    if (row.kind === "more") {
      return h("div", { ...common, class: `uc-more-row${active ? " is-active" : ""}`, onClick: () => { handlers.onActive(row.key); handlers.onMore(row.path); } }, h("span", { class: "uc-more-link" }, `Show ${formatCount(row.remaining)} more`));
    }
    if (row.kind === "error") {
      return h("div", { ...common, class: "uc-error-row", role: "none" }, h("span", { class: "uc-error-text" }, `Could not load more: ${row.message}`), h("button", { type: "button", class: "uc-link-btn", onClick: () => handlers.onRetry() }, "Retry"));
    }
    if (row.kind === "loading") return h("div", { ...common, class: "uc-loading-row", role: "none" }, "Loading…");
    return h("div", { ...common, class: "uc-header-row", role: "none" }, row.name);
  }

  function drawWindow() {
    if (!model) return;
    const { start, end } = visibleWindow(layout.tops, tree.scrollTop, viewportHeight());
    windowEl.replaceChildren(...model.rows.slice(start, end).map((row, i) => rowEl(row, start + i)));
    const active = model.activeKey && model.rows.some((row) => row.key === model.activeKey) ? rowDomId(model.activeKey) : null;
    if (active) tree.setAttribute("aria-activedescendant", active);
    else tree.removeAttribute("aria-activedescendant");
    windowEl.dataset.rendered = String(end - start);
  }

  function drawFilters() {
    const f = model.filters;
    const label = (name, value) => (value ? `${name}: ${value}` : name);
    filters.hidden = Boolean(model.empty);
    result.hidden = Boolean(model.empty);
    filters.replaceChildren(
      filterChip({ label: label("Persona", model.labels.persona), active: Boolean(f.persona), onClick: (e) => handlers.onFilterMenu("persona", e.currentTarget), onClear: () => handlers.onClearFilter("persona") }),
      filterChip({ label: label("Status", f.status && (STATUS_LABELS[f.status] ?? f.status)), active: Boolean(f.status), onClick: (e) => handlers.onFilterMenu("status", e.currentTarget), onClear: () => handlers.onClearFilter("status") }),
      filterChip({ label: label("Tag", f.tag), active: Boolean(f.tag), onClick: (e) => handlers.onFilterMenu("tag", e.currentTarget), onClear: () => handlers.onClearFilter("tag") }),
      filterChip({ label: label("Screen", f.screen), active: Boolean(f.screen), onClick: (e) => handlers.onFilterMenu("screen", e.currentTarget), onClear: () => handlers.onClearFilter("screen") }),
      filterChip({ label: "Has variants", toggle: true, active: f.hasVariants, onClick: handlers.onToggleHasVariants }),
    );
    const filtered = hasActiveFilters(f);
    const sortLabel = SORTS.find((s) => s.id === model.sort)?.label ?? model.sort;
    const total = model.counts?.use_cases ?? model.total;
    result.replaceChildren(
      h("span", { class: "uc-result-text", role: "status" }, filtered ? `${formatCount(model.total)} of ${plural(total, "use case")}` : plural(model.total, "use case")),
      h("button", { type: "button", class: "uc-sort", "aria-haspopup": "menu", "aria-expanded": "false", onClick: (e) => handlers.onSortMenu(e.currentTarget) }, icon("sort"), sortLabel, icon("expand_more")),
    );
  }

  return {
    /** Re-renders from a fresh model (filters, result line, rows). Keeps the scroll position and the search text. */
    update(next) {
      model = next;
      layout = rowTops(model.rows);
      spacer.style.height = `${layout.total}px`;
      if (document.activeElement !== search && search.value !== model.filters.query) search.value = model.filters.query;
      drawFilters();
      status.hidden = !(model.error || (model.rows.length === 0 && !model.loading));
      status.textContent = model.error ? model.error : model.empty ? model.emptyText : model.rows.length === 0 && !model.loading ? (hasActiveFilters(model.filters) ? "No use case matches these filters." : "No use cases yet.") : "";
      status.hidden = status.hidden && !model.empty;
      drawWindow();
      maybeNeedMore();
    },
    scrollToKey,
    focusSearch() {
      search.focus();
      search.select();
    },
    /** Rows currently in the DOM — what the scale proof reads. */
    renderedRows: () => windowEl.childElementCount,
    totalRows: () => model?.rows.length ?? 0,
  };
}
