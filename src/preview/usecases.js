// Use Cases tab — the controller. Owns the tab's state (section, filters, list, selected use case, pool), talks to the
// daemon through usecases-api.js, reacts to the SSE `usecases` events and wires the view modules together:
//   usecases-list.js (left list), usecases-detail.js, usecases-mapping.js, usecases-pool.js, usecases-forms*.js.
// Optional feature: nothing is fetched until the tab is first shown, every call is a read, and a project without a
// usecases/ folder gets the empty guide. The preview writes use-case data only through the tools API (set_use_cases,
// generate_personas, delete_entity) — never screens, the design system or flows.

import { h, icon } from "./usecases-dom.js";
import { createListPanel } from "./usecases-list.js";
import { renderDetail } from "./usecases-detail.js";
import { createMappingView } from "./usecases-mapping.js";
import { renderPersonaList, renderPersonaPage, renderObjectList, renderObjectPage, CARD_PAGE, LIST_PAGE } from "./usecases-pool.js";
import { openUseCaseDialog, draftFromSource } from "./usecases-forms.js";
import { openPersonaDialog, openDimensionDialog, openObjectDialog, openGenerateDialog } from "./usecases-forms-pool.js";
import { confirmDialog } from "./usecases-dialog.js";
import { openMenu, closeMenu } from "./usecases-menu.js";
import * as api from "./usecases-api.js";
import {
  EMPTY_FILTERS,
  STATUSES,
  STATUS_LABELS,
  SORTS,
  buildQuery,
  buildGroupTree,
  groupAncestors,
  isCanonicalGroup,
  removeStepTarget,
  flattenTree,
  flattenFlat,
  indexById,
  GROUP_FIRST_PAGE,
  GROUP_PAGE,
  FLAT_PAGE,
  PAGE_MAX,
  warningSummary,
  plural,
  errorMessage,
  actorName,
} from "./usecases-data.js";
import { avatar } from "./usecases-parts.js";
import { avatarOf } from "./usecases-data.js";

const SECTIONS = [
  { id: "cases", label: "Use cases" },
  { id: "personas", label: "Personas" },
  { id: "objects", label: "Data objects" },
];
const RELOAD_DEBOUNCE_MS = 120;

/**
 * @param {{
 *   rootEl: HTMLElement,
 *   getProject: () => string | null,
 *   getProjectName: () => string,
 *   getScreens: () => { name: string }[],
 *   fetchRender: (screen: string, project: string) => Promise<any>,
 *   fetchScreenNodes: (screen: string, project: string) => Promise<{ ok: boolean, nodes?: { id: string }[] }>,
 *   openScreen: (screen: string, node: string | null) => void,
 * }} options
 */
