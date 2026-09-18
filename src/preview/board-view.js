// Board view: every screen as a tile on one scrollable surface, with flow
// edges drawn as SVG curves between them. All DOM/measurement work lives
// here — the actual layout/edge/scroll math is in board.js.
//
// Comment mode is not supported on the board — the board's per-tile iframes
// don't carry comment listeners at all, so toggling comment mode has no
// effect while the board is showing (app.js falls back to "none" when
// switching views away from a mode the new view doesn't support, except it
// keeps flow mode since the board does support that).

import { fetchRender } from "./api.js";
import { applyFlowMode } from "./flows.js";
import {
  computeBoardLayout,
  findTile,
  elementSideAnchor,
  tileAnchor,
  edgeSides,
  bezierPath,
  computeCenterScroll,
  edgesFromNode,
  screenIdFromRef,
  clampZoom,
  computeFitAllZoom,
  computeBoardColumns,
  computeZoomAroundCursor,
  labelDisplayMode,
  BASE_GAP,
  BASE_PADDING,
  DEFAULT_BOARD_ZOOM,
} from "./board.js";

const SVG_NS = "http://www.w3.org/2000/svg";
// The base layout (tile positions, gaps, padding) is always computed at
// native (unscaled) tile size, with the board's own 100%-zoom reference
// gap/padding. Board zoom (5%-200%) is then a single CSS `transform:
// scale()` applied to #board-canvas-inner on top of that fixed layout (see
// applyZoomSizing) — never a re-layout — which is what makes zoom-around-
// cursor exact (computeZoomAroundCursor) instead of an approximation.
// `columns` is NOT fixed here (CHR-623 review) — it's chosen dynamically by
// computeBoardColumns, see relayout()/GRID_OPTIONS.
const GRID_OPTIONS = { gapX: BASE_GAP, gapY: BASE_GAP, padding: BASE_PADDING };
// Wheel-delta-to-zoom-percent sensitivity for Ctrl/Cmd+wheel and trackpad
// pinch (both arrive as `wheel` events with ctrlKey/metaKey set) — chosen
// so a typical trackpad pinch or a few notches of a physical wheel move the
// slider a comfortable amount without either crawling or overshooting.
const WHEEL_ZOOM_SENSITIVITY = 0.5;
// A resized #board-surface (window resize, side-panel collapse) debounces
// into a relayout — recomputing the column count on every intermediate
// resize tick would be wasted work at best and janky at worst. Screen-list/
// project-switch relayouts (setScreens) run immediately, not debounced.
const RESIZE_RELAYOUT_DEBOUNCE_MS = 150;

/**
 * @param {{
 *   surfaceEl: HTMLElement, canvasEl: HTMLElement, canvasInnerEl: HTMLElement,
 *   tilesEl: HTMLElement, edgesEl: SVGElement,
 *   onZoomChange?: (zoomPercent: number, source: "manual" | "fitall") => void,
 * }} args `onZoomChange` fires whenever zoom changes for ANY reason —
 *   quick-jump/step buttons, Fit all, the range input, or Ctrl/Cmd+wheel/
 *   pinch on the canvas — so app.js can keep the toolbar's range input,
 *   readout and quick-jump active states in sync regardless of the source.
 */
