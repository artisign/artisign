// CHR-1264 — comment pins on the Board: the open threads of every screen tile
// as pins at their nodes, a count chip per tile, a group pin where pins
// overlap, a detached pin, and — below 15 % board zoom — one count dot per
// tile. A click (never a hover) on a pin or a chip opens the thread in the
// comment canvas's popover (CHR-1295: reply, resolve, reopen, "Open in
// Screens"); a click on a dot opens the screen's thread list.
//
// Everything is an overlay in the PARENT document (#board-comment-layer, in
// #board-canvas's scrolled coordinates, next to the zoomed #board-canvas-inner).
// No listener or element goes into a tile iframe: node positions are measured
// with contentDocument.getElementById, exactly like the flow edges. The pin,
// message and chip looks are the canvas's (comment-canvas.js, style.css).
//
// The module fetches nothing: app.js hands it the one GET /api/comments?scope=screens
// answer and the actions.

import { icon } from "./icons.js";
import { authorLabel, bareId, numberThreads, pinnedThreads, placePopover, relativeTime, threadKind } from "./comment-canvas.js";
import { OVERVIEW_ZOOM_BELOW } from "./board.js";

const PIN_SIZE = 24;
/** Pins on one element stack leftwards by this much; pins closer than it in both axes merge into a group. */
const STACK_STEP = PIN_SIZE - 4;
const DETACHED_STEP = 30;
const DOT_INSET = 6;
/** Gap between a label's text and its count chips, and the label row's height when the label itself is not drawn, in px. */
const CHIP_GAP = 8;
const LABEL_ROW = 18;
/** How far past its tile's right edge a label may reach, in board px: half the gap to the next tile (board.js BASE_GAP). */
const NEIGHBOR_ROOM = 40;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in board-comments.test.js)
// ---------------------------------------------------------------------------

/**
 * Merges pins that would overlap at the current zoom: a pin joins the first
 * group whose first pin is closer than STACK_STEP in both axes (pins stacked
 * on one element sit exactly STACK_STEP apart and stay separate).
 * @template {{ x: number, y: number }} P
 * @param {P[]} pins in draw order
 * @returns {P[][]}
 */
export function groupPins(pins) {
  /** @type {P[][]} */
  const groups = [];
  for (const pin of pins) {
    const home = groups.find((g) => Math.abs(g[0].x - pin.x) < STACK_STEP && Math.abs(g[0].y - pin.y) < STACK_STEP);
    if (home) home.push(pin);
    else groups.push([pin]);
  }
  return groups;
}

/**
 * The counts of one screen's threads. `open` leaves out detached ones (the
 * chips show them apart); `openTotal` is what the status line counts.
 * @param {{ status: "open" | "resolved", detached: boolean }[]} threads
 * @returns {{ open: number, detached: number, resolved: number, openTotal: number }}
 */
export function screenCounts(threads) {
  const count = (kind) => threads.filter((t) => threadKind(t) === kind).length;
  const open = count("open");
  const detached = count("detached");
  return { open, detached, resolved: count("resolved"), openTotal: open + detached };
}

/** @param {number} n the dot's number, capped like the design's "99+" */
export function dotText(n) {
  return n > 99 ? "99+" : String(n);
}

/** @param {number} n @param {string} noun */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, screen: string, node_id: string | null, author: "human" | "agent", agent?: string, status: "open" | "resolved", detached: boolean, reply_count: number }} BoardThread
 * @typedef {{ id: string, screen?: string, node_id: string | null, text: string, author: "human" | "agent", agent?: string, parent_id: string | null, resolved: boolean, ts: string }} BoardRecord
 * @typedef {{ type: "list", screen: string }} Active the thread list a count dot opens
 */

/**
 * @param {{
 *   layerEl: HTMLElement,
 *   surfaceEl: HTMLElement,
 *   geometry: () => ReturnType<ReturnType<typeof import("./board-view.js").createBoardView>["commentGeometry"]>,
 *   onOpenInScreens: (screen: string, threadId: string | null) => void,
 *   onOpenThread: (threadId: string) => void,
 *   onZoomToTile: (screen: string) => void,
 *   enabled?: boolean,
 *   showResolved?: boolean,
 * }} opts
 */
