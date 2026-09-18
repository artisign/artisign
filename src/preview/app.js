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
  fetchTags,
  fetchScreenNodes,
  postComment,
  fetchProjects,
  activateProject,
  openProject,
  initProject,
  fetchBoardState,
  setBoardState,
} from "./api.js";
import { renderScreenList, filterScreens } from "./screens.js";
import { renderMockupList, filterMockups } from "./mockups.js";
import { renderTagNotes } from "./notes-panel.js";
import { renderMockupView } from "./mockup-view.js";
import { applyMockupZoom } from "./mockup-zoom.js";
import { applyFlowMode } from "./flows.js";
import { applyCommentMode, highlightSelection, bareNodeId, openNodeIds, renderCommentsPanel, resolveSelectionAfterReload } from "./comments.js";
import {
  pushActivityEntry,
  activityTargetExists,
  activityIsNavigable,
  resolveFollowNavigation,
  highlightDurationMs,
  highlightNodes,
  highlightScreen,
  renderActivityFeed,
  renderFollowToggle,
  nextFollowState,
  followToggleClickAction,
  FOLLOW_OFF,
  WRITE_RERENDER_GRACE_MS,
} from "./activity.js";
import { renderDesignSystem } from "./design-system.js";
import { setMarkdown } from "./markdown.js";
import { connectEvents } from "./sse.js";
import { applyCanvas } from "./canvas.js";
import { updateWarningBadge } from "./warnings.js";
import { createBoardView } from "./board-view.js";
import {
  MIN_BOARD_ZOOM,
  MAX_BOARD_ZOOM,
  DEFAULT_BOARD_ZOOM,
  clampZoom,
  zoomSliderOffset,
  stepZoomDown,
  stepZoomUp,
  computeBoardVisibility,
  formatBoardStatusText,
} from "./board.js";
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
  parseBoardZoomPref,
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
const notesPanelTagsEl = document.getElementById("notes-panel-tags");
const screenFrame = document.getElementById("screen-frame");
const canvasEl = document.getElementById("canvas");
const screenHolderEl = document.getElementById("screen-holder");
const statusBarOverlayEl = document.getElementById("status-bar-overlay");
const emptyState = document.getElementById("empty-state");
const screensViewEl = document.getElementById("screens-view");
const designSystemViewEl = document.getElementById("design-system-view");
const boardViewEl = document.getElementById("board-view");
const boardSurfaceEl = document.getElementById("board-surface");
const boardCanvasEl = document.getElementById("board-canvas");
const boardCanvasInnerEl = document.getElementById("board-canvas-inner");
const boardTilesEl = document.getElementById("board-tiles");
const boardEdgesEl = document.getElementById("board-edges");
const boardEmptyStateEl = document.getElementById("board-empty-state");
const boardEmptyBodyEl = document.getElementById("board-empty-body");
const boardFitallBtn = document.getElementById("board-fitall-btn");
const board100Btn = document.getElementById("board-100-btn");
const boardZoomMinusBtn = document.getElementById("board-zoom-minus");
const boardZoomPlusBtn = document.getElementById("board-zoom-plus");
const boardZoomRangeInput = document.getElementById("board-zoom-range");
const boardZoomReadoutEl = document.getElementById("board-zoom-readout");
const boardEdgesToggleBtn = document.getElementById("board-edges-toggle");
const boardToolbarStatusEl = document.getElementById("board-toolbar-status");
const boardClearPinsBtn = document.getElementById("board-clear-pins-btn");
const boardPresentedBannerEl = document.getElementById("board-presented-banner");
const boardPresentedTextEl = document.getElementById("board-presented-text");
const boardPresentedDismissBtn = document.getElementById("board-presented-dismiss");
const followToggleEl = document.getElementById("follow-toggle");
const followToggleToggleEl = document.getElementById("follow-toggle-toggle");
const followToggleResumeEl = document.getElementById("follow-toggle-resume");
const followToggleLabelEl = document.getElementById("follow-toggle-label");
const activityScreenHighlightEl = document.getElementById("activity-screen-highlight");
const panelTabElementsEl = document.getElementById("panel-tab-elements");
const panelTabActivityEl = document.getElementById("panel-tab-activity");
const panelBodyElementsEl = document.getElementById("panel-body-elements");
const panelBodyActivityEl = document.getElementById("panel-body-activity");
const activityFeedListEl = document.getElementById("activity-feed-list");
const activityFeedEmptyEl = document.getElementById("activity-feed-empty");
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
/** @type {{ tag: string, notes: string }[]} — every project tag with its own notes (CHR-596). */
let tagNotes = [];
// Which tag specs the reader has opened. Survives a re-render of the panel,
// which happens on every SSE screen event and sidebar filter keystroke.
const expandedTagNotes = new Set();
let currentScreen = null;
/** @type {{ name: string, title?: string, description?: string, tags: string[], variants: { id: string, title: string, description?: string }[] }[]} */
let mockups = [];
// Mutually exclusive with currentScreen — see selectScreen/selectMockup.
let currentMockup = null;
// The Board's shared filter (CHR-624/ADR-005) — daemon-held, per project,
// not reset locally on a project switch (unlike the old purely-local
// version of this variable): loadBoardState() populates it from
// fetchBoardState() on boot/project-switch/resync, and every SSE
// board_state event overwrites it again, from EITHER door (this browser's
// own write, another tab, or an MCP agent). Renders instantly on every
// keystroke (refreshSidebar/renderBoardStatus read this directly); the
// write to the daemon is debounced — see screenFilterInput's listener.
let screenFilter = "";
/** @type {string[]} pinned screen names, same daemon-held/SSE-driven lifecycle as screenFilter. */
let pinnedScreens = [];
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
// CHR-628/CHR-629/CHR-630/CHR-631, ADR-005 — follow mode. `followState`
// itself is off/following/paused (see activity.js's nextFollowState);
// `activityFeed` is the last ACTIVITY_FEED_LIMIT tool calls, newest first,
// in-memory only — cleared on reload and on every project switch, never
// persisted. Only `followState.enabled` is a per-browser preference
// (readBoolPref below); `paused` always starts false on boot/project
// switch — there's nothing pending to have paused for yet.
let followState = FOLLOW_OFF;
// The last `enabled` value actually written to localStorage (review fix 7)
// — `null` up front so the very first renderFollowUI() call (boot, reading
// the persisted pref back in) still writes once; every OTHER call only
// writes when `enabled` actually changed, since renderFollowUI() runs on
// every pauseFollow() (a sidebar/tab/mode click, an agent Board
// presentation), none of which touch `enabled` at all.
let persistedFollowEnabled = null;
let activityFeed = [];
let activityNodeHighlightCleanup = () => {}; // clears the current node-level read/write outline early (screen switch, a newer highlight superseding it)
let activityScreenHighlightCleanup = () => {}; // same, for the whole-screen write-html highlight
// A write's highlight waits for the re-render it caused (never landing on
// the stale pre-write DOM) — this is what it's waiting on: the screen the
// pending event targets, applied once that screen's `load` event fires, or
// after WRITE_RERENDER_GRACE_MS as a fallback if the load never arrives.
// See applyPendingActivityHighlight/scheduleActivityHighlight.
let pendingActivityHighlight = null; // { screen: string, event: object } | null
let activityHighlightGraceTimer = null;
// Follow-mode navigation is coalesced to at most once per 300ms (ADR-005) —
// a trailing throttle: within a burst, only the LAST event still navigates,
// after the window closes, not every one of them.
const ACTIVITY_NAVIGATE_THROTTLE_MS = 300;
let lastActivityNavigateAt = 0;
let throttledActivityEvent = null;
let activityNavigateThrottleTimer = null;
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