export function createUseCasesView(options) {
  const { rootEl } = options;
  let project = null;
  let visible = false;
  let section = "cases";
  let mode = "detail"; // detail | mapping
  let filters = { ...EMPTY_FILTERS };
  let sort = "group";
  let reloadTimer = null;
  let loadedFor = null;
  let autoSelected = false;
  let poolQuery = "";
  let objectQuery = "";
  let personaLimit = CARD_PAGE;
  let personaListLimit = LIST_PAGE;
  let selectedPersona = null;
  let selectedObject = null;
  let coverageOpen = false;

  const pool = emptyPool();
  const list = { req: 0, loading: false, error: "", total: 0, counts: null, facets: null, facetsTruncated: [], mode: "tree", tree: null, expanded: new Set(), groupState: new Map(), ungrouped: { count: 0, rows: [], loading: false }, flat: { items: [], cursor: null, loading: false, error: "" }, activeKey: null };
  let detail = null; // { id, variantId, view, base, source, error, loading }

  // --- DOM skeleton --------------------------------------------------------------------------------------------

  const subnav = h("nav", { class: "uc-subnav", "aria-label": "Use Cases sections" }, SECTIONS.map((s) => h("button", { type: "button", class: "chrome-tab uc-subtab", dataset: { section: s.id }, "aria-pressed": "false", onClick: () => setSection(s.id) }, s.label)), h("span", { class: "uc-map-spacer" }), h("button", { type: "button", class: "chrome-icon-btn", id: "uc-add", onClick: () => addForSection() }, icon("add")));
  const addButton = subnav.querySelector("#uc-add");
  const casesPanelEl = h("div", { class: "uc-side-panel", dataset: { section: "cases" } });
  const personasPanelEl = h("div", { class: "uc-side-panel", dataset: { section: "personas" }, hidden: true });
  const objectsPanelEl = h("div", { class: "uc-side-panel", dataset: { section: "objects" }, hidden: true });
  const personaSearch = h("input", { type: "search", class: "chrome-field uc-search-input", placeholder: "Search personas, goals, traits…", "aria-label": "Search personas", autocomplete: "off" });
  const personaSummary = h("div", { class: "uc-result" });
  const personaListEl = h("div", { class: "uc-plist" });
  personasPanelEl.append(h("div", { class: "uc-search" }, icon("search"), personaSearch), personaSummary, personaListEl);
  const objectSearch = h("input", { type: "search", class: "chrome-field uc-search-input", placeholder: "Search data objects…", "aria-label": "Search data objects", autocomplete: "off" });
  const objectSummary = h("div", { class: "uc-result" });
  const objectListEl = h("div", { class: "uc-plist" });
  objectsPanelEl.append(h("div", { class: "uc-search" }, icon("search"), objectSearch), objectSummary, objectListEl);
  const side = h("aside", { class: "uc-side" }, subnav, casesPanelEl, personasPanelEl, objectsPanelEl);
  const toast = h("div", { class: "uc-toast", role: "status", hidden: true });
  const content = h("div", { class: "uc-content" });
  const main = h("main", { class: "uc-main" }, toast, content);
  const root = h("div", { class: "uc-root", dataset: { mode: "detail" } }, side, main);
  rootEl.append(root);

  const listPanel = createListPanel(casesPanelEl, {
    onQuery: (text) => {
      filters = { ...filters, query: text };
      loadList();
    },
    onFilterMenu: openFilterMenu,
    onClearFilter: (kind) => {
      filters = { ...filters, [kind]: "" };
      loadList();
    },
    onToggleHasVariants: () => {
      filters = { ...filters, hasVariants: !filters.hasVariants };
      loadList();
    },
    onSortMenu: openSortMenu,
    onOpenCase: (id) => openCase(id),
    onToggleGroup: toggleGroup,
    onMore: loadMore,
    onActive: (key) => {
      list.activeKey = key;
    },
    onNeedMore: () => loadMore(null),
    onRetry: () => loadMore(null),
  });

  personaSearch.addEventListener("input", () => {
    poolQuery = personaSearch.value;
    personaLimit = CARD_PAGE;
    personaListLimit = LIST_PAGE;
    renderPersonas();
  });
  objectSearch.addEventListener("input", () => {
    objectQuery = objectSearch.value;
    renderObjects();
  });
  const mapping = createMappingView({
    root: content,
    fetchRender: options.fetchRender,
    handlers: {
      onBack: () => {
        mode = "detail";
        renderAll();
      },
      onVariantMenu: (anchor) =>
        openMenu({
          anchor,
          label: "Variant",
          items: [{ value: "", label: "Base", checked: !detail?.variantId }, ...(detail?.base?.variants ?? []).map((v) => ({ value: v.id, label: v.title, checked: detail.variantId === v.id }))],
          onPick: async (value) => {
            await openCase(detail.id, value || null, { keepMode: true });
            showMapping(null);
          },
        }),
      onOpenScreen: (screen, node) => options.openScreen(screen, node),
      onPickTarget: pickTarget,
      onUnmap: unmapStep,
      onStep: () => {},
    },
  });

  // --- Pool ------------------------------------------------------------------------------------------------------

  function emptyPool() {
    return { personas: [], dimensions: [], objects: [], personasById: new Map(), dimensionsById: new Map(), objectsById: new Map(), counts: null, usage: Object.assign(new Map(), { complete: false }), loaded: false };
  }

  async function loadPool() {
    const forProject = project;
    const res = await api.getUseCases(forProject, { limit: 1, include: ["personas", "dimensions", "data_objects"] });
    if (forProject !== project) return;
    if (!res.ok) {
      showToast(errorMessage(res), []);
      return;
    }
    const data = res.data;
    pool.personas = data.personas ?? [];
    pool.dimensions = data.dimensions ?? [];
    pool.objects = data.data_objects ?? [];
    pool.personasById = indexById(pool.personas);
    pool.dimensionsById = indexById(pool.dimensions);
    pool.objectsById = indexById(pool.objects);
    pool.counts = data.counts ?? { use_cases: 0, personas: 0, dimensions: 0, data_objects: 0 };
    pool.usage = Object.assign(new Map(Object.entries(data.facets?.persona ?? {})), { complete: !(data.facets_truncated ?? []).includes("persona") });
    pool.loaded = true;
  }

  const poolView = () => pool;
  const isEmptyProject = () => pool.loaded && pool.counts && pool.counts.use_cases === 0 && pool.counts.personas === 0 && pool.counts.dimensions === 0 && pool.counts.data_objects === 0;

  // --- List ------------------------------------------------------------------------------------------------------

  function listRows() {
    if (list.mode === "tree" && list.tree) return flattenTree({ roots: list.tree.roots, expanded: list.expanded, groupState: list.groupState, ungrouped: list.ungrouped });
    return flattenFlat({ items: list.flat.items, withHeaders: sort === "group", total: list.total, loading: list.flat.loading, error: list.flat.error });
  }

  function renderList() {
    const rows = listRows();
    const labels = { persona: filters.persona ? actorName(filters.persona, pool.personasById) : "" };
    const empty = isEmptyProject();
    const emptyText = `${plural(0, "use case")} · ${plural(pool.counts?.personas ?? 0, "persona")}`;
    listPanel.update({ filters, sort, total: list.total, counts: list.counts, rows, selectedId: detail?.id ?? null, activeKey: list.activeKey, labels, loading: list.loading, error: list.error, empty, emptyText });
  }

  async function loadList() {
    const forProject = project;
    const req = ++list.req;
    const query = buildQuery(filters);
    list.loading = true;
    list.error = "";
    const stale = () => req !== list.req || forProject !== project;
    const first = await api.getUseCases(forProject, { ...query, sort, limit: sort === "group" ? 1 : FLAT_PAGE });
    if (stale()) return;
    list.loading = false;
    if (!first.ok) {
      list.error = errorMessage(first);
      renderList();
      return;
    }
    const data = first.data;
    list.total = data.total ?? 0;
    list.counts = data.counts ?? list.counts;
    list.facets = data.facets ?? {};
    list.facetsTruncated = data.facets_truncated ?? [];
    pool.counts = data.counts ?? pool.counts;
    if (data.warnings?.length) showToast("Some use case files could not be loaded.", data.warnings, 0, data.invalid_file_count);
    const groupComplete = !list.facetsTruncated.includes("group") && Object.keys(list.facets.group ?? {}).every(isCanonicalGroup);

    if (sort === "group" && groupComplete) {
      list.mode = "tree";
      list.tree = buildGroupTree(list.facets.group);
      const grouped = Object.values(list.facets.group ?? {}).reduce((sum, n) => sum + n, 0);
      const keep = new Set([...list.expanded].filter((path) => path === "" || list.tree.byPath.has(path)));
      if (detail?.view?.use_case) for (const path of groupAncestors(detail.view.use_case.group)) if (list.tree.byPath.has(path)) keep.add(path);
      list.expanded = keep;
      const previous = list.groupState;
      list.groupState = new Map();
      list.ungrouped = { count: Math.max(0, list.total - grouped), rows: [], loading: false };
      renderList();
      await Promise.all([...list.expanded].map((path) => reloadGroup(path, previous.get(path)?.rows.length ?? 0, req)));
      if (stale()) return;
    } else {
      list.mode = "flat";
      list.tree = null;
      list.flat = { items: [], cursor: null, loading: false, error: "" };
      if (sort === "group") {
        const page = await api.getUseCases(forProject, { ...query, sort, limit: FLAT_PAGE });
        if (stale()) return;
        if (page.ok) {
          list.flat.items = page.data.use_cases ?? [];
          list.flat.cursor = page.data.next_cursor ?? null;
        }
      } else {
        list.flat.items = data.use_cases ?? [];
        list.flat.cursor = data.next_cursor ?? null;
      }
    }
    renderList();
    renderAll();
    if (!autoSelected && !detail) await autoSelectFirst(req);
  }

  /** Pages through `limit`-sized requests (never above PAGE_MAX, the most the tool returns) by cursor until `want` rows are in. */
  async function pageRows(query, want, startCursor, keep) {
    const rows = [];
    let cursor = startCursor;
    while (rows.length < want) {
      const res = await api.getUseCases(project, { ...query, limit: Math.min(PAGE_MAX, want - rows.length), ...(cursor !== undefined ? { cursor } : {}) });
      if (!res.ok) return { ok: false, rows, cursor };
      rows.push(...(res.data.use_cases ?? []).filter(keep));
      cursor = res.data.next_cursor;
      if (cursor === undefined) break;
    }
    return { ok: true, rows, cursor };
  }

  /** (Re)load the first `count` rows of one group — at least the first page — by cursor, so a refresh of 600 loaded rows is 6 requests, not one over the tool's limit. */
  async function reloadGroup(path, count, req = list.req) {
    if (path === "") return reloadUngrouped(count, req);
    const node = list.tree?.byPath.get(path);
    if (!node || node.direct === 0) {
      list.groupState.set(path, { rows: [], cursor: undefined, loading: false });
      return;
    }
    const want = Math.min(node.direct, Math.max(GROUP_FIRST_PAGE, count));
    list.groupState.set(path, { rows: list.groupState.get(path)?.rows ?? [], cursor: undefined, loading: true });
    renderList();
    const result = await pageRows({ ...buildQuery(filters), group: path, sort: "group" }, want, undefined, (u) => u.group === path);
    if (req !== list.req) return;
    list.groupState.set(path, { rows: result.rows, cursor: result.cursor, loading: false });
    renderList();
  }

  async function reloadUngrouped(count, req) {
    const offset = list.total - list.ungrouped.count;
    const want = Math.min(list.ungrouped.count, Math.max(GROUP_FIRST_PAGE, count));
    list.ungrouped.loading = true;
    renderList();
    const result = await pageRows({ ...buildQuery(filters), sort: "group" }, want, String(offset), () => true);
    if (req !== list.req) return;
    list.ungrouped.rows = result.rows;
    list.ungrouped.loading = false;
    renderList();
  }

  async function toggleGroup(path) {
    if (list.expanded.has(path)) list.expanded.delete(path);
    else {
      list.expanded.add(path);
      if (!list.groupState.get(path)?.rows.length && !(path === "" && list.ungrouped.rows.length)) await reloadGroup(path, 0);
    }
    renderList();
  }

  async function loadMore(path) {
    const req = list.req;
    if (list.mode === "flat" || path === null) {
      if (list.flat.loading || !list.flat.cursor) return;
      list.flat.loading = true;
      list.flat.error = "";
      renderList();
      const res = await api.getUseCases(project, { ...buildQuery(filters), sort, limit: FLAT_PAGE, cursor: list.flat.cursor });
      if (req !== list.req) return;
      list.flat.loading = false;
      if (res.ok) {
        list.flat.items = list.flat.items.concat(res.data.use_cases ?? []);
        list.flat.cursor = res.data.next_cursor ?? null;
      } else {
        // Stop auto-paging: the error row offers Retry (a failing page must not become a request loop).
        list.flat.error = errorMessage(res);
      }
      renderList();
      return;
    }
    if (path === "") {
      const offset = list.total - list.ungrouped.count + list.ungrouped.rows.length;
      list.ungrouped.loading = true;
      renderList();
      const result = await pageRows({ ...buildQuery(filters), sort: "group" }, Math.min(GROUP_PAGE, list.ungrouped.count - list.ungrouped.rows.length), String(offset), () => true);
      if (req !== list.req) return;
      list.ungrouped.loading = false;
      list.ungrouped.rows = list.ungrouped.rows.concat(result.rows);
      renderList();
      return;
    }
    const node = list.tree?.byPath.get(path);
    const state = list.groupState.get(path);
    if (!node || !state || state.loading) return;
    state.loading = true;
    renderList();
    const result = await pageRows({ ...buildQuery(filters), group: path, sort: "group" }, Math.min(GROUP_PAGE, node.direct - state.rows.length), state.cursor, (u) => u.group === path);
    if (req !== list.req) return;
    list.groupState.set(path, { rows: state.rows.concat(result.rows), cursor: result.cursor, loading: false });
    renderList();
  }

  /** Opens the first use case of the list once (landing view) — and not again after the user chose or deleted one. */
  async function autoSelectFirst(req) {
    const open = async (id) => {
      autoSelected = true;
      await openCase(id);
    };
    if (list.mode === "flat") {
      const first = list.flat.items[0];
      if (first) await open(first.id);
      return;
    }
    let node = list.tree?.roots[0];
    while (node && node.direct === 0 && node.children.length > 0) node = node.children[0];
    if (!node) {
      if (list.ungrouped.count > 0) {
        list.expanded.add("");
        await reloadUngrouped(0, req);
        if (list.ungrouped.rows[0]) await open(list.ungrouped.rows[0].id);
      }
      return;
    }
    for (const path of groupAncestors(node.path)) list.expanded.add(path);
    await reloadGroup(node.path, 0, req);
    const first = list.groupState.get(node.path)?.rows[0];
    if (first) await open(first.id);
    renderList();
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (!project) return;
      await loadPool();
      renderPools();
      await loadList();
      if (detail?.id) await reloadDetail();
      options.onDataChanged?.();
    }, RELOAD_DEBOUNCE_MS);
  }

  // --- Filter and sort menus --------------------------------------------------------------------------------------

  async function openFilterMenu(kind, anchor) {
    if (kind === "screen") {
      const screens = options.getScreens().map((s) => s.name);
      return openMenu({
        anchor,
        label: "Screen",
        title: "Screens used by a step",
        items: screens.map((name) => ({ value: name, label: name, checked: filters.screen === name })),
        filterable: true,
        emptyText: "No screens.",
        onPick: (value) => {
          filters = { ...filters, screen: value };
          loadList();
        },
        onClear: filters.screen ? () => {
          filters = { ...filters, screen: "" };
          loadList();
        } : undefined,
        clearLabel: "Clear screen filter",
      });
    }
    // Counts inside the current filters, except this one: with it applied the facet would show only the picked value.
    let facets = list.facets ?? {};
    if (filters[kind]) {
      const res = await api.getUseCases(project, { ...buildQuery({ ...filters, [kind]: "" }), limit: 1 });
      if (res.ok) facets = res.data.facets ?? facets;
    }
    const counts = facets[kind] ?? {};
    const truncated = (list.facetsTruncated ?? []).includes(kind);
    let entries = kind === "status" ? STATUSES.map((s) => [s, counts[s] ?? 0]) : Object.entries(counts);
    // The facets stop at 50 values. Every persona is known client-side, so that menu lists them all; for tags the menu's text
    // field offers what was typed as the filter value (the server matches tags case-insensitively).
    if (kind === "persona" && truncated) entries = pool.personas.map((p) => [p.id, counts[p.id]]);
    const items = entries.map(([value, count]) => ({ value, label: kind === "status" ? STATUS_LABELS[value] : kind === "persona" ? actorName(value, pool.personasById) : value, count, checked: filters[kind] === value, leading: kind === "persona" ? avatar(avatarOf(value, pool.personasById), "sm") : null }));
    openMenu({
      anchor,
      label: kind[0].toUpperCase() + kind.slice(1),
      title: `${kind[0].toUpperCase() + kind.slice(1)} · counts within current filters`,
      items,
      filterable: kind !== "status",
      allowCustom: kind === "tag" && truncated,
      emptyText: `No ${kind} in these use cases.`,
      onPick: (value) => {
        filters = { ...filters, [kind]: value };
        loadList();
      },
      onClear: filters[kind] ? () => {
        filters = { ...filters, [kind]: "" };
        loadList();
      } : undefined,
      clearLabel: `Clear ${kind} filter`,
    });
  }

  function openSortMenu(anchor) {
    openMenu({
      anchor,
      label: "Sort",
      items: SORTS.map((s) => ({ value: s.id, label: s.label, checked: sort === s.id })),
      onPick: (value) => {
        sort = value;
        loadList();
      },
    });
  }

  // --- Detail ----------------------------------------------------------------------------------------------------

  async function openCase(id, variantId = null, { keepMode = false } = {}) {
    if (!keepMode) mode = "detail";
    const forProject = project;
    detail = { ...(detail?.id === id ? detail : {}), id, variantId, loading: true, error: "" };
    renderAll();
    renderList();
    const [view, base, source, suggest] = await Promise.all([api.getUseCase(forProject, id, variantId), variantId ? api.getUseCase(forProject, id) : Promise.resolve(null), api.fetchUseCaseSource(forProject, id), api.suggestUseCaseVariants(forProject, id, 1)]);
    if (forProject !== project || detail?.id !== id || detail.variantId !== variantId) return;
    if (!view.ok) {
      detail = { id, variantId, loading: false, error: view.code === "not_found" ? "This use case no longer exists." : view.message };
    } else {
      detail = { id, variantId, loading: false, error: "", view: view.data, base: base?.ok ? base.data : view.data, source: source.ok ? source.useCase : null, suggest: suggest.ok ? suggest.data : null };
    }
    // Reveal it in the list: its group path opens (the tree loads groups lazily).
    if (list.mode === "tree" && detail.view) {
      const open = groupAncestors(detail.view.use_case.group).filter((p) => list.tree?.byPath.has(p) && !list.expanded.has(p));
      for (const path of open) list.expanded.add(path);
      for (const path of open) if (!list.groupState.get(path)?.rows.length) await reloadGroup(path, 0);
    }
    renderList();
    renderAll();
  }

  async function reloadDetail() {
    if (!detail?.id) return;
    const { id, variantId } = detail;
    const hadMapping = mode === "mapping";
    await openCase(id, variantId, { keepMode: true });
    if (hadMapping && detail?.view) showMapping(null);
  }

  function showMapping(stepId) {
    if (!detail?.view) return;
    mode = "mapping";
    root.dataset.mode = "mapping";
    mapping.show({ project, bundle: detail.view, variantId: detail.variantId, variants: detail.base?.variants ?? [], pool, stepId });
  }

  function detailCtx() {
    return {
      bundle: detail.view,
      base: detail.base,
      source: detail.source,
      suggest: detail.suggest,
      variantId: detail.variantId,
      pool,
      coverageOpen,
      handlers: {
        onVariant: (variantId) => openCase(detail.id, variantId),
        onEdit: () => editUseCase(detail.id),
        onMap: (stepId) => showMapping(stepId),
        onCopyId: () => copy(detail.id),
        onCopy: (text) => copy(text),
        onAddVariant: () => editUseCase(detail.id, { variants: true, addVariant: true }),
        onToggleCoverage: () => {
          coverageOpen = !coverageOpen;
          renderAll();
        },
        onDelete: () => deleteUseCase(detail.id),
      },
    };
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied.", [], 1500);
    } catch {
      // A clipboard that is missing or refuses is tolerated.
    }
  }

  // --- Rendering -------------------------------------------------------------------------------------------------

  function renderAll() {
    root.dataset.mode = mode;
    for (const button of subnav.querySelectorAll(".uc-subtab")) button.setAttribute("aria-pressed", String(button.dataset.section === section));
    casesPanelEl.hidden = section !== "cases";
    personasPanelEl.hidden = section !== "personas";
    objectsPanelEl.hidden = section !== "objects";
    addButton.setAttribute("aria-label", section === "cases" ? "New use case" : section === "personas" ? "New persona" : "New data object");
    addButton.title = addButton.getAttribute("aria-label");
    if (mode === "mapping" && detail?.view) return; // the mapping view owns the content
    if (section === "personas") return renderPersonas();
    if (section === "objects") return renderObjects();
    if (isEmptyProject()) return renderGuide();
    if (!detail) {
      content.replaceChildren(h("div", { class: "uc-placeholder" }, list.loading ? "Loading…" : pool.counts?.use_cases === 0 ? h("div", null, h("p", null, "No use cases yet."), h("button", { type: "button", class: "chrome-btn", onClick: () => newUseCase() }, icon("add"), "New use case")) : "Select a use case."));
      return;
    }
    if (detail.loading && !detail.view) return content.replaceChildren(h("div", { class: "uc-placeholder" }, "Loading…"));
    if (detail.error) return content.replaceChildren(h("div", { class: "uc-placeholder" }, h("p", null, detail.error)));
    renderDetail(content, detailCtx());
  }

  function renderPoolPanel() {
    personaSummary.textContent = `${plural(pool.personas.length, "persona")} · ${plural(pool.dimensions.length, "dimension")}`;
    objectSummary.textContent = plural(pool.objects.length, "data object");
  }

  function renderPersonas() {
    renderPoolPanel();
    renderPersonaList(personaListEl, { pool, query: poolQuery, selectedId: selectedPersona, limit: personaListLimit, handlers: { onSelect: (id) => { selectedPersona = id; scrollToPersona(id); renderPersonas(); }, onMore: () => { personaListLimit += LIST_PAGE * 2; renderPersonas(); } } });
    if (section === "personas" && mode !== "mapping") renderPersonaPage(content, { pool, query: poolQuery, selectedId: selectedPersona, limit: personaLimit, usage: pool.usage, handlers: personaHandlers });
  }

  function scrollToPersona(id) {
    const index = pool.personas.findIndex((p) => p.id === id);
    if (index >= personaLimit) personaLimit = index + CARD_PAGE;
    queueMicrotask(() => content.querySelector(`[data-persona="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: "center" }));
  }

  const personaHandlers = {
    onNew: () => editPersona(null),
    onEdit: (id) => editPersona(id),
    onGenerate: generate,
    onEditDimension: (id) => editDimension(id),
    onMore: () => {
      personaLimit += CARD_PAGE * 2;
      renderPersonas();
    },
  };

  function renderObjects() {
    renderPoolPanel();
    const handlers = { onSelect: (id) => { selectedObject = id; renderObjects(); }, onNew: () => editObject(null), onEdit: (id) => editObject(id) };
    renderObjectList(objectListEl, { pool, query: objectQuery, selectedId: selectedObject, handlers });
    if (section === "objects" && mode !== "mapping") renderObjectPage(content, { pool, query: objectQuery, selectedId: selectedObject, handlers });
  }

  function renderPools() {
    renderPoolPanel();
    if (section === "personas") renderPersonas();
    else if (section === "objects") renderObjects();
    else renderAll();
  }

  function renderGuide() {
    const name = options.getProjectName();
    const prompt = `Write use cases for the screens in ${name || "this project"}`;
    content.replaceChildren(
      h(
        "div",
        { class: "uc-guide" },
        h("h1", { class: "uc-guide-title" }, "Describe what people do with your screens"),
        h("p", { class: "uc-guide-lede" }, "Use cases are optional. Without them this project works exactly as before. Add them when coding agents should build against concrete flows: who acts, which screen or element each step touches, and example data before and after."),
        h(
          "ol",
          { class: "uc-guide-steps" },
          h("li", null, h("span", { class: "uc-guide-num" }, "1"), h("div", null, h("p", null, "Say who uses the product. Write a few personas, or list the ways your users differ and generate them."), h("div", { class: "uc-guide-actions" }, h("button", { type: "button", class: "chrome-btn", onClick: () => editPersona(null) }, icon("person_add"), "New persona"), h("button", { type: "button", class: "uc-link-btn", onClick: () => { setSection("personas"); editDimension(null); } }, "Set up dimensions")))),
          h("li", null, h("span", { class: "uc-guide-num" }, "2"), h("div", null, h("p", null, "Write your first use case and point each step at a screen or a single element."), h("div", { class: "uc-guide-actions" }, h("button", { type: "button", class: "chrome-btn", onClick: () => newUseCase() }, icon("add"), "New use case")))),
          h("li", null, h("span", { class: "uc-guide-num is-icon" }, icon("smart_toy")), h("div", null, h("p", null, "Or let your AI tool do both. It reads your screens and writes personas, data objects and use cases here."), h("div", { class: "uc-prompt" }, h("code", null, prompt), h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": "Copy prompt", onClick: () => copy(prompt) }, icon("content_copy"))))),
        ),
      ),
    );
  }

  /** `total` is the real number of warnings when the tool capped the list (invalid_file_count, warning_count). */
  function showToast(text, warnings = [], autoHideMs = 0, total = warnings.length) {
    toast.replaceChildren(
      h("div", { class: "uc-toast-body" }, h("strong", null, text), warnings.length > 0 ? h("ul", null, warnings.slice(0, 5).map((w) => h("li", null, w.message ?? String(w)))) : null, total > 5 ? h("p", { class: "uc-muted" }, `… and ${total - 5} more`) : null),
      h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": "Dismiss", onClick: () => { toast.hidden = true; } }, icon("close")),
    );
    toast.hidden = false;
    clearTimeout(showToast.timer);
    if (autoHideMs > 0) showToast.timer = setTimeout(() => { toast.hidden = true; }, autoHideMs);
  }

  /** Response of a write: warnings are shown, never blocking. */
  function reportWrite(data, label) {
    const warnings = data.warnings ?? [];
    if (warnings.length > 0) showToast(`${label} ${warningSummary(warnings, data.warning_count)}`, warnings, 0, data.warning_count ?? warnings.length);
    else showToast(label, [], 1800);
  }

  // --- Writes ----------------------------------------------------------------------------------------------------

  const takenIds = (kind) => () => {
    if (kind === "use_case") return new Set([...(list.flat.items ?? []).map((u) => u.id), ...[...list.groupState.values()].flatMap((s) => s.rows.map((u) => u.id)), ...(detail?.id ? [detail.id] : [])]);
    if (kind === "persona") return new Set(pool.personas.map((p) => p.id));
    if (kind === "dimension") return new Set(pool.dimensions.map((d) => d.id));
    return new Set(pool.objects.map((o) => o.id));
  };

  async function refreshAfterWrite() {
    await loadPool();
    renderPools();
    await loadList();
    if (detail?.id) await reloadDetail();
  }

  async function nodeIds(screen) {
    const res = await options.fetchScreenNodes(screen, project);
    return res.ok ? (res.nodes ?? []).map((n) => n.id) : [];
  }

  function useCaseDialogOptions(extra) {
    const groups = Object.keys(list.facets?.group ?? {});
    return {
      pool: poolView,
      screens: () => options.getScreens().map((s) => s.name),
      groups: () => groups,
      takenIds: takenIds("use_case"),
      exists: async (id) => {
        const res = await api.fetchUseCaseSource(project, id);
        return res.ok || res.status === 422; // a file that no longer validates is still a file: never overwrite it by accident
      },
      loadNodes: nodeIds,
      save: (payload) => api.setUseCases(project, { use_cases: [payload] }),
      newObject: () => editObject(null),
      ...extra,
    };
  }

  async function newUseCase() {
    if (!pool.loaded) await loadPool();
    const saved = await openUseCaseDialog(useCaseDialogOptions({ mode: "new", source: null }));
    if (!saved) return;
    reportWrite(saved.data, "Use case created.");
    setSection("cases");
    await loadPool();
    await loadList();
    await openCase(saved.id);
  }

  async function editUseCase(id, focus = {}) {
    // Always from the file as it is now: an edit sends whole arrays (shallow merge), so a stale copy would overwrite an agent's change.
    const res = await api.fetchUseCaseSource(project, id);
    if (!res.ok) return showToast(res.message, []);
    const source = res.useCase;
    const initialDraft = focus.addVariant ? Object.assign(draftFromSource(source), {}) : undefined;
    if (initialDraft) initialDraft.variants.push({ id: "", title: "", description: "", when: {}, rest: "" });
    const saved = await openUseCaseDialog(useCaseDialogOptions({ mode: "edit", source, focus, initialDraft }));
    if (!saved) return;
    reportWrite(saved.data, "Use case saved.");
    await refreshAfterWrite();
    if (mode === "mapping") showMapping(null);
  }

  async function unmapStep(stepId) {
    if (!detail?.id) return;
    const fresh = await api.fetchUseCaseSource(project, detail.id);
    if (!fresh.ok) return showToast(fresh.message, []);
    const result = removeStepTarget(fresh.useCase, stepId, detail.variantId);
    if (!result.changed) return showToast("Nothing to change: that step has no target in the stored use case any more.", []);
    const res = await api.setUseCases(project, { use_cases: [{ id: detail.id, ...result.patch }] });
    if (!res.ok) return showToast(res.message, []);
    reportWrite(res.data, result.where === "variant" ? "Step left unmapped in this variant." : "Step left unmapped.");
    await reloadDetail();
  }

  /** "Pick new target": a step a variant changed or added is edited in that variant's overrides, any other in the base steps. */
  function pickTarget(stepId) {
    const step = detail?.view?.use_case?.steps?.find((s) => s.id === stepId);
    if (detail?.variantId && (step?.change === "changed" || step?.change === "added")) return editUseCase(detail.id, { variantId: detail.variantId });
    return editUseCase(detail.id, { step: stepId });
  }

  async function deleteUseCase(id) {
    const ok = await confirmDialog({ title: "Delete use case", text: `Delete "${detail?.view?.use_case?.title ?? id}"? Its file is removed. This cannot be undone here (the project history keeps it when auto-commit is on).`, confirmLabel: "Delete use case" });
    if (!ok) return;
    const res = await api.deleteUseCase(project, id);
    if (!res.ok) return showToast(res.message, []);
    reportWrite(res.data, "Use case deleted.");
    detail = null;
    mode = "detail";
    autoSelected = false;
    await loadPool();
    await loadList();
  }

  async function editPersona(id) {
    let source = id ? pool.personasById.get(id) : null;
    if (id && !source) return;
    const saved = await openPersonaDialog({ mode: id ? "edit" : "new", source, pool: poolView, takenIds: takenIds("persona"), save: (payload) => api.setUseCases(project, { personas: [payload] }), remove: (pid) => api.deletePersona(project, pid) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Persona deleted." : "Persona saved.");
    if (saved.deleted) selectedPersona = null;
    else selectedPersona = saved.id;
    await refreshAfterWrite();
  }

  async function editDimension(id) {
    const source = id ? pool.dimensionsById.get(id) : null;
    const saved = await openDimensionDialog({ mode: id ? "edit" : "new", source, takenIds: takenIds("dimension"), save: (payload) => api.setUseCases(project, { dimensions: [payload] }), remove: (did) => api.deleteDimension(project, did) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Dimension deleted." : "Dimension saved.");
    await refreshAfterWrite();
  }

  async function editObject(id) {
    const source = id ? pool.objectsById.get(id) : null;
    const saved = await openObjectDialog({ mode: id ? "edit" : "new", source, pool: poolView, takenIds: takenIds("object"), save: (payload) => api.setUseCases(project, { data_objects: [payload] }), remove: (oid) => api.deleteDataObject(project, oid) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Data object deleted." : "Data object saved.");
    if (!saved.deleted) selectedObject = saved.id;
    await loadPool();
    renderPools();
  }

  async function generate() {
    const saved = await openGenerateDialog({ pool: poolView, generate: (input) => api.generatePersonas(project, input) });
    if (!saved) return;
    reportWrite(saved.data, `${plural(saved.created, "persona")} generated.`);
    await refreshAfterWrite();
  }

  function addForSection() {
    if (section === "cases") newUseCase();
    else if (section === "personas") editPersona(null);
    else editObject(null);
  }

  function setSection(next) {
    section = next;
    mode = "detail";
    closeMenu();
    renderAll();
    if (next === "personas") personaSearch.focus?.();
  }

  // --- Public ----------------------------------------------------------------------------------------------------

  async function start() {
    if (!project) return;
    loadedFor = project;
    autoSelected = false;
    detail = null;
    mode = "detail";
    list.expanded = new Set();
    list.groupState = new Map();
    renderAll();
    await Promise.all([loadPool(), loadList()]);
    renderPools();
    renderAll();
  }

  return {
    /** The tab was opened: loads on first show / after a project switch; later shows only re-render (live events keep it current). */
    async show() {
      visible = true;
      project = options.getProject();
      if (project && loadedFor !== project) await start();
    },
    hide() {
      visible = false;
      closeMenu();
    },
    /** `/`: focus the search field of the current section. Returns whether there was one to focus (not in the mapping view). */
    focusSearch() {
      if (mode === "mapping") return false;
      if (section === "cases") listPanel.focusSearch();
      else (section === "personas" ? personaSearch : objectSearch).focus();
      return true;
    },
    /** Forget everything of the previous project (project switch). */
    reset() {
      project = options.getProject();
      loadedFor = null;
      detail = null;
      filters = { ...EMPTY_FILTERS };
      Object.assign(pool, emptyPool());
      list.req++;
      mapping.hide();
      if (visible) start();
    },
    /** SSE `usecases` change event: { name: "personas" | "data-objects" | "cases/<id>" | "usecases" | "cases" }. */
    onChange() {
      // Also while the tab is hidden (once it has loaded): otherwise the list, the detail and the pool a later edit works from would be stale.
      if (!project || loadedFor !== project) return;
      scheduleReload();
    },
    /** Reconnect after a dropped event stream: refetch everything shown. */
    resync() {
      if (project && loadedFor === project) scheduleReload();
    },
    /** Reverse entry: a short list of the use cases that map to a screen (none unless the tab has loaded some). */
    async forScreen(screen) {
      if (!project || !pool.loaded || (pool.counts?.use_cases ?? 0) === 0) return { total: 0, items: [] };
      const res = await api.getUseCases(project, { screen, limit: 5, sort: "title" });
      return res.ok ? { total: res.data.total ?? 0, items: res.data.use_cases ?? [] } : { total: 0, items: [] };
    },
    /** Reverse entry: the whole list filtered to a screen. */
    async showScreen(screen) {
      project = options.getProject();
      filters = { ...EMPTY_FILTERS, screen };
      section = "cases";
      mode = "detail";
      detail = null;
      autoSelected = false;
      loadedFor = project;
      await Promise.all([loadPool(), loadList()]);
      renderAll();
    },
    /** Opens one use case in the tab (the tab itself is shown by the caller). */
    async showCase(id) {
      project = options.getProject();
      if (loadedFor !== project) await start();
      section = "cases";
      await openCase(id);
    },
    openCase,
    /** What the scale proof reads. */
    stats: () => ({ rendered: listPanel.renderedRows(), rows: listPanel.totalRows(), total: list.total, mode: list.mode }),
    isLoaded: () => loadedFor === project && pool.loaded,
    hasUseCases: () => (pool.counts?.use_cases ?? 0) > 0,
  };
}
