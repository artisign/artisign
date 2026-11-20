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
import { blankVariant } from "./usecases-variant-edit.js";
import { openPersonaDialog, openDimensionDialog, openObjectDialog, openGenerateDialog } from "./usecases-forms-pool.js";
import { openEntityDialog, openRelationshipTypeDialog, openConstellationDialog } from "./usecases-forms-world.js";
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
  splitInvalidWarnings,
} from "./usecases-data.js";
import { avatar, statusDot } from "./usecases-parts.js";
import { actorKind } from "./usecases-world-parts.js";
import { renderLoadProblem, renderEntryNotice, savingPausedReason } from "./usecases-problem.js";
import { renderWorldNav, renderWorldPage } from "./usecases-world-pool.js";
import { flowSequence } from "./usecases-world-data.js";
import { avatarOf } from "./usecases-data.js";

const SECTIONS = [
  { id: "cases", label: "Use cases" },
  { id: "personas", label: "Personas" },
  { id: "world", label: "World" },
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
  let selectedWorldPart = "entities";
  let coverageOpen = false;
  let selectedStep = null; // the mapping view's focused step: survives a reload while the step still exists
  let shownInvalid = ""; // key of the set of unreadable files the toast last reported
  let pendingWorldError = ""; // a world-read error held back while a confirmation was visible
  let shownWorldError = ""; // the world-read error the toast last said, so a reload does not repeat it
  let writeToast = false; // the visible toast is a write's confirmation
  let pendingInvalid = null; // an invalid-files report held back while a confirmation was visible
  let poolProblem = ""; // the pool read failed outright (a file that is not JSON, the wrong shape): the tab says so instead of showing empty lists
  let listProblem = ""; // the same for the list read
  let listEntryWarnings = []; // skipped entries of personas.json / data-objects.json, from the list read
  let entryTotal = 0; // the real number of skipped entries in the list read (the list carries at most 10)
  let worldEntryWarnings = []; // skipped entries of world.json, from GET /api/world

  const pool = emptyPool();
  const list = { req: 0, loading: false, error: "", total: 0, counts: null, facets: null, facetsTruncated: [], mode: "tree", tree: null, expanded: new Set(), groupState: new Map(), groupErrors: new Map(), ungrouped: { count: 0, rows: [], loading: false }, flat: { items: [], cursor: null, loading: false, error: "" }, activeKey: null };
  let detail = null; // { id, variantId, view, base, source, error, loading }

  // --- DOM skeleton --------------------------------------------------------------------------------------------

  const subnav = h("nav", { class: "uc-subnav", "aria-label": "Use Cases sections" }, SECTIONS.map((s) => h("button", { type: "button", class: "chrome-tab uc-subtab", dataset: { section: s.id }, "aria-pressed": "false", onClick: () => setSection(s.id) }, s.label)), h("span", { class: "uc-map-spacer" }), h("button", { type: "button", class: "chrome-icon-btn", id: "uc-add", onClick: () => addForSection() }, icon("add")));
  const addButton = subnav.querySelector("#uc-add");
  const casesPanelEl = h("div", { class: "uc-side-panel", dataset: { section: "cases" } });
  const personasPanelEl = h("div", { class: "uc-side-panel", dataset: { section: "personas" }, hidden: true });
  const objectsPanelEl = h("div", { class: "uc-side-panel", dataset: { section: "objects" }, hidden: true });
  const worldPanelEl = h("div", { class: "uc-side-panel uc-world-nav", dataset: { section: "world" }, hidden: true });
  const personaSearch = h("input", { type: "search", class: "chrome-field uc-search-input", placeholder: "Search personas, goals, traits…", "aria-label": "Search personas", autocomplete: "off" });
  const personaSummary = h("div", { class: "uc-result" });
  const personaListEl = h("div", { class: "uc-plist" });
  personasPanelEl.append(h("div", { class: "uc-search" }, icon("search"), personaSearch), personaSummary, personaListEl);
  const objectSearch = h("input", { type: "search", class: "chrome-field uc-search-input", placeholder: "Search data objects…", "aria-label": "Search data objects", autocomplete: "off" });
  const objectSummary = h("div", { class: "uc-result" });
  const objectListEl = h("div", { class: "uc-plist" });
  objectsPanelEl.append(h("div", { class: "uc-search" }, icon("search"), objectSearch), objectSummary, objectListEl);
  const side = h("aside", { class: "uc-side" }, subnav, casesPanelEl, personasPanelEl, worldPanelEl, objectsPanelEl);
  const toast = h("div", { class: "uc-toast", role: "status", hidden: true });
  const notice = h("div", { class: "uc-toast uc-notice", role: "status", hidden: true });
  const content = h("div", { class: "uc-content" });
  const main = h("main", { class: "uc-main" }, toast, notice, content);
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
    onRetry: (path) => loadMore(path),
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
      onStep: (stepId) => {
        selectedStep = stepId;
      },
    },
  });

  // --- Pool ------------------------------------------------------------------------------------------------------

  function emptyPool() {
    // `world`: the stored world pool (GET /api/world); `constellations`: id -> name for the filter menu.
    return { worldError: "", world: { entities: [], relationship_types: [], constellations: [] }, constellations: new Map(), personas: [], dimensions: [], objects: [], personasById: new Map(), dimensionsById: new Map(), objectsById: new Map(), counts: null, usage: Object.assign(new Map(), { complete: false }), loaded: false };
  }

  async function loadPool() {
    const forProject = project;
    const [res, worldRes] = await Promise.all([api.listUseCases(forProject, { limit: 1, include: ["personas", "dimensions", "data_objects"] }), api.fetchWorldSource(forProject)]);
    if (forProject !== project) return;
    poolProblem = res.ok ? "" : errorMessage(res);
    // The world pool has its own read, applied whatever the other one says; a failed one is said where the world shows (the World tab, the filter menu, a toast).
    const world = worldRes.ok ? worldRes.world : { entities: [], relationship_types: [], constellations: [] };
    const worldError = worldRes.ok ? "" : errorMessage(worldRes);
    worldEntryWarnings = worldRes.ok ? worldRes.warnings : [];
    reportWorldError(worldError);
    if (!res.ok) {
      // The tab's content says so (renderAll), with Retry; nothing of the last good read stays on show.
      Object.assign(pool, emptyPool(), { world, worldError, constellations: new Map(world.constellations.map((c) => [c.id, c.name])) });
      return;
    }
    const data = res.data;
    pool.world = world;
    pool.worldError = worldError;
    pool.constellations = new Map(world.constellations.map((c) => [c.id, c.name]));
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
  const loadProblem = () => poolProblem || listProblem;
  /** Marks every control of a pool page that opens an editor or a generator while saving is paused: focusable, with the reason as its title; the handlers refuse the click too. */
  function markPaused(root) {
    const reason = pausedReason();
    if (!reason) return;
    for (const el of root.querySelectorAll(".uc-persona-open, .uc-dim-name, .uc-h2-action, .uc-persona-new, .uc-io-pencil, .uc-page-head .uc-actions button, .uc-world-page .uc-h2-row button, .uc-world-page .uc-link-row, .uc-world-page .uc-guide-actions button")) {
      if (el.disabled) continue;
      el.setAttribute("aria-disabled", "true");
      el.title = reason;
    }
  }
  const pausedReason = () => savingPausedReason({ problem: loadProblem(), warnings: [...listEntryWarnings, ...worldEntryWarnings] });

  /** What a person has to look at: the whole-file problem as the tab's content, skipped entries as a notice above it (the toast keeps unreadable case files). */
  function renderProblems() {
    renderEntryNotice(notice, { warnings: [...listEntryWarnings, ...worldEntryWarnings], total: entryTotal + worldEntryWarnings.length, onRetry: retry });
  }

  async function retry() {
    await Promise.all([loadPool(), loadList()]);
    renderPools();
    renderAll();
  }
  const isEmptyProject = () => pool.loaded && pool.counts && pool.counts.use_cases === 0 && pool.counts.personas === 0 && pool.counts.dimensions === 0 && pool.counts.data_objects === 0;

  // --- List ------------------------------------------------------------------------------------------------------

  function listRows() {
    if (list.mode === "tree" && list.tree) {
      const rows = flattenTree({ roots: list.tree.roots, expanded: list.expanded, groupState: list.groupState, ungrouped: list.ungrouped });
      // A group whose last page failed shows the error row (with Retry) in place of its "Show N more" row.
      return rows.map((row) => (row.kind === "more" && list.groupErrors.has(row.path) ? { kind: "error", key: `e:${row.path}`, path: row.path, depth: row.depth, message: list.groupErrors.get(row.path) } : row));
    }
    return flattenFlat({ items: list.flat.items, withHeaders: sort === "group", total: list.total, loading: list.flat.loading, error: list.flat.error });
  }

  function renderList() {
    const rows = listRows();
    const labels = { persona: filters.persona ? actorName(filters.persona, pool.personasById) : "", constellation: filters.constellation ? (pool.constellations.get(filters.constellation) ?? filters.constellation) : "" };
    const empty = isEmptyProject();
    const emptyText = `${plural(0, "use case")} · ${plural(pool.counts?.personas ?? 0, "persona")}`;
    // The reason is said once, in the tab's content; the list only says that there is none.
    listPanel.update({ filters, sort, total: list.total, counts: list.counts, rows, selectedId: detail?.id ?? null, activeKey: list.activeKey, labels, loading: list.loading, error: list.error ? "Use cases could not be loaded." : "", empty: empty || Boolean(list.error), emptyText });
  }

  /** The invalid-files toast shows when the set of unreadable files changes — not on every list load — and never replaces a write's confirmation. */
  function reportInvalidFiles(data) {
    const { entries, files: warnings } = splitInvalidWarnings(data.warnings);
    listEntryWarnings = entries;
    entryTotal = data.invalid_pool_entry_count ?? entries.length;
    const total = data.invalid_file_count; // case files only; pool entries have invalid_pool_entry_count
    const key = warnings.length ? JSON.stringify([total ?? warnings.length, warnings.map((w) => w.message ?? String(w))]) : "";
    if (key === shownInvalid || key === "") {
      pendingInvalid = null;
      shownInvalid = key === "" ? "" : shownInvalid;
      return;
    }
    const report = { key, warnings, total };
    if (writeToast && !toast.hidden) {
      pendingInvalid = report; // shown when the confirmation goes away
      return;
    }
    showInvalid(report);
  }

  function showInvalid(report) {
    pendingInvalid = null;
    shownInvalid = report.key;
    showToast("Some use case files could not be loaded.", report.warnings, 0, report.total);
  }

  function hideToast() {
    toast.hidden = true;
    if (writeToast) {
      writeToast = false;
      if (pendingInvalid) showInvalid(pendingInvalid);
    }
    // A held-back world error comes after the invalid-files report: once no toast is showing any more.
    if (toast.hidden && pendingWorldError) reportWorldError(pendingWorldError);
  }

  /** The world-read error toast: said once per message, and held back while a write's confirmation is visible. */
  function reportWorldError(message) {
    if (message === "" || message === shownWorldError) {
      pendingWorldError = "";
      if (message === "") shownWorldError = "";
      return;
    }
    if (writeToast && !toast.hidden) {
      pendingWorldError = message;
      return;
    }
    shownWorldError = message;
    pendingWorldError = "";
    showToast(`The world could not be read: ${message}`, []);
  }

  async function loadList() {
    const forProject = project;
    const req = ++list.req;
    const query = buildQuery(filters);
    list.loading = true;
    list.error = "";
    list.groupErrors = new Map();
    const stale = () => req !== list.req || forProject !== project;
    const first = await api.listUseCases(forProject, { ...query, sort, limit: sort === "group" ? 1 : FLAT_PAGE });
    if (stale()) return;
    list.loading = false;
    listProblem = first.ok ? "" : errorMessage(first);
    if (!first.ok) {
      list.error = listProblem;
      listEntryWarnings = [];
      entryTotal = 0;
      // Nothing of an earlier read stays on show next to the problem.
      list.total = 0;
      list.mode = "flat";
      list.tree = null;
      list.flat = { items: [], cursor: null, loading: false, error: "" };
      renderList();
      renderAll();
      return;
    }
    const data = first.data;
    list.total = data.total ?? 0;
    list.counts = data.counts ?? list.counts;
    list.facets = data.facets ?? {};
    list.facetsTruncated = data.facets_truncated ?? [];
    pool.counts = data.counts ?? pool.counts;
    reportInvalidFiles(data);
    const groupComplete = !list.facetsTruncated.includes("group") && Object.keys(list.facets.group ?? {}).every(isCanonicalGroup);

    if (sort === "group" && groupComplete) {
      list.mode = "tree";
      list.tree = buildGroupTree(list.facets.group);
      const grouped = Object.values(list.facets.group ?? {}).reduce((sum, n) => sum + n, 0);
      const keep = new Set([...list.expanded].filter((path) => path === "" || list.tree.byPath.has(path)));
      if (detail?.view?.use_case) for (const path of groupAncestors(detail.view.use_case.group)) if (list.tree.byPath.has(path)) keep.add(path);
      list.expanded = keep;
      // A reload keeps the rows already loaded (so the list does not collapse and the scroll position stays) and
      // refetches the same number of rows per expanded group and for "No group".
      const previous = list.groupState;
      const previousUngrouped = list.ungrouped.rows;
      const ungroupedCount = Math.max(0, list.total - grouped);
      list.groupState = new Map([...previous].filter(([path]) => path !== "" && list.expanded.has(path)));
      list.ungrouped = { count: ungroupedCount, rows: previousUngrouped.slice(0, ungroupedCount), loading: false };
      renderList();
      await Promise.all([...list.expanded].map((path) => reloadGroup(path, path === "" ? previousUngrouped.length : (previous.get(path)?.rows.length ?? 0), req)));
      if (stale()) return;
    } else {
      list.mode = "flat";
      list.tree = null;
      list.flat = { items: [], cursor: null, loading: false, error: "" };
      if (sort === "group") {
        const page = await api.listUseCases(forProject, { ...query, sort, limit: FLAT_PAGE });
        if (stale()) return;
        if (page.ok) {
          list.flat.items = page.data.use_cases ?? [];
          list.flat.cursor = page.data.next_cursor ?? null;
        } else {
          // The error row offers Retry; nothing retries by itself.
          list.flat.error = errorMessage(page);
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
      const res = await api.listUseCases(project, { ...query, limit: Math.min(PAGE_MAX, want - rows.length), ...(cursor !== undefined ? { cursor } : {}) });
      if (!res.ok) return { ok: false, rows, cursor, message: errorMessage(res) };
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
    if (result.ok) list.groupErrors.delete(path);
    else list.groupErrors.set(path, result.message); // the error row offers Retry (loadMore continues at the cursor)
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
    if (result.ok) list.groupErrors.delete("");
    else list.groupErrors.set("", result.message);
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
      // Without a cursor only a failed first page (no rows, an error) may load: that is Retry.
      const retryFirst = !list.flat.cursor && list.flat.error && list.flat.items.length === 0;
      if (list.flat.loading || (!list.flat.cursor && !retryFirst)) return;
      list.flat.loading = true;
      list.flat.error = "";
      renderList();
      const res = await api.listUseCases(project, { ...buildQuery(filters), sort, limit: FLAT_PAGE, ...(list.flat.cursor ? { cursor: list.flat.cursor } : {}) });
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
      list.groupErrors.delete("");
      renderList();
      const result = await pageRows({ ...buildQuery(filters), sort: "group" }, Math.min(GROUP_PAGE, list.ungrouped.count - list.ungrouped.rows.length), String(offset), () => true);
      if (req !== list.req) return;
      list.ungrouped.loading = false;
      list.ungrouped.rows = list.ungrouped.rows.concat(result.rows);
      if (!result.ok) list.groupErrors.set("", result.message);
      renderList();
      return;
    }
    const node = list.tree?.byPath.get(path);
    const state = list.groupState.get(path);
    if (!node || !state || state.loading) return;
    state.loading = true;
    list.groupErrors.delete(path);
    renderList();
    const result = await pageRows({ ...buildQuery(filters), group: path, sort: "group" }, Math.min(GROUP_PAGE, node.direct - state.rows.length), state.cursor, (u) => u.group === path);
    if (req !== list.req) return;
    if (!result.ok) list.groupErrors.set(path, result.message);
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
      const hadDetail = Boolean(detail?.id); // a detail that loadList's auto-select opens is fresh already
      await Promise.all([loadPool(), loadList()]);
      renderPools();
      if (hadDetail && detail?.id) await reloadDetail();
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
    if (kind === "constellation") {
      const known = new Map(pool.constellations);
      if (filters.constellation && !known.has(filters.constellation)) known.set(filters.constellation, filters.constellation);
      const clear = () => {
        filters = { ...filters, constellation: "" };
        loadList();
      };
      return openMenu({
        anchor,
        label: "Constellation",
        title: "Constellation · from the world pool",
        items: [...known].map(([value, label]) => ({ value, label, checked: filters.constellation === value })),
        filterable: true,
        emptyText: pool.worldError ? `The world could not be read: ${pool.worldError}` : "No constellations in the world yet.",
        note: "Matches the case and its variants. No counts: a case can hold in several worlds.",
        onPick: (value) => {
          filters = { ...filters, constellation: value };
          loadList();
        },
        onClear: filters.constellation ? clear : undefined,
        clearLabel: "Clear constellation filter",
      });
    }
    // Counts inside the current filters, except this one: with it applied the facet would show only the picked value.
    let facets = list.facets ?? {};
    if (filters[kind]) {
      const res = await api.listUseCases(project, { ...buildQuery({ ...filters, [kind]: "" }), limit: 1 });
      if (res.ok) facets = res.data.facets ?? facets;
    }
    const counts = facets[kind] ?? {};
    const truncated = (list.facetsTruncated ?? []).includes(kind);
    let entries = kind === "status" ? STATUSES.map((s) => [s, counts[s] ?? 0]) : Object.entries(counts);
    // The facets stop at 50 values. Every persona is known client-side, so that menu lists them all; for tags the menu's text
    // field offers what was typed as the filter value (the server matches tags case-insensitively).
    if (kind === "persona" && truncated) entries = pool.personas.map((p) => [p.id, counts[p.id]]);
    const items = entries.map(([value, count]) => ({ value, label: kind === "status" ? STATUS_LABELS[value] : kind === "persona" ? actorName(value, pool.personasById) : value, count, checked: filters[kind] === value, leading: kind === "persona" ? avatar(avatarOf(value, pool.personasById), "sm") : kind === "status" ? statusDot(value) : null, trailing: kind === "persona" ? actorKind(pool.personasById.get(value)?.kind) : null }));
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
    if (!view.ok && view.code === "not_found" && variantId && base?.ok) {
      // The variant is gone, the case is not: show the base flow instead of a wrong "no longer exists".
      detail = { id, variantId: null, loading: false, error: "", view: base.data, base: base.data, source: source.ok ? source.useCase : null, suggest: suggest.ok ? suggest.data : null };
      showToast("That variant no longer exists. Showing the base flow.", [], 6000);
    } else if (!view.ok) {
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
    if (hadMapping && detail?.view) showMapping(flowSequence(detail.view.use_case.steps ?? [], detail.view.use_case.branches ?? []).some((item) => item.step.id === selectedStep) ? selectedStep : null);
  }

  function showMapping(stepId) {
    if (!detail?.view) return;
    mode = "mapping";
    selectedStep = stepId;
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
      paused: pausedReason(),
      handlers: {
        onVariant: (variantId) => openCase(detail.id, variantId),
        onEdit: () => editUseCase(detail.id),
        onOpenWorld: () => setSection("world"),
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
    worldPanelEl.hidden = section !== "world";
    addButton.hidden = section === "world"; // the world is edited in its own dialogs (not part of the read views)
    addButton.setAttribute("aria-label", section === "cases" ? "New use case" : section === "personas" ? "New persona" : "New data object");
    // Paused, not disabled: the button stays focusable and says why (a dialog would open on incomplete pools and its save would be refused).
    const paused = pausedReason();
    addButton.setAttribute("aria-disabled", paused ? "true" : "false");
    addButton.title = paused || addButton.getAttribute("aria-label");
    renderProblems();
    if (mode === "mapping" && detail?.view) return; // the mapping view owns the content
    if (loadProblem() && section !== "world") {
      renderPersonas(); // while there is a problem these only say so in their sidebars
      renderObjects();
      return renderLoadProblem(content, { message: loadProblem(), onRetry: retry });
    } // not an empty list: the data is there, it cannot be read
    if (section === "personas") return renderPersonas();
    if (section === "objects") return renderObjects();
    if (section === "world") return renderWorld();
    if (isEmptyProject()) return renderGuide();
    if (!detail) {
      content.replaceChildren(h("div", { class: "uc-placeholder" }, list.loading ? "Loading…" : pool.counts?.use_cases === 0 ? h("div", null, h("p", null, "No use cases yet."), h("button", { type: "button", class: "chrome-btn", onClick: () => newUseCase() }, icon("add"), "New use case")) : "Select a use case."));
      return;
    }
    if (detail.loading && !detail.view) return content.replaceChildren(h("div", { class: "uc-placeholder" }, "Loading…"));
    if (detail.error) return content.replaceChildren(h("div", { class: "uc-placeholder" }, h("p", null, detail.error)));
    renderDetail(content, detailCtx());
  }

  /** A sidebar whose pool could not be read says so instead of listing nothing (or the last good read). */
  function renderPoolProblem(summaryEl, listEl, what) {
    summaryEl.hidden = true; // no empty band with a divider above the message
    listEl.replaceChildren(h("p", { class: "uc-list-status" }, `${what} could not be loaded.`));
  }

  function renderPoolPanel() {
    personaSummary.hidden = false;
    objectSummary.hidden = false;
    personaSummary.textContent = `${plural(pool.personas.length, "persona")} · ${plural(pool.dimensions.length, "dimension")}`;
    objectSummary.textContent = plural(pool.objects.length, "data object");
  }

  function renderPersonas() {
    if (loadProblem()) return renderPoolProblem(personaSummary, personaListEl, "Personas");
    renderPoolPanel();
    renderPersonaList(personaListEl, { pool, query: poolQuery, selectedId: selectedPersona, limit: personaListLimit, handlers: { onSelect: (id) => { selectedPersona = id; scrollToPersona(id); renderPersonas(); }, onMore: () => { personaListLimit += LIST_PAGE * 2; renderPersonas(); } } });
    if (section === "personas" && mode !== "mapping" && !loadProblem()) {
      renderPersonaPage(content, { pool, query: poolQuery, selectedId: selectedPersona, limit: personaLimit, usage: pool.usage, handlers: personaHandlers });
      markPaused(content);
    }
  }

  function scrollToPersona(id) {
    const index = pool.personas.findIndex((p) => p.id === id);
    if (index >= personaLimit) personaLimit = index + CARD_PAGE;
    queueMicrotask(() => content.querySelector(`[data-persona="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: "center" }));
  }

  const personaHandlers = {
    onNew: () => editPersona(null),
    onEdit: (id) => editPersona(id),
    onGenerate: () => generate("personas"),
    onEditDimension: (id) => editDimension(id),
    onMore: () => {
      personaLimit += CARD_PAGE * 2;
      renderPersonas();
    },
  };

  function renderObjects() {
    if (loadProblem()) return renderPoolProblem(objectSummary, objectListEl, "Data objects");
    renderPoolPanel();
    const handlers = { onSelect: (id) => { selectedObject = id; renderObjects(); }, onNew: () => editObject(null), onEdit: (id) => editObject(id) };
    renderObjectList(objectListEl, { pool, query: objectQuery, selectedId: selectedObject, handlers });
    if (section === "objects" && mode !== "mapping" && !loadProblem()) {
      renderObjectPage(content, { pool, query: objectQuery, selectedId: selectedObject, handlers });
      markPaused(content);
    }
  }

  function renderWorld() {
    renderWorldNav(worldPanelEl, { world: pool.world, selected: selectedWorldPart, onSelect: (part) => { selectedWorldPart = part; renderWorld(); document.getElementById(`uc-world-${part}`)?.scrollIntoView?.({ block: "start" }); } });
    if (section === "world" && mode !== "mapping") {
      renderWorldPage(content, { world: pool.world, pool, selected: selectedWorldPart, error: pool.worldError, handlers: worldHandlers });
      markPaused(content);
    }
  }

  const worldHandlers = {
    onNewEntity: () => editEntity(null),
    onEditEntity: (id) => editEntity(id),
    onNewRelationshipType: () => editRelationshipType(null),
    onEditRelationshipType: (id) => editRelationshipType(id),
    onNewConstellation: () => editConstellation(null),
    onEditConstellation: (id) => editConstellation(id),
    onGenerate: () => generate("constellations"),
  };

  function renderPools() {
    renderPoolPanel();
    if (section === "world") return renderWorld();
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
      h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": "Dismiss", onClick: hideToast }, icon("close")),
    );
    toast.hidden = false;
    writeToast = false;
    clearTimeout(showToast.timer);
    if (autoHideMs > 0) showToast.timer = setTimeout(hideToast, autoHideMs);
  }

  /** Response of a write: warnings are shown, never blocking. */
  function reportWrite(data, label) {
    const warnings = data.warnings ?? [];
    if (warnings.length > 0) showToast(`${label} ${warningSummary(warnings, data.warning_count)}`, warnings, 0, data.warning_count ?? warnings.length);
    else showToast(label, [], 1800);
    writeToast = true;
  }

  // --- Writes ----------------------------------------------------------------------------------------------------

  const takenIds = (kind) => () => {
    if (kind === "use_case") return new Set([...(list.flat.items ?? []).map((u) => u.id), ...[...list.groupState.values()].flatMap((s) => s.rows.map((u) => u.id)), ...(detail?.id ? [detail.id] : [])]);
    if (kind === "persona") return new Set(pool.personas.map((p) => p.id));
    if (kind === "dimension") return new Set(pool.dimensions.map((d) => d.id));
    if (kind === "entity" || kind === "relationship_type" || kind === "constellation") return new Set((pool.world[kind === "entity" ? "entities" : kind === "constellation" ? "constellations" : "relationship_types"] ?? []).map((x) => x.id));
    return new Set(pool.objects.map((o) => o.id));
  };

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
      newObject: async () => {
        await editObject(null);
        await loadPool(); // the dialog's select reads the pool now, not after the write's SSE event
      },
      ...extra,
    };
  }

  async function newUseCase() {
    if (pausedReason()) return;
    if (!pool.loaded) await loadPool();
    const saved = await openUseCaseDialog(useCaseDialogOptions({ mode: "new", source: null }));
    if (!saved) return;
    reportWrite(saved.data, "Use case created.");
    setSection("cases");
    await openCase(saved.id); // the list and pool follow with the write's own SSE event
  }

  async function editUseCase(id, focus = {}) {
    if (pausedReason()) return;
    // Always from the file as it is now: an edit sends whole arrays (shallow merge), so a stale copy would overwrite an agent's change.
    const res = await api.fetchUseCaseSource(project, id);
    if (!res.ok) return showToast(res.message, []);
    const source = res.useCase;
    const initialDraft = focus.addVariant ? Object.assign(draftFromSource(source), {}) : undefined;
    if (initialDraft) initialDraft.variants.push(blankVariant());
    const saved = await openUseCaseDialog(useCaseDialogOptions({ mode: "edit", source, focus, initialDraft }));
    if (!saved) return;
    reportWrite(saved.data, "Use case saved."); // the SSE event reloads list, pool and detail (and keeps the mapping view)
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
    renderAll();
    renderList();
  }

  async function editPersona(id) {
    if (pausedReason()) return;
    let source = id ? pool.personasById.get(id) : null;
    if (id && !source) return;
    const saved = await openPersonaDialog({ mode: id ? "edit" : "new", source, pool: poolView, takenIds: takenIds("persona"), save: (payload) => api.setUseCases(project, { personas: [payload] }), remove: (pid) => api.deletePersona(project, pid) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Persona deleted." : "Persona saved.");
    if (saved.deleted) selectedPersona = null;
    else selectedPersona = saved.id;
  }

  async function editDimension(id) {
    if (pausedReason()) return;
    const source = id ? pool.dimensionsById.get(id) : null;
    const saved = await openDimensionDialog({ mode: id ? "edit" : "new", source, takenIds: takenIds("dimension"), save: (payload) => api.setUseCases(project, { dimensions: [payload] }), remove: (did) => api.deleteDimension(project, did) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Dimension deleted." : "Dimension saved.");
  }

  async function editObject(id) {
    if (pausedReason()) return;
    const source = id ? pool.objectsById.get(id) : null;
    const saved = await openObjectDialog({ mode: id ? "edit" : "new", source, pool: poolView, takenIds: takenIds("object"), save: (payload) => api.setUseCases(project, { data_objects: [payload] }), remove: (oid) => api.deleteDataObject(project, oid) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Data object deleted." : "Data object saved.");
    if (!saved.deleted) selectedObject = saved.id;
  }

  async function generate(target = "personas") {
    if (pausedReason()) return;
    const saved = await openGenerateDialog({ pool: poolView, target, generate: (input) => api.generatePersonas(project, input) });
    if (!saved) return;
    reportWrite(saved.data, `${plural(saved.created, saved.target === "constellations" ? "constellation" : "persona")} generated.`);
  }

  /** "Used by 3 use cases." for the footer of a world dialog and its delete question; empty when the read fails. */
  const usageOf = (filter) => async (id) => {
    const res = await api.listUseCases(project, { ...filter(id), limit: 1 });
    return res.ok ? `Used by ${plural(res.data.total ?? 0, "use case")}.` : "";
  };

  async function editEntity(id) {
    if (pausedReason()) return;
    const source = id ? pool.world.entities.find((e) => e.id === id) : null;
    if (id && !source) return;
    const saved = await openEntityDialog({ mode: id ? "edit" : "new", source, pool: poolView, takenIds: takenIds("entity"), save: (payload) => api.setUseCases(project, { entities: [payload] }), remove: (eid) => api.deleteMainEntity(project, eid), usage: usageOf((eid) => ({ entity: eid })) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Entity deleted." : "Entity saved.");
  }

  async function editRelationshipType(id) {
    if (pausedReason()) return;
    const source = id ? pool.world.relationship_types.find((t) => t.id === id) : null;
    if (id && !source) return;
    const saved = await openRelationshipTypeDialog({ mode: id ? "edit" : "new", source, pool: poolView, takenIds: takenIds("relationship_type"), save: (payload) => api.setUseCases(project, { relationship_types: [payload] }), remove: (tid) => api.deleteRelationshipType(project, tid) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Relationship type deleted." : "Relationship type saved.");
  }

  async function editConstellation(id) {
    if (pausedReason()) return;
    const source = id ? pool.world.constellations.find((c) => c.id === id) : null;
    if (id && !source) return;
    const saved = await openConstellationDialog({ mode: id ? "edit" : "new", source, pool: poolView, takenIds: takenIds("constellation"), save: (payload) => api.setUseCases(project, { constellations: [payload] }), remove: (cid) => api.deleteConstellation(project, cid), usage: usageOf((cid) => ({ constellation: cid })) });
    if (!saved) return;
    reportWrite(saved.data, saved.deleted ? "Constellation deleted." : "Constellation saved.");
  }

  function addForSection() {
    if (pausedReason()) return;
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
    shownInvalid = "";
    pendingInvalid = null;
    selectedStep = null;
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
      shownInvalid = "";
      pendingInvalid = null;
      selectedStep = null;
      filters = { ...EMPTY_FILTERS };
      Object.assign(pool, emptyPool());
      poolProblem = "";
      listProblem = "";
      listEntryWarnings = [];
      entryTotal = 0;
      worldEntryWarnings = [];
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
    /** Reverse entry: a short list of the use cases that map to a screen. A plain read that needs no loaded tab: a project without usecases/ answers with zero. */
    async forScreen(screen) {
      const forProject = options.getProject();
      if (!forProject) return { total: 0, items: [] };
      const res = await api.listUseCases(forProject, { screen, limit: 5, sort: "title" });
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