// Board zoom's own value (CHR-623) — separate from `zoom`/`mockupZoom`
// (the screen canvas / mockup row) since it's a different surface with its
// own persisted level; see prefs.parseBoardZoomPref.
let boardZoom = DEFAULT_BOARD_ZOOM;
let boardEdgesVisible = true;
// The zoom "Fit all" last computed, if any — the only way to know whether
// its quick-jump button should read active, since (unlike "100%") its
// target isn't a fixed constant. Set from board.setZoom's onZoomChange
// callback (source === "fitall"), read by updateBoardToolbar.
let lastFitAllZoom = null;
// Debounces the board zoom preference write (CHR-623 review finding 3) — a
// slider drag fires onZoomChange, and so a localStorage write, on every
// `input` tick; only the LAST value in a burst is worth persisting.
let boardZoomPrefWriteTimer = null;
const BOARD_ZOOM_PREF_WRITE_DEBOUNCE_MS = 300;

function scheduleBoardZoomPrefWrite(value) {
  clearTimeout(boardZoomPrefWriteTimer);
  boardZoomPrefWriteTimer = setTimeout(
    () => writeStringPref(prefsStorage, "artisign.boardZoom", String(value)),
    BOARD_ZOOM_PREF_WRITE_DEBOUNCE_MS,
  );
}

const board = createBoardView({
  surfaceEl: boardSurfaceEl,
  canvasEl: boardCanvasEl,
  canvasInnerEl: boardCanvasInnerEl,
  tilesEl: boardTilesEl,
  edgesEl: boardEdgesEl,
  emptyStateEl: boardEmptyStateEl,
  emptyStateBodyEl: boardEmptyBodyEl,
  onZoomChange: (value, source) => {
    if (source === "fitall") lastFitAllZoom = value;
    boardZoom = value;
    scheduleBoardZoomPrefWrite(value);
    updateBoardToolbar();
  },
  // CHR-623 review finding 2: a relayout can change the grid shape under a
  // `lastFitAllZoom` that was exact for the PREVIOUS shape — invalidate it
  // so "Fit all" stops reading as active for a value it wouldn't actually
  // compute anymore.
  onRelayout: () => {
    lastFitAllZoom = null;
    updateBoardToolbar();
  },
  onTogglePin: (screen) => toggleScreenPin(screen),
});
board.mount();

/**
 * Pin/unpin one screen (CHR-624) — shared by the sidebar's pin button and
 * the board tile's pin button, both of which call this the same way. Fires
 * the write and returns; the actual UI update comes back through the SSE
 * `board_state` broadcast (handleBoardStateEvent), same as every other
 * client on this project including this one — see api.js's setBoardState
 * for why this never applies its own result directly.
 * @param {string} screen
 */
function toggleScreenPin(screen) {
  if (!activeProjectRoot) return;
  const op = pinnedScreens.includes(screen) ? "remove" : "add";
  reportBoardStateFailure(setBoardState(activeProjectRoot, { pins: { op, screens: [screen] } }));
}

boardClearPinsBtn.addEventListener("click", () => {
  if (activeProjectRoot) reportBoardStateFailure(setBoardState(activeProjectRoot, { pins: { op: "clear" } }));
});

// CHR-625/ADR-005 review fix — whether the "agent switched you here" banner
// is currently up. The banner's own `hidden` attribute is derived DOM state;
// this flag is the source of truth updateAgentPresentedBannerText() (called
// from renderBoardStatus, on every board-state-relevant change) reads to
// decide whether to keep re-deriving the banner's own count. A captured
// count read once at presentation time can go stale: the agent's usual
// sequence is `write_html` then `set_board_state`, two SSE messages in
// quick succession, and handleChangeEvent's loadScreens() isn't serialised
// against handleBoardStateEvent — the board_state event can fire against
// the OLD `screens` array, then loadScreens() resolves and the board grows
// a tile the banner's text never learns about. Re-deriving it the same way
// the toolbar status text already does (same computeBoardVisibility call)
// keeps the two in permanent agreement instead.
let agentPresentationActive = false;

/**
 * CHR-625/ADR-005 — the "Agent switched you here" pill banner (see the
 * `board-view-presented` design screen). Shown over the Board tab whenever a
 * `board_state` SSE event's `source` is `"agent"`; stays up until the human
 * dismisses it, no auto-dismiss timer, and a further agent presentation
 * while it's already showing just refreshes the count in place.
 */
function showAgentPresentedBanner() {
  agentPresentationActive = true;
  // Unhide BEFORE writing the text: a screen reader generally doesn't
  // announce a text change made to a still-hidden live region (role="status"
  // on #board-presented-banner in index.html) — the unhide itself is what
  // must trigger the announcement.
  boardPresentedBannerEl.hidden = false;
  updateAgentPresentedBannerText();
}

function hideAgentPresentedBanner() {
  agentPresentationActive = false;
  boardPresentedBannerEl.hidden = true;
}

boardPresentedDismissBtn.addEventListener("click", () => hideAgentPresentedBanner());

/** No-op while the banner isn't showing — called from renderBoardStatus (see agentPresentationActive's own doc comment for why this needs to re-derive rather than hold a captured count). */
function updateAgentPresentedBannerText() {
  if (!agentPresentationActive) return;
  const shownCount = computeBoardVisibility(screens, screenFilter, pinnedScreens).shownCount;
  // CHR-625 review fix 3 — a filter matching nothing sits right above the
  // board's own empty state ("matches nothing"); "to show 0 screens" reads
  // like a machine repeating itself. The approved copy's count covers the
  // case where there's something to point at; drop it for the zero case.
  boardPresentedTextEl.textContent =
    shownCount === 0 ? "Agent switched you here" : `Agent switched you here to show ${shownCount} screen${shownCount === 1 ? "" : "s"}`;
}

