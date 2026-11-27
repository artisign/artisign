// The Elements panel: a read-only list of every element on the
// current screen, each expandable to computed geometry/style values plus
// its design-system refs, and inspect mode — clicking an element in the
// canvas focuses + expands its matching entry.
//
// Two independent data sources, kept apart deliberately:
//  - refs (component/variant/token) come straight from the server's
//    `get_screen` "full" view (see api.js/inspector-data.js's
//    `buildEntries`) — the same shape `get_node` returns per node. No
//    client-side re-parsing of the augmented source: which class is a
//    component ref vs. a token-style class is a server-side (registry)
//    decision, not something a client-side grammar guess can get right.
//  - computed values (box, font) and unresolved
//    markers come from the *rendered* iframe document, read live, lazily,
//    only when an entry is expanded — same "no second render engine"
//    rationale as canvas.js/warnings.js: nothing here re-resolves a ref,
//    it only reads what render-document.ts already produced.
//
// This module is DOM wiring end to end (getBoundingClientRect,
// getComputedStyle). createInspectorPanel's list/row structure gets a jsdom
// smoke test; the getBoundingClientRect/
// getComputedStyle-dependent row body still isn't, since jsdom doesn't
// compute real layout. The actual logic it leans on (token-ref-format.js,
// inspector-data.js) is unit-tested on its own.

import { icon } from "./icons.js";
import { formatTokenRef, isRefUnresolved } from "./token-ref-format.js";
import { relativeRect, resolveModelId, parseUnresolvedPaths, rgbToHex } from "./inspector-data.js";

const UNRESOLVED_MARKER_ATTR = "data-unresolved-token";

/** "background" reads as a near-empty shorthand in some engines; the color is what these refs actually carry. */
function resolvedPropertyName(property) {
  return property === "background" ? "background-color" : property;
}

