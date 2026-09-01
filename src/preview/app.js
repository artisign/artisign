// Entry point: wires the screen list, the sandboxed render iframe, flow
// mode, comment mode and the design-system view together, and drives live
// reload from SSE. State lives in module scope — no framework store.

import {
  fetchScreens,
  fetchRender,
  fetchMockups,
  fetchMockupRender,
  fetchDesignSystem,
  fetchComments,
  fetchFlows,
  fetchScreenNodes,
  postComment,
  fetchProjects,
  activateProject,
  openProject,
  initProject,
} from "./api.js";
import { renderScreenList, filterScreens } from "./screens.js";
import { renderMockupList, filterMockups } from "./mockups.js";
import { renderMockupView } from "./mockup-view.js";
import { applyMockupZoom } from "./mockup-zoom.js";
import { applyFlowMode } from "./flows.js";
import { applyCommentMode, highlightSelection, openNodeIds, renderCommentsPanel, resolveSelectionAfterReload } from "./comments.js";
import { renderDesignSystem } from "./design-system.js";
import { connectEvents } from "./sse.js";
import { applyCanvas } from "./canvas.js";
import { updateWarningBadge } from "./warnings.js";
import { createBoardView } from "./board-view.js";
import { createProjectUI } from "./projects.js";
import { createProjectDialogs } from "./project-dialogs.js";
import {
  readBoolPref,
  writeBoolPref,
  readStringPref,
  writeStringPref,
  pickInitialScreen,
  parseLastSelection,
  parseZoomPref,
  parseEnumPref,
} from "./prefs.js";
import { createInspectorPanel, applyInspectMode, updateInspectOverlay } from "./inspector.js";
import { buildEntries } from "./inspector-data.js";

const screenListEl = document.getElementById("screen-list");
const mockupSectionEl = document.getElementById("mockup-section");
const mockupListEl = document.getElementById("mockup-list");
const mockupViewEl = document.getElementById("mockup-view");
const screenFilterInput = document.getElementById("screen-filter-input");
const screenFilterHint = document.getElementById("screen-filter-hint");
const notesPanelEl = document.getElementById("notes-panel");
const notesPanelHeader = document.getElementById("notes-panel-header");
const notesPanelScreen = document.getElementById("notes-panel-screen");
const notesPanelText = document.getElementById("notes-panel-text");
const screenFrame = document.getElementById("screen-frame");
const canvasEl = document.getElementById("canvas");
const screenHolderEl = document.getElementById("screen-holder");
const statusBarOverlayEl = document.getElementById("status-bar-overlay");
const emptyState = document.getElementById("empty-state");
const screensViewEl = document.getElementById("screens-view");
const designSystemViewEl = document.getElementById("design-system-view");
const boardViewEl = document.getElementById("board-view");
const boardSurfaceEl = document.getElementById("board-surface");
const boardTilesEl = document.getElementById("board-tiles");
const boardEdgesEl = document.getElementById("board-edges");
const flowModeToggle = document.getElementById("flow-mode-toggle");
const commentModeToggle = document.getElementById("comment-mode-toggle");
const canvasControlsEl = document.getElementById("canvas-controls");
const zoomButtons = document.querySelectorAll(".zoom-button");
const statusBarToggle = document.getElementById("status-bar-toggle");
const warningBadge = document.getElementById("warning-badge");
const connectionStatus = document.getElementById("connection-status");
const viewTabs = document.querySelectorAll(".view-tab");
const commentsListEl = document.getElementById("comments-list");
const commentComposeForm = document.getElementById("comment-compose");
const commentTargetLabel = document.getElementById("comment-target-label");
const commentBodyInput = document.getElementById("comment-body-input");
const commentErrorEl = document.getElementById("comment-error");
const commentCancelButton = document.getElementById("comment-cancel");
const bodyEl = document.getElementById("body");
const sidebarScreensEl = document.getElementById("sidebar-screens");
const sidebarScreensCollapseBtn = document.getElementById("sidebar-screens-collapse");
const sidebarContextEl = document.getElementById("sidebar-context");
const sidebarContextCollapseBtn = document.getElementById("sidebar-context-collapse");
const inspectModeToggle = document.getElementById("inspect-mode-toggle");
const inspectorEl = document.getElementById("inspector");
const inspectorCollapseBtn = document.getElementById("inspector-collapse");
const inspectorListEl = document.getElementById("inspector-list");
const inspectorEmptyEl = document.getElementById("inspector-empty");
const inspectorErrorEl = document.getElementById("inspector-error");
const inspectOverlayEl = document.getElementById("inspect-overlay");
const noProjectStateEl = document.getElementById("no-project-state");
const viewTabsNav = document.getElementById("view-tabs");
const projectPickerTrigger = document.getElementById("project-picker-trigger");
const projectPickerName = document.getElementById("project-picker-name");
const projectMenu = document.getElementById("project-menu");
const menuLabelOpen = document.getElementById("menu-label-open");
const menuOpenList = document.getElementById("menu-open-list");
const menuDivider1 = document.getElementById("menu-divider-1");
const menuLabelRecent = document.getElementById("menu-label-recent");
const menuRecentList = document.getElementById("menu-recent-list");
const menuActionOpen = document.getElementById("menu-action-open");
const menuActionInit = document.getElementById("menu-action-init");
const emptyRecentList = document.getElementById("empty-recent-list");
const emptyBtnOpen = document.getElementById("empty-btn-open");
const emptyBtnInit = document.getElementById("empty-btn-init");
const dialogScrim = document.getElementById("dialog-scrim");
const openProjectDialogEl = document.getElementById("open-project-dialog");
const initProjectDialogEl = document.getElementById("init-project-dialog");