/** Re-renders the board toolbar's status text + Clear pins visibility from the current screens/screenFilter/pinnedScreens — cheap and pure, so it's fine to call unconditionally on every board-state-relevant change, not just while the Board tab is actually showing. */
function renderBoardStatus() {
  const visibility = computeBoardVisibility(screens, screenFilter, pinnedScreens);
  boardToolbarStatusEl.textContent = formatBoardStatusText(visibility);
  // Gated on the raw pin list, not `visibility.pinnedCount` (review fix 5):
  // the latter is the CLEANED count (a pin whose screen no longer exists is
  // dropped from it), so a project whose pins are entirely ghosts — the
  // JSDoc on `pinnedScreens` above already names the causes, a branch
  // switch or a hand-deleted file the daemon never pruned — would hide the
  // one button that can get rid of them.
  boardClearPinsBtn.hidden = pinnedScreens.length === 0;
  updateAgentPresentedBannerText(); // CHR-625 — keeps the banner's own count from drifting away from this same visibility computation
}

/** Syncs every toolbar control (range input + its fill/aria-valuetext, readout, quick-jump active states, step-button aria-disabled states) from the current `boardZoom`. */
function updateBoardToolbar() {
  boardZoomRangeInput.value = String(boardZoom);
  const rounded = Math.round(boardZoom);
  boardZoomReadoutEl.textContent = `${rounded}%`;
  // The raw value ("80") reads to a screen reader as the plain number
  // eighty — aria-valuetext overrides that with the actual unit (CHR-623
  // review finding 8).
  boardZoomRangeInput.setAttribute("aria-valuetext", `${rounded}%`);
  const fillPct = zoomSliderOffset(boardZoom, 100);
  boardZoomRangeInput.style.background = `linear-gradient(to right, var(--color-accent) ${fillPct}%, var(--color-border) ${fillPct}%)`;
  board100Btn.setAttribute("aria-pressed", String(boardZoom === 100));
  boardFitallBtn.setAttribute("aria-pressed", String(lastFitAllZoom !== null && boardZoom === lastFitAllZoom));
  // aria-disabled, not the `disabled` attribute (CHR-623 review finding 8):
  // a hard-disabled button can't hold focus, so tabbing onto "−" right as
  // it hits the floor bumps focus to <body>. Styled the same as :disabled
  // used to look (style.css); a click while aria-disabled stays a harmless
  // no-op — stepZoomDown/stepZoomUp already clamp at the floor/ceiling, so
  // there's nothing to guard in the handlers below.
  boardZoomMinusBtn.setAttribute("aria-disabled", String(boardZoom <= MIN_BOARD_ZOOM));
  boardZoomPlusBtn.setAttribute("aria-disabled", String(boardZoom >= MAX_BOARD_ZOOM));
}

boardFitallBtn.addEventListener("click", () => board.fitAll());
board100Btn.addEventListener("click", () => board.setZoom(100));
boardZoomMinusBtn.addEventListener("click", () => board.setZoom(stepZoomDown(boardZoom)));
boardZoomPlusBtn.addEventListener("click", () => board.setZoom(stepZoomUp(boardZoom)));
boardZoomRangeInput.addEventListener("input", () => board.setZoom(Number(boardZoomRangeInput.value)));
boardEdgesToggleBtn.addEventListener("click", () => {
  boardEdgesVisible = !boardEdgesVisible;
  writeBoolPref(prefsStorage, "artisign.boardEdgesVisible", boardEdgesVisible);
  board.setEdgesVisible(boardEdgesVisible);
  boardEdgesToggleBtn.setAttribute("aria-pressed", String(boardEdgesVisible));
  boardEdgesToggleBtn.textContent = boardEdgesVisible ? "Edges: On" : "Edges: Off";
});

boardZoom = clampZoom(parseBoardZoomPref(readStringPref(prefsStorage, "artisign.boardZoom", null), boardZoom, MIN_BOARD_ZOOM, MAX_BOARD_ZOOM));
boardEdgesVisible = readBoolPref(prefsStorage, "artisign.boardEdgesVisible", boardEdgesVisible);
board.setZoom(boardZoom);
board.setEdgesVisible(boardEdgesVisible);
boardEdgesToggleBtn.setAttribute("aria-pressed", String(boardEdgesVisible));
boardEdgesToggleBtn.textContent = boardEdgesVisible ? "Edges: On" : "Edges: Off";
updateBoardToolbar();

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
  tagNotes = []; // else one project's tag notes leak into the panel of the next
  currentScreen = null;
  // screenFilter/pinnedScreens are deliberately NOT reset here (CHR-624) —
  // they're daemon-held, per-project state now, not local-only; loadBoardState()
  // (called from bootScreens, right after this) overwrites them with the
  // NEW project's actual values. Clearing the pending debounced write
  // guards against it firing (with the OLD project's filter text) after
  // activeProjectRoot has already moved on to the new project.
  clearTimeout(boardFilterWriteTimer);
  hideAgentPresentedBanner(); // CHR-625 — a presentation is per-project; don't carry it over to the next
  comments = [];
  boardBuilt = false;
  activeMode = "none";
  flowModeToggle.setAttribute("aria-pressed", "false");
  commentModeToggle.setAttribute("aria-pressed", "false");
  inspectModeToggle.setAttribute("aria-pressed", "false");
  screenFrame.srcdoc = "";
  board.setScreens([], [], activeProjectRoot);
  iframeRenderedScreen = null;
  pendingRenderScreen = null;
  inspectorRequestId++; // discards any in-flight fetch from the project we just left — see loadInspectorEntries
  inspectorPanel.setEntries([], null);
  updateInspectOverlay(inspectOverlayEl, null, null);
  mockups = [];
  currentMockup = null;
  mockupViewEl.innerHTML = "";
  mockupRequestId++; // discards any in-flight render from the project we just left — see loadCurrentMockup
  // CHR-631 — the activity feed is in-memory only, per the design spec
  // ("cleared on reload and on project switch"); `enabled` is the one bit
  // that IS a per-browser preference and survives (see the module doc on
  // followState), so only `paused` resets here — nothing is pending a
  // resume for in the project we're leaving.
  activityFeed = [];
  renderActivityFeedPanel();
  clearActivityHighlights();
  mockupCueCleanup();
  mockupCueCleanup = () => {};
  designSystemCueCleanup();
  designSystemCueCleanup = () => {};
  pendingActivityHighlight = null;
  clearTimeout(activityHighlightGraceTimer);
  // review fix 1 — a navigate already queued in the OLD project's throttle
  // window must not fire against the new one once it switches in: its
  // target screen may not even exist here, and selectScreen has no reason
  // to expect a name from a project it never asked about.
  clearTimeout(activityNavigateThrottleTimer);
  activityNavigateThrottleTimer = null;
  throttledActivityEvent = null;
  followState = { enabled: followState.enabled, paused: false };
  renderFollowUI();
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

