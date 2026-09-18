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
import { PIN_ICON_SVG } from "./screens.js";
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
  computeWheelZoomFactor,
  labelDisplayMode,
  LOW_ZOOM_AFFORDANCE_THRESHOLD,
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
// A batch of near-simultaneous iframe `load` events (e.g. ~186 screens all
// finishing at once) coalesces into a single relayout — see
// scheduleRelayout's own comment.
const RELAYOUT_COALESCE_MS = 50;
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
 *   `onTogglePin` (CHR-624) fires when a tile's pin button is clicked —
 *   app.js owns the actual pin/unpin write (setBoardState) and the
 *   resulting SSE broadcast is what actually changes what's pinned; this
 *   view never mutates its own pinned/outsideFilter sets outside setScreens.
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
  onTogglePin,
}) {
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
  // CHR-624 — which of the CURRENT `screens` are pinned, and which of
  // those are pinned but don't match the shared filter (the `outside-filter`
  // tile treatment). Set only by setScreens, same as `screens`/`flows`
  // themselves — the visible set, pin state and outside-filter
  // classification are always rebuilt together (see setScreens's own
  // comment), never patched independently.
  let pinnedScreens = new Set();
  let outsideFilterScreens = new Set();
  let edgesVisible = true;
  // CHR-623 review findings 3/5: a single coalescing timer shared by every
  // relayout TRIGGER that isn't already synchronous/immediate (an iframe
  // `load`, a surface resize) — see scheduleRelayout. `lastWheelAt` is read
  // by it to defer a coalesced relayout while a zoom gesture is in
  // progress; `handleWheel` and `handleClick`/`handleWheel` themselves are
  // named (not inline) so mount()'s teardown can actually remove them.
  let relayoutTimer = null;
  let lastWheelAt = 0;

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

  /**
   * Two zoom-dependent tile chrome rules from the chr-621 tag notes, both
   * driven by the same LOW_ZOOM_AFFORDANCE_THRESHOLD: the label's display
   * mode (hidden/truncated/full — board.js's labelDisplayMode), and the
   * UNPINNED pin button's visibility (CHR-624) — below the threshold it's
   * hover-revealed instead of always shown (a static/headless check can't
   * express hover, so it's simply absent below the threshold here); a
   * PINNED tile's button always stays visible at any zoom, since it carries
   * information ("this is here because it's pinned") a hover can't replace.
   */
  function applyZoomDependentTileChrome() {
    const mode = labelDisplayMode(zoom);
    const showUnpinnedAffordance = zoom >= LOW_ZOOM_AFFORDANCE_THRESHOLD;
    for (const tile of layout.tiles) {
      const el = tilesEl.querySelector(`.board-tile[data-screen="${CSS.escape(tile.screen)}"]`);
      if (!el) continue;
      const label = el.querySelector(".board-tile-label");
      if (label) {
        label.dataset.mode = mode;
        label.style.maxWidth = mode === "truncated" ? `${tile.width}px` : "";
      }
      const pin = el.querySelector(".board-tile-pin");
      if (pin) pin.hidden = !pinnedScreens.has(tile.screen) && !showUnpinnedAffordance;
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
    applyZoomDependentTileChrome();
    drawEdges();
    onRelayout?.();
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
      applyZoomDependentTileChrome();
      surfaceEl.scrollLeft = left;
      surfaceEl.scrollTop = top;
    } else {
      zoom = clamped;
      applyZoomSizing();
      applyZoomDependentTileChrome();
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
    const isPinned = pinnedScreens.has(screen);
    // The dashed-border/badge `outside-filter` treatment (CHR-624) — a tile
    // that's on the board SOLELY because it's pinned, not because it also
    // matches the shared filter. Purely visual: `.board-tile`'s own
    // overflow isn't clipped (unlike `.board-tile-frame`), so the label
    // above and the badge/pin below/beside it can sit outside the tile's
    // own box without affecting computeBoardLayout's geometry at all.
    tile.classList.toggle("outside-filter", outsideFilterScreens.has(screen));

    const label = document.createElement("div");
    label.className = "board-tile-label";
    label.textContent = screen;
    tile.appendChild(label);

    if (outsideFilterScreens.has(screen)) {
      const badge = document.createElement("span");
      badge.className = "board-tile-badge";
      badge.textContent = "pinned · outside filter";
      tile.appendChild(badge);
    }

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
      scheduleRelayout();
    });
    frame.appendChild(iframe);
    tile.appendChild(frame);

    // A <button>, not the design's plain <span> — this one is clickable, so
    // it needs the native focus/keyboard-activation/role a real button
    // gives for free. Visibility (hidden below LOW_ZOOM_AFFORDANCE_THRESHOLD
    // when unpinned) is applied right after by applyZoomDependentTileChrome
    // (called from relayout(), right after setScreens rebuilds every tile).
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "board-tile-pin pin-button";
    pin.classList.toggle("pinned", isPinned);
    pin.setAttribute("aria-label", isPinned ? `Unpin ${screen}` : `Pin ${screen}`);
    pin.setAttribute("aria-pressed", String(isPinned));
    pin.innerHTML = PIN_ICON_SVG;
    pin.addEventListener("click", (evt) => {
      // Tiles have their own click handling for flow-source highlighting
      // (see attachTileClicks, wired inside the iframe's own document —
      // unaffected by this) and centerOnScreen navigation; this button
      // isn't inside the iframe, but stopPropagation keeps it from also
      // reaching #board-surface's own click listener (setHighlight(null)).
      evt.stopPropagation();
      onTogglePin?.(screen);
    });
    tile.appendChild(pin);

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
    lastWheelAt = performance.now();
    const factor = computeWheelZoomFactor(evt.deltaY, evt.deltaMode, surfaceEl.clientHeight);
    setZoom(zoom * factor, { cursor: { clientX: evt.clientX, clientY: evt.clientY } });
  }

  function handleSurfaceClick(evt) {
    if (evt.target === surfaceEl || evt.target === tilesEl) setHighlight(null);
  }

  /** @returns {() => void} teardown for every listener/observer/timer mount() sets up. */
  function mount() {
    surfaceEl.addEventListener("click", handleSurfaceClick);
    // Not passive: handleWheel calls preventDefault() to stop the browser's
    // own page-zoom/native-scroll response to a Ctrl/Cmd+wheel or pinch.
    surfaceEl.addEventListener("wheel", handleWheel, { passive: false });
    // A resized #board-surface (window resize, side-panel collapse) also
    // goes through scheduleRelayout — see its own comment; recomputing the
    // column count on every intermediate resize-observer tick (there can be
    // dozens during a drag-resize or a side-panel collapse animation) would
    // be wasted, possibly janky work.
    resizeObserver = new ResizeObserver(() => scheduleRelayout());
    resizeObserver.observe(surfaceEl);
    return () => {
      surfaceEl.removeEventListener("click", handleSurfaceClick);
      surfaceEl.removeEventListener("wheel", handleWheel);
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
   * @param {{ pinned?: Iterable<string>, outsideFilter?: Iterable<string>, filter?: string }} [pinInfo]
   *   All default to empty/"" — a caller with no filter/pins concept at all
   *   (there is none left in app.js, but tests may still omit it) gets tiles
   *   with no pin button state distinct from "unpinned, matching". `filter`
   *   is used only for the empty-state message's own copy (CHR-624, the
   *   `board-view-empty` design) when `nextScreens` is empty.
   */
  async function setScreens(nextScreens, nextFlows, pinInfo = {}) {
    if (nextScreens.length === 0) {
      for (const key of Object.keys(measuredSizes)) delete measuredSizes[key];
    }
    screens = nextScreens;
    flows = nextFlows;
    pinnedScreens = new Set(pinInfo.pinned ?? []);
    outsideFilterScreens = new Set(pinInfo.outsideFilter ?? []);
    const isEmpty = screens.length === 0;
    if (emptyStateEl) emptyStateEl.hidden = !isEmpty;
    if (emptyStateBodyEl && isEmpty) {
      const filter = pinInfo.filter ?? "";
      emptyStateBodyEl.textContent = filter
        ? `"${filter}" matches nothing, and nothing is pinned. Clear the filter or pin a screen from the sidebar to bring it onto the board.`
        : "This project has no screens yet.";
    }
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

  return {
    mount,
    setScreens,
    refreshScreen,
    setFlows,
    setFlowMode,
    setZoom,
    fitAll,
    setEdgesVisible,
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