/** @type {{ name: string, tags: string[], notes: string }[]} */
let screens = [];
let currentScreen = null;
/** @type {{ name: string, title?: string, description?: string, tags: string[], variants: { id: string, title: string, description?: string }[] }[]} */
let mockups = [];
// Mutually exclusive with currentScreen — see selectScreen/selectMockup.
let currentMockup = null;
let screenFilter = "";
let notesExpanded = true;
let currentView = "screens";
/** @type {"none" | "flow" | "comment" | "inspect"} */
let activeMode = "none";
let modeCleanup = () => {}; // click handling + outlines/markers inside the iframe
let warningBadgeCleanup = () => {}; // click-to-cycle listener on the warning badge
let warningCount = 0;
let comments = [];
let selectedNode; // undefined = nothing selected; null = screen-level target
// The screen `selectedNode` was selected on — set by restoreSelection.
// A reload only re-resolves a selection made on the SAME screen it applies
// to (see resolveSelectionAfterReload); this also catches a screen switch
// racing a click on the still-attached old screen's document, which would
// otherwise tag the click's target with whichever screen the app has since
// switched to.
let selectedNodeScreen = null;
let selectionCleanup = () => {}; // highlight on the currently selected target
/** @type {"fit" | number} */
let zoom = "fit";
// Separate zoom state for the mockup comparison row (see applyMockupZoom in
// mockup-zoom.js) — the topbar's zoom buttons are shared between it and the
// screen canvas, but each remembers its own level (see setZoom/isMockupZoomActive).
/** @type {"fit" | number} */
let mockupZoom = "fit";
let boardBuilt = false; // built lazily on first activation, then kept in sync via SSE — see loadBoard()
let activeProjectRoot = null; // the project root currently displayed; null while the empty state shows
let eventSource; // current /events connection — closed and reopened with a fresh ?project= on every switch

// Which screen the iframe's CURRENT document actually renders — set from
// the `load` event, not from `currentScreen` (which can already point at a
// newer screen while the iframe is still mid-load). Node ids are only
// unique within one screen; reading the iframe's DOM for computed values
// without checking this first can silently return another screen's stale
// element under the same id. `pendingRenderScreen` captures which screen a
// given `srcdoc` assignment was for, so the `load` handler (which has no
// other way to know) can set `iframeRenderedScreen` correctly even if
// `currentScreen` has since moved on again.
let iframeRenderedScreen = null;
let pendingRenderScreen = null;

// `localStorage` itself can throw on access (not just on getItem/setItem) in
// some privacy modes — resolve it once, tolerantly, rather than letting that
// crash module evaluation and take down the whole preview.
const prefsStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const board = createBoardView({ surfaceEl: boardSurfaceEl, tilesEl: boardTilesEl, edgesEl: boardEdgesEl });
board.mount();

/** @param {string | null} screen */
function getRenderedDocForScreen(screen) {
  return screen !== null && iframeRenderedScreen === screen ? screenFrame.contentDocument : null;
}

const inspectorPanel = createInspectorPanel(
  { listEl: inspectorListEl, emptyEl: inspectorEmptyEl, errorEl: inspectorErrorEl },
  { getRenderedDoc: getRenderedDocForScreen },
);

const projectUI = createProjectUI(
  {
    triggerEl: projectPickerTrigger,
    nameEl: projectPickerName,
    menuEl: projectMenu,
    openLabelEl: menuLabelOpen,
    openListEl: menuOpenList,
    dividerEl: menuDivider1,
    recentLabelEl: menuLabelRecent,
    recentListEl: menuRecentList,
    actionOpenEl: menuActionOpen,
    actionInitEl: menuActionInit,
    noProjectEl: noProjectStateEl,
    bodyEl,
    viewTabsEl: viewTabsNav,
    flowToggleEl: flowModeToggle,
    commentToggleEl: commentModeToggle,
    emptyRecentListEl: emptyRecentList,
    emptyBtnOpenEl: emptyBtnOpen,
    emptyBtnInitEl: emptyBtnInit,
  },
  {
    onSwitch: async (root) => {
      const result = await activateProject(root);
      if (result.ok) await applyProjectsResult(result.projects);
      else console.error(result.message);
    },
    onOpenRecent: async (dir) => {
      const result = await openProject(dir);
      if (result.ok) await applyProjectsResult(result.projects);
      else {
        console.error(result.message);
        await refreshProjectsState(); // the recent path may no longer exist — drop it from the list
      }
    },
    onOpenDialog: () => projectDialogs.showOpenDialog(),
    onInitDialog: () => projectDialogs.showInitDialog(),
  },
);

const projectDialogs = createProjectDialogs(
  { scrimEl: dialogScrim, openSectionEl: openProjectDialogEl, initSectionEl: initProjectDialogEl },
  {
    onOpen: async (dir) => {
      const result = await openProject(dir);
      if (result.ok) await applyProjectsResult(result.projects);
      return result;
    },
    onInit: async (dir, name) => {
      const result = await initProject(dir, name);
      if (result.ok) await applyProjectsResult(result.projects);
      return result;
    },
  },
);

