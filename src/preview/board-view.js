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
import { computeBoardLayout, findTile, elementSideAnchor, tileAnchor, edgeSides, bezierPath, computeCenterScroll, edgesFromNode, screenIdFromRef } from "./board.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export function createBoardView({ surfaceEl, tilesEl, edgesEl }) {
  /** @type {string[]} */
  let screens = [];
  /** @type {{ from: string, event: string, to: string, to_kind: string }[]} */
  let flows = [];
  /** @type {Record<string, { width: number, height: number }>} */
  const measuredSizes = {};
  /** @type {{ tiles: ReturnType<typeof computeBoardLayout>["tiles"], contentWidth: number, contentHeight: number }} */
  let layout = { tiles: [], contentWidth: 0, contentHeight: 0 };
  /** @type {Map<string, HTMLIFrameElement>} */
  const iframesByScreen = new Map();
  /** @type {Map<string, () => void>} */
  const modeCleanupByScreen = new Map();
  let flowModeOn = false;
  /** @type {{ from: string } | null} */
  let highlightedSource = null;
  let resizeObserver;

  function screenIdToNodeId(el) {
    return el.getAttribute("id");
  }

  function centerOnScreen(screenId) {
    const tile = findTile(layout.tiles, screenId);
    if (!tile) return;
    const { left, top } = computeCenterScroll(tile, surfaceEl.clientWidth, surfaceEl.clientHeight, layout.contentWidth, layout.contentHeight);
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

  function relayout() {
    layout = computeBoardLayout(screens, measuredSizes);
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

  /** @returns {() => void} teardown for resize observers etc. */
  function mount() {
    surfaceEl.addEventListener("click", (evt) => {
      if (evt.target === surfaceEl || evt.target === tilesEl) setHighlight(null);
    });
    resizeObserver = new ResizeObserver(() => drawEdges());
    resizeObserver.observe(surfaceEl);
    return () => resizeObserver?.disconnect();
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

  return { mount, setScreens, refreshScreen, setFlows, setFlowMode };
}