function formatResolvedValue(raw) {
  return /^rgba?\(/.test(raw) ? rgbToHex(raw) : raw;
}

/**
 * Reads computed geometry/style/unresolved-marker values for one element
 * of the currently rendered screen. Returns null when the element isn't in
 * the rendered DOM (e.g. a stale id after a screen edit, or a render
 * failure that replaced the whole document with an error message).
 * @param {Document} renderedDoc
 * @param {string} domId — the element to actually read (the clicked one for
 *   a component-instance-descendant click, otherwise the entry's own id)
 * @returns {{ rect: { x: number, y: number, w: number, h: number }, fontSize: string, fontWeight: string, unresolvedPaths: string[], resolve: (property: string) => string } | null}
 */
function readComputedDetails(renderedDoc, domId) {
  const el = renderedDoc.getElementById(domId);
  const root = renderedDoc.body?.firstElementChild;
  if (!el || !root) return null;
  const cs = getComputedStyle(el);
  const unresolvedPaths = parseUnresolvedPaths(el.getAttribute(UNRESOLVED_MARKER_ATTR));
  return {
    rect: relativeRect(el.getBoundingClientRect(), root.getBoundingClientRect()),
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    unresolvedPaths,
    resolve: (property) => formatResolvedValue(cs.getPropertyValue(resolvedPropertyName(property))),
  };
}

/** Labels for the properties a token ref usually sits on (design `prop-row`, token variant). */
const PROPERTY_LABELS = { background: "Fill", "background-color": "Fill", color: "Text", "border-radius": "Radius", padding: "Padding", margin: "Margin", gap: "Gap", "font-size": "Size", "font-weight": "Weight" };

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** A small muted status line for states that don't have a body to show yet (waiting/missing). */
function statusNote(text) {
  return el("p", "inspector-entry-note", text);
}

/** A section head: bold title left, quiet meta right (design `section-head`). */
function sectionHead(title, meta = "") {
  const head = el("div", "tool-section-head");
  head.append(el("span", "", title), el("span", "tool-section-meta", meta));
  return head;
}

/** Design `prop-row`: a label and a mono value. */
function propRow(label, value) {
  const row = el("div", "prop-row");
  row.append(el("span", "prop-label", label), el("span", "prop-value", value));
  return row;
}

/** Design `prop-row` token variant: the ref as a chip, its resolved value under it. */
function tokenRow({ label, ref, value, unresolved }) {
  const row = el("div", unresolved ? "prop-row prop-row-token prop-row-warning" : "prop-row prop-row-token");
  const main = el("span", "prop-main");
  main.append(el("span", "prop-ref", ref), el("span", "prop-value prop-value-sub", unresolved ? "unresolved" : value));
  row.append(el("span", "prop-label", label), main);
  return row;
}

/**
 * The sections below the layers for one element: Box, Design system, Type (design `inspector-selected`).
 * @param {{ id: string, tag: string, componentRef: string | null, variant: string | null, tokenRefs: { property: string, ref: unknown }[] }} entry
 * @param {NonNullable<ReturnType<typeof readComputedDetails>>} details
 */
function buildDetails(entry, details) {
  const frag = document.createDocumentFragment();
  frag.append(sectionHead("Box", "px"), propRow("Size", `${details.rect.w} × ${details.rect.h}`), propRow("Position", `x ${details.rect.x}, y ${details.rect.y}`));
  const refCount = (entry.componentRef ? 1 : 0) + entry.tokenRefs.length;
  if (refCount > 0) {
    frag.append(sectionHead("Design system", `${refCount} ref${refCount === 1 ? "" : "s"}`));
    if (entry.componentRef) frag.append(tokenRow({ label: "Component", ref: `$${entry.componentRef}`, value: entry.variant ?? "default", unresolved: false }));
    for (const tokenRef of entry.tokenRefs) {
      const unresolved = isRefUnresolved(tokenRef.ref, details.unresolvedPaths);
      frag.append(tokenRow({ label: PROPERTY_LABELS[tokenRef.property] ?? tokenRef.property, ref: formatTokenRef(tokenRef.ref), value: unresolved ? "" : details.resolve(tokenRef.property), unresolved }));
    }
  }
  frag.append(sectionHead("Type"), propRow("Font", `${details.fontSize}, ${details.fontWeight}`));
  return frag;
}

/**
 * Owns the Inspect panel's DOM (design `inspector-selected`): the selected element's summary, the Layers tree (`node-row`s, chevrons, the selected row tinted) and, below it, Box / Design system / Type for the selection. Inspect mode drives the selection from the canvas through `focusEntry`; a click on a row selects the same way (`onSelect`).
 *
 * @param {{ listEl: HTMLElement, emptyEl: HTMLElement, errorEl: HTMLElement, summaryEl: HTMLElement, detailsEl: HTMLElement }} elements
 * @param {{ getRenderedDoc: (screen: string) => Document | null, onSelect?: (id: string) => void }} deps —
 *   reads the *current* iframe document lazily, at selection/refresh time,
 *   scoped to a screen name so a stale/mismatched iframe (still showing a
 *   different screen, or not loaded yet) is never read as if it were live.
 */
export function createInspectorPanel({ listEl, emptyEl, errorEl, summaryEl, detailsEl }, { getRenderedDoc, onSelect }) {
  /** @type {{ id: string, tag: string, parentId: string | null, componentRef: string | null, variant: string | null, tokenRefs: { property: string, ref: unknown }[] }[]} */
  let entries = [];
  let entriesScreen = null;
  let modelIds = new Set();
  /** @type {Map<string, string | null>} entry id -> parent entry id (null at a root or when the parent is not an entry) */
  let parentOf = new Map();
  /** @type {Map<string, string[]>} */
  let childrenOf = new Map();
  const expanded = new Set(); // tree nodes the reader (or a selection) opened
  let focusedId = null;
  let lastClickedDomId = null;

  summaryEl.hidden = true;
  detailsEl.hidden = true;

  function depthOf(id) {
    let depth = 0;
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) depth += 1;
    return depth;
  }

  function ancestors(id) {
    const chain = [];
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) chain.push(p);
    return chain;
  }

  /** Rows that show: every root, and the children of an expanded visible node. */
  function visibleIds() {
    const out = [];
    const walk = (id) => {
      out.push(id);
      if (expanded.has(id)) for (const child of childrenOf.get(id) ?? []) walk(child);
    };
    for (const e of entries) if (!parentOf.get(e.id)) walk(e.id);
    return out;
  }

  function renderTree() {
    const byId = new Map(entries.map((e) => [e.id, e]));
    listEl.replaceChildren(
      ...visibleIds().map((id) => {
        const entry = /** @type {NonNullable<ReturnType<typeof byId.get>>} */ (byId.get(id));
        const kids = childrenOf.get(id) ?? [];
        const li = el("li", id === focusedId ? "inspector-entry inspector-entry-focused node-row is-selected" : "inspector-entry node-row");
        li.setAttribute("role", "treeitem");
        li.setAttribute("aria-level", String(depthOf(id) + 1));
        li.setAttribute("aria-selected", String(id === focusedId));
        if (kids.length > 0) li.setAttribute("aria-expanded", String(expanded.has(id)));
        li.dataset.entry = id;
        li.style.paddingLeft = `calc(var(--space-md) + ${depthOf(id)} * 12px)`;
        const chev = el("span", "node-row-chev");
        if (kids.length > 0) {
          chev.append(icon(expanded.has(id) ? "expand_more" : "chevron_right", "icon-xs"));
          chev.addEventListener("click", (evt) => {
            evt.stopPropagation();
            toggle(id);
          });
        }
        li.append(chev, el("span", "node-row-tag", entry.tag), el("span", "node-row-id", entry.id));
        if (entry.componentRef) {
          const badge = el("span", "inspector-entry-badge", `$${entry.componentRef}`);
          li.append(badge);
        }
        li.addEventListener("click", () => {
          if (onSelect) onSelect(id);
          else focusEntry(id);
        });
        return li;
      }),
    );
    emptyEl.hidden = entries.length > 0;
  }

  function toggle(id) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    renderTree();
  }

  function renderSelection() {
    const entry = focusedId ? entries.find((e) => e.id === focusedId) : null;
    if (!entry) {
      summaryEl.hidden = true;
      detailsEl.hidden = true;
      return;
    }
    const where = ancestors(entry.id).slice(0, 2);
    const isPart = lastClickedDomId !== null && lastClickedDomId !== entry.id;
    summaryEl.replaceChildren(el("div", "inspect-summary-id", isPart ? lastClickedDomId : entry.id), el("div", "inspect-summary-sub", isPart ? `part of ${entry.id}` : `${entry.tag}${where.length > 0 ? ` in ${where.join(", ")}` : ""}`));
    summaryEl.hidden = false;
    const doc = getRenderedDoc(entriesScreen);
    detailsEl.replaceChildren();
    detailsEl.hidden = false;
    if (!doc) {
      detailsEl.append(statusNote("Waiting for the screen to finish rendering…"));
      return;
    }
    const domId = lastClickedDomId ?? entry.id;
    const details = readComputedDetails(doc, domId);
    if (!details) {
      detailsEl.append(statusNote("Element not found in the rendered screen."));
      return;
    }
    detailsEl.append(buildDetails(entry, details));
  }

  /**
   * Rebuilds the tree. When `screen` is the SAME screen the panel already
   * showed (a re-render — SSE change, not a screen switch), expansion and
   * the selection are carried over so a design-system edit doesn't collapse
   * what the reader had open; on an actual screen switch nothing carries
   * over — ids are only stable within one screen.
   * @param {typeof entries} nextEntries
   * @param {string | null} screen
   */
  function setEntries(nextEntries, screen) {
    const sameScreen = screen !== null && screen === entriesScreen;
    const previousFocused = sameScreen ? focusedId : null;
    const previousClicked = sameScreen ? lastClickedDomId : null;
    if (!sameScreen) expanded.clear();
    entries = nextEntries;
    entriesScreen = screen;
    modelIds = new Set(entries.map((e) => e.id));
    parentOf = new Map(entries.map((e) => [e.id, e.parentId && modelIds.has(e.parentId) ? e.parentId : null]));
    childrenOf = new Map();
    for (const e of entries) {
      const parent = parentOf.get(e.id);
      if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), e.id]);
    }
    if (!sameScreen) for (const e of entries) if (!parentOf.get(e.id)) expanded.add(e.id); // the roots open one level
    errorEl.hidden = true;
    focusedId = previousFocused && modelIds.has(previousFocused) ? previousFocused : null;
    lastClickedDomId = focusedId ? previousClicked : null;
    renderTree();
    renderSelection();
  }

  /** A fetch failure: shows the server's message instead of the empty/list state. */
  function setError(message) {
    entries = [];
    entriesScreen = null;
    modelIds = new Set();
    parentOf = new Map();
    childrenOf = new Map();
    expanded.clear();
    focusedId = null;
    lastClickedDomId = null;
    listEl.replaceChildren();
    emptyEl.hidden = true;
    renderSelection();
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  /** Re-reads the selection's computed values against the current (possibly just-reloaded) document — see readComputedDetails. */
  function refreshExpanded() {
    if (focusedId) renderSelection();
  }

  /**
   * Selects an entry (a canvas click in inspect mode, or a row click): opens its ancestors, tints its row, shows its summary and values. For a component-instance descendant, `clickedDomId` is the actual element clicked (its computed values are shown) while `id` (the containing instance) is what the tree selects.
   * @param {string} id
   * @param {string} [clickedDomId]
   */
  function focusEntry(id, clickedDomId) {
    if (!modelIds.has(id)) return;
    focusedId = id;
    lastClickedDomId = clickedDomId ?? id;
    for (const ancestor of ancestors(id)) expanded.add(ancestor);
    renderTree();
    renderSelection();
    listEl.querySelector(".inspector-entry-focused")?.scrollIntoView({ block: "nearest" });
  }

  function clearFocus() {
    focusedId = null;
    lastClickedDomId = null;
    renderTree();
    renderSelection();
  }

  /** The dom id last shown for the currently focused entry (for overlay positioning), or null when nothing's focused. */
  function getFocusedDomId() {
    if (!focusedId || !modelIds.has(focusedId)) return null;
    return lastClickedDomId ?? focusedId;
  }

  /** CHR-780 — the focused entry's "$ref · variant" label for the canvas outline, from the same entry the row badge reads; null for a plain element or when the outline sits on a descendant of the instance rather than the instance itself. */
  function getFocusedLabel() {
    if (!focusedId) return null;
    const entry = entries.find((e) => e.id === focusedId);
    if (!entry?.componentRef) return null;
    const outlinedId = lastClickedDomId ?? focusedId;
    if (outlinedId !== focusedId) return null;
    return entry.variant ? `$${entry.componentRef} · ${entry.variant}` : `$${entry.componentRef}`;
  }

  /** Every known model node id on the current screen — for resolving a canvas click's DOM id (see resolveModelId). */
  function getModelIds() {
    return modelIds;
  }

  return { setEntries, setError, refreshExpanded, focusEntry, clearFocus, getFocusedDomId, getFocusedLabel, getModelIds };
}