async function loadTags() {
  tagNotes = await fetchTags(activeProjectRoot);
  updateNotesPanel();
}

/**
 * Applies a filter/pinned pair — from loadBoardState's own GET, or directly
 * from an SSE `board_state` event's payload (same shape, so no extra
 * round-trip is needed there) — and re-renders everything derived from it.
 * @param {string | null} filter
 * @param {string[]} pinned
 * @param {boolean} [forceInputSync] CHR-625 review fix 3 — an agent
 *   presentation writes the filter INPUT even while it has focus, overriding
 *   whatever the human was mid-typing (handleBoardStateEvent already clears
 *   the pending debounced write for the same reason — see its own comment).
 *   `false` for every other caller (loadBoardState, a `source: "human"`
 *   event), which keep the focus guard below.
 */
function applyBoardState(filter, pinned, forceInputSync = false) {
  screenFilter = filter ?? "";
  // Skip while the human is typing in this very input (review fix 1) — the
  // broadcast this fires from is an echo of ITS OWN write (or a whitespace-
  // only filter the daemon normalised to `null`, board-state.ts), so writing
  // `.value` here would replace half-typed text and jump the cursor. Every
  // other consumer of `screenFilter` below still re-renders from the
  // broadcast as usual; only the input element itself is an input, not a
  // pure output. `forceInputSync` overrides this for an agent presentation,
  // which is a takeover, not an echo — see its own doc above.
  if (forceInputSync || document.activeElement !== screenFilterInput) screenFilterInput.value = screenFilter;
  pinnedScreens = pinned ?? [];
  refreshSidebar();
  if (boardBuilt) loadBoard();
}

/**
 * Fires a Board-state write and reports a failure the way the rest of this
 * file does (console.error) — every write is otherwise fire-and-forget
 * since the UI only ever updates from the SSE broadcast (see setBoardState's
 * own doc comment in api.js), so a rejected write would otherwise vanish
 * silently (review fix 3). Also catches `fetch` itself throwing (e.g. a
 * network drop), which would otherwise surface as an unhandled rejection.
 * @param {Promise<{ ok: true } | { ok: false, message: string }>} writePromise
 */
function reportBoardStateFailure(writePromise) {
  writePromise.then(
    (result) => {
      if (!result.ok) console.error(result.message);
    },
    (error) => console.error(error),
  );
}

/**
 * Re-fetches the Board's shared filter/pinned state (CHR-624/ADR-005) for
 * the current project — called on boot/project-switch (bootScreens) and SSE
 * reconnect (resyncCurrentProject); a live update while connected arrives as
 * an SSE `board_state` event instead (handleBoardStateEvent), which applies
 * its own payload directly rather than re-fetching.
 *
 * Captures `activeProjectRoot` up front and re-checks it after the await
 * (review fix 2) — `switchToProject` isn't serialised, so a second switch
 * can start while this fetch is still in flight; without the check, a slow
 * response for the project we've since left would land in the NEW project's
 * UI. Also never lets a failure propagate to its caller's `Promise.all`
 * (review fix 4) — bootScreens awaits this alongside loadScreens/loadMockups/
 * loadTags, and a rejection there would abort the rest of boot (including
 * restoring the persisted screen selection); on failure this instead resets
 * to empty so a fetch error can't leave the PREVIOUS project's filter/pins
 * on screen (resetProjectState deliberately no longer clears them itself).
 */
async function loadBoardState() {
  if (!activeProjectRoot) return;
  const root = activeProjectRoot;
  let state;
  try {
    state = await fetchBoardState(root);
  } catch (error) {
    console.error(error);
    if (root === activeProjectRoot) applyBoardState(null, []);
    return;
  }
  if (root !== activeProjectRoot) return; // a later switch has since moved on — this response is stale
  applyBoardState(state.filter, state.pinned);
}

async function bootScreens() {
  await Promise.all([loadScreens(), loadMockups(), loadTags(), loadBoardState()]);
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
  loadTags();
  loadBoardState(); // CHR-624 — the daemon's board state is empty after a restart; a reconnect must resync it same as everything else
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

/** Order-sensitive string-array equality — used below to compare board visibility's own name arrays, which come from the same deterministic computation each time, so a reorder is as much a "change" as an add/remove for this purpose. */
function arraysEqual(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
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
      // Tags, not just names/membership/order (CHR-624): the board's
      // visible set depends on the shared filter, which matches a screen's
      // tags too (board.js's computeBoardVisibility, same rule as
      // filterScreens) — a tag-only edit (same name, same position) can
      // still move a screen in or out of the filter, or in/out of the
      // outside-filter classification.
      //
      // Compare the ACTUAL computed visibility, not just names/tags (review
      // fix 6) — a name/tag diff alone flags every tag edit as
      // board-affecting even when the visible set doesn't move at all, and
      // `set_meta` is something agents write often; that turned a routine
      // tag touch into a full loadBoard() (re-fetch flows, re-render every
      // tile) instead of the cheap single-tile refreshScreen. `screenFilter`/
      // `pinnedScreens` themselves are unchanged by a "screen" event, so
      // it's only `screens` that can move either name array.
      const previousVisibility = computeBoardVisibility(previousScreens, screenFilter, pinnedScreens);
      const nextVisibility = computeBoardVisibility(screens, screenFilter, pinnedScreens);
      const visibilityChanged =
        !arraysEqual(previousVisibility.visibleNames, nextVisibility.visibleNames) ||
        !arraysEqual(previousVisibility.outsideFilterNames, nextVisibility.outsideFilterNames);
      if (visibilityChanged) await loadBoard();
      else await board.refreshScreen(event.name, activeProjectRoot);
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
    if (boardBuilt) board.setFlows(await fetchFlows(activeProjectRoot));
  } else if (event.kind === "tag_meta") {
    // Re-tagging a screen needs nothing extra here — a "screen" event above
    // already refreshes the panel with the (unchanged) tag list; this branch
    // only fires when a tag's own notes change.
    await loadTags();
  }
}

/** @param {{ type: "project-switched" | "project-opened" | "project-closed", root: string }} event */
async function handleLifecycleEvent(event) {
  const state = await refreshProjectsState();
  if (event.type === "project-switched" || event.type === "project-closed") await switchToProject(state.active);
}

/**
 * @param {{ type: "board_state", filter: string | null, pinned: string[], source: "agent" | "human" }} event
 * Always applies the event's own payload directly (no re-fetch) — from
 * EITHER door (another tab's write, an MCP agent's, or this very tab's own
 * write echoed back) and regardless of `source`: the simplest correct
 * client re-renders from the broadcast every time, rather than trying to
 * detect and suppress its own echo (CHR-624 ticket brief).
 *
 * `source === "agent"` is CHR-625: switch to the Board tab and show the
 * "agent switched you here" banner, so the human sees exactly what the
 * agent presented without a manual reload. A `"human"` source (this tab's
 * own echoed write, or another tab/browser) only re-renders the filter/pins
 * as usual — no tab switch, no banner.
 *
 * CHR-631 (follow mode) — pause precedence rule 2 (ADR-005): an explicit
 * agent presentation on the Board wins over follow, so a `source: "agent"`
 * event pauses follow the same way any other human-navigation trigger does,
 * before `setView("board")` runs.
 */
