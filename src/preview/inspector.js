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
//  - computed values (position/colors/typography/spacing) and unresolved
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

import { formatTokenRef, isRefUnresolved } from "./token-ref-format.js";
import { relativeRect, resolveModelId, parseUnresolvedPaths, rgbToHex, formatPosition, formatTypography, formatSpacing } from "./inspector-data.js";

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
 * @returns {{ rect: object, bg: string, text: string, typography: string, spacing: string, unresolvedPaths: string[], resolve: (property: string) => string } | null}
 */
function readComputedDetails(renderedDoc, domId) {
  const el = renderedDoc.getElementById(domId);
  const root = renderedDoc.body?.firstElementChild;
  if (!el || !root) return null;
  const cs = getComputedStyle(el);
  const unresolvedPaths = parseUnresolvedPaths(el.getAttribute(UNRESOLVED_MARKER_ATTR));
  return {
    rect: relativeRect(el.getBoundingClientRect(), root.getBoundingClientRect()),
    bg: rgbToHex(cs.backgroundColor),
    text: rgbToHex(cs.color),
    typography: formatTypography({ fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight }),
    spacing: formatSpacing({ padding: cs.padding, margin: cs.margin, radius: cs.borderRadius }),
    unresolvedPaths,
    resolve: (property) => formatResolvedValue(cs.getPropertyValue(resolvedPropertyName(property))),
  };
}

function group(labelText, valueEl) {
  const wrap = document.createElement("div");
  wrap.className = "inspector-group";
  const label = document.createElement("span");
  label.className = "inspector-group-label";
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(valueEl);
  return wrap;
}

function textValue(text) {
  const span = document.createElement("span");
  span.className = "inspector-group-value";
  span.textContent = text;
  return span;
}

function colorSwatchRow(details) {
  const row = document.createElement("span");
  row.className = "inspector-colors-value";
  const bgChip = document.createElement("span");
  bgChip.className = "inspector-color-chip";
  bgChip.style.background = details.bg === "transparent" ? "#fff" : details.bg;
  row.append(bgChip, document.createTextNode(`bg ${details.bg}`));
  const textChip = document.createElement("span");
  textChip.className = "inspector-color-chip";
  textChip.style.background = details.text === "transparent" ? "#fff" : details.text;
  row.append(textChip, document.createTextNode(`text ${details.text}`));
  return row;
}

function dsChip(text, variantStyle) {
  const chip = document.createElement("span");
  chip.className = variantStyle ? "inspector-ds-chip inspector-ds-chip-variant" : "inspector-ds-chip";
  chip.textContent = text;
  return chip;
}

function dsRow({ property, display, unresolved, resolvedValue }) {
  const row = document.createElement("div");
  row.className = unresolved ? "inspector-ds-row inspector-ds-row-warning" : "inspector-ds-row";

  if (unresolved) {
    const icon = document.createElement("span");
    icon.className = "inspector-ds-warning-icon";
    icon.textContent = "⚠";
    row.appendChild(icon);
  }

  const prop = document.createElement("span");
  prop.className = "inspector-ds-prop";
  prop.textContent = property;
  row.appendChild(prop);

  const path = document.createElement("span");
  path.className = "inspector-ds-path";
  path.textContent = display;
  row.appendChild(path);

  const value = document.createElement("span");
  value.className = "inspector-ds-value";
  value.textContent = unresolved ? "unresolved" : resolvedValue;
  row.appendChild(value);

  return row;
}

/** A small muted status line for states that don't have a body to show yet (waiting/missing). */
function statusNote(text) {
  const note = document.createElement("p");
  note.className = "inspector-entry-note";
  note.textContent = text;
  return note;
}