/** Applies a fresh `/api/projects` response: updates the picker/empty-state and, if the active project changed, switches to it. */
async function applyProjectsResult(state) {
  projectUI.render(state);
  if (state.active !== activeProjectRoot) await switchToProject(state.active);
}

async function refreshProjectsState() {
  const state = await fetchProjects();
  projectUI.render(state);
  return state;
}

/** Resets every module-level piece of state tied to the previously active project, ready for a fresh boot. */
function resetProjectState() {
  modeCleanup();
  modeCleanup = () => {};
  warningBadgeCleanup();
  warningBadgeCleanup = () => {};
  warningCount = 0;
  clearSelection();
  screens = [];
  currentScreen = null;
  screenFilter = "";
  screenFilterInput.value = "";
  comments = [];
  boardBuilt = false;
  activeMode = "none";
  flowModeToggle.setAttribute("aria-pressed", "false");
  commentModeToggle.setAttribute("aria-pressed", "false");
  inspectModeToggle.setAttribute("aria-pressed", "false");
  screenFrame.srcdoc = "";
  board.setScreens([], []);
  iframeRenderedScreen = null;
  pendingRenderScreen = null;
  inspectorRequestId++; // discards any in-flight fetch from the project we just left — see loadInspectorEntries
  inspectorPanel.setEntries([], null);
  updateInspectOverlay(inspectOverlayEl, null, null);
  mockups = [];
  currentMockup = null;
  mockupViewEl.innerHTML = "";
  mockupRequestId++; // discards any in-flight render from the project we just left — see loadCurrentMockup
  applyMainVisibility();
}

/** @param {string | null} root */
async function switchToProject(root) {
  if (root === activeProjectRoot) return;
  activeProjectRoot = root;
  resetProjectState();
  reconnectSse(root ?? undefined);
  if (root) await bootScreens();
}

/** localStorage key for the last opened screen — scoped per project since the daemon serves several at once. */
function lastScreenKey(projectRoot) {
  return `artisign.last-screen:${projectRoot}`;
}

async function bootScreens() {
  await Promise.all([loadScreens(), loadMockups()]);
  const persisted = parseLastSelection(readStringPref(prefsStorage, lastScreenKey(activeProjectRoot), null));
  if (persisted?.kind === "mockup" && mockups.some((m) => m.name === persisted.name)) {
    await selectMockup(persisted.name);
    return;
  }
  if (screens.length === 0) return;
  await selectScreen(pickInitialScreen(screens, persisted?.kind === "screen" ? persisted.name : null));
}

/** Re-fetches everything the current view depends on — used after an SSE reconnect, where the gap while disconnected is invisible to us. */
async function resyncCurrentProject() {
  loadScreens();
  const mockupsOk = await loadMockups();
  if (currentScreen) {
    loadCurrentScreen();
    loadComments();
    loadInspectorEntries();
  }
  if (currentMockup && mockupsOk) {
    if (mockups.some((m) => m.name === currentMockup)) loadCurrentMockup();
    else await fallbackFromVanishedMockup();
  }
  if (currentView === "design-system") loadDesignSystem();
  if (boardBuilt) loadBoard();
}

/** Falls back from a currentMockup selection that no longer exists (deleted on disk) to the first available screen — same as boot's "nothing persisted" path — or, if the project has no screens either, just refreshes the sidebar/main state around the now-empty selection. Shared by the SSE mockup handler and resyncCurrentProject. */
async function fallbackFromVanishedMockup() {
  currentMockup = null;
  if (screens.length > 0) await selectScreen(pickInitialScreen(screens, null));
  else {
    refreshSidebar();
    applyMainVisibility();
  }
}

async function handleChangeEvent(event) {
  if (event.kind === "screen") {
    const previousScreens = screens;
    await loadScreens();
    if (event.name === currentScreen) {
      await loadCurrentScreen();
      await loadInspectorEntries(); // the screen's own source changed — refs may have too
    }
    if (boardBuilt) {
      const screenListChanged =
        previousScreens.length !== screens.length || previousScreens.some((s, i) => s.name !== screens[i].name);
      if (screenListChanged) await loadBoard();
      else await board.refreshScreen(event.name);
    }
  } else if (event.kind === "tokens" || event.kind === "component" || event.kind === "pattern" || event.kind === "asset") {
    // Tokens/components/patterns can affect any screen's render (refs
    // resolve through them) and the design-system view itself; an asset
    // change is the same shape — any screen or component/pattern variant
    // could reference it — and there's no cheaper way to know which without
    // re-parsing every document, so a re-render on any `assets/` change is
    // the whole fix. The Elements panel's own refs don't change, but the
    // RESOLVED values it shows for them do — loadInspectorEntries() rebuilds
    // the list (a same-screen rebuild, so createInspectorPanel.setEntries
    // carries expand/focus state over), and the iframe's own `load` handler
    // then refreshes those rows' bodies once the re-render lands.
    if (currentScreen) {
      await loadCurrentScreen();
      await loadInspectorEntries();
    }
    if (currentView === "design-system") await loadDesignSystem();
  } else if (event.kind === "design_system_meta") {
    if (currentView === "design-system") await loadDesignSystem();
  } else if (event.kind === "mockup") {
    if (!(await loadMockups())) return; // a fetch error must not be misread as "the mockup was deleted" — see fetchMockups
    if (event.name !== currentMockup) return;
    // A delete fires multiple "mockup" events for the same name (server-side,
    // one per file removed), so the vanished branch may run more than once;
    // fallbackFromVanishedMockup is idempotent.
    if (mockups.some((m) => m.name === currentMockup)) await loadCurrentMockup();
    else await fallbackFromVanishedMockup();
  } else if (event.kind === "comments") {
    await loadComments(); // refreshes the panel and, if comment mode is active, the open-thread markers
  } else if (event.kind === "flows") {
    // The single-screen view reads data-flow-target straight off the
    // rendered HTML (see flows.js), which a "screen" event above already
    // refreshes. The board draws edges from flows.json separately, so it
    // needs its own refetch here.
    if (boardBuilt) board.setFlows(await fetchFlows());
  }
}