function handleBoardStateEvent(event) {
  if (event.source === "agent") {
    // CHR-625 review fix 3 — an agent presentation is an explicit takeover,
    // not an echo of the human's own typing: it must win over whatever's
    // still half-typed in the filter input, both on screen (forceInputSync)
    // and on the wire — clearing the pending debounced write stops it from
    // firing the HUMAN's now-superseded text back to the daemon a moment
    // later and silently discarding the agent's own filter (see the
    // screenFilterInput "input" listener below).
    clearTimeout(boardFilterWriteTimer);
    pauseFollow();
    applyBoardState(event.filter, event.pinned, true);
    setView("board"); // also persists "board" as the last-viewed tab (artisign.view) — same side effect a manual tab click has, just triggered by the agent instead
    showAgentPresentedBanner();
  } else {
    applyBoardState(event.filter, event.pinned);
  }
}

// --- CHR-628/CHR-629/CHR-630/CHR-631, ADR-005 — follow mode -----------------

/** Re-renders the follow toggle from the current `followState`, and persists its `enabled` bit (never `paused`, which is session-local — see the module-level doc comment) only when it actually changed (review fix 7) — this runs on every pauseFollow() call, most of which are a sidebar/tab/mode click that never touches `enabled` at all. */
function renderFollowUI() {
  renderFollowToggle(followToggleEl, followToggleToggleEl, followToggleLabelEl, followState);
  if (followState.enabled !== persistedFollowEnabled) {
    writeBoolPref(prefsStorage, "artisign.followEnabled", followState.enabled);
    persistedFollowEnabled = followState.enabled;
  }
}

/**
 * Pause precedence rule 1/2 (ADR-005) — a no-op unless follow is currently
 * enabled and not already paused, so every trigger (human screen/tab
 * selection, entering comment/inspect mode, an agent Board presentation)
 * can call this unconditionally.
 */
function pauseFollow() {
  followState = nextFollowState(followState, "pause");
  renderFollowUI();
}

/** Applies a follow-toggle action (see followToggleClickAction) — shared by the toggle button and the separate Resume button (review fix 4: two sibling buttons, not one button with "Resume" nested inside it — see index.html's own comment on why). */
function applyFollowToggleAction(action) {
  const wasOff = !followState.enabled;
  followState = nextFollowState(followState, action);
  renderFollowUI();
  // Turning follow on, or resuming it, jumps to the agent's latest known
  // target right away — same "re-arms and jumps" wording as $follow-toggle's
  // own usage note for Resume; applied to the initial "off -> on" turn-on
  // too, for the same reason (there's no point following blind when the
  // feed already has a target waiting).
  if (action === "resume" || (action === "toggle-on" && wasOff)) jumpToLatestActivity();
}

followToggleToggleEl.addEventListener("click", () => applyFollowToggleAction(followToggleClickAction(followState, false)));
followToggleResumeEl.addEventListener("click", () => applyFollowToggleAction(followToggleClickAction(followState, true)));

/** Finds the most recent feed entry with a live, navigable target and jumps to it — used when follow is turned on or resumed. A no-op if the feed has nothing navigable yet. */
function jumpToLatestActivity() {
  const lists = currentActivityLists();
  // activityIsNavigable, not the bare activityNavigationTarget (review fix
  // 3) — the last write in the feed can be a `delete_entity` (or any other
  // write) whose own target no longer exists; jumping to it would show an
  // error render instead of the agent's actual latest live target.
  const latest = activityFeed.find((event) => event.ok && activityIsNavigable(event, lists));
  if (latest) navigateToActivity(latest);
}

panelTabElementsEl.addEventListener("click", () => setRightPanelTab("elements"));
panelTabActivityEl.addEventListener("click", () => setRightPanelTab("activity"));

/** Switches the right panel between the Elements list and the new Activity feed ($panel-tabs) — a plain client-side split, not persisted (the feed itself resets on reload anyway). */
function setRightPanelTab(tab) {
  panelTabElementsEl.setAttribute("aria-pressed", String(tab === "elements"));
  panelTabActivityEl.setAttribute("aria-pressed", String(tab === "activity"));
  panelBodyElementsEl.hidden = tab !== "elements";
  panelBodyActivityEl.hidden = tab !== "activity";
  // review fix 4 — the collapse button's label named a fixed "Elements
  // panel" from before this panel could show two different tabs; keep it
  // naming whichever one is actually active instead of going stale the
  // moment Activity is selected.
  inspectorCollapseBtn.setAttribute("aria-label", `Collapse ${tab === "elements" ? "Elements" : "Activity"} panel`);
}

/** The `{ screenNames, mockupNames }` shape activityTargetExists/activityIsNavigable both take — read fresh at call time, never cached, since `screens`/`mockups` change under it. */
function currentActivityLists() {
  return { screenNames: screens.map((s) => s.name), mockupNames: mockups.map((m) => m.name) };
}

/** Re-renders the activity feed from the current `activityFeed` + the live screens/mockups lists (a target's existence can change independently of the feed itself — see activityTargetExists). */
function renderActivityFeedPanel() {
  renderActivityFeed(activityFeedListEl, activityFeedEmptyEl, activityFeed, {
    exists: (event) => activityTargetExists(event, currentActivityLists()),
    onSelect: handleActivityFeedSelect,
  });
}

/** A feed row's click is human navigation like any other (ADR-005 pause rule 1) — a click landing here means the human wants to look at that entry's target, so it pauses follow the same way a sidebar click or a tab switch does, then navigates there. The 2026-09-18 exemption that let a feed click skip pauseFollow is reversed: it pulled the view right back to the agent's current target on the next live call, which is wrong the moment the human actually clicked something. */
function handleActivityFeedSelect(event) {
  pauseFollow();
  navigateToActivity(event);
}

/**
 * One per MCP tool call (src/mcp/activity.ts), regardless of follow's own
 * state — the feed fills even while follow is off/paused; only navigation
 * is gated on actually following (throttledActivityNavigate).
 * @param {object} event
 */
function handleActivityEvent(event) {
  activityFeed = pushActivityEntry(activityFeed, event);
  renderActivityFeedPanel();
  // A failed call never navigates or highlights — by design, not an
  // oversight (ADR-005: "never navigate or highlight — there is nothing
  // confirmed to point at").
  if (!event.ok) return;
  throttledActivityNavigate(event);
}