/** @param {{ id: string, tag: string, componentRef: string | null, variant: string | null, tokenRefs: { property: string, ref: unknown }[] }} entry */
function buildEntryBody(entry, details) {
  const body = document.createElement("div");
  body.className = "inspector-entry-body";
  body.appendChild(group("Position", textValue(formatPosition(details.rect))));
  body.appendChild(group("Colors", colorSwatchRow(details)));
  body.appendChild(group("Typography", textValue(details.typography)));
  body.appendChild(group("Spacing & radius", textValue(details.spacing)));

  if (entry.componentRef || entry.tokenRefs.length > 0) {
    const dsGroup = document.createElement("div");
    dsGroup.className = "inspector-group";
    const label = document.createElement("span");
    label.className = "inspector-group-label";
    label.textContent = "Design system";
    dsGroup.appendChild(label);

    if (entry.componentRef) {
      const refsRow = document.createElement("div");
      refsRow.className = "inspector-ds-refs";
      refsRow.appendChild(dsChip(`$${entry.componentRef}`, false));
      if (entry.variant) refsRow.appendChild(dsChip(entry.variant, true));
      dsGroup.appendChild(refsRow);
    }

    for (const tokenRef of entry.tokenRefs) {
      const unresolved = isRefUnresolved(tokenRef.ref, details.unresolvedPaths);
      dsGroup.appendChild(
        dsRow({
          property: tokenRef.property,
          display: formatTokenRef(tokenRef.ref),
          unresolved,
          resolvedValue: unresolved ? "" : details.resolve(tokenRef.property),
        }),
      );
    }
    body.appendChild(dsGroup);
  }

  return body;
}

/**
 * Owns the Elements panel's list DOM: builds one row per entry, expands
 * rows on their own header click, and lets `focusEntry` (inspect mode)
 * drive expand + highlight + scroll-into-view externally.
 *
 * @param {{ listEl: HTMLElement, emptyEl: HTMLElement, errorEl: HTMLElement }} elements
 * @param {{ getRenderedDoc: (screen: string) => Document | null }} deps —
 *   reads the *current* iframe document lazily, at expand/refresh time,
 *   scoped to a screen name so a stale/mismatched iframe (still showing a
 *   different screen, or not loaded yet) is never read as if it were live.
 */