export function createBoardView({ surfaceEl, canvasEl, canvasInnerEl, tilesEl, edgesEl, onZoomChange }) {
  /** @type {string[]} */
  let screens = [];
  /** @type {{ from: string, event: string, to: string, to_kind: string }[]} */
  let flows = [];
  /** @type {Record<string, { width: number, height: number }>} */
  const measuredSizes = {};
  /** @type {{ tiles: ReturnType<typeof computeBoardLayout>["tiles"], contentWidth: number, contentHeight: number }} */
  let layout = { tiles: [], contentWidth: 0, contentHeight: 0 };
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
  /** @type {{ from: string } | null} */
  let highlightedSource = null;
  let resizeObserver;
  let zoom = DEFAULT_BOARD_ZOOM;
  let edgesVisible = true;

  function screenIdToNodeId(el) {
    return el.getAttribute("id");
  }

  function centerOnScreen(screenId) {
    const tile = findTile(layout.tiles, screenId);
    if (!tile) return;
    const scale = zoom / 100;
    const scaledTile = { x: tile.x * scale, y: tile.y * scale, width: tile.width * scale, height: tile.height * scale };
    const { left, top } = computeCenterScroll(
      scaledTile,
      surfaceEl.clientWidth,
      surfaceEl.clientHeight,
      layout.contentWidth * scale,
      layout.contentHeight * scale,
    );
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
    modeCleanupByScreen.set(screenId, () => {
      flowCleanup();
      clickCleanup();
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
    canvasEl.style.width = `${layout.contentWidth * scale}px`;
    canvasEl.style.height = `${layout.contentHeight * scale}px`;
  }

  /** Sets each tile label's zoom-dependent display mode (board.js's labelDisplayMode) — hidden/truncated/full, per the chr-621 tag notes. */
  function applyLabelModes() {
    const mode = labelDisplayMode(zoom);
    for (const tile of layout.tiles) {
      const el = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(tile.screen)}"]`);
      const label = el?.querySelector(".board-tile-label");
      if (!label) continue;
      label.dataset.mode = mode;
      label.style.maxWidth = mode === "truncated" ? `${tile.width}px` : "";
    }
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
    currentColumns = computeBoardColumns(screens, measuredSizes, surfaceEl.clientWidth, surfaceEl.clientHeight, GRID_OPTIONS);
    layout = computeBoardLayout(screens, measuredSizes, { ...GRID_OPTIONS, scale: 1, columns: currentColumns });
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
    applyZoomSizing();
    applyLabelModes();
    drawEdges();
  }

  /**
   * Sets board zoom, clamped to [10, 200]. `cursor`, when given (Ctrl/Cmd+
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
      const { left, top } = computeZoomAroundCursor({
        cursorX: cursor.clientX - rect.left,
        cursorY: cursor.clientY - rect.top,
        scrollLeft: surfaceEl.scrollLeft,
        scrollTop: surfaceEl.scrollTop,
        oldZoomPercent: zoom,
        newZoomPercent: clamped,
        contentWidth: layout.contentWidth,
        contentHeight: layout.contentHeight,
        viewportWidth: surfaceEl.clientWidth,
        viewportHeight: surfaceEl.clientHeight,
      });
      zoom = clamped;
      applyZoomSizing();
      applyLabelModes();
      surfaceEl.scrollLeft = left;
      surfaceEl.scrollTop = top;
    } else {
      zoom = clamped;
      applyZoomSizing();
      applyLabelModes();
    }
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
    setZoom(
      computeFitAllZoom(screens, measuredSizes, surfaceEl.clientWidth, surfaceEl.clientHeight, { ...GRID_OPTIONS, columns: currentColumns }),
      { source: "fitall" },
    );
  }

  function setEdgesVisible(visible) {
    edgesVisible = visible;
    drawEdges();
  }

  function edgeEndpoints(flow) {
    const fromScreen = screenIdFromRef(flow.from);
    const fromTile = findTile(layout.tiles, fromScreen);
    const toScreen = screenIdFromRef(flow.to);
    const toTile = findTile(layout.tiles, toScreen);
    if (!fromTile || !toTile) return null;

    const sides = edgeSides(fromTile, toTile);
    const dot = flow.from.indexOf(".");
    const nodeId = dot === -1 ? null : flow.from.slice(dot + 1);
    const iframe = iframesByScreen.get(fromScreen);
    const elementRect = nodeId && iframe?.contentDocument ? iframe.contentDocument.getElementById(nodeId)?.getBoundingClientRect() : null;
    const from = elementRect ? elementSideAnchor(fromTile, elementRect, sides.from) : tileAnchor(fromTile, sides.from);
    const to = tileAnchor(toTile, sides.to);
    return { from, to, sides };
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
    }
  }

  function buildTile(screen) {
    const tile = document.createElement("div");
    tile.className = "board-tile";
    tile.dataset.screen = screen;

    const label = document.createElement("div");
    label.className = "board-tile-label";
    label.textContent = screen;
    tile.appendChild(label);

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
      measuredSizes[screen] = readNaturalSize(iframe);
      applyTileMode(iframe, screen);
      relayout();
    });
    frame.appendChild(iframe);
    tile.appendChild(frame);
    iframesByScreen.set(screen, iframe);
    return tile;
  }

  /**
   * Ctrl/Cmd+scroll-wheel and trackpad pinch (Chrome/Firefox synthesize
   * pinch as a `wheel` event with `ctrlKey: true`) zoom around the cursor —
   * a plain wheel/two-finger scroll (neither modifier) is left alone so
   * #board-surface's native scroll still pans the canvas.
   */
  function handleWheel(evt) {
    if (!evt.ctrlKey && !evt.metaKey) return;
    evt.preventDefault();
    setZoom(zoom - evt.deltaY * WHEEL_ZOOM_SENSITIVITY, { cursor: { clientX: evt.clientX, clientY: evt.clientY } });
  }

  /** @returns {() => void} teardown for resize observers etc. */
  function mount() {
    surfaceEl.addEventListener("click", (evt) => {
      if (evt.target === surfaceEl || evt.target === tilesEl) setHighlight(null);
    });
    // Not passive: handleWheel calls preventDefault() to stop the browser's
    // own page-zoom/native-scroll response to a Ctrl/Cmd+wheel or pinch.
    surfaceEl.addEventListener("wheel", handleWheel, { passive: false });
    // Debounced (RESIZE_RELAYOUT_DEBOUNCE_MS): a resized viewport can change
    // the best column count (computeBoardColumns), which relayout() decides
    // — recomputing it on every intermediate resize-observer tick (there
    // can be dozens during a drag-resize or a side-panel collapse
    // animation) would be wasted, possibly janky work.
    let resizeTimer;
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayout, RESIZE_RELAYOUT_DEBOUNCE_MS);
    });
    resizeObserver.observe(surfaceEl);
    return () => {
      clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
    };
  }

  /**
   * Rebuilds tiles from scratch — called on first activation and whenever
   * the screen list changes, since new/removed screens change the grid.
   * @param {string[]} nextScreens
   * @param {{ from: string, event: string, to: string, to_kind: string }[]} nextFlows
   */
  async function setScreens(nextScreens, nextFlows) {
    screens = nextScreens;
    flows = nextFlows;
    for (const cleanup of modeCleanupByScreen.values()) cleanup();
    modeCleanupByScreen.clear();
    iframesByScreen.clear();
    tilesEl.innerHTML = "";
    for (const screen of screens) tilesEl.appendChild(buildTile(screen));
    relayout();
    await Promise.all(
      screens.map(async (screen) => {
        const iframe = iframesByScreen.get(screen);
        if (!iframe) return;
        const result = await fetchRender(screen);
        // The screen list may have changed again by the time this resolves
        // (setScreens re-entered) — iframesByScreen was cleared/rebuilt in
        // that case, so this iframe is stale; skip assigning to it.
        if (iframesByScreen.get(screen) !== iframe) return;
        iframe.srcdoc = result.ok
          ? result.html
          : `<p style="font-family: system-ui, sans-serif; color: #900; padding: 16px;">${result.message}</p>`;
      }),
    );
  }

  /** Re-renders a single screen's tile (e.g. on an SSE "screen" change) without rebuilding the whole grid. */
  async function refreshScreen(screen) {
    const iframe = iframesByScreen.get(screen);
    if (!iframe) return;
    const result = await fetchRender(screen);
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

  return { mount, setScreens, refreshScreen, setFlows, setFlowMode, setZoom, fitAll, setEdgesVisible };
}