/** @param {{ type: "project-switched" | "project-opened" | "project-closed", root: string }} event */
async function handleLifecycleEvent(event) {
  const state = await refreshProjectsState();
  if (event.type === "project-switched" || event.type === "project-closed") await switchToProject(state.active);
}

function reconnectSse(project) {
  eventSource?.close();
  eventSource = connectEvents({
    project,
    onChange: handleChangeEvent,
    onLifecycle: handleLifecycleEvent,
    onOpen: (isReconnect) => {
      connectionStatus.classList.remove("disconnected");
      // The SSE gap while disconnected is invisible to us — EventSource only
      // replays events sent after it reopens, not what happened during the
      // drop — so resync from scratch on reconnect.
      if (isReconnect) resyncCurrentProject();
    },
    onDisconnect: () => connectionStatus.classList.add("disconnected"),
  });
}

// Bumped on every loadCurrentScreen()/loadComments() call; a fetch only
// applies its result if it's still the most recently requested one.
// Without this, two quick screen switches (or an SSE-triggered refetch
// racing a screen switch) can let a slower, stale response overwrite a
// newer one — iframe shows screen A while the sidebar marks B as selected,
// or the comment panel/markers show screen A's comments under screen B.
let renderRequestId = 0;
let commentsRequestId = 0;
let inspectorRequestId = 0;
let mockupRequestId = 0;

/** Re-renders the screen list and the mockup list (both filtered by the same sidebar search), plus everything in the sidebar derived from them/the current selection. */
function refreshSidebar() {
  renderScreenList(screenListEl, screens, currentScreen, selectScreen, screenFilter);
  const filteredMockups = filterMockups(mockups, screenFilter);
  renderMockupList(mockupListEl, filteredMockups, { activeName: currentMockup, onSelect: selectMockup });
  mockupSectionEl.hidden = filteredMockups.length === 0;
  const filteredScreenCount = filterScreens(screens, screenFilter).length;
  screenFilterHint.textContent = `${filteredScreenCount} screen${filteredScreenCount === 1 ? "" : "s"} · ${filteredMockups.length} mockup${filteredMockups.length === 1 ? "" : "s"} · matches name and tags`;
  updateNotesPanel();
}

function updateNotesPanel() {
  const screen = screens.find((s) => s.name === currentScreen);
  const notes = screen?.notes ?? "";
  notesPanelEl.hidden = notes.length === 0;
  if (notes.length === 0) return;
  notesPanelScreen.textContent = screen.name;
  notesPanelText.textContent = notes;
  notesPanelHeader.setAttribute("aria-expanded", String(notesExpanded));
}

screenFilterInput.addEventListener("input", () => {
  screenFilter = screenFilterInput.value;
  refreshSidebar();
});

notesPanelHeader.addEventListener("click", () => {
  notesExpanded = !notesExpanded;
  notesPanelHeader.setAttribute("aria-expanded", String(notesExpanded));
});

async function loadScreens() {
  screens = await fetchScreens();
  refreshSidebar();
  emptyState.hidden = screens.length > 0;
  screenFrame.hidden = screens.length === 0;
}

async function selectScreen(screen) {
  // Node ids are only unique within one screen (see the iframeRenderedScreen
  // comment above) — a comment target selected on the previous screen must
  // not survive onto this one, even if a same-named id happens to exist
  // here too. The reload's `load` handler only re-resolves a SAME-screen
  // reload (see resolveSelectionAfterReload); an actual screen switch has to
  // clear it up front instead.
  clearSelection();
  currentScreen = screen;
  currentMockup = null; // screens and mockups are never selected at the same time
  if (activeProjectRoot) writeStringPref(prefsStorage, lastScreenKey(activeProjectRoot), screen);
  refreshSidebar();
  applyMainVisibility();
  await Promise.all([loadCurrentScreen(), loadComments(), loadInspectorEntries()]);
}

/**
 * Selects a mockup: mutually exclusive with selectScreen (see currentMockup)
 * — turns off any active flow/comment/inspect mode (none of them apply to
 * the mockup view) via the same toggle-off path their own buttons use, and
 * clears the screen selection highlight.
 * @param {string} name
 */