export function createInspectorPanel({ listEl, emptyEl, errorEl }, { getRenderedDoc }) {
  /** @type {{ id: string, tag: string, componentRef: string | null, variant: string | null, tokenRefs: object[] }[]} */
  let entries = [];
  let entriesScreen = null;
  let modelIds = new Set();
  const rows = new Map(); // id -> { rowEl, headEl, chevronEl, bodyEl, expanded, lastClickedDomId }
  let focusedId = null;

  function renderBody(id, clickedDomId) {
    const row = rows.get(id);
    const entry = entries.find((e) => e.id === id);
    if (!row || !entry) return;
    row.lastClickedDomId = clickedDomId;
    row.bodyEl.innerHTML = "";

    const isPart = clickedDomId !== id;
    if (isPart) {
      const note = document.createElement("p");
      note.className = "inspector-entry-note";
      note.append("Part of component instance ");
      const strong = document.createElement("strong");
      strong.textContent = entry.id;
      note.appendChild(strong);
      row.bodyEl.appendChild(note);
    }

    const doc = getRenderedDoc(entriesScreen);
    if (!doc) {
      row.bodyEl.appendChild(statusNote("Waiting for the screen to finish rendering…"));
      return;
    }
    const details = readComputedDetails(doc, clickedDomId ?? id);
    if (!details) {
      row.bodyEl.appendChild(statusNote("Element not found in the rendered screen."));
      return;
    }
    row.bodyEl.appendChild(buildEntryBody(entry, details));
  }

  function setExpanded(id, expanded, clickedDomId) {
    const row = rows.get(id);
    if (!row) return;
    row.expanded = expanded;
    row.headEl.setAttribute("aria-expanded", String(expanded));
    row.chevronEl.textContent = expanded ? "▾" : "▶";
    if (expanded) {
      renderBody(id, clickedDomId ?? id);
      row.bodyEl.hidden = false;
    } else {
      row.bodyEl.hidden = true;
    }
  }

  function buildRow(entry) {
    const li = document.createElement("li");
    li.className = "inspector-entry";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "inspector-entry-head";
    head.setAttribute("aria-expanded", "false");

    const chevron = document.createElement("span");
    chevron.className = "inspector-entry-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▶";
    head.appendChild(chevron);

    const label = document.createElement("span");
    label.className = "inspector-entry-label";
    label.textContent = `<${entry.tag}> · ${entry.id}`;
    head.appendChild(label);

    if (entry.componentRef) {
      const badge = document.createElement("span");
      badge.className = "inspector-entry-badge";
      badge.textContent = `$${entry.componentRef}`;
      head.appendChild(badge);
    }

    li.appendChild(head);

    const body = document.createElement("div");
    body.className = "inspector-entry-body";
    body.hidden = true;
    li.appendChild(body);

    const row = { rowEl: li, headEl: head, chevronEl: chevron, bodyEl: body, expanded: false, lastClickedDomId: null };
    head.addEventListener("click", () => setExpanded(entry.id, !row.expanded));
    return row;
  }

  /**
   * Rebuilds the list. When `screen` is the SAME screen the panel already
   * showed (a re-render — SSE change, not a screen switch), expand/focus
   * state is carried over onto the matching new rows so a design-system
   * edit doesn't visually collapse whatever the user had open; on an
   * actual screen switch (`screen` differs) nothing carries over — ids
   * are only stable within one screen, not across them.
   * @param {typeof entries} nextEntries
   * @param {string | null} screen
   */
  function setEntries(nextEntries, screen) {
    const sameScreen = screen !== null && screen === entriesScreen;
    const previouslyExpanded = sameScreen ? [...rows].filter(([, r]) => r.expanded).map(([id]) => id) : [];
    const previousClickedByRow = sameScreen ? new Map([...rows].map(([id, r]) => [id, r.lastClickedDomId])) : new Map();
    const previousFocused = sameScreen ? focusedId : null;

    entries = nextEntries;
    entriesScreen = screen;
    modelIds = new Set(entries.map((e) => e.id));
    rows.clear();
    listEl.innerHTML = "";
    focusedId = null;
    errorEl.hidden = true;
    emptyEl.hidden = entries.length > 0;

    for (const entry of entries) {
      const row = buildRow(entry);
      rows.set(entry.id, row);
      listEl.appendChild(row.rowEl);
    }

    for (const id of previouslyExpanded) {
      if (!rows.has(id)) continue;
      setExpanded(id, true, previousClickedByRow.get(id) ?? id);
    }
    if (previousFocused && rows.has(previousFocused)) {
      focusedId = previousFocused;
      rows.get(previousFocused).rowEl.classList.add("inspector-entry-focused");
    }
  }

  /** A fetch failure: shows the server's message instead of the empty/list state. */
  function setError(message) {
    entries = [];
    entriesScreen = null;
    modelIds = new Set();
    rows.clear();
    listEl.innerHTML = "";
    focusedId = null;
    emptyEl.hidden = true;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  /** Re-renders every currently expanded row's body against the current (possibly just-reloaded) document — see readComputedDetails. */
  function refreshExpanded() {
    for (const [id, row] of rows) {
      if (row.expanded) renderBody(id, row.lastClickedDomId ?? id);
    }
  }

  /**
   * Focuses + expands the entry for a canvas click (inspect mode). For a
   * component-instance descendant, `clickedDomId` is the actual element
   * clicked (its computed values are shown) while `id` (the containing
   * instance) is what gets focused/expanded in the list.
   * @param {string} id
   * @param {string} [clickedDomId]
   */
  function focusEntry(id, clickedDomId) {
    if (!rows.has(id)) return;
    if (focusedId && rows.has(focusedId)) rows.get(focusedId).rowEl.classList.remove("inspector-entry-focused");
    focusedId = id;
    const row = rows.get(id);
    row.rowEl.classList.add("inspector-entry-focused");
    setExpanded(id, true, clickedDomId);
    row.rowEl.scrollIntoView({ block: "nearest" });
  }

  function clearFocus() {
    if (focusedId && rows.has(focusedId)) rows.get(focusedId).rowEl.classList.remove("inspector-entry-focused");
    focusedId = null;
  }

  /** The dom id last shown for the currently focused entry (for overlay positioning), or null when nothing's focused. */
  function getFocusedDomId() {
    if (!focusedId || !rows.has(focusedId)) return null;
    return rows.get(focusedId).lastClickedDomId ?? focusedId;
  }

  /** Every known model node id on the current screen — for resolving a canvas click's DOM id (see resolveModelId). */
  function getModelIds() {
    return modelIds;
  }

  return { setEntries, setError, refreshExpanded, focusEntry, clearFocus, getFocusedDomId, getModelIds };
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
 * }} handlers
 * @returns {() => void} cleanup
 */
export function applyInspectMode(doc, enabled, { getModelIds, onSelect, onDeselect, onScroll }) {
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
    if (evt.key === "Escape") onDeselect();
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
 */
export function updateInspectOverlay(overlayEl, renderedDoc, domId) {
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
  overlayEl.hidden = false;
}