export function createBoardComments({ layerEl, surfaceEl, geometry, onOpenInScreens, onOpenThread, onZoomToTile, enabled: initialEnabled = true, showResolved: initialShowResolved = false }) {
  let enabled = initialEnabled;
  let showResolved = initialShowResolved;
  /** @type {BoardThread[]} */
  let threads = [];
  /** @type {BoardRecord[]} */
  let comments = [];
  /** @type {Active | null} */
  let active = null;
  /** The thread whose popover the comment canvas has open: its marker shows as active. @type {string | null} */
  let activeThreadId = null;
  /** The element the open list came from, so Esc can give the focus back. @type {HTMLElement | null} */
  let trigger = null;
  /** Its marker key: layout() rebuilds the markers, so the element is looked up again by it. @type {string | null} */
  let triggerKey = null;
  /** The chip rows of the last layout(), placed once every marker is in the layer (measuring needs them there). @type {{ screen: string, row: HTMLElement, tileBox: { left: number, top: number } }[]} */
  let chipRows = [];
  /** Marker key → the element drawn for it by the last layout(). @type {Map<string, HTMLElement>} */
  let markers = new Map();
  /** Thread id → the key of the marker that stands for it (its pin, else its group, dot or chip). @type {Map<string, string>} */
  let anchors = new Map();

  const previewEl = document.createElement("div");
  previewEl.className = "board-comment-preview";
  previewEl.id = "board-comment-preview";
  previewEl.setAttribute("role", "dialog");
  previewEl.tabIndex = -1;
  previewEl.hidden = true;
  const markersEl = document.createElement("div");
  markersEl.className = "board-comment-markers";
  layerEl.replaceChildren(markersEl, previewEl);
  layerEl.hidden = !enabled;

  // ------------------------------------------------------------------ data

  const threadsOf = (screen) => threads.filter((t) => t.screen === screen);
  const thread = (id) => threads.find((t) => t.id === id) ?? null;
  const key = {
    pin: (id) => `pin:${id}`,
    group: (screen, i) => `group:${screen}:${i}`,
    dot: (screen) => `dot:${screen}`,
    chip: (screen, kind) => `chip:${screen}:${kind}`,
  };

  /** The element's box in layer pixels, or null when the tile's document has no such element (yet). */
  function elementBox(g, tile, id) {
    const tileScale = tile.width / tile.naturalWidth;
    const scale = g.zoom / 100;
    const px = (v, origin) => (origin + v * tileScale) * scale;
    if (id === null) return { left: tile.x * scale, top: tile.y * scale, right: (tile.x + tile.width) * scale, bottom: (tile.y + tile.height) * scale };
    const el = g.docOf(tile.screen)?.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: px(r.left, tile.x), top: px(r.top, tile.y), right: px(r.right, tile.x), bottom: px(r.bottom, tile.y) };
  }

  // ------------------------------------------------------------------ layout

  /** Rebuilds every marker from the data and the tiles' current geometry. Opening or closing a preview never calls it: it only flips attributes, so a press on a marker is never swallowed by a rebuild. */
  function layout() {
    layerEl.hidden = !enabled;
    if (!enabled) {
      closePreview(false);
      return;
    }
    const focusedKey = markersEl.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.key : undefined;
    const focusInPreview = previewEl.contains(document.activeElement);
    const g = geometry();
    const low = g.zoom < OVERVIEW_ZOOM_BELOW;
    // A list belongs to a dot: the pins' zoom mode has no such marker.
    if (active && !low) closePreview(false);
    markers = new Map();
    anchors = new Map();
    chipRows = [];
    const nodes = [];
    for (const tile of g.tiles) {
      const all = threadsOf(tile.screen);
      if (all.length === 0) continue;
      const shown = pinnedThreads(all, { showResolved });
      const numbers = numberThreads(all);
      const scale = g.zoom / 100;
      const box = { left: tile.x * scale, top: tile.y * scale, right: (tile.x + tile.width) * scale };
      if (low) {
        if (shown.length > 0) nodes.push(buildDot(tile.screen, shown, box));
        continue;
      }
      nodes.push(...buildChips(tile.screen, all, box));
      /** @type {{ t: BoardThread, x: number, y: number }[]} */
      const placed = [];
      let detachedIndex = 0;
      const perElement = new Map();
      for (const t of shown) {
        if (t.detached) {
          // Detached pins stack at the tile's top-left, centred on its corner.
          placed.push({ t, x: box.left, y: box.top + detachedIndex++ * DETACHED_STEP });
          continue;
        }
        const id = bareId(t.node_id);
        const eb = elementBox(g, tile, id);
        if (!eb) continue; // not in the tile's document (yet): the next layout() places it
        const index = perElement.get(id) ?? 0;
        perElement.set(id, index + 1);
        // An element on the tile's top edge would put its pin into the name row above (chips, label): the pin stays inside the tile.
        placed.push({ t, x: eb.right - index * STACK_STEP, y: Math.max(eb.top, box.top + PIN_SIZE / 2) });
      }
      const open = placed.filter((p) => !p.t.detached);
      const groups = groupPins(open);
      let groupIndex = 0;
      for (const p of placed.filter((q) => q.t.detached)) nodes.push(buildPin(p.t, numbers, p.x, p.y));
      for (const members of groups) {
        if (members.length === 1) nodes.push(buildPin(members[0].t, numbers, members[0].x, members[0].y));
        else nodes.push(buildGroup(tile.screen, groupIndex++, members));
      }
    }
    markersEl.replaceChildren(...nodes);
    placeChips(g);
    trigger = triggerKey ? (markers.get(triggerKey) ?? null) : null;
    syncActive();
    if (focusedKey) markers.get(focusedKey)?.focus();
    else if (focusInPreview && active) previewEl.focus();
  }

  /**
   * Puts each chip row in the room its tile's label keeps for it — name, count, chips, then the pin mark — so the chips never cover the pin mark: the row's width is measured and handed to the label, which makes the room, and the row goes where the room starts.
   * @param {ReturnType<typeof geometry>} g
   */
  function placeChips(g) {
    const layerBox = layerEl.getBoundingClientRect();
    for (const { screen, row, tileBox } of chipRows) {
      const width = row.getBoundingClientRect().width;
      g.reserveChips?.(screen, width + CHIP_GAP);
      const at = g.chipsAt?.(screen);
      row.hidden = false;
      if (at) {
        const left = at.left - layerBox.left;
        row.style.left = `${left}px`;
        row.style.top = `${at.top - layerBox.top}px`;
        row.style.height = `${at.height}px`;
        // Chips that would run into the next tile's label (the gap between two tiles is only a few pixels on screen at a small zoom) stay out: the pins still say it, and the label keeps its own room.
        if (left + width > tileBox.right + (NEIGHBOR_ROOM * g.zoom) / 100) {
          row.hidden = true;
          g.reserveChips?.(screen, 0);
        }
      } else {
        row.style.left = `${tileBox.left}px`;
        row.style.top = `${tileBox.top - LABEL_ROW}px`;
        row.style.height = `${LABEL_ROW}px`;
      }
    }
  }

  function register(markerKey, el, threadIds) {
    el.dataset.key = markerKey;
    markers.set(markerKey, el);
    // A thread's own pin wins; else the first marker that stands for it (chip, group, dot).
    for (const id of threadIds) if (!anchors.has(id) || markerKey.startsWith("pin:")) anchors.set(id, markerKey);
    return el;
  }

  /** @param {BoardThread} t @param {Map<string, number>} numbers */
  function buildPin(t, numbers, x, y) {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "comment-pin board-comment-pin";
    pin.dataset.thread = t.id;
    pin.dataset.kind = t.author;
    pin.dataset.state = t.status === "resolved" ? "resolved" : t.detached ? "detached" : "open";
    pin.style.left = `${x - PIN_SIZE / 2}px`;
    pin.style.top = `${y - PIN_SIZE / 2}px`;
    const node = bareId(t.node_id);
    const state = t.status === "resolved" ? "resolved" : t.detached ? "detached" : "open";
    pin.setAttribute("aria-label", t.detached ? `Comment ${numbers.get(t.id)}${t.status === "resolved" ? ", resolved" : ""}, detached: its element is gone` : `Comment ${numbers.get(t.id)} on ${node ?? "screen"}, ${state}`);
    pin.setAttribute("aria-expanded", "false");
    if (t.status === "resolved") pin.append(icon("check"));
    else pin.textContent = String(numbers.get(t.id));
    pin.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closePreview(false);
      onOpenThread(t.id);
    });
    return register(key.pin(t.id), pin, [t.id]);
  }

  /** @param {{ t: BoardThread, x: number, y: number }[]} members */
  function buildGroup(screen, index, members) {
    const first = members[0];
    const group = document.createElement("button");
    group.type = "button";
    group.className = "comment-pin board-comment-pin board-comment-group";
    group.dataset.state = "group";
    group.style.left = `${first.x - PIN_SIZE / 2}px`;
    group.style.top = `${first.y - PIN_SIZE / 2}px`;
    group.textContent = String(members.length);
    group.setAttribute("aria-label", `${members.length} comments overlap here, zoom in to separate them`);
    group.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closePreview(false);
      onZoomToTile(screen);
    });
    return register(key.group(screen, index), group, members.map((m) => m.t.id));
  }

  /** The count chips of one tile: open, detached, and (when Show resolved is off and nothing else is left) the hidden resolved count. They sit in the label row above the tile, in the room the label keeps for them (placeChips; design `board-cluster`). */
  function buildChips(screen, all, tileBox) {
    const counts = screenCounts(all);
    const specs = [
      ["open", counts.open, "chat_bubble", "open comment", ""],
      ["detached", counts.detached, "warning", "detached comment", ""],
      ...(!showResolved && counts.openTotal === 0 ? [["resolved", counts.resolved, "check", "resolved comment", ", hidden"]] : []),
    ].filter((s) => s[1] > 0);
    if (specs.length === 0) return [];
    const row = document.createElement("div");
    row.className = "board-comment-chips";
    chipRows.push({ screen, row, tileBox });
    for (const [kind, count, glyph, noun, suffix] of specs) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "comment-count-chip";
      chip.dataset.kind = kind;
      chip.setAttribute("aria-label", `${plural(count, noun)}${suffix}`);
      chip.setAttribute("aria-expanded", "false");
      chip.append(icon(glyph), String(count));
      chip.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const first = all.find((t) => threadKind(t) === kind);
        if (first) {
          closePreview(false);
          onOpenThread(first.id);
        }
      });
      // The first thread of the chip's kind may have no pin (grouped, or resolved and hidden): the chip is its anchor then.
      const firstOfKind = all.find((t) => threadKind(t) === kind);
      register(key.chip(screen, kind), chip, firstOfKind ? [firstOfKind.id] : []);
      row.append(chip);
    }
    return [row];
  }

  /** The one count dot of a tile below 15 % zoom, inside its top-left corner. */
  function buildDot(screen, shown, tileBox) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "board-comment-dot";
    dot.dataset.state = shown.every((t) => t.detached) ? "detached" : "open";
    dot.style.left = `${tileBox.left + DOT_INSET}px`;
    dot.style.top = `${tileBox.top + DOT_INSET}px`;
    dot.textContent = dotText(shown.length);
    dot.setAttribute("aria-label", `${plural(shown.length, "comment")} on ${screen}, show list`);
    dot.setAttribute("aria-expanded", "false");
    dot.addEventListener("click", (evt) => {
      evt.stopPropagation();
      toggle({ type: "list", screen }, dot);
    });
    register(key.dot(screen), dot, []);
    for (const t of shown) anchors.set(t.id, key.dot(screen));
    return dot;
  }

  // ------------------------------------------------------------------ preview

  /** @param {Active} next @param {HTMLElement} from */
  function toggle(next, from) {
    if (active !== null && active.screen === next.screen) {
      closePreview(true);
      return;
    }
    active = next;
    trigger = from;
    triggerKey = from.dataset.key ?? null;
    syncActive();
    previewEl.focus();
  }

  /** The marker the open list hangs off, or null when layout() no longer draws one. @param {Active} a */
  function anchorOf(a) {
    return markers.get(key.dot(a.screen)) ?? null;
  }

  /** Marks the open markers (aria-expanded, active ring), builds the list and places it. Touches no marker's identity. */
  function syncActive() {
    for (const el of markers.values()) {
      el.setAttribute("aria-expanded", "false");
      delete el.dataset.active;
    }
    const threadKey = activeThreadId ? anchors.get(activeThreadId) : null;
    const threadMarker = threadKey ? markers.get(threadKey) : null;
    if (threadMarker) {
      threadMarker.setAttribute("aria-expanded", "true");
      threadMarker.dataset.active = "true";
    }
    if (!active) {
      previewEl.hidden = true;
      previewEl.replaceChildren();
      return;
    }
    const anchor = anchorOf(active);
    if (!anchor) {
      closePreview(false);
      return;
    }
    for (const el of [anchor, trigger]) {
      if (!el || !layerEl.contains(el)) continue;
      el.setAttribute("aria-expanded", "true");
      el.dataset.active = "true";
    }
    buildListPreview(active.screen);
    previewEl.hidden = false;
    anchor.setAttribute("aria-controls", previewEl.id);
    place(anchor);
  }

  /** Places the preview beside its marker inside the visible part of the surface (layer coordinates = #board-canvas's). */
  function place(anchor) {
    const a = anchor.getBoundingClientRect();
    const o = layerEl.getBoundingClientRect();
    const box = { left: a.left - o.left, top: a.top - o.top, right: a.right - o.left, bottom: a.bottom - o.top };
    const view = { left: surfaceEl.scrollLeft, top: surfaceEl.scrollTop, right: surfaceEl.scrollLeft + surfaceEl.clientWidth, bottom: surfaceEl.scrollTop + surfaceEl.clientHeight };
    const size = { width: previewEl.offsetWidth || 320, height: previewEl.offsetHeight || 200 };
    const spot = placePopover(box, size, view);
    previewEl.style.left = `${spot.left}px`;
    previewEl.style.top = `${spot.top}px`;
    previewEl.dataset.side = spot.side;
  }

  /** @param {string} screen */
  function buildListPreview(screen) {
    const all = threadsOf(screen);
    const shown = pinnedThreads(all, { showResolved });
    const numbers = numberThreads(all);
    previewEl.setAttribute("aria-label", "Comments of this screen, read only");
    previewEl.dataset.mode = "list";

    const head = div("board-comment-preview-head");
    const title = document.createElement("b");
    title.className = "board-comment-preview-title";
    title.textContent = screen;
    const open = document.createElement("span");
    open.className = "board-comment-preview-count";
    open.textContent = `${screenCounts(all).openTotal} open`;
    head.append(title, open, div("comment-popover-spacer"), closeButton());

    const list = document.createElement("div");
    list.className = "board-comment-rows";
    list.setAttribute("role", "list");
    for (const t of shown) list.append(buildRow(t, numbers.get(t.id) ?? 0));
    previewEl.replaceChildren(head, list, foot("Click a thread to open it", screen, null));
  }

  /** @param {BoardThread} t @param {number} number */
  function buildRow(t, number) {
    const last = comments.filter((c) => c.id === t.id || c.parent_id === t.id).at(-1);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "board-comment-row";
    row.setAttribute("role", "listitem");
    const no = document.createElement("span");
    no.className = "board-comment-row-no";
    no.dataset.kind = t.author;
    no.dataset.state = t.status === "resolved" ? "resolved" : t.detached ? "detached" : "open";
    no.setAttribute("aria-hidden", "true");
    no.textContent = String(number);
    const main = div("board-comment-row-main");
    const meta = div("board-comment-row-meta");
    const node = document.createElement("code");
    node.className = "comment-popover-node";
    node.textContent = bareId(t.node_id) ?? "screen";
    if (t.detached) node.classList.add("is-detached");
    meta.append(node);
    if (t.detached) meta.append(badge("Detached", "detached"));
    const time = document.createElement("span");
    time.className = "board-comment-row-time";
    time.textContent = last ? relativeTime(last.ts) : "";
    meta.append(time);
    const text = div("board-comment-row-text");
    text.textContent = last ? `${authorLabel(last)}: ${last.text}` : "";
    main.append(meta, text);
    row.append(no, main);
    row.addEventListener("click", () => {
      closePreview(false);
      onOpenInScreens(t.screen, t.id);
    });
    return row;
  }

  function foot(meta, screen, threadId) {
    const el = div("board-comment-preview-foot");
    const m = document.createElement("span");
    m.className = "board-comment-preview-meta";
    m.textContent = meta;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "chrome-btn chrome-btn--compact";
    open.textContent = "Open in Screens";
    open.addEventListener("click", () => {
      closePreview(false);
      onOpenInScreens(screen, threadId);
    });
    el.append(m, open);
    return el;
  }

  function closeButton() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chrome-icon-btn chrome-icon-btn--sm";
    b.setAttribute("aria-label", "Close (Esc)");
    b.dataset.tooltip = "Close (Esc)";
    b.append(icon("close"));
    b.addEventListener("click", () => closePreview(true));
    return b;
  }

  function badge(text, kind) {
    const b = document.createElement("span");
    b.className = `comment-badge comment-badge--${kind}`;
    b.textContent = text;
    return b;
  }

  function div(className) {
    const el = document.createElement("div");
    el.className = className;
    return el;
  }

  /** @param {boolean} returnFocus */
  function closePreview(returnFocus) {
    const from = trigger;
    active = null;
    trigger = null;
    triggerKey = null;
    syncActive();
    if (returnFocus && from && from.isConnected) from.focus();
  }

  // Esc and an outside press close the preview. A press on a marker is left to the marker itself (it toggles), so no rebuild can swallow it.
  document.addEventListener(
    "keydown",
    (evt) => {
      // Only while the board shows: the capture listener must not swallow Esc in another view.
      if (evt.key !== "Escape" || !active || layerEl.closest("[hidden]")) return;
      // A modal dialog owns Escape (the browser closes it); a preview behind it must not take the key first.
      if (document.querySelector("dialog.float-dialog[open], dialog.uc-dialog[open]")) return;
      evt.preventDefault();
      evt.stopPropagation();
      closePreview(true);
    },
    true,
  );
  // A press inside a tile never reaches this document (no listener goes into a tile iframe): the focus moving into the iframe is how it shows up here.
  window.addEventListener("blur", () => {
    if (active && document.activeElement?.tagName === "IFRAME") closePreview(false);
  });
  document.addEventListener(
    "pointerdown",
    (evt) => {
      if (!active) return;
      const target = /** @type {Node} */ (evt.target);
      if (previewEl.contains(target) || layerEl.contains(target)) return;
      closePreview(false);
    },
    true,
  );

  return {
    /** @param {{ comments: BoardRecord[], threads: BoardThread[] }} data */
    setData(data) {
      comments = data.comments;
      threads = data.threads;
      layout();
    },
    /** Re-measures every marker — after a relayout, a zoom or a tile reload. */
    layout,
    /** The toolbar's "Comments" toggle. @param {boolean} on */
    setEnabled(on) {
      enabled = on;
      layout();
    },
    /** The toolbar's "Show resolved" toggle. @param {boolean} on */
    setShowResolved(on) {
      showResolved = on;
      closePreview(false);
      layout();
    },
    /** @returns {Set<string>} the screens that have threads */
    threadScreens: () => new Set(threads.map((t) => t.screen)),
    /**
     * What the status line says about the shown screens.
     * @param {Iterable<string>} screens
     * @returns {{ open: number, detached: number, resolved: number }}
     */
    summary(screens) {
      const shown = new Set(screens);
      const counts = screenCounts(threads.filter((t) => shown.has(t.screen)));
      return { open: counts.openTotal, detached: counts.detached, resolved: counts.resolved };
    },
    /** The thread whose popover is open in the comment canvas (null: none); its pin shows as active. @param {string | null} id */
    setActiveThread(id) {
      activeThreadId = id;
      syncActive();
    },
    /** The marker that stands for a thread, to give the focus back to. @param {string} id @returns {HTMLElement | null} */
    markerOf(id) {
      const k = anchors.get(id);
      return k ? (markers.get(k) ?? null) : null;
    },
    /** @param {string} id the screen a thread is on, or null @returns {string | null} */
    screenOf: (id) => thread(id)?.screen ?? null,
    close: () => closePreview(false),
    isOpen: () => active !== null,
  };
}