async function selectMockup(name) {
  setMode(activeMode); // passing the CURRENT mode always resolves to "none" — see setMode
  clearInspectFocus();
  currentScreen = null;
  currentMockup = name;
  if (activeProjectRoot) writeStringPref(prefsStorage, lastScreenKey(activeProjectRoot), `mockup:${name}`);
  // Discards whatever the PREVIOUS screen's loadCurrentScreen()/loadInspectorEntries()
  // may still have in flight — neither is re-run here (there's no screen to
  // render/inspect anymore), so their own guards would otherwise let a late
  // result land after we've already switched away. loadComments() below
  // bumps commentsRequestId itself, but bumping it up front too means the
  // invalidation doesn't depend on that call happening to run first.
  renderRequestId++;
  commentsRequestId++;
  inspectorRequestId++;
  refreshSidebar();
  applyMainVisibility();
  await Promise.all([loadCurrentMockup(), loadComments()]); // loadComments() clears the panel to the previous screen's threads otherwise
}

/** HTML-escapes text for safe interpolation into an srcdoc HTML string. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

async function loadCurrentScreen() {
  if (!currentScreen) return;
  const requestId = ++renderRequestId;
  const result = await fetchRender(currentScreen);
  if (requestId !== renderRequestId) return; // a newer request has since started — drop this stale result
  pendingRenderScreen = currentScreen; // read by the `load` handler below once this srcdoc assignment actually lands
  screenFrame.srcdoc = result.ok
    ? result.html
    : `<p style="font-family: system-ui, sans-serif; color: #900; padding: 16px;">${escapeHtml(result.message)}</p>`;
}

async function loadComments() {
  const requestId = ++commentsRequestId;
  const result = currentScreen ? await fetchComments(currentScreen) : [];
  if (requestId !== commentsRequestId) return; // a newer request has since started — drop this stale result
  comments = result;
  renderCommentsPanel(commentsListEl, comments, handleReply);
  // Markers depend on `comments`, not on the iframe's load event — refresh
  // them here, right when the data they're derived from actually changes,
  // rather than relying on applyActiveMode() being re-triggered by
  // something else that happens to run afterward.
  if (activeMode === "comment") applyActiveMode();
}

/** Rebuilds the Elements panel's list from the current screen's nodes (see fetchScreenNodes/buildEntries). */
async function loadInspectorEntries() {
  const requestId = ++inspectorRequestId;
  if (!currentScreen) {
    inspectorPanel.setEntries([], null);
    syncInspectOverlay();
    return;
  }
  const result = await fetchScreenNodes(currentScreen);
  if (requestId !== inspectorRequestId) return; // a newer request has since started — drop this stale result
  if (result.ok) inspectorPanel.setEntries(buildEntries(result.nodes), currentScreen);
  else inspectorPanel.setError(result.message);
  syncInspectOverlay();
}

/** Clears inspect mode's list focus and canvas overlay — used whenever the underlying selection is no longer valid. */
function clearInspectFocus() {
  inspectorPanel.clearFocus();
  updateInspectOverlay(inspectOverlayEl, null, null);
}

/** Keeps the canvas overlay in agreement with whatever the panel currently has focused (or hides it when nothing is) — called after anything that can change either side: a click, a list rebuild, or an iframe reload. */
function syncInspectOverlay() {
  const domId = inspectorPanel.getFocusedDomId();
  updateInspectOverlay(inspectOverlayEl, domId ? getRenderedDocForScreen(currentScreen) : null, domId);
}

/** @type {(rootId: string, text: string, onError: (message: string) => void) => void} */
async function handleReply(rootId, text, onError) {
  const result = await postComment({ parent_id: rootId, text });
  if (!result.ok) {
    onError(result.message);
    return;
  }
  await loadComments(); // a reply can resolve the thread — loadComments() itself refreshes markers
}

function clearSelection() {
  selectionCleanup();
  selectionCleanup = () => {};
  selectedNode = undefined;
  selectedNodeScreen = null;
  commentComposeForm.hidden = true;
  commentErrorEl.hidden = true;
  commentBodyInput.value = "";
}

/**
 * Applies (or re-applies) a comment-mode selection: highlights `nodeId` in
 * the current document, updates the target label, and tags it with `screen`
 * (see selectedNodeScreen) so a later reload can tell whether it still
 * applies. Used both for a fresh click (via selectCommentTarget, which also
 * opens the compose form) and to silently re-apply an already-open
 * selection after an SSE-triggered reload, without touching the compose
 * form/error state or stealing focus.
 * @param {string | null} nodeId
 * @param {string | null} screen
 */
function restoreSelection(nodeId, screen) {
  selectionCleanup();
  const doc = screenFrame.contentDocument;
  selectedNode = nodeId;
  selectedNodeScreen = screen;
  selectionCleanup = doc ? highlightSelection(doc, nodeId) : () => {};
  commentTargetLabel.textContent = nodeId === null ? "New comment on screen" : `New comment on ${nodeId}`;
}

function selectCommentTarget(nodeId) {
  // The screen this click's doc actually renders — see the module comment
  // on iframeRenderedScreen. Tagging with it here (not `currentScreen`)
  // matters if a screen switch is racing this click: `currentScreen` may
  // already read the NEW screen while this doc (whose listeners are what
  // just fired) is still the OLD one; `iframeRenderedScreen` only changes
  // once that new screen's own `load` event lands.
  restoreSelection(nodeId, iframeRenderedScreen);
  commentErrorEl.hidden = true;
  commentComposeForm.hidden = false;
  commentBodyInput.focus();
}