/**
 * Trailing 300ms throttle on follow-mode navigation (ADR-005) — within a
 * burst, only the LAST event still navigates, once the window closes.
 *
 * Calls `resolveFollowNavigation` (activity.js) at BOTH decision points —
 * the immediate-elapsed branch and the delayed timer-fire branch — instead
 * of re-deriving "is follow even on right now" itself at either one
 * (review fix 1/8): every one of review round 1's three bugs came from
 * exactly that kind of scattered, untested re-derivation. Whatever pauses
 * or turns off follow during the open window (a human sidebar click, an
 * agent Board presentation via handleBoardStateEvent's own pauseFollow
 * call) is picked up by the SAME check the timer-fire branch runs, not a
 * separate one that could drift from it.
 *
 * `lastActivityNavigateAt` only advances on an ACTUAL navigate, in either
 * branch — never merely because a check ran — so a burst that never
 * results in a navigate (follow off/paused the whole time) never
 * artificially throttles a later one once follow turns back on.
 */
function throttledActivityNavigate(event) {
  const now = Date.now();
  const elapsed = now - lastActivityNavigateAt;
  if (elapsed >= ACTIVITY_NAVIGATE_THROTTLE_MS) {
    if (resolveFollowNavigation(event, followState, currentActivityLists())) {
      lastActivityNavigateAt = now;
      navigateToActivity(event);
    }
    return;
  }
  throttledActivityEvent = event;
  if (activityNavigateThrottleTimer) return;
  activityNavigateThrottleTimer = setTimeout(() => {
    activityNavigateThrottleTimer = null;
    const pending = throttledActivityEvent;
    throttledActivityEvent = null;
    if (pending && resolveFollowNavigation(pending, followState, currentActivityLists())) {
      lastActivityNavigateAt = Date.now();
      navigateToActivity(pending);
    }
  }, ACTIVITY_NAVIGATE_THROTTLE_MS - elapsed);
}

/**
 * Navigates to (and schedules a highlight for) an activity event's target —
 * shared by live follow (handleActivityEvent, gated on actually following)
 * and a feed click (handleActivityFeedSelect, unconditional). Uses
 * activityIsNavigable, not the bare activityNavigationTarget (review fix
 * 2) — a write whose own target has already vanished by the time this
 * fires (`delete_entity`, most notably) must not jump to an error render.
 * A broad read, a component/pattern target, or a vanished target all fall
 * through to the same `!target` branch below — a component/pattern still
 * gets a best-effort cue in the Design System view instead of a silent
 * no-op; the other two are silent no-ops, correctly.
 * @param {object} event
 */
async function navigateToActivity(event) {
  const target = activityIsNavigable(event, currentActivityLists());
  if (!target) {
    if (event.target?.kind === "component" || event.target?.kind === "pattern") {
      setView("design-system");
      await loadDesignSystem(); // setView's own fire-and-forget call already kicked this off too — cueDesignSystemEntry needs the render to actually have landed before it can find the card, so it awaits its own call rather than racing that one
      cueDesignSystemEntry(event.target, event.kind);
    }
    return;
  }
  if (target.kind === "mockup") {
    selectMockup(target.name); // navigation-only, per the design spec — a mockup has no nodes to box
    cueMockupSidebarEntry(target.name, event.kind);
    return;
  }
  // selectScreen clears any still-pending highlight for the screen it's
  // leaving (clearActivityHighlights) — schedule THIS highlight only after
  // that call returns, so its own clear can't wipe what we just asked for.
  if (currentScreen !== target.name) {
    selectScreen(target.name); // the resulting `load` event applies the pending highlight — see applyPendingActivityHighlight
    scheduleActivityHighlight(target.name, event);
  } else if (event.kind === "write") {
    // Already showing the target screen — the write itself is already on
    // disk (the daemon only broadcasts `activity` after the tool handler
    // returns), but THIS document was rendered before it landed. Force a
    // fresh render rather than hoping the `change` SSE event's own
    // loadCurrentScreen() call wins the race against this one — see
    // scheduleActivityHighlight's own comment on why the highlight itself
    // still waits for the resulting `load` event (or the grace timer).
    scheduleActivityHighlight(target.name, event);
    loadCurrentScreen();
  } else {
    scheduleActivityHighlight(target.name, event);
    applyPendingActivityHighlight(); // a read on the already-current screen — nothing to reload, apply now
  }
}

/**
 * Records which screen/event a highlight is waiting for. A write always
 * gets a WRITE_RERENDER_GRACE_MS fallback timer — the write's own re-render
 * normally arrives well within that (loadCurrentScreen resolves and its
 * `load` event fires), but if it somehow doesn't (a slow/failed fetch),
 * the highlight still lands rather than silently never appearing. A read
 * needing navigation has no such fallback: selectScreen's own fetch always
 * completes and fires `load`, so there's nothing to fall back from.
 * @param {string} screenName
 * @param {object} event
 */
function scheduleActivityHighlight(screenName, event) {
  clearTimeout(activityHighlightGraceTimer);
  pendingActivityHighlight = { screen: screenName, event, appliedAt: null };
  if (event.kind === "write") {
    activityHighlightGraceTimer = setTimeout(applyPendingActivityHighlight, WRITE_RERENDER_GRACE_MS);
  }
}

/**
 * Applies the pending highlight (see scheduleActivityHighlight) if one is
 * still waiting AND still targets the currently displayed screen — a later
 * switch/event moving on in the meantime makes this a no-op, never a
 * highlight landing on the wrong (or stale) document. Called from the
 * iframe's `load` handler and, for a same-screen read, immediately.
 *
 * Deliberately does NOT clear `pendingActivityHighlight` on a normal apply
 * (only on expiry, or a screen switch elsewhere) — the SSE `change` event
 * for the very write that scheduled this highlight often triggers ITS OWN
 * redundant reload a moment after ours (handleChangeEvent's own
 * loadCurrentScreen, once `event.name === currentScreen`), which replaces
 * the iframe document wholesale and would otherwise wipe an already-applied
 * highlight with nothing left to reapply it. Re-running the same
 * highlightNodes/highlightScreen call on every such `load` (restarting its
 * own timer) keeps it visible through that; letting it restart rather than
 * counting down exactly is an acceptable approximation for something
 * described as "brief" rather than precisely timed.
 */
