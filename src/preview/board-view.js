// Board view: every screen as a tile on one scrollable surface, with flow
// edges drawn as SVG curves between them. All DOM/measurement work lives
// here — the actual layout/edge/scroll math is in board.js.
//
// Comment mode is not supported on the board — the board's per-tile iframes
// don't carry comment listeners at all, so toggling comment mode has no
// effect while the board is showing (app.js falls back to "none" when
// switching views away from a mode the new view doesn't support, except it
// keeps flow mode since the board does support that). The comment pins on the
// board (CHR-1264, board-comments.js) are a read-only overlay in the parent
// document that measures tiles through commentGeometry().

import { fetchRender } from "./api.js";
import { createCanvasInput } from "./canvas-input.js";
import { applyFlowMode } from "./flows.js";
import { icon } from "./icons.js";
import { DESKTOP_MIN_WIDTH } from "./screens.js";
import {
  computeLayout,
  buildBoardModel,
  resolveEdgeEnd,
  resolveFlowEdge,
  findTile,
  elementSideAnchor,
  tileAnchor,
  bezierPath,
  edgesFromNode,
  screenIdFromRef,
  clampZoom,
  computeFitAllZoom,
  computeBoardColumns,
  computeZoomAroundCursor,
  labelDisplayMode,
  BASE_GAP,
  BASE_GAP_Y,
  BASE_PADDING,
  DEFAULT_BOARD_ZOOM,
} from "./board.js";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The target edge label's arrow: drawn at this size, with this much of the pill reserved for it (arrow + gap), in px. */
const EDGE_LABEL_ARROW_SIZE = 12;
const EDGE_LABEL_ARROW_PX = 16;
// The base layout (tile positions, gaps, padding) is always computed at
// native (unscaled) tile size, with the board's own 100%-zoom reference
// gap/padding. Board zoom (5%-200%) is then a single CSS `transform:
// scale()` applied to #board-canvas-inner on top of that fixed layout (see
// applyZoomSizing) — never a re-layout — which is what makes zoom-around-
// cursor exact (computeZoomAroundCursor) instead of an approximation.
// `columns` is NOT fixed here (CHR-623 review) — it's chosen dynamically by
// computeBoardColumns, see relayout()/GRID_OPTIONS.
const GRID_OPTIONS = { gapX: BASE_GAP, gapY: BASE_GAP_Y, padding: BASE_PADDING };
// A batch of near-simultaneous iframe `load` events (e.g. ~186 screens all
// finishing at once) coalesces into a single relayout — see
// scheduleRelayout's own comment.
const RELAYOUT_COALESCE_MS = 50;
/** A cluster card at least this wide on screen (px) has room for its Collapse toggle beside the label. */
const ROOMY_FRAME_WIDTH = 200;
/** The card's padding right of its last tile, in board px (board.js's frame padding). */
const FRAME_RIGHT_PAD = 24;
/** What the Collapse toggle takes of a header, in px on screen (its width, its gap and a little air). */
const COLLAPSE_TOGGLE_WIDTH = 104;
// If a wheel/pinch zoom gesture fired more recently than this, a coalesced
// relayout defers instead of running — the grid shape (in particular the
// column count) must not change mid-gesture, or tiles jump under the
// cursor (CHR-623 review finding 3).
const ZOOM_GESTURE_QUIET_MS = 150;

/**
 * @param {{
 *   surfaceEl: HTMLElement, canvasEl: HTMLElement, canvasInnerEl: HTMLElement,
 *   tilesEl: HTMLElement, edgesEl: SVGElement,
 *   emptyStateEl?: HTMLElement, emptyStateBodyEl?: HTMLElement,
 *   onZoomChange?: (zoomPercent: number, source: "manual" | "fitall") => void,
 *   onRelayout?: () => void,
 *   onTogglePin?: (screen: string) => void,
 *   onToggleCluster?: (cluster: { root: string, expanded: boolean, memberNames: string[] }) => void,
 *   onTileKeydown?: (event: KeyboardEvent) => void,
 *   onManualNavigate?: () => void,
 * }} args `onZoomChange` fires whenever zoom changes for ANY reason —
 *   quick-jump/step buttons, Fit all, the range input, or Ctrl/Cmd+wheel/
 *   pinch on the canvas — so app.js can keep the toolbar's range input,
 *   readout and quick-jump active states in sync regardless of the source.
 *   `onRelayout` (CHR-623 review finding 6) fires whenever relayout()
 *   actually runs (screen-list/resize/project-switch/tab-switch — never a
 *   zoom-only action) — app.js uses it to invalidate its "Fit all was the
 *   last zoom applied" bookkeeping, since a grid-shape change can leave a
 *   previously-exact `lastFitAllZoom` no longer matching what Fit all would
 *   compute now.
 *   `onLayout` (CHR-1264) fires after every change of tile geometry or zoom
 *   (relayout and setZoom) — the read-only comment overlay re-measures its
 *   markers from it; it never writes into a tile.
 *   `onTogglePin` (CHR-624) fires when a tile's pin button is clicked —
 *   app.js owns the actual pin/unpin write (setBoardState) and the
 *   resulting SSE broadcast is what actually changes what's pinned; this
 *   view never mutates its own pinned/outsideFilter sets outside setScreens.
 *   `onToggleCluster` (CHR-733) fires when a cluster frame's header is
 *   clicked — like `onTogglePin`, app.js owns the write (`set_board_state`
 *   `expanded`) and the SSE broadcast is what actually re-renders.
 *   `onTileKeydown` (CHR-1271) receives every key pressed while the focus is
 *   inside a tile's document (same-origin srcdoc) — a press that never
 *   reaches the top document, so the shell's keyboard shortcuts keep working
 *   once a tile was clicked, as they do inside the Screens view's frame.
 *   `onManualNavigate` (CHR-1290/CHR-1291) fires when a drag or the wheel moves or zooms the canvas by hand — app.js pauses Follow.
 *   `getInsets` (CHR-1299) returns what the floating cards cover of the window right now; it feeds Fit all and the centring, never the canvas origin.
 *   `emptyStateEl`/`emptyStateBodyEl` (CHR-624) — shown/filled by setScreens
 *   whenever the visible set is empty, per the `board-view-empty` design.
 */