// The iframe document is replaced wholesale on every srcdoc assignment, so
// flow/comment-mode listeners and outlines have to be reapplied after each
// load, and any selection tied to the old document no longer applies.
function applyActiveMode() {
  modeCleanup();
  const doc = screenFrame.contentDocument;
  if (!doc) {
    modeCleanup = () => {};
  } else if (activeMode === "flow") {
    modeCleanup = applyFlowMode(doc, true, selectScreen);
  } else if (activeMode === "comment") {
    modeCleanup = applyCommentMode(doc, true, openNodeIds(comments), selectCommentTarget);
  } else if (activeMode === "inspect") {
    modeCleanup = applyInspectMode(doc, true, {
      getModelIds: () => inspectorPanel.getModelIds(),
      onSelect: handleInspectSelect,
      onDeselect: clearInspectFocus,
      onScroll: syncInspectOverlay,
    });
  } else {
    modeCleanup = () => {};
  }
}

/** @param {string} modelId @param {string} clickedDomId */
function handleInspectSelect(modelId, clickedDomId) {
  inspectorPanel.focusEntry(modelId, clickedDomId);
  syncInspectOverlay();
}

function updateCanvas() {
  applyCanvas({ canvasEl, holderEl: screenHolderEl, iframeEl: screenFrame, zoom });
}

/** Whether the zoom buttons currently control the mockup row instead of the screen canvas — see applyMainVisibility. */
function isMockupZoomActive() {
  return currentView === "screens" && currentMockup !== null;
}

/**
 * Re-applies mockup zoom from the current `mockupZoom` level. A no-op while
 * no mockup is showing yet (`.mockup-columns` not rendered) — safe to call
 * eagerly from applyMainVisibility() right after a view/selection switch.
 */
function updateMockupZoom() {
  const columnsEl = mockupViewEl.querySelector(".mockup-columns");
  if (columnsEl) applyMockupZoom({ paneEl: mockupViewEl, columnsEl, zoom: mockupZoom });
}

/** Re-fits whichever of the screen canvas / mockup row is actually showing — shared by every trigger whose available space can change without a view/selection switch of its own (pane resize, side-panel collapse). */
function refitActivePane() {
  if (isMockupZoomActive()) updateMockupZoom();
  else updateCanvas();
}

/**
 * Wires a collapsible side panel: applies the persisted collapse state up
 * front, then toggles + persists + re-fits the canvas on every click. The
 * DOM (`panelEl.dataset.collapsed`) is the single source of truth — no
 * parallel module-level boolean to keep in sync.
 */
function setupSidePanel(panelEl, collapseBtn, prefKey) {
  function apply(collapsed) {
    panelEl.dataset.collapsed = String(collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  }
  apply(readBoolPref(prefsStorage, prefKey, false));
  collapseBtn.addEventListener("click", () => {
    const collapsed = panelEl.dataset.collapsed !== "true";
    apply(collapsed);
    writeBoolPref(prefsStorage, prefKey, collapsed);
    // The Screens/Context panels stay visible over the mockup view too
    // (only the Elements/inspector panel doesn't) — collapsing either
    // changes #mockup-view's available width just as much as the canvas's,
    // so this must re-fit whichever is active.
    refitActivePane();
  });
}

setupSidePanel(sidebarScreensEl, sidebarScreensCollapseBtn, "artisign.sidebar-screens.collapsed");
setupSidePanel(sidebarContextEl, sidebarContextCollapseBtn, "artisign.sidebar-context.collapsed");
setupSidePanel(inspectorEl, inspectorCollapseBtn, "artisign.inspector.collapsed");

zoom = parseZoomPref(readStringPref(prefsStorage, "artisign.zoom", null), zoom);
mockupZoom = parseZoomPref(readStringPref(prefsStorage, "artisign.mockupZoom", null), mockupZoom);
syncZoomButtons(zoom);
updateCanvas();

screenFrame.addEventListener("load", () => {
  // An SSE-triggered change event reloads the iframe every time the
  // watched project's files change while the human is looking — often every
  // few seconds while an agent is actively editing. Re-resolve the comment
  // selection against the freshly loaded document instead of dropping it
  // unconditionally: decide it up front (selectedNodeScreen
  // guards against a screen switch racing a click on the old doc — review
  // fix 2), but apply the decision below only AFTER applyActiveMode(). The
  // Elements panel's inspect-mode focus survives on its own via
  // createInspectorPanel.setEntries' same-screen carry-over (see its own
  // comment) — nothing to redo for it here.
  const doc = screenFrame.contentDocument;
  const nodeExists = typeof selectedNode === "string" && !!doc?.getElementById(selectedNode);
  const resolvedSelection = resolveSelectionAfterReload({
    selectedNode,
    selectionScreen: selectedNodeScreen,
    reloadedScreen: pendingRenderScreen,
    nodeExists,
  });
  // Which screen this document actually is — see the module comment on
  // iframeRenderedScreen. Setting it before refreshExpanded()/
  // syncInspectOverlay() below lets both correctly read this (now current)
  // document instead of treating it as still-loading.
  iframeRenderedScreen = pendingRenderScreen;
  inspectorPanel.refreshExpanded(); // re-reads computed values for whatever's still expanded against the fresh document
  syncInspectOverlay(); // repositions the overlay if something's still focused on this same screen, hides it otherwise
  applyActiveMode();
  // Restoring the selection AFTER applyActiveMode matters when the selected
  // node also anchors an open thread marker: applyCommentMode must capture
  // the marker-only style as this element's "original" before
  // highlightSelection appends the selection outline on top — otherwise
  // clearing the selection later strips the marker along with it, and the
  // stale modeCleanup closure re-applies a style still carrying the
  // selection outline on the NEXT reload, with nothing selected (review
  // fix 1).
  if (resolvedSelection === undefined) clearSelection();
  else restoreSelection(resolvedSelection, iframeRenderedScreen);
  updateCanvas();
  warningBadgeCleanup();
  const badgeUpdate = updateWarningBadge(warningBadge, screenFrame.contentDocument);
  warningBadgeCleanup = badgeUpdate.cleanup;
  warningCount = badgeUpdate.count;
  // Routed through applyMainVisibility() (rather than setting warningBadge.hidden
  // directly here) so a `load` event that lands late — e.g. a stale
  // loadCurrentScreen() resolving after the human has since switched to the
  // mockup view — can't un-hide the badge behind it; applyMainVisibility()
  // re-derives every #main/toolbar hidden-toggle from the CURRENT
  // currentView/currentMockup, not from whatever was true when this srcdoc
  // load was kicked off.
  applyMainVisibility();
});

// Only "fit" needs to react to the pane resizing — a fixed zoom level keeps
// its scale regardless of the available space.
window.addEventListener("resize", () => {
  if (isMockupZoomActive() ? mockupZoom === "fit" : zoom === "fit") refitActivePane();
});

function syncZoomButtons(value) {
  for (const button of zoomButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.zoom === (value === "fit" ? "fit" : String(value))));
  }
}