function applyPendingActivityHighlight() {
  clearTimeout(activityHighlightGraceTimer);
  const pending = pendingActivityHighlight;
  if (!pending || pending.screen !== currentScreen) return;
  if (pending.appliedAt !== null && Date.now() - pending.appliedAt >= highlightDurationMs(pending.event.kind)) {
    pendingActivityHighlight = null; // already fully faded — nothing left for a later redundant reload to reapply
    return;
  }
  const doc = getRenderedDocForScreen(currentScreen);
  if (!doc) return;
  activityNodeHighlightCleanup();
  activityScreenHighlightCleanup();
  pending.appliedAt = Date.now();
  if (pending.event.tool === "write_html") {
    activityScreenHighlightCleanup = highlightScreen(activityScreenHighlightEl, "write");
    return;
  }
  const bareIds = pending.event.nodes.map((ref) => bareNodeId(ref)).filter((id) => doc.getElementById(id));
  if (bareIds.length === 0) {
    // No specific node (get_screen/get_mockup, or nothing resolved) — the
    // whole-screen overlay, not an outline on the iframe's own root
    // element, which would sit exactly on the iframe's edge and get
    // clipped by its nested browsing context (see highlightScreen's doc).
    activityScreenHighlightCleanup = highlightScreen(activityScreenHighlightEl, pending.event.kind);
  } else {
    activityNodeHighlightCleanup = highlightNodes(doc, bareIds, pending.event.kind);
  }
}

/** Clears both highlight kinds early — used on a screen/mockup switch and on project reset, so an old highlight never lingers over a document it no longer describes. */
function clearActivityHighlights() {
  activityNodeHighlightCleanup();
  activityNodeHighlightCleanup = () => {};
  activityScreenHighlightCleanup();
  activityScreenHighlightCleanup = () => {};
}

// Cancel handles for the two sidebar/design-system "cue" flashes below
// (review fix 7) — same pattern as activityNodeHighlightCleanup/
// activityScreenHighlightCleanup: a bare setTimeout with no handle means a
// SECOND cue on the same element cuts the first one's timer short (both
// add/remove the identical class, so the earlier timer's removal fires
// while the later cue still wants it showing) or, after a refreshSidebar/
// loadDesignSystem rebuild, keeps a reference to an element already
// detached from the DOM. Clearing the previous one before starting a new
// one fixes both — the class add is always paired with the matching timer
// that will eventually remove it, never an orphaned one from a prior call.
let mockupCueCleanup = () => {};
let designSystemCueCleanup = () => {};

/** Transient left-border cue on a mockup's sidebar row (CHR-631) — a mockup target gets navigation-only otherwise, since it has no nodes for the node-box highlight. */
function cueMockupSidebarEntry(name, kind) {
  mockupCueCleanup();
  mockupCueCleanup = () => {};
  const button = [...mockupListEl.querySelectorAll(".mockup-item")].find((el) => el.dataset.mockupName === name);
  if (!button) return;
  const cls = kind === "write" ? "activity-cue-write" : "activity-cue-read";
  button.classList.add(cls);
  const timer = setTimeout(() => button.classList.remove(cls), highlightDurationMs(kind));
  mockupCueCleanup = () => {
    clearTimeout(timer);
    button.classList.remove(cls);
  };
}

/**
 * Best-effort Design System cue for a component/pattern activity target
 * (CHR-631) — scrolls to and briefly cues the whole component/pattern
 * card (or, when a variant is named, that one variant cell), rather than
 * the exact per-node outline inside its standalone-variant render: this
 * project's design-system view renders each variant in its own separate
 * iframe with no addressable node-highlight surface today, so a card-level
 * cue is what's actually feasible here — see the module's own follow-up
 * note for the full per-node treatment the design spec describes.
 * @param {{ name: string, variant?: string }} target
 * @param {"read" | "write"} kind
 */
function cueDesignSystemEntry(target, kind) {
  designSystemCueCleanup();
  designSystemCueCleanup = () => {};
  const block = [...designSystemViewEl.querySelectorAll(".ds-component")].find((el) => el.dataset.componentName === target.name);
  if (!block) return;
  const cell = target.variant ? [...block.querySelectorAll(".ds-variant-cell")].find((el) => el.dataset.variantName === target.variant) : null;
  const cueEl = cell ?? block;
  cueEl.scrollIntoView({ block: "center", behavior: "smooth" });
  const cls = kind === "write" ? "activity-cue-write" : "activity-cue-read";
  cueEl.classList.add(cls);
  const timer = setTimeout(() => cueEl.classList.remove(cls), highlightDurationMs(kind));
  designSystemCueCleanup = () => {
    clearTimeout(timer);
    cueEl.classList.remove(cls);
  };
}

