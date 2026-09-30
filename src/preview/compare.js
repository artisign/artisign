// CHR-738 — side-by-side variant compare: a mode of the screen view. The
// reference (the main screen of the open screen's variant family) and up to
// three members render as equal-width columns through the normal render
// route; the node-level diff from /api/compare is drawn as an overlay ABOVE
// the rendered frames (never into the screen HTML) and listed in the compare
// panel. Zoom reuses mockup-zoom.js / iframe-fit.js. State lives in the
// factory's closure; per-browser prefs go through prefs.js.

import { buildScreenTree } from "./screens.js";
import { createFittingIframe } from "./iframe-fit.js";
import { applyMockupZoom } from "./mockup-zoom.js";
import {
  COMPARE_MAX_MEMBERS,
  familyOf,
  mergeSelection,
  toggleMember,
  diffRows,
  overlapPercent,
} from "./compare-data.js";
import {
  readBoolPref,
  writeBoolPref,
  readStringPref,
  writeStringPref,
  parseZoomPref,
  readCompareSelection,
  writeCompareSelection,
} from "./prefs.js";

const MODE_KEY = "artisign.compare";
const DIFF_KEY = "artisign.compareDiff";
const ZOOM_KEY = "artisign.compareZoom";
const ZOOMS = [
  { value: "fit", label: "Fit" },
  { value: 1, label: "100%" },
  { value: 1.5, label: "150%" },
];
const BADGES = { added: "+ added", changed: "~ changed", removed: "− removed" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * @param {{
 *   barEl: HTMLElement, hintEl: HTMLElement, canvasEl: HTMLElement,
 *   columnsEl: HTMLElement, panelEl: HTMLElement,
 * }} els `columnsEl` must sit inside a wrapper element (the zoom target's parent, see applyMockupZoom), itself inside `canvasEl`.
 * @param {{
 *   storage: Storage | null,
 *   getProject: () => string | null,
 *   getScreens: () => object[],
 *   fetchRender: (screen: string) => Promise<{ ok: true, html: string } | { ok: false, message: string }>,
 *   fetchCompare: (base: string, others: string[]) => Promise<{ ok: true, compare: object } | { ok: false, message: string }>,
 *   onAdd: () => void,
 *   onChange: () => void,
 *   isVisible?: () => boolean,
 * }} deps `isVisible` (default: always) says whether the compare view is on screen; a hidden view
 *   measures every iframe as 0x0, so renders wait until `show()` says it is visible again. `onChange` fires after every state change the rest of the UI mirrors
 *   (mode, selection) so the sidebar, breadcrumb and main visibility re-render.
 */
export function createCompareView({ barEl, hintEl, canvasEl, columnsEl, panelEl }, deps) {
  let on = false;
  let reference = null;
  let previousScreen = null;
  let selected = [];
  let diff = readBoolPref(deps.storage, DIFF_KEY, true);
  let zoom = parseZoomPref(readStringPref(deps.storage, ZOOM_KEY, null), "fit");
  let data = null; // the /api/compare response for the current selection, null while unknown
  let dataError = null;
  let highlightedId = null;
  let compareRequestId = 0;
  /** @type {Map<string, ReturnType<typeof createColumn>>} */
  const columns = new Map();

  const family = () => (reference ? familyOf(buildScreenTree(deps.getScreens()), reference) : null);
  const memberData = (name) => data?.members.find((m) => m.screen === name);

  function relayout() {
    applyMockupZoom({ paneEl: canvasEl, columnsEl, zoom });
  }

  // --- columns -----------------------------------------------------------

  function createColumn(name) {
    const column = { name, request: 0, ready: false };
    column.el = el("div", "compare-column");
    column.el.dataset.screen = name;
    column.labelEl = el("div", "compare-label");
    column.bannerEl = el("p", "compare-banner");
    column.errorEl = el("p", "compare-column-error");
    column.errorEl.hidden = true;
    const frameWrap = el("div", "compare-frame");
    column.iframe = createFittingIframe(() => {
      column.ready = true;
      drawOverlays();
      relayout();
    });
    column.iframe.className = "compare-frame-iframe";
    column.overlayEl = el("div", "compare-overlay");
    frameWrap.append(column.iframe, column.overlayEl);
    column.el.append(column.labelEl, column.bannerEl, column.errorEl, frameWrap);
    return column;
  }

  function loadRender(column) {
    const request = ++column.request;
    column.deferred = deps.isVisible ? !deps.isVisible() : false;
    if (column.deferred) return;
    deps.fetchRender(column.name).then((result) => {
      if (request !== column.request || columns.get(column.name) !== column) return;
      column.ready = false;
      column.errorEl.hidden = result.ok;
      if (result.ok) column.iframe.srcdoc = result.html;
      else column.errorEl.textContent = result.message;
    });
  }

  function syncColumns() {
    const names = [reference, ...selected];
    for (const [name, column] of columns) {
      if (!names.includes(name)) {
        column.request++;
        column.el.remove();
        columns.delete(name);
      }
    }
    for (const name of names) {
      if (!columns.has(name)) {
        const column = createColumn(name);
        columns.set(name, column);
        loadRender(column);
      }
      columnsEl.appendChild(columns.get(name).el); // re-appending in order keeps the column order
    }
  }

  function renderLabels() {
    for (const [name, column] of columns) {
      column.labelEl.replaceChildren(el("span", "compare-label-name", name));
      column.labelEl.title = name;
      const member = memberData(name);
      column.bannerEl.hidden = true;
      let note = "";
      if (name === reference) note = "reference";
      else if (member?.status === "low_overlap") {
        note = "diff unavailable";
        column.bannerEl.textContent = `No shared node ids with the reference (${member.overlap.shared} of ${member.overlap.base}) — diff unavailable`;
        column.bannerEl.hidden = false;
      } else if (member) {
        const count = diffRows({ members: [member] }).length;
        note = `${count} diff${count === 1 ? "" : "s"}`;
      }
      if (note) column.labelEl.appendChild(el("small", "compare-label-note", note));
    }
  }

  // --- diff overlay ------------------------------------------------------

  /** Rect of node `id` inside a column's rendered document, in the frame's own (unscaled) coordinates. */
  function rectOf(column, id) {
    const node = column?.ready ? column.iframe.contentDocument?.getElementById(id) : null;
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function place(node, rect) {
    node.style.left = `${rect.x}px`;
    node.style.top = `${rect.y}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
  }

  function mark(column, kind, id, rect) {
    const node = el("div", `compare-mark compare-mark-${kind}`);
    node.dataset.id = id;
    node.dataset.kind = kind;
    node.classList.toggle("highlighted", id === highlightedId);
    place(node, rect);
    node.appendChild(el("em", "compare-mark-badge", BADGES[kind]));
    column.overlayEl.appendChild(node);
  }

  function drawOverlays() {
    const referenceColumn = columns.get(reference);
    for (const [name, column] of columns) {
      column.overlayEl.replaceChildren();
      if (!column.ready) continue;
      const member = memberData(name);
      if (diff && member?.status === "ok") {
        for (const kind of ["added", "changed"]) {
          for (const id of member[kind]) {
            const rect = rectOf(column, id);
            if (rect) mark(column, kind, id, rect);
          }
        }
        for (const { id, parent } of member.removed) {
          // Where the node used to be: its own rect in the reference, else its nearest identity ancestor's.
          const rect = rectOf(referenceColumn, id) ?? (parent ? rectOf(referenceColumn, parent) : null);
          if (rect) mark(column, "removed", id, rect);
        }
      }
      const rect = highlightedId === null ? null : rectOf(column, highlightedId);
      if (rect) {
        const box = el("div", "compare-highlight");
        box.dataset.id = highlightedId;
        place(box, rect);
        column.overlayEl.appendChild(box);
      }
    }
  }

  // --- chip row, hint, panel ---------------------------------------------

  function renderBar() {
    barEl.replaceChildren();
    barEl.appendChild(el("b", "compare-title", "Compare"));
    const ref = el("span", "compare-chip compare-chip-reference");
    ref.dataset.screen = reference;
    ref.title = reference;
    ref.append(el("span", "compare-chip-lock", "🔒"), el("span", "compare-chip-name", `⌂ ${reference}`), el("span", "compare-chip-note", "· reference"));
    barEl.appendChild(ref);
    for (const name of selected) {
      const chip = el("span", "compare-chip");
      chip.dataset.screen = name;
      chip.title = name;
      chip.appendChild(el("span", "compare-chip-name", name));
      const member = memberData(name);
      if (member?.status === "low_overlap") {
        const share = el("span", "compare-chip-overlap", `${overlapPercent(member)}%`);
        share.title = "Share of node ids in common with the reference";
        chip.appendChild(share);
      }
      const remove = button("compare-chip-remove", "✕", () => toggle(name));
      remove.setAttribute("aria-label", `Remove ${name} from the comparison`);
      chip.appendChild(remove);
      barEl.appendChild(chip);
    }
    const add = button("compare-chip compare-chip-add", "+ add", (evt) => {
      evt.stopPropagation(); // the popover closes on any outside click; this one opens it
      deps.onAdd();
    });
    add.disabled = selected.length >= COMPARE_MAX_MEMBERS;
    if (add.disabled) add.title = `At most ${COMPARE_MAX_MEMBERS} screens next to the reference`;
    barEl.appendChild(add);

    const diffLabel = el("label", "compare-diff");
    const diffBox = document.createElement("input");
    diffBox.type = "checkbox";
    diffBox.className = "compare-diff-toggle";
    diffBox.checked = diff;
    diffBox.addEventListener("change", () => setDiff(diffBox.checked));
    diffLabel.append(diffBox, "Diff");
    barEl.appendChild(diffLabel);

    const zoomGroup = el("span", "compare-zoom");
    zoomGroup.setAttribute("role", "group");
    zoomGroup.setAttribute("aria-label", "Compare zoom");
    for (const { value, label } of ZOOMS) {
      const b = button("compare-zoom-button", label, () => setZoom(value));
      b.dataset.zoom = String(value);
      b.setAttribute("aria-pressed", String(zoom === value));
      zoomGroup.appendChild(b);
    }
    barEl.appendChild(zoomGroup);
  }

  function renderPanel() {
    panelEl.replaceChildren();
    if (selected.length === 0) {
      panelEl.appendChild(el("p", "compare-panel-empty", `Pick 1–${COMPARE_MAX_MEMBERS} screens to compare with ${reference}.`));
      return;
    }
    const summary = el("div", "compare-summary");
    summary.appendChild(el("h3", "", `vs. reference ${reference}`));
    for (const name of selected) {
      const member = memberData(name);
      const row = el("div", "compare-summary-row");
      row.dataset.screen = name;
      const count = member ? diffRows({ members: [member] }).length : 0;
      const value = !member ? "…" : member.status === "low_overlap" ? "unavailable" : `${count} node${count === 1 ? "" : "s"}`;
      row.append(el("span", "compare-summary-name", name), el("b", "", value));
      summary.appendChild(row);
    }
    panelEl.appendChild(summary);
    if (dataError) panelEl.appendChild(el("p", "compare-panel-error", dataError));
    if (!diff) return;
    const list = el("div", "compare-diff-list");
    for (const row of diffRows(data)) {
      const item = button("compare-diff-row", "", () => highlight(row.id));
      item.dataset.id = row.id;
      item.dataset.kind = row.kind;
      item.dataset.member = row.member;
      item.classList.toggle("selected", row.id === highlightedId);
      item.setAttribute("aria-pressed", String(row.id === highlightedId));
      item.append(el("b", "compare-diff-sign", row.sign), el("code", "compare-diff-id", row.id), el("i", "compare-diff-member", row.member));
      list.appendChild(item);
    }
    panelEl.appendChild(list);
  }

  function renderAll() {
    hintEl.hidden = selected.length > 0;
    hintEl.textContent = `pick 1–${COMPARE_MAX_MEMBERS} screens`;
    syncColumns();
    renderBar();
    renderLabels();
    renderPanel();
    drawOverlays();
    relayout();
  }

  /** Re-renders everything derived from the response without refetching it. */
  function renderData() {
    renderBar();
    renderLabels();
    renderPanel();
    drawOverlays();
  }

  async function loadCompare() {
    const request = ++compareRequestId;
    data = null;
    dataError = null;
    if (selected.length === 0) return renderData();
    const result = await deps.fetchCompare(reference, selected);
    if (request !== compareRequestId || !on) return; // a newer request or a leave has superseded this one
    if (result.ok) data = result.compare;
    else dataError = result.message;
    renderData();
  }

  // --- state changes -----------------------------------------------------

  function persistSelection() {
    const project = deps.getProject();
    if (project) writeCompareSelection(deps.storage, project, reference, selected);
  }

  function setSelection(next) {
    selected = next;
    persistSelection();
    renderAll();
    loadCompare();
    deps.onChange();
  }

  function toggle(name) {
    if (!on) return;
    const next = toggleMember(selected, name, family() ?? { reference, members: [] });
    if (next !== selected) setSelection(next);
  }

  function setDiff(next) {
    diff = next;
    writeBoolPref(deps.storage, DIFF_KEY, diff);
    if (on) renderData();
  }

  function setZoom(next) {
    zoom = next;
    writeStringPref(deps.storage, ZOOM_KEY, String(next));
    if (on) {
      renderBar();
      relayout();
    }
  }

  function highlight(id) {
    highlightedId = highlightedId === id ? null : id;
    renderPanel();
    drawOverlays();
  }

  /** Clears the view without touching prefs or telling anyone — a project switch. */
  function reset() {
    on = false;
    reference = null;
    previousScreen = null;
    selected = [];
    data = null;
    dataError = null;
    highlightedId = null;
    compareRequestId++;
    for (const column of columns.values()) column.request++;
    columns.clear();
    columnsEl.replaceChildren();
    barEl.replaceChildren();
    panelEl.replaceChildren();
    hintEl.hidden = true;
  }

  /**
   * Turns compare on for the family of `open`.
   * @param {string} open the screen that is open now — preselected, and where leave() goes back to
   * @returns {boolean} false (and stays off) when the family has no other screen
   */
  function enter(open) {
    const found = familyOf(buildScreenTree(deps.getScreens()), open);
    if (!found || found.members.length === 0) return false;
    const project = deps.getProject();
    reset();
    on = true;
    reference = found.reference;
    previousScreen = open;
    selected = mergeSelection(found, open, project ? readCompareSelection(deps.storage, project, reference) : []);
    persistSelection();
    writeBoolPref(deps.storage, MODE_KEY, true);
    renderAll();
    loadCompare();
    deps.onChange();
    return true;
  }

  /** Turns compare off; returns the screen that was open when it was entered. */
  function leave() {
    if (!on) return null;
    const back = previousScreen;
    reset();
    writeBoolPref(deps.storage, MODE_KEY, false);
    deps.onChange();
    return back;
  }

  /** After a screen list change: a deleted member drops out, a deleted (or re-parented) reference ends compare. */
  function reconcile() {
    if (!on) return;
    const current = family();
    if (!current || current.reference !== reference) {
      leave();
      return;
    }
    const kept = selected.filter((name) => current.members.includes(name));
    if (kept.length !== selected.length) setSelection(kept);
  }

  /** A screen's source changed: re-render its column (if compared) and refetch the diff. */
  function screenChanged(name) {
    const column = columns.get(name);
    if (!on || !column) return;
    loadRender(column);
    loadCompare();
  }

  /** The compare view became visible: run the renders that were held back while it was hidden. */
  function show() {
    for (const column of columns.values()) if (column.deferred) loadRender(column);
  }

  /** Tokens, components or a reconnect can change any render: reload every column and the diff. */
  function reloadAll() {
    if (!on) return;
    for (const column of columns.values()) loadRender(column);
    loadCompare();
  }

  return {
    isOn: () => on,
    state: () => ({ on, reference, selected: [...selected], family: on ? [reference, ...(family()?.members ?? [])] : [], cap: COMPARE_MAX_MEMBERS }),
    /** Whether `name` belongs to the family being compared. */
    inFamily: (name) => on && (name === reference || (family()?.members.includes(name) ?? false)),
    /** The persisted "compare was on" flag, read once at boot to restore the mode. */
    restoreWanted: () => readBoolPref(deps.storage, MODE_KEY, false),
    getZoom: () => zoom,
    enter,
    leave,
    toggle,
    reset,
    reconcile,
    screenChanged,
    reloadAll,
    show,
    relayout: () => on && relayout(),
    setDiff,
    setZoom,
  };
}