/** Sets the zoom level for whichever the buttons currently target — the mockup row or the screen canvas (see isMockupZoomActive) — each remembered under its own pref key. */
function setZoom(next) {
  syncZoomButtons(next);
  if (isMockupZoomActive()) {
    mockupZoom = next;
    writeStringPref(prefsStorage, "artisign.mockupZoom", String(next));
    updateMockupZoom();
  } else {
    zoom = next;
    writeStringPref(prefsStorage, "artisign.zoom", String(next));
    updateCanvas();
  }
}

for (const button of zoomButtons) {
  button.addEventListener("click", () => {
    const value = button.dataset.zoom;
    setZoom(value === "fit" ? "fit" : Number(value));
  });
}

statusBarToggle.addEventListener("click", () => {
  const isOn = statusBarToggle.getAttribute("aria-pressed") === "true";
  statusBarToggle.setAttribute("aria-pressed", String(!isOn));
  statusBarOverlayEl.hidden = isOn;
});

/** Flow/comment/inspect modes are mutually exclusive — picking one turns whichever other was active off. Clicking the active mode's button turns it off. */
function setMode(next) {
  // Compare against the RESULTING mode, not `next` — clicking the already-
  // active mode's own button passes `next === activeMode` too (that's how
  // it turns off), so gating on `next` alone would never clean up state
  // for a self-toggle-off, only for switching to a *different* mode.
  const resulting = activeMode === next ? "none" : next;
  if (activeMode === "comment" && resulting !== "comment") clearSelection();
  if (activeMode === "inspect" && resulting !== "inspect") clearInspectFocus();
  activeMode = resulting;
  flowModeToggle.setAttribute("aria-pressed", String(activeMode === "flow"));
  commentModeToggle.setAttribute("aria-pressed", String(activeMode === "comment"));
  inspectModeToggle.setAttribute("aria-pressed", String(activeMode === "inspect"));
  applyActiveMode();
  board.setFlowMode(activeMode === "flow");
}

flowModeToggle.addEventListener("click", () => setMode("flow"));
commentModeToggle.addEventListener("click", () => setMode("comment"));
inspectModeToggle.addEventListener("click", () => setMode("inspect"));

// Esc clears inspect focus even when keyboard focus is in the parent
// document (e.g. right after clicking a list entry's own header) — the
// iframe-level listener in applyInspectMode only catches it while the
// canvas itself has focus.
document.addEventListener("keydown", (evt) => {
  if (evt.key === "Escape" && activeMode === "inspect") clearInspectFocus();
});

commentCancelButton.addEventListener("click", () => clearSelection());

commentComposeForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const text = commentBodyInput.value.trim();
  if (!text || !currentScreen) return;
  const result = await postComment({ screen: currentScreen, node_id: selectedNode ?? null, text });
  if (!result.ok) {
    commentErrorEl.textContent = result.message;
    commentErrorEl.hidden = false;
    return;
  }
  clearSelection();
  await loadComments(); // the new comment may need an open-thread marker — loadComments() refreshes it
});

/**
 * @returns {Promise<boolean>} false on a fetch error (network/5xx) — the
 *   `mockups` array is left untouched in that case (never reset to `[]`),
 *   since callers use "the selected mockup is missing from `mockups`" to
 *   mean "it was deleted"; a transient fetch error must never be misread
 *   as a deletion (see fetchMockups).
 */
async function loadMockups() {
  const result = await fetchMockups();
  if (!result.ok) {
    console.error(result.message);
    return false;
  }
  mockups = result.mockups;
  refreshSidebar();
  return true;
}