function reconnectSse(project) {
  eventSource?.close();
  eventSource = connectEvents({
    project,
    onChange: handleChangeEvent,
    onLifecycle: handleLifecycleEvent,
    onBoardState: handleBoardStateEvent,
    onActivity: handleActivityEvent,
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

/** Pause precedence rule 1 (ADR-005) — a manual sidebar screen pick is human navigation, so it pauses follow before selecting, unlike navigateToActivity's own (unwrapped) calls to selectScreen. */
function selectScreenHuman(screen) {
  pauseFollow();
  return selectScreen(screen);
}

/** Same as selectScreenHuman, for a manual sidebar mockup pick. */
function selectMockupHuman(name) {
  pauseFollow();
  return selectMockup(name);
}

/** Re-renders the screen list and the mockup list (both filtered by the same sidebar search), plus everything in the sidebar derived from them/the current selection, plus the board toolbar's status text/Clear pins (CHR-624 — cheap and pure, so it's simplest to always keep in sync here rather than gate it on the Board tab actually showing). */
function refreshSidebar() {
  renderScreenList(screenListEl, screens, currentScreen, selectScreenHuman, screenFilter, {
    pinned: new Set(pinnedScreens),
    onTogglePin: toggleScreenPin,
  });
  const filteredMockups = filterMockups(mockups, screenFilter);
  renderMockupList(mockupListEl, filteredMockups, { activeName: currentMockup, onSelect: selectMockupHuman });
  mockupSectionEl.hidden = filteredMockups.length === 0;
  const filteredScreenCount = filterScreens(screens, screenFilter).length;
  screenFilterHint.textContent = `${filteredScreenCount} screen${filteredScreenCount === 1 ? "" : "s"} · ${filteredMockups.length} mockup${filteredMockups.length === 1 ? "" : "s"} · matches name and tags`;
  updateNotesPanel();
  renderBoardStatus();
  renderActivityFeedPanel(); // CHR-631 — a screen/mockup's deletion can flip a feed row to the inert "deleted" look; recompute alongside everything else refreshSidebar already keeps in sync
}

function updateNotesPanel() {
  const screen = screens.find((s) => s.name === currentScreen);
  const notes = screen?.notes ?? "";
  const screenTags = screen?.tags ?? [];
  const screenTagsLower = new Set(screenTags.map((t) => t.toLowerCase()));
  const matchingTagNotes = tagNotes.filter((t) => screenTagsLower.has(t.tag.toLowerCase()));
  // A screen with no notes of its own but a tagged spec still gets a panel —
  // the tag section is the whole point, not an addendum to the screen's own
  // notes.
  notesPanelEl.hidden = notes.length === 0 && matchingTagNotes.length === 0;
  if (notesPanelEl.hidden) return;
  notesPanelScreen.textContent = screen.name;
  // notesPanelText only ever holds the screen's own notes — setMarkdown
  // replaces its children wholesale, so the tag sections render into their
  // own sibling element (notesPanelTagsEl), never inside this one.
  setMarkdown(notesPanelText, notes);
  notesPanelHeader.setAttribute("aria-expanded", String(notesExpanded));
  renderTagNotes(notesPanelTagsEl, screenTags, tagNotes, expandedTagNotes);
}

// CHR-624/ADR-005: the sidebar (and, via refreshSidebar's renderBoardStatus,
// the toolbar status text) filters locally and instantly on every
// keystroke — `screenFilter` itself is the single source of truth for
// rendering, updated synchronously here. The WRITE to the daemon (which is
// what actually moves the Board's tile set, and what every other tab sees)
// is debounced: each write fans out an SSE broadcast to every connected
// client and costs the daemon one meta read per screen, both wasted if
// re-run on every single keystroke.
const BOARD_FILTER_WRITE_DEBOUNCE_MS = 200;
let boardFilterWriteTimer;
screenFilterInput.addEventListener("input", () => {
  screenFilter = screenFilterInput.value;
  refreshSidebar();
  clearTimeout(boardFilterWriteTimer);
  boardFilterWriteTimer = setTimeout(() => {
    if (activeProjectRoot) reportBoardStateFailure(setBoardState(activeProjectRoot, { filter: screenFilter }));
  }, BOARD_FILTER_WRITE_DEBOUNCE_MS);
});

notesPanelHeader.addEventListener("click", () => {
  notesExpanded = !notesExpanded;
  notesPanelHeader.setAttribute("aria-expanded", String(notesExpanded));
});

async function loadScreens() {
  screens = await fetchScreens(activeProjectRoot);
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
  clearActivityHighlights(); // CHR-631 — an old highlight must never linger over a screen it no longer describes; navigateToActivity schedules THIS screen's own highlight only after this call returns (see its own comment)
  pendingActivityHighlight = null;
  clearTimeout(activityHighlightGraceTimer);
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
  clearActivityHighlights(); // CHR-631 — no screen highlight applies to the mockup view
  pendingActivityHighlight = null;
  clearTimeout(activityHighlightGraceTimer);
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
  const result = await fetchRender(currentScreen, activeProjectRoot);
  if (requestId !== renderRequestId) return; // a newer request has since started — drop this stale result
  pendingRenderScreen = currentScreen; // read by the `load` handler below once this srcdoc assignment actually lands
  screenFrame.srcdoc = result.ok
    ? result.html
    : `<p style="font-family: system-ui, sans-serif; color: #900; padding: 16px;">${escapeHtml(result.message)}</p>`;
}

async function loadComments() {
  const requestId = ++commentsRequestId;
  const result = currentScreen ? await fetchComments(currentScreen, activeProjectRoot) : [];
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
  const result = await fetchScreenNodes(currentScreen, activeProjectRoot);
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
  const result = await postComment({ parent_id: rootId, text }, activeProjectRoot);
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
    modeCleanup = applyFlowMode(doc, true, selectScreenHuman); // a flow click-through is human navigation too (ADR-005 pause rule 1)
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

// CHR-631 — follow's `enabled` bit is the one per-browser preference here
// (off by default); `paused` never persists — see the module-level doc.
followState = { enabled: readBoolPref(prefsStorage, "artisign.followEnabled", false), paused: false };
renderFollowUI();
renderActivityFeedPanel(); // shows the empty state before boot() ever loads a project
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
  applyPendingActivityHighlight(); // CHR-631 — the re-render a pending write/navigate highlight was waiting for has now landed
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
  // ADR-005 pause rule 1 — an open comment or inspect mode pauses follow.
  if (resulting === "comment" || resulting === "inspect") pauseFollow();
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
  const result = await postComment({ screen: currentScreen, node_id: selectedNode ?? null, text }, activeProjectRoot);
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
  const result = await fetchMockups(activeProjectRoot);
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
  const projectRoot = activeProjectRoot;
  renderMockupView(mockupViewEl, mockup, {
    fetchRenderFor: async (variantId) => {
      const result = await fetchMockupRender(mockupName, variantId, projectRoot);
      return requestId === mockupRequestId ? result : { ok: false, message: "stale mockup selection" };
    },
    onColumnMeasured: updateMockupZoom,
  });
  updateMockupZoom(); // initial pass — columns start at their CSS default width, before any iframe has measured its variant
}

async function loadDesignSystem() {
  const data = await fetchDesignSystem(activeProjectRoot);
  renderDesignSystem(designSystemViewEl, data);
}

/** Builds the board from scratch — screens + flows. Only called once, lazily; SSE handlers keep it in sync afterward (see connectEvents below). */
async function loadBoard() {
  // Captured up front and re-checked after the await (CHR-651, same pattern
  // as loadBoardState) — a project switch landing mid-fetch would otherwise
  // pair the NEW project's screens/root with the OLD project's flows below.
  const project = activeProjectRoot;
  const flows = await fetchFlows(project);
  if (project !== activeProjectRoot) return;
  // CHR-624: the board's tile set is filter matches ∪ pinned, not every
  // screen — renderBoardStatus() (called by refreshSidebar, which every
  // caller of loadBoard already runs first) recomputes the identical
  // visibility, but board.setScreens also needs the pin/outside-filter
  // classification per tile, not just the counts renderBoardStatus keeps.
  const visibility = computeBoardVisibility(screens, screenFilter, pinnedScreens);
  await board.setScreens(visibility.visibleNames, flows, project, {
    pinned: visibility.pinnedNames,
    outsideFilter: visibility.outsideFilterNames,
    filter: screenFilter,
  });
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
  // CHR-623 review finding 5: an already-built board was `hidden` (clientWidth
  // 0) while another tab showed, so any relayout that ran while hidden used
  // a zero-viewport computeBoardColumns and would otherwise stay wrong until
  // the next scheduleRelayout trigger fires — relayout immediately instead
  // of waiting on that.
  if (view === "board" && boardBuilt) board.relayout();
  // A sidebar toggle while another view was active runs against a
  // display:none canvas (clientWidth 0) — re-fit now that it's visible
  // again, in case its available width changed while we were away.
  if (view === "screens" && currentMockup === null) updateCanvas();
}

for (const tab of viewTabs) {
  tab.addEventListener("click", () => {
    pauseFollow(); // ADR-005 pause rule 1 — a manual tab switch is human navigation, unlike handleBoardStateEvent's own agent-triggered setView("board")
    setView(tab.dataset.view);
  });
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