/**
 * Inspect mode: click an element in the canvas to focus its entry (see
 * createInspectorPanel.focusEntry), Esc/click the screen root to clear it,
 * and reposition/hide the selection overlay on scroll (the iframe's
 * content can be taller than its own viewport). Mirrors
 * applyCommentMode/applyFlowMode's capture-phase click wiring.
 *
 * @param {Document} doc
 * @param {boolean} enabled
 * @param {{
 *   getModelIds: () => Set<string>,
 *   onSelect: (modelId: string, clickedDomId: string) => void,
 *   onDeselect: () => void,
 *   onScroll: () => void,
 *   hasFocus?: () => boolean, // whether an element is currently focused (an Escape that clears it is marked as handled)
 * }} handlers
 * @returns {() => void} cleanup
 */
export function applyInspectMode(doc, enabled, { getModelIds, onSelect, onDeselect, onScroll, hasFocus }) {
  if (!enabled) return () => {};
  const root = doc.body.firstElementChild;

  function handleClick(evt) {
    const el = /** @type {HTMLElement} */ (evt.target).closest("[id]");
    if (!el || el === root) {
      onDeselect();
      return;
    }
    evt.preventDefault();
    const { modelId } = resolveModelId(el.id, getModelIds());
    onSelect(modelId, el.id);
  }

  function handleKeydown(evt) {
    if (evt.key !== "Escape") return;
    // An Escape that cleared a selection is spent: marking it keeps the shortcut handler from also leaving the mode in the same keystroke (the next Escape does).
    if (hasFocus?.()) evt.preventDefault();
    onDeselect();
  }

  // `scroll` doesn't bubble, but it does fire during the capture phase on
  // any ancestor — this one listener catches it from the window itself or
  // any scrollable element inside the screen.
  function handleScroll() {
    onScroll();
  }

  doc.addEventListener("click", handleClick, true);
  doc.addEventListener("keydown", handleKeydown, true);
  doc.addEventListener("scroll", handleScroll, true);
  return () => {
    doc.removeEventListener("click", handleClick, true);
    doc.removeEventListener("keydown", handleKeydown, true);
    doc.removeEventListener("scroll", handleScroll, true);
  };
}