/** Re-renders the mockup view from the already-loaded `mockups` array — callers that need fresher data call loadMockups() first (see handleChangeEvent/resyncCurrentProject). The request id is threaded into each variant's render fetch (not just checked once synchronously here, which would never actually catch anything) so a column whose fetch resolves after a NEWER loadCurrentMockup() call has already started renders nothing instead of writing a stale result. */
async function loadCurrentMockup() {
  if (!currentMockup) return;
  const requestId = ++mockupRequestId;
  const mockup = mockups.find((m) => m.name === currentMockup);
  if (!mockup) return; // vanished — the SSE mockup handler/resync fall back themselves
  const mockupName = currentMockup;
  renderMockupView(mockupViewEl, mockup, {
    fetchRenderFor: async (variantId) => {
      const result = await fetchMockupRender(mockupName, variantId);
      return requestId === mockupRequestId ? result : { ok: false, message: "stale mockup selection" };
    },
    onColumnMeasured: updateMockupZoom,
  });
  updateMockupZoom(); // initial pass — columns start at their CSS default width, before any iframe has measured its variant
}

async function loadDesignSystem() {
  const data = await fetchDesignSystem();
  renderDesignSystem(designSystemViewEl, data);
}

/** Builds the board from scratch — screens + flows. Only called once, lazily; SSE handlers keep it in sync afterward (see connectEvents below). */
async function loadBoard() {
  const flows = await fetchFlows();
  await board.setScreens(
    screens.map((s) => s.name),
    flows,
  );
  boardBuilt = true;
}

/**
 * Reconciles every hidden-toggle in #main and the toolbar for the current
 * view + mockup selection. The mockup view only ever shows within the
 * "screens" tab, replacing the canvas — everything canvas-specific (zoom
 * controls, inspector, warning badge, flow/comment/inspect toggles) goes
 * with it, since none of those apply to a mockup comparison.
 * @returns {boolean} whether the mockup view is the one now showing — callers
 *   (setView) use this to decide whether an active mode needs turning off.
 */
function applyMainVisibility() {
  const showMockup = currentView === "screens" && currentMockup !== null;
  screensViewEl.hidden = currentView !== "screens" || showMockup;
  mockupViewEl.hidden = !showMockup;
  designSystemViewEl.hidden = currentView !== "design-system";
  boardViewEl.hidden = currentView !== "board";
  // The zoom group stays visible over the mockup view too — it
  // scales the whole comparison row instead of the screen canvas. Only the
  // Status bar toggle, which has no mockup-view counterpart, hides with it.
  canvasControlsEl.hidden = currentView !== "screens";
  statusBarToggle.hidden = currentView !== "screens" || showMockup;
  warningBadge.hidden = currentView !== "screens" || showMockup || warningCount === 0;
  // The Elements panel only makes sense next to the single-screen canvas.
  inspectorEl.hidden = currentView !== "screens" || showMockup;
  // Comment/inspect mode have no board counterpart (see board-view.js), and
  // none of the three apply to the mockup view.
  flowModeToggle.disabled = showMockup;
  commentModeToggle.disabled = currentView === "board" || showMockup;
  inspectModeToggle.disabled = currentView === "board" || showMockup;
  syncZoomButtons(showMockup ? mockupZoom : zoom);
  if (showMockup) updateMockupZoom();
  return showMockup;
}

function setView(view) {
  currentView = view;
  writeStringPref(prefsStorage, "artisign.view", view);
  for (const tab of viewTabs) tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
  const showMockup = applyMainVisibility();
  // Flow mode has no mockup-view counterpart either, but (unlike comment/
  // inspect) it's still armable from the Board tab — entering the mockup
  // state with it already on would otherwise leave it stuck active behind
  // a now-disabled toggle. Same self-toggle-off path as its own button.
  if (showMockup && activeMode === "flow") setMode("flow");
  // Comment/inspect mode have no board counterpart (see board-view.js) —
  // picking the board while either is active turns it off, same as
  // clicking its own toggle.
  if (view === "board" && activeMode === "comment") setMode("comment");
  if (view === "board" && activeMode === "inspect") setMode("inspect");
  if (view === "design-system") loadDesignSystem();
  if (view === "board" && !boardBuilt) loadBoard();
  // A sidebar toggle while another view was active runs against a
  // display:none canvas (clientWidth 0) — re-fit now that it's visible
  // again, in case its available width changed while we were away.
  if (view === "screens" && currentMockup === null) updateCanvas();
}

for (const tab of viewTabs) {
  tab.addEventListener("click", () => setView(tab.dataset.view));
}

/**
 * Boots the whole preview: loads the daemon's project registry state first
 * (works even with zero projects open — see server.ts), shows the empty
 * state or the normal screen/board/design-system UI accordingly, and opens
 * the single /events connection everything else reacts to.
 */
async function boot() {
  const state = await refreshProjectsState();
  activeProjectRoot = state.active;
  reconnectSse(activeProjectRoot ?? undefined);
  if (activeProjectRoot) {
    await bootScreens();
    const allowedViews = [...viewTabs].map((tab) => tab.dataset.view);
    const persistedView = parseEnumPref(readStringPref(prefsStorage, "artisign.view", null), allowedViews, currentView);
    if (persistedView !== currentView) setView(persistedView);
  }
}

boot();