export function createBoardView({
  surfaceEl,
  canvasEl,
  canvasInnerEl,
  tilesEl,
  edgesEl,
  emptyStateEl,
  emptyStateBodyEl,
  onZoomChange,
  onRelayout,
  onLayout,
  onTogglePin,
  onToggleCluster,
  onTileKeydown,
  onManualNavigate,
  getInsets,
}) {
  /** @type {string[]} */
  let screens = [];
  /** @type {{ from: string, event: string, to: string, to_kind: string }[]} */
  let flows = [];
  /** @type {Record<string, { width: number, height: number }>} */
  const measuredSizes = {};
  // CHR-733 — the project's screen records (for variant_of), the shared
  // `expanded` names and the "Clusters" toggle. `model` is what they and the
  // visible set make of the board (plain tiles and clusters); with clusters
  // off it is exactly the visible set as plain tiles, i.e. today's flat board.
  let allScreens = [];
  let expandedNames = [];
  let clustersOn = false;
  let currentProject = "";
  let model = buildBoardModel([], [], [], { clusters: false });
  /** @type {{ tiles: object[], frames: object[], mores: object[], contentWidth: number, contentHeight: number }} */
  let layout = { tiles: [], frames: [], mores: [], contentWidth: 0, contentHeight: 0 };
  const framesEl = document.createElement("div");
  framesEl.className = "board-frames";
  // The column count the CURRENT `layout` was built with — set only by
  // relayout() (see its own comment on when that runs). fitAll() reads
  // this rather than recomputing it, so a zoom-only action never itself
  // changes the grid shape.
  let currentColumns = 1;
  /** @type {Map<string, HTMLIFrameElement>} */
  const iframesByScreen = new Map();
  /** @type {Map<string, () => void>} */
  const modeCleanupByScreen = new Map();
  let flowModeOn = false;
  // CHR-1290/CHR-1291 — the canvas input shared with the Screens view: a left-drag pans (the surface scrolls), the mouse wheel and a pinch zoom around the pointer, a trackpad two-finger scroll stays the surface's native scroll. Flow mode keeps the left button for its clicks.
  const canvasInput = createCanvasInput({
    surfaceEl,
    isToolActive: () => flowModeOn,
    ignoreSelector: "#board-comment-layer *",
    onManual: () => onManualNavigate?.(),
    onPan: (dx, dy) => {
      surfaceEl.scrollLeft -= dx;
      surfaceEl.scrollTop -= dy;
    },
    onZoom: (factor, clientX, clientY) => {
      lastWheelAt = performance.now();
      setZoom(zoom * factor, { cursor: { clientX, clientY } });
    },
  });
  /** @type {{ from: string } | null} */
  let highlightedSource = null;
  let resizeObserver;
  let zoom = DEFAULT_BOARD_ZOOM;
  // CHR-624 — which of the CURRENT `screens` are pinned, and which of
  // those are pinned but don't match the shared filter (the `outside-filter`
  // tile treatment). Set only by setScreens, same as `screens`/`flows`
  // themselves — the visible set, pin state and outside-filter
  // classification are always rebuilt together (see setScreens's own
  // comment), never patched independently.
  let pinnedScreens = new Set();
  let outsideFilterScreens = new Set();

  /** The size of every screen of the project (get_project's viewport data), for the glyph of a label and the shape of a thumbnail — also of variants that have no tile on the board. @type {Map<string, { width: number, height: number }>} */
  let viewports = new Map();
  /** Whether a screen is drawn as a desktop frame: its viewport, else the size its tile was measured at, else a phone. */
  function isDesktop(screen) {
    const size = viewports.get(screen) ?? measuredSizes[screen];
    return (size?.width ?? 0) >= DESKTOP_MIN_WIDTH;
  }

  /** The screen the agent is writing right now (design: violet ring and a "Writing" chip), or null. */
  let writingName = null;

  function gridOptions() {
    return GRID_OPTIONS;
  }
  let edgesVisible = true;
  // CHR-623 review findings 3/5: a single coalescing timer shared by every
  // relayout TRIGGER that isn't already synchronous/immediate (an iframe
  // `load`, a surface resize) — see scheduleRelayout. `lastWheelAt` is read
  // by it to defer a coalesced relayout while a zoom gesture is in
  // progress; `handleWheel` and `handleClick`/`handleWheel` themselves are
  // named (not inline) so mount()'s teardown can actually remove them.
  let relayoutTimer = null;
  let lastWheelAt = 0;
  // CHR-1298 — while the Board's view is `hidden` (display: none) nothing in it has a size: a relayout would lay the grid out for a 0 x 0 surface and a tile document that loads then reads 0 as its size. So nothing is measured or laid out while hidden; `unmeasured` holds the tiles whose documents loaded meanwhile (read on the next relayout), `hiddenSeen` says the view was away (the browser drops a hidden element's scroll position, so the pan is put back), `pan` is the last scroll position seen while visible.
  const unmeasured = new Set();
  let hiddenSeen = false;
  let pan = { left: 0, top: 0 };
  function isHidden() {
    return surfaceEl.closest("[hidden]") !== null;
  }

  function screenIdToNodeId(el) {
    return el.getAttribute("id");
  }

  /**
   * CHR-1299 — the surface fills the window; its padding is the constant area the cards take when open, where the content starts at scroll 0. A card never changes it. (style.css `#board-surface`)
   * @returns {{ left: number, right: number, top: number, bottom: number }}
   */
  function contentPad() {
    const style = getComputedStyle(surfaceEl);
    return { left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0, top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0 };
  }

  /** The area the cards leave free right now, in surface pixels — what Fit all fits into and centring aims at. `getInsets` (app.js) measures the cards; without it the content area stands in. */
  function freeArea() {
    const insets = getInsets?.() ?? contentPad();
    return {
      left: insets.left,
      top: insets.top,
      width: Math.max(0, surfaceEl.clientWidth - insets.left - insets.right),
      height: Math.max(0, surfaceEl.clientHeight - insets.top - insets.bottom),
    };
  }

  /** The scroll offset that puts the centre of a box (board px at the current zoom) in the middle of the free area, clamped to the scrollable range. */
  function scrollToCenter(box) {
    const pad = contentPad();
    const scale = zoom / 100;
    const free = freeArea();
    const maxLeft = Math.max(0, pad.left + layout.contentWidth * scale + pad.right - surfaceEl.clientWidth);
    const maxTop = Math.max(0, pad.top + layout.contentHeight * scale + pad.bottom - surfaceEl.clientHeight);
    return {
      left: Math.min(Math.max(0, pad.left + box.x + box.width / 2 - (free.left + free.width / 2)), maxLeft),
      top: Math.min(Math.max(0, pad.top + box.y + box.height / 2 - (free.top + free.height / 2)), maxTop),
    };
  }

  function centerOnScreen(screenId) {
    // A variant inside a collapsed cluster centres the cluster frame (it is
    // never auto-expanded); one folded into "+N more" centres that tile.
    const tile = resolveEdgeEnd(layout, screenId)?.rect;
    if (!tile) return;
    const scale = zoom / 100;
    const scaledTile = { x: tile.x * scale, y: tile.y * scale, width: tile.width * scale, height: tile.height * scale };
    const { left, top } = scrollToCenter(scaledTile);
    surfaceEl.scrollTo({ left, top, behavior: "smooth" });
  }

  function setHighlight(source) {
    highlightedSource = source;
    drawEdges();
  }

  /** Per-tile click handling for flow-source elements, active regardless of flow mode (only the effect differs). */
  function attachTileClicks(doc, screenId) {
    function handleClick(evt) {
      const el = evt.target.closest?.("[data-flow-target]");
      if (!el) {
        setHighlight(null);
        return;
      }
      const trigger = el.getAttribute("data-flow-trigger") ?? "tap";
      if (trigger !== "tap") return;
      evt.preventDefault();
      if (flowModeOn) {
        centerOnScreen(screenIdFromRef(el.getAttribute("data-flow-target")));
      } else {
        const nodeId = screenIdToNodeId(el);
        setHighlight(nodeId ? { screen: screenId, nodeId } : null);
      }
    }
    doc.addEventListener("click", handleClick, true);
    return () => doc.removeEventListener("click", handleClick, true);
  }

  function applyTileMode(iframe, screenId) {
    modeCleanupByScreen.get(screenId)?.();
    const doc = iframe.contentDocument;
    if (!doc) {
      modeCleanupByScreen.delete(screenId);
      return;
    }
    // applyFlowMode(..., true, ...) both outlines flow sources and wires
    // clicks to navigate — reused here for the visual outline and the
    // "flow mode on" click behavior. It's a no-op when enabled is false, so
    // the highlight-on-click behavior for "flow mode off" is wired
    // separately by attachTileClicks regardless of flowModeOn.
    const flowCleanup = applyFlowMode(doc, flowModeOn, (targetScreen) => centerOnScreen(targetScreen));
    const clickCleanup = flowModeOn ? () => {} : attachTileClicks(doc, screenId);
    const inputCleanup = canvasInput.attachDoc(doc, iframe);
    if (onTileKeydown) doc.addEventListener("keydown", onTileKeydown);
    modeCleanupByScreen.set(screenId, () => {
      flowCleanup();
      clickCleanup();
      inputCleanup();
      if (onTileKeydown) doc.removeEventListener("keydown", onTileKeydown);
    });
  }

  function readNaturalSize(iframe) {
    const root = iframe.contentDocument?.body?.firstElementChild;
    return { width: root?.offsetWidth || 390, height: root?.offsetHeight || 844 };
  }

  /** Applies the current `zoom` as a canvas-level transform on top of the fixed base layout — never a re-layout, see GRID_OPTIONS's module comment. */
  function applyZoomSizing() {
    const scale = zoom / 100;
    canvasInnerEl.style.transform = `scale(${scale})`;
    canvasInnerEl.style.setProperty("--bz", String(scale)); // chrome that keeps its size at every zoom divides by it (style.css)
    canvasEl.style.width = `${layout.contentWidth * scale}px`;
    canvasEl.style.height = `${layout.contentHeight * scale}px`;
  }

  /** The zoom-dependent label rule (board.js's labelDisplayMode): hidden when the board is an overview, truncated to the tile's width on screen below 100 %, full from there. The sizes are style.css's (the label keeps one size at every zoom). */
  function applyZoomDependentTileChrome() {
    for (const label of tilesEl.querySelectorAll(".board-tile-label")) label.dataset.mode = labelDisplayMode(zoom, { member: label.parentElement?.classList.contains("member") });
    for (const caption of tilesEl.querySelectorAll(".board-tile-caption")) caption.dataset.mode = labelDisplayMode(zoom, { member: true });
    // An expanded cluster's toggle sits inside its header when the card is wide enough on screen to hold it beside the label, and beside the card otherwise.
    for (const frame of layout.frames) {
      framesEl.querySelector(`.board-cluster-frame[data-root="${CSS.escape(frame.root)}"]`)?.classList.toggle("roomy", (frame.width * zoom) / 100 >= ROOMY_FRAME_WIDTH);
      // The label of an expanded cluster's main tile has the whole card to its right, not just the (smaller) tile's width.
      const main = findTile(layout.tiles, frame.root);
      const label = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(frame.root)}"] .board-tile-label`);
      if (main && label) {
        const room = ((frame.x + frame.width - main.x - FRAME_RIGHT_PAD) * zoom) / 100;
        const roomy = (frame.width * zoom) / 100 >= ROOMY_FRAME_WIDTH;
        label.style.width = frame.expanded ? `${Math.max(88, room - (roomy ? COLLAPSE_TOGGLE_WIDTH : 0))}px` : ""; // the Collapse toggle takes its share of a roomy card's header
      }
    }
  }

  /** The viewport glyph of each label: a monitor for a wide screen, a phone otherwise. */
  function applyViewportIcons() {
    for (const tile of layout.tiles) {
      const el = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(tile.screen)}"] .board-tile-viewport`);
      if (el) el.textContent = isDesktop(tile.screen) ? "desktop_windows" : "smartphone";
    }
  }

  /**
   * The project's viewport data arrived or changed: glyphs and thumbnails follow.
   * @param {Map<string, { width: number, height: number }>} next
   */
  function setViewports(next) {
    viewports = next;
    if (layout.frames.length > 0) renderFrames();
    applyViewportIcons();
    applyZoomDependentTileChrome();
  }

  /**
   * Re-lays out the whole grid: column count AND tile positions, both from
   * scratch. The only place the column count is decided (computeBoardColumns
   * — CHR-623 review) — called on a screen-list change, a (debounced)
   * surface resize, and a project switch, i.e. whenever the set of tiles or
   * the viewport shape changes, but NEVER from setZoom/the wheel handler:
   * the grid shape must stay put while the human is mid-drag on the zoom
   * slider or mid-pinch on the canvas, or tiles would visibly jump under
   * their cursor.
   */
  function relayout() {
    if (isHidden()) {
      hiddenSeen = true;
      return; // measured and laid out when the view shows again (app.js's setView calls relayout then)
    }
    for (const screen of unmeasured) {
      const iframe = iframesByScreen.get(screen);
      if (iframe) measuredSizes[screen] = readNaturalSize(iframe);
    }
    unmeasured.clear();
    const pad = contentPad();
    currentColumns = computeBoardColumns(model.items, measuredSizes, surfaceEl.clientWidth - pad.left - pad.right, surfaceEl.clientHeight - pad.top - pad.bottom, gridOptions());
    layout = computeLayout(model.items, measuredSizes, { ...gridOptions(), scale: 1, columns: currentColumns });
    layout = { frames: [], mores: [], ...layout };
    tilesEl.style.width = `${layout.contentWidth}px`;
    tilesEl.style.height = `${layout.contentHeight}px`;
    edgesEl.setAttribute("width", String(layout.contentWidth));
    edgesEl.setAttribute("height", String(layout.contentHeight));
    edgesEl.setAttribute("viewBox", `0 0 ${layout.contentWidth} ${layout.contentHeight}`);
    for (const tile of layout.tiles) {
      const el = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(tile.screen)}"]`);
      if (!el) continue;
      el.style.left = `${tile.x}px`;
      el.style.top = `${tile.y}px`;
      el.style.width = `${tile.width}px`;
      el.style.height = `${tile.height}px`;
      const frame = el.querySelector(".board-tile-frame");
      frame.style.width = `${tile.naturalWidth}px`;
      frame.style.height = `${tile.naturalHeight}px`;
      frame.style.transform = `scale(${tile.width / tile.naturalWidth})`;
    }
    renderFrames();
    applyViewportIcons();
    applyZoomSizing();
    applyZoomDependentTileChrome();
    drawEdges();
    if (hiddenSeen) {
      // Back from another view: zoom stays (it is a transform on the canvas), the pan comes back.
      hiddenSeen = false;
      surfaceEl.scrollLeft = pan.left;
      surfaceEl.scrollTop = pan.top;
    }
    onRelayout?.();
    onLayout?.();
  }

  /**
   * Coalesces relayout triggers that can fire many times in a short burst —
   * a batch of iframe `load` events (up to one per tile: ~186 for a large
   * project, most arriving within the same handful of milliseconds) and a
   * dragged/animated surface resize — into a single relayout() call
   * (CHR-623 review finding 3: calling relayout() — and inside it,
   * computeBoardColumns, itself O(n) — once PER TILE LOAD made the
   * 186-screen case O(n²) relayouts on top of computeBoardColumns' own
   * O(n) work, the real source of the multi-second load time). Each call
   * resets the timer, so only the LAST one in a burst actually schedules
   * a run, using measuredSizes/viewport as they stand once the burst
   * settles.
   *
   * Also defers (reschedules further out, not run-then-forget) while a
   * zoom gesture is in progress (a wheel/pinch tick within the last
   * ZOOM_GESTURE_QUIET_MS) — the whole point of relayout() never running
   * from setZoom/handleWheel is to keep the grid shape stable while the
   * human is mid-gesture; a coalesced relayout landing mid-gesture (e.g.
   * from a screen reloading via SSE while the human happens to be
   * pinching) would silently break that same promise.
   */
  function scheduleRelayout() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(runRelayoutIfQuiet, RELAYOUT_COALESCE_MS);
  }

  /**
   * scheduleRelayout's timer callback — re-checks gesture recency AT FIRE
   * TIME (using the latest `lastWheelAt`, not one captured back when the
   * timer was armed) and, if a wheel/pinch tick has landed since, re-defers
   * instead of running: a gesture that's still going when the FIRST
   * RELAYOUT_COALESCE_MS elapses must keep pushing the relayout out, not
   * just delay it once by a fixed amount computed at schedule time (which
   * would still let a mid-gesture relayout land if the gesture outlasted
   * that one computed delay).
   */
  function runRelayoutIfQuiet() {
    const sinceWheel = performance.now() - lastWheelAt;
    if (sinceWheel < ZOOM_GESTURE_QUIET_MS) {
      relayoutTimer = setTimeout(runRelayoutIfQuiet, ZOOM_GESTURE_QUIET_MS - sinceWheel);
      return;
    }
    relayout();
  }

  /**
   * Sets board zoom, clamped to [5, 200]. `cursor`, when given (Ctrl/Cmd+
   * wheel, pinch), is a `{ clientX, clientY }` viewport point to zoom
   * around — see board.js's computeZoomAroundCursor — instead of leaving
   * the scroll position untouched. `source` is passed straight through to
   * `onZoomChange` — app.js uses it to tell a `fitAll()`-driven change apart
   * from every other one, which is the only way it can know whether the
   * "Fit all" quick-jump should read as active (its target value isn't a
   * fixed constant like 100%'s).
   * @param {number} next
   * @param {{ cursor?: { clientX: number, clientY: number }, source?: "manual" | "fitall" }} [opts]
   */
  function setZoom(next, { cursor, source = "manual" } = {}) {
    const clamped = clampZoom(next);
    if (clamped === zoom) {
      // Nothing to re-render, but still tell the caller — a fitAll() (or
      // any other) call landing on the value already active is still a
      // meaningful event for e.g. the "Fit all" quick-jump's active state,
      // which depends on `source` even when the number itself didn't move.
      onZoomChange?.(zoom, source);
      return;
    }
    if (cursor) {
      const rect = surfaceEl.getBoundingClientRect();
      const pad = contentPad(); // the content starts `pad` into the scroll area: measure the cursor and the viewport from there
      const { left, top } = computeZoomAroundCursor({
        cursorX: cursor.clientX - rect.left - pad.left,
        cursorY: cursor.clientY - rect.top - pad.top,
        scrollLeft: surfaceEl.scrollLeft,
        scrollTop: surfaceEl.scrollTop,
        oldZoomPercent: zoom,
        newZoomPercent: clamped,
        contentWidth: layout.contentWidth,
        contentHeight: layout.contentHeight,
        viewportWidth: surfaceEl.clientWidth - pad.left - pad.right,
        viewportHeight: surfaceEl.clientHeight - pad.top - pad.bottom,
      });
      zoom = clamped;
      applyZoomSizing();
      applyZoomDependentTileChrome();
      surfaceEl.scrollLeft = left;
      surfaceEl.scrollTop = top;
    } else {
      zoom = clamped;
      applyZoomSizing();
      applyZoomDependentTileChrome();
    }
    onLayout?.();
    onZoomChange?.(zoom, source);
  }

  /**
   * One-shot: zooms to the largest value at which every current tile fits
   * inside the viewport — see board.js's computeFitAllZoom. Uses
   * `currentColumns`, NOT a fresh computeBoardColumns call: the grid shape
   * is relayout()'s job (screen-list/resize/project-switch), not a zoom
   * action's — see relayout()'s own comment.
   */
  function fitAll() {
    if (isHidden()) return; // the viewport is 0 x 0 then
    const free = freeArea();
    setZoom(computeFitAllZoom(model.items, measuredSizes, free.width, free.height, { ...gridOptions(), columns: currentColumns }), { source: "fitall" });
    // The content starts at the constant pad; bring it to where the free area starts (CHR-1299).
    const pad = contentPad();
    surfaceEl.scrollLeft = Math.max(0, pad.left - free.left);
    surfaceEl.scrollTop = Math.max(0, pad.top - free.top);
  }

  /**
   * Zooms to one tile and centres it — a group comment pin's click (CHR-1264).
   * Zooms in: to at least 100 % and 1.5x the current zoom, more when the tile needs it to fill the surface (the 200 % cap applies); never out.
   * @param {string} screen
   */
  function zoomToTile(screen) {
    const tile = findTile(layout.tiles, screen);
    if (!tile) return;
    const room = 2 * BASE_PADDING;
    const free = freeArea();
    const fit = Math.min(free.width / (tile.width + room), free.height / (tile.height + room)) * 100;
    setZoom(Math.max(100, zoom * 1.5, fit));
    const scale = zoom / 100;
    const { left, top } = scrollToCenter({ x: tile.x * scale, y: tile.y * scale, width: tile.width * scale, height: tile.height * scale });
    surfaceEl.scrollLeft = left;
    surfaceEl.scrollTop = top;
  }

  /**
   * What the read-only comment overlay measures against (CHR-1264): the zoom,
   * every tile's base-layout box, and each tile's rendered document — read
   * like flow edges read their elements, never written to.
   * @returns {{ zoom: number, tiles: { screen: string, x: number, y: number, width: number, height: number, naturalWidth: number }[], docOf: (screen: string) => Document | null, chipsAt: (screen: string) => { left: number, top: number, height: number } | null, reserveChips: (screen: string, width: number) => void }} `chipsAt`: where the room the label keeps for the count chips starts on screen (viewport pixels), null while the label is not drawn; `reserveChips` makes that room as wide as the chips
   */
  function commentGeometry() {
    return {
      zoom,
      tiles: layout.tiles.map((t) => ({ screen: t.screen, x: t.x, y: t.y, width: t.width, height: t.height, naturalWidth: t.naturalWidth })),
      docOf: (screen) => iframesByScreen.get(screen)?.contentDocument ?? null,
      chipsAt: (screen) => {
        const slot = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(screen)}"] .board-tile-chips-slot`);
        const label = slot?.parentElement;
        if (!slot || !label || label.dataset.mode === "hidden") return null;
        const box = slot.getBoundingClientRect();
        return { left: box.left, top: label.getBoundingClientRect().top, height: label.getBoundingClientRect().height };
      },
      reserveChips: (screen, width) => {
        const slot = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(screen)}"] .board-tile-chips-slot`);
        if (slot && slot.style.width !== `${width}px`) slot.style.width = `${width}px`;
      },
    };
  }

  /**
   * The screen the agent is writing now gets the violet ring and the "Writing" chip (design `board-cluster` writing); null clears it. A no-op while nothing changes, so the agent bar's regular refresh costs nothing.
   * @param {string | null} screen
   */
  function setWritingScreen(screen) {
    if (screen === writingName) return;
    writingName = screen;
    for (const el of tilesEl.querySelectorAll(".board-tile")) {
      const on = el.dataset.screen === screen;
      el.classList.toggle("writing", on);
      const chip = el.querySelector(".board-tile-writing");
      if (chip) chip.hidden = !on;
    }
  }

  function setEdgesVisible(visible) {
    edgesVisible = visible;
    drawEdges();
  }

  function edgeEndpoints(flow) {
    const resolved = resolveFlowEdge(layout, flow);
    if (!resolved) return null;
    const { from: fromEnd, to: toEnd, sides } = resolved;
    const dot = flow.from.indexOf(".");
    const nodeId = dot === -1 ? null : flow.from.slice(dot + 1);
    // Only an edge leaving an exact tile can start at the element; one leaving
    // a frame / "+N more" tile docks on its side.
    const iframe = fromEnd.kind === "tile" ? iframesByScreen.get(fromEnd.screen) : null;
    const elementRect = nodeId && iframe?.contentDocument ? iframe.contentDocument.getElementById(nodeId)?.getBoundingClientRect() : null;
    const from = elementRect ? elementSideAnchor(fromEnd.rect, elementRect, sides.from) : tileAnchor(fromEnd.rect, sides.from);
    const to = tileAnchor(toEnd.rect, sides.to);
    return { from, to, sides, fromEnd, toEnd };
  }

  /** A pill naming the variant a docked edge really touches: accent with an arrow for the target end, grey for the source end. */
  function buildEdgeLabel(point, side, text, role) {
    const hasArrow = role === "target";
    const width = text.length * 6.2 + 14 + (hasArrow ? EDGE_LABEL_ARROW_PX : 0);
    const height = 18;
    const x = side === "left" ? point.x - width - 6 : side === "right" ? point.x + 6 : point.x - width / 2;
    const y = side === "top" ? point.y - height - 6 : side === "bottom" ? point.y + 6 : point.y - height / 2;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `board-edge-label ${role}`);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(height));
    rect.setAttribute("rx", "9");
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("y", String(y + height / 2));
    label.setAttribute("dominant-baseline", "central");
    label.textContent = text;
    g.append(rect);
    if (hasArrow) {
      // Material "arrow_forward" drawn as a path (24px grid scaled to the pill), so it needs no icon font and cannot change the pill's width.
      const arrow = document.createElementNS(SVG_NS, "path");
      arrow.setAttribute("class", "board-edge-label-arrow");
      arrow.setAttribute("d", "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z");
      arrow.setAttribute("transform", `translate(${x + 6} ${y + (height - EDGE_LABEL_ARROW_SIZE) / 2}) scale(${EDGE_LABEL_ARROW_SIZE / 24})`);
      arrow.setAttribute("aria-hidden", "true");
      g.append(arrow);
      label.setAttribute("x", String(x + 6 + EDGE_LABEL_ARROW_PX));
      label.setAttribute("text-anchor", "start");
    } else {
      label.setAttribute("x", String(x + width / 2));
      label.setAttribute("text-anchor", "middle");
    }
    g.append(label);
    return g;
  }

  /** A `<marker>` def for arrowheads — one per variant, since a single shared marker can't pick up its referencing path's own highlight class. */
  function buildArrowMarker(id, extraClass) {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const arrow = document.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", "M0,0 L6,3 L0,6 Z");
    arrow.setAttribute("class", extraClass ? `board-edge-arrow ${extraClass}` : "board-edge-arrow");
    marker.appendChild(arrow);
    return marker;
  }

  function drawEdges() {
    edgesEl.innerHTML = "";
    // With edges hidden, flow-mode centering (attachTileClicks/applyFlowMode
    // -> centerOnScreen) and highlight-on-click still work exactly as
    // before — setHighlight just has nothing to paint while this is false.
    if (!edgesVisible) return;
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.appendChild(buildArrowMarker("board-arrowhead"));
    defs.appendChild(buildArrowMarker("board-arrowhead-highlighted", "highlighted"));
    edgesEl.appendChild(defs);

    const highlightedEdges = highlightedSource ? new Set(edgesFromNode(flows, highlightedSource.screen, highlightedSource.nodeId)) : new Set();
    for (const flow of flows) {
      const endpoints = edgeEndpoints(flow);
      if (!endpoints) continue;
      const highlighted = highlightedEdges.has(flow);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", bezierPath(endpoints.from, endpoints.to, endpoints.sides.from, endpoints.sides.to));
      path.setAttribute("class", highlighted ? "board-edge highlighted" : "board-edge");
      path.setAttribute("marker-end", highlighted ? "url(#board-arrowhead-highlighted)" : "url(#board-arrowhead)");
      edgesEl.appendChild(path);
      if (endpoints.toEnd.kind !== "tile") edgesEl.appendChild(buildEdgeLabel(endpoints.to, endpoints.sides.to, endpoints.toEnd.screen, "target"));
      if (endpoints.fromEnd.kind !== "tile") edgesEl.appendChild(buildEdgeLabel(endpoints.from, endpoints.sides.from, endpoints.fromEnd.screen, "source"));
    }
  }

  /** Cluster frames (the card, its Expand / Collapse toggle, the variant thumbnails) and "+N more" tiles — a layer under the tiles, rebuilt on every relayout. The cluster's label (icon, name, variant count, pin mark) is its main tile's own label. */
  function renderFrames() {
    framesEl.innerHTML = "";
    for (const frame of layout.frames) {
      const cluster = model.clusters.find((c) => c.root === frame.root);
      const el = document.createElement("div");
      el.className = frame.expanded ? "board-cluster-frame expanded" : "board-cluster-frame";
      el.classList.toggle("outside-filter", outsideFilterScreens.has(frame.root));
      el.dataset.root = frame.root;
      el.style.left = `${frame.x}px`;
      el.style.top = `${frame.y}px`;
      el.style.width = `${frame.width}px`;
      el.style.height = `${frame.height}px`;
      const header = document.createElement("button");
      header.type = "button";
      header.className = "board-cluster-header";
      header.setAttribute("aria-expanded", String(frame.expanded));
      header.setAttribute("aria-label", `${frame.expanded ? "Collapse" : "Expand"} ${frame.root}`);
      header.style.height = `${frame.headerHeight}px`;
      const toggle = document.createElement("span");
      toggle.className = "board-cluster-toggle";
      toggle.append(icon(frame.expanded ? "keyboard_arrow_up" : "keyboard_arrow_down", "icon-xs"), frame.expanded ? "Collapse" : "Expand");
      header.appendChild(toggle);
      header.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (cluster) onToggleCluster?.(cluster);
      });
      el.appendChild(header);
      if (!frame.expanded && frame.thumbs.length > 0) {
        const main = findTile(layout.tiles, frame.root);
        const strip = document.createElement("div");
        strip.className = "board-cluster-thumbs";
        strip.style.top = `${main ? main.y - frame.y + main.height + 12 : frame.headerHeight}px`;
        // The first thumb stands for the frame above it (design `cluster-thumb` desktop-on / mobile-on); the others are its variants.
        const own = document.createElement("span");
        own.className = `board-cluster-thumb on ${isDesktop(frame.root) ? "desktop" : "mobile"}`;
        strip.appendChild(own);
        for (const thumb of frame.thumbs) {
          const micro = document.createElement("span");
          micro.className = `board-cluster-thumb kind-${thumb.kind ?? "state"} ${isDesktop(thumb.screen) ? "desktop" : "mobile"}`;
          micro.classList.toggle("deeper", thumb.deeper);
          micro.title = thumb.screen;
          strip.appendChild(micro);
        }
        if (frame.moreThumbs > 0) {
          const more = document.createElement("span");
          more.className = "board-cluster-thumbs-more";
          more.textContent = `+${frame.moreThumbs}`;
          strip.appendChild(more);
        }
        el.appendChild(strip);
      }
      framesEl.appendChild(el);
    }
    for (const more of layout.mores) {
      const el = document.createElement("div");
      el.className = "board-more-tile";
      el.dataset.id = more.id;
      el.style.left = `${more.x}px`;
      el.style.top = `${more.y}px`;
      el.style.width = `${more.width}px`;
      el.style.height = `${more.height}px`;
      el.textContent = `+${more.names.length} more`;
      el.title = more.names.join("\n");
      framesEl.appendChild(el);
    }
  }

  /** The caption of a variant tile in an expanded cluster: its name without the family's prefix ("cart-empty" under "cart" reads "empty"). */
  function captionOf(screen, root) {
    return screen.startsWith(`${root}-`) && screen.length > root.length + 1 ? screen.slice(root.length + 1) : screen;
  }

  /**
   * What a tile is in the cluster layout, as classes, and its label chrome built to match — called for a new tile and again for a kept one whose cluster expanded or collapsed.
   * - a plain tile or a collapsed cluster's main tile: the label above it (viewport glyph, name, variant count of a cluster's main screen, room for the comment chips, a pin mark while pinned);
   * - an expanded cluster's main tile: the same label is the card's header, and the tile is the ringed `current` member with the caption "default" below it;
   * - a variant tile of an expanded cluster (`member`): only its caption below (name, chips, pin mark).
   */
  function applyTileRole(tile, screen) {
    const cluster = model.clusters.find((c) => c.memberNames.includes(screen));
    const isRoot = cluster?.root === screen;
    const member = Boolean(cluster?.expanded && !isRoot);
    tile.classList.toggle("outside-filter", outsideFilterScreens.has(screen));
    tile.classList.toggle("context", model.contextNames.has(screen));
    // Inside a cluster's frame the frame is the card; every other tile draws its own.
    tile.classList.toggle("in-cluster", Boolean(cluster));
    tile.classList.toggle("member", member);
    tile.classList.toggle("current", Boolean(cluster?.expanded && isRoot));
    tile.classList.toggle("writing", screen === writingName);
    tile.querySelector(".board-tile-label")?.remove();
    tile.querySelector(".board-tile-caption")?.remove();

    const label = document.createElement("div");
    label.className = "board-tile-label";
    const name = document.createElement("span");
    name.className = "board-tile-name";
    name.textContent = member ? captionOf(screen, cluster.root) : screen;
    if (member) label.append(name);
    else {
      label.append(icon("smartphone", "board-tile-viewport"), name);
      if (cluster) {
        const count = document.createElement("span");
        count.className = "board-tile-count";
        count.textContent = `${cluster.size} variant${cluster.size === 1 ? "" : "s"}`;
        label.append(count);
      }
    }
    // Reserved by board-comments.js for the count chips, which sit in the overlay layer: name, count, chips, pin mark.
    const slot = document.createElement("span");
    slot.className = "board-tile-chips-slot";
    label.append(slot);
    // The pin mark is a button: the only way to unpin from the board itself (pinning starts in the card's list).
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "board-tile-pin";
    pin.hidden = !pinnedScreens.has(screen);
    pin.setAttribute("aria-label", `Unpin ${screen} from the board`);
    pin.setAttribute("aria-pressed", "true");
    pin.appendChild(icon("keep", "icon-xs"));
    pin.addEventListener("click", (evt) => {
      // Tiles have their own click handling for flow-source highlighting (see attachTileClicks, wired inside the iframe's own document — unaffected by this); stopPropagation keeps the press from also reaching #board-surface's own click listener (setHighlight(null)).
      evt.stopPropagation();
      onTogglePin?.(screen);
    });
    label.append(pin);
    tile.prepend(label);
    if (cluster?.expanded && isRoot) {
      const caption = document.createElement("span");
      caption.className = "board-tile-caption";
      caption.textContent = "default";
      tile.append(caption);
    }
    applyViewportIconIn(tile, screen);
  }

  function applyViewportIconIn(tile, screen) {
    const el = tile.querySelector(".board-tile-viewport");
    if (el) el.textContent = isDesktop(screen) ? "desktop_windows" : "smartphone";
  }

  function buildTile(screen) {
    const tile = document.createElement("div");
    tile.className = "board-tile";
    tile.dataset.screen = screen;

    const frame = document.createElement("div");
    frame.className = "board-tile-frame";

    const iframe = document.createElement("iframe");
    iframe.className = "board-tile-iframe";
    iframe.title = `${screen} (board)`;
    // Same sandbox as the single-screen view — allow-same-origin only,
    // never allow-scripts (screen HTML is untrusted; see index.html's note
    // on #screen-frame for why).
    iframe.setAttribute("sandbox", "allow-same-origin");
    iframe.addEventListener("load", () => {
      applyTileMode(iframe, screen);
      if (isHidden()) {
        unmeasured.add(screen); // a hidden document has no size to read — see `unmeasured`
        return;
      }
      measuredSizes[screen] = readNaturalSize(iframe);
      scheduleRelayout();
    });
    frame.appendChild(iframe);
    tile.appendChild(frame);

    const writing = document.createElement("span");
    writing.className = "board-tile-writing";
    writing.hidden = screen !== writingName;
    writing.append(icon("edit", "icon-xs"), "Writing");
    tile.appendChild(writing);

    applyTileRole(tile, screen);
    iframesByScreen.set(screen, iframe);
    return tile;
  }

  function handleSurfaceScroll() {
    if (!isHidden()) pan = { left: surfaceEl.scrollLeft, top: surfaceEl.scrollTop };
  }

  function handleSurfaceClick(evt) {
    if (evt.target === surfaceEl || evt.target === tilesEl) setHighlight(null);
  }

  /** @returns {() => void} teardown for every listener/observer/timer mount() sets up. */
  function mount() {
    surfaceEl.addEventListener("click", handleSurfaceClick);
    const unmountInput = canvasInput.mount();
    surfaceEl.addEventListener("scroll", handleSurfaceScroll, { passive: true });
    // A resized #board-surface (window resize, side-panel collapse) also
    // goes through scheduleRelayout — see its own comment; recomputing the
    // column count on every intermediate resize-observer tick (there can be
    // dozens during a drag-resize or a side-panel collapse animation) would
    // be wasted, possibly janky work.
    resizeObserver = new ResizeObserver(() => {
      if (isHidden()) hiddenSeen = true; // shrunk to nothing because the view went away: nothing to lay out
      else scheduleRelayout();
    });
    resizeObserver.observe(surfaceEl);
    return () => {
      surfaceEl.removeEventListener("click", handleSurfaceClick);
      unmountInput();
      surfaceEl.removeEventListener("scroll", handleSurfaceScroll);
      clearTimeout(relayoutTimer);
      resizeObserver?.disconnect();
    };
  }

  /**
   * Rebuilds tiles from scratch — called on first activation and whenever
   * the VISIBLE screen set changes, since app.js already treats a filter or
   * pinned-set change exactly like a screen-list change (CHR-623 review,
   * AC8): `nextScreens` is board.js's `computeBoardVisibility().visibleNames`
   * — filter matches ∪ pinned, not necessarily every screen in the project.
   *
   * An empty `nextScreens` is app.js's project-switch reset (resetProjectState
   * calls `setScreens([], [])` before loading the new project's own screens)
   * — the one point where clearing `measuredSizes` is both safe and
   * necessary (CHR-623 review finding 4): safe, because there's nothing
   * left on the board to need its old size; necessary, because two
   * projects can share a screen NAME (`home`, `login`, ...), and without
   * this the new project's `home` would inherit the old project's `home`'s
   * measured size for its very first (pre-iframe-load) relayout — wrong
   * unless they happen to be the same size by coincidence. An ordinary
   * same-project `setScreens` call (adding/removing/reordering screens)
   * must NOT clear it — that would throw away sizes for screens that are
   * still on the board and haven't reloaded, forcing every tile back to
   * FALLBACK_SIZE until each one's iframe fires `load` again.
   * @param {string[]} nextScreens
   * @param {{ from: string, event: string, to: string, to_kind: string }[]} nextFlows
   * @param {string} project the project the calling tab is displaying
   *   (`activeProjectRoot` in app.js) — CHR-651, same convention as api.js's
   *   other calls; every tile's own render fetch below must stay scoped to
   *   it, not the daemon-wide active project.
   * @param {{ pinned?: Iterable<string>, outsideFilter?: Iterable<string>, filter?: string,
   *   screens?: { name: string, variant_of?: string, variant_kind?: string }[], expanded?: string[], clusters?: boolean }} [pinInfo]
   *   CHR-733: `screens` (every screen of the project, with its variant
   *   fields), `expanded` (the shared expanded names) and `clusters` (the
   *   "Clusters" toggle) turn `nextScreens` — the visible set — into the
   *   cluster board; all default to the flat board.
   *   All default to empty/"" — a caller with no filter/pins concept at all
   *   (there is none left in app.js, but tests may still omit it) gets tiles
   *   with no pin button state distinct from "unpinned, matching". `filter`
   *   is used only for the empty-state message's own copy (CHR-624, the
   *   `board-view-empty` design) when `nextScreens` is empty.
   */
  async function setScreens(nextScreens, nextFlows, project, pinInfo = {}) {
    if (nextScreens.length === 0) {
      for (const key of Object.keys(measuredSizes)) delete measuredSizes[key];
    }
    screens = nextScreens;
    flows = nextFlows;
    currentProject = project;
    allScreens = pinInfo.screens ?? nextScreens.map((name) => ({ name, tags: [] }));
    expandedNames = pinInfo.expanded ?? [];
    clustersOn = pinInfo.clusters ?? false;
    if (pinInfo.viewports) viewports = pinInfo.viewports;
    model = buildBoardModel(allScreens, screens, expandedNames, { clusters: clustersOn });
    pinnedScreens = new Set(pinInfo.pinned ?? []);
    outsideFilterScreens = new Set(pinInfo.outsideFilter ?? []);
    const isEmpty = screens.length === 0;
    if (emptyStateEl) emptyStateEl.hidden = !isEmpty;
    if (emptyStateBodyEl && isEmpty) {
      const filter = pinInfo.filter ?? "";
      emptyStateBodyEl.textContent = filter
        ? `No screen matches \u201c${filter}\u201d and nothing is pinned.\nClear the filter, or pin a screen from the list.`
        : "This project has no screens yet.";
    }
    for (const cleanup of modeCleanupByScreen.values()) cleanup();
    modeCleanupByScreen.clear();
    iframesByScreen.clear();
    tilesEl.innerHTML = "";
    tilesEl.appendChild(framesEl);
    for (const screen of model.tileNames) tilesEl.appendChild(buildTile(screen));
    relayout();
    await Promise.all(model.tileNames.map((screen) => loadTileRender(screen, project)));
  }

  async function loadTileRender(screen, project) {
    const iframe = iframesByScreen.get(screen);
    if (!iframe) return;
    const result = await fetchRender(screen, project);
    // The screen list may have changed again by the time this resolves
    // (setScreens re-entered) — iframesByScreen was cleared/rebuilt in
    // that case, so this iframe is stale; skip assigning to it.
    if (iframesByScreen.get(screen) !== iframe) return;
    iframe.srcdoc = result.ok
      ? result.html
      : `<p style="font-family: system-ui, sans-serif; color: #900; padding: 16px;">${result.message}</p>`;
  }

  /**
   * CHR-733 — the shared `expanded` names or the "Clusters" toggle changed
   * (the visible set did not): rebuilds the model and re-lays out, KEEPING
   * every tile that stays on the board (no iframe reload) and only creating
   * the ones a newly expanded cluster shows / dropping the ones a collapsed
   * one hides.
   * @param {{ expanded?: string[], clusters?: boolean }} next
   */
  async function setClusterState(next) {
    if (next.expanded !== undefined) expandedNames = next.expanded;
    if (next.clusters !== undefined) clustersOn = next.clusters;
    model = buildBoardModel(allScreens, screens, expandedNames, { clusters: clustersOn });
    const wanted = new Set(model.tileNames);
    for (const screen of [...iframesByScreen.keys()]) {
      if (wanted.has(screen)) continue;
      modeCleanupByScreen.get(screen)?.();
      modeCleanupByScreen.delete(screen);
      iframesByScreen.delete(screen);
      tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(screen)}"]`)?.remove();
    }
    const added = model.tileNames.filter((screen) => !iframesByScreen.has(screen));
    for (const screen of added) tilesEl.appendChild(buildTile(screen));
    // A kept tile may have changed its part in the cluster (a member now, the main screen now ringed): its chrome follows, its iframe stays.
    for (const screen of model.tileNames) {
      const el = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(screen)}"]`);
      if (el) applyTileRole(el, screen);
    }
    relayout();
    await Promise.all(added.map((screen) => loadTileRender(screen, currentProject)));
  }

  /**
   * Re-renders a single screen's tile (e.g. on an SSE "screen" change)
   * without rebuilding the whole grid.
   * @param {string} screen
   * @param {string} project see setScreens's own note — required here too.
   */
  async function refreshScreen(screen, project) {
    const iframe = iframesByScreen.get(screen);
    if (!iframe) return;
    const result = await fetchRender(screen, project);
    if (iframesByScreen.get(screen) !== iframe) return;
    iframe.srcdoc = result.ok ? result.html : iframe.srcdoc;
  }

  function setFlows(nextFlows) {
    flows = nextFlows;
    drawEdges();
  }

  function setFlowMode(enabled) {
    flowModeOn = enabled;
    setHighlight(null);
    for (const [screen, iframe] of iframesByScreen) applyTileMode(iframe, screen);
  }

  return {
    mount,
    setScreens,
    setClusterState,
    refreshScreen,
    setFlows,
    setFlowMode,
    setZoom,
    fitAll,
    zoomToTile,
    commentGeometry,
    setEdgesVisible,
    setWritingScreen,
    setViewports,
    // CHR-623 review finding 7: switching TO an already-built board tab
    // must relayout immediately, not through scheduleRelayout's coalescing
    // delay — #board-view is `hidden` (clientWidth 0) while another tab
    // shows, so any relayout that happened while hidden used a
    // zero-viewport `computeBoardColumns`, and the wrong (DEFAULT_COLUMNS)
    // grid would otherwise persist for RELAYOUT_COALESCE_MS+ after
    // switching back. app.js's setView calls this directly.
    relayout,
  };
}