/**
 * Positions the inspect-mode selection outline over `domId` in the
 * PARENT document. Uses the element's RAW (viewport-relative) rect, not
 * one made relative to the screen root: `#screen-holder` (the overlay's
 * positioning parent) shares the iframe's own viewport space one-for-one,
 * the same origin `getBoundingClientRect()` already measures against — so
 * this stays correct even when the iframe's content is scrolled (unlike a
 * root-relative rect, which would only track the element's position
 * within the document, not within the currently visible viewport).
 * Hides the overlay when the element can't be found (stale id, or the
 * rendered document doesn't match what the caller expected).
 * @param {HTMLElement} overlayEl
 * @param {Document | null} renderedDoc
 * @param {string | null} domId
 * @param {string | null} [label] component tag drawn on the outline's top-left edge (CHR-780); style.css flips it inside the outline when `data-flip` is set, i.e. when there's no room above
 */
export function updateInspectOverlay(overlayEl, renderedDoc, domId, label = null) {
  const el = domId && renderedDoc ? renderedDoc.getElementById(domId) : null;
  if (!el) {
    overlayEl.hidden = true;
    return;
  }
  const rect = el.getBoundingClientRect();
  overlayEl.style.left = `${Math.round(rect.left)}px`;
  overlayEl.style.top = `${Math.round(rect.top)}px`;
  overlayEl.style.width = `${Math.round(rect.width)}px`;
  overlayEl.style.height = `${Math.round(rect.height)}px`;
  // The overlay sits inside the zoomed #screen-holder; the label counter-scales (style.css) to a constant on-screen size, so its room/width needs are in unscaled iframe px = on-screen px / zoom.
  const zoom = parseFloat(overlayEl.parentElement?.style.getPropertyValue("--zoom") ?? "") || 1;
  if (label) overlayEl.dataset.label = label;
  else delete overlayEl.dataset.label;
  if (rect.top < INSPECT_LABEL_ROOM_PX / zoom) overlayEl.dataset.flip = "";
  else delete overlayEl.dataset.flip;
  // A label scrolled partly above the viewport would be clipped at the holder's top: nudge it into view.
  overlayEl.style.setProperty("--label-clamp", `${Math.max(0, -Math.round(rect.top))}px`);
  // Overhangs the outline like devtools; right-aligns instead when it would cross the holder's right edge.
  const labelWidth = label ? (label.length * INSPECT_LABEL_CHAR_PX + INSPECT_LABEL_PAD_PX) / zoom : 0;
  if (label && rect.left + labelWidth > (overlayEl.parentElement?.clientWidth ?? Infinity)) overlayEl.dataset.alignRight = "";
  else delete overlayEl.dataset.alignRight;
  overlayEl.hidden = false;
}

// On-screen px (style.css `#inspect-overlay[data-label]::after`): height the label needs above the outline before it flips inside, and a rough width estimate (0.65rem semibold ≈ 6.5px/char + padding) for the right-edge check.
const INSPECT_LABEL_ROOM_PX = 22;
const INSPECT_LABEL_CHAR_PX = 6.5;
const INSPECT_LABEL_PAD_PX = 16;
