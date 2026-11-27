// CHR-1269 — the Agent bar: the right column's floating card (design `float-card` + `agent-status` + `agent-activity` + `agent-note` + `live-chip` + `agent-bar-folded`). It says what the agent is doing now, carries the Follow switch, lists the Activity feed and takes a note for the agent. The feed, the follow state machine and the navigation stay in activity.js / app.js; this module is the card: the status words (pure), the note's scope (pure) and the DOM.
//
// Folding: the bar folds to its head (grip, "Agent", the live status, the Live chip, the chevron) by the user's choice (remembered, key `]`) and by itself while a tool panel takes the column below it; the panel closing brings it back. A panel-fold is never stored: it is derived from "a panel is open" every time.

import { describeActivity, fillActivityText, formatActivityTime, renderActivityFeed } from "./activity.js";
import { makeCardDraggable } from "./float-card.js";
import { readBoolPref, writeBoolPref } from "./prefs.js";

/** The newest feed entry is this old → the agent counts as idle. */
export const IDLE_AFTER_MS = 60_000;

const NO_CALL_YET = "No agent call in this session yet";

/**
 * What the status box says (design `agent-status`): the latest feed entry as the agent's present, "Idle" when nothing happened for a while or the feed is empty, "Waiting for the connection" while the live connection is down.
 * @param {{ feed: object[], follow: { enabled: boolean, paused: boolean }, connected: boolean, now: number, exists: (event: object) => boolean }} state
 * @returns {{ look: "active" | "idle", text: import("./activity.js").ActivityText, detail: string }}
 */
export function agentStatus({ feed, follow, connected, now, exists }) {
  const latest = feed[0];
  const lastActivity = latest ? `Last activity ${formatActivityTime(latest.at, now)}` : NO_CALL_YET;
  if (!connected) return { look: "active", text: { before: "Waiting for the connection", name: null, after: "" }, detail: lastActivity };
  if (!latest || now - latest.at > IDLE_AFTER_MS) return { look: "idle", text: { before: "Idle", name: null, after: "" }, detail: lastActivity };
  const text = describeActivity(latest, { gone: !exists(latest), progressive: true });
  if (follow.enabled && follow.paused) return { look: "active", text, detail: "You moved away, so the canvas stays where you are" };
  if (!follow.enabled) return { look: "active", text, detail: "Follow is off, the canvas stays where you are" };
  const onMockup = latest.target?.kind === "mockup";
  return { look: "active", text, detail: onMockup ? "Following: mockups have no node ids, so the row lights up" : "Following: the canvas shows each screen the agent touches" };
}

/**
 * Where the note field's thread would land, and whether it can: on the open screen, anchored to the screen root. The Board, a mockup and a compare have no single screen to anchor to, so the field is off there and says why (the same words as the tool bar's greyed tools).
 * @param {{ view: string, showMockup: boolean, comparing: boolean, screen: string | null, screenLabel: string, mockup: string | null, boardCount: number }} where
 * @returns {{ enabled: boolean, key: string, icon: string, scope: string, reason: string }}
 */
export function noteState({ view, showMockup, comparing, screen, screenLabel, mockup, boardCount }) {
  if (view === "board") {
    return { enabled: false, key: "board", icon: "grid_view", scope: `On the Board, ${boardCount} screen${boardCount === 1 ? "" : "s"}`, reason: "Not available on the Board" };
  }
  if (showMockup) return { enabled: false, key: `mockup:${mockup}`, icon: "view_column", scope: `On ${mockup}`, reason: "Not available for mockups" };
  if (screen === null) return { enabled: false, key: "none", icon: "desktop_windows", scope: "No screen open", reason: "No screen is open" };
  if (comparing) return { enabled: false, key: `screen:${screen}`, icon: "desktop_windows", scope: `On ${screenLabel}`, reason: "Not available while comparing variants" };
  return { enabled: true, key: `screen:${screen}`, icon: "desktop_windows", scope: `On ${screenLabel}`, reason: "" };
}

/**
 * @param {{
 *   barEl: HTMLElement,
 *   storage: Storage,
 *   onFollow: (on: boolean) => void,
 *   onResume: () => void,
 *   onSelect: (event: object) => void,
 *   onSend: (text: string, noteKey: string) => Promise<{ ok: true } | { ok: false, message: string }>,
 * }} args `onSend` posts the note for the scope the field showed when it was sent (`noteKey`).
 */
export function createAgentBar({ barEl, storage, onFollow, onResume, onSelect, onSend }) {
  const $ = (id) => /** @type {HTMLElement} */ (barEl.querySelector(`#${id}`));
  const foldEl = /** @type {HTMLButtonElement} */ ($("agent-bar-fold"));
  const foldIconEl = $("agent-bar-fold-icon");
  const bodyEl = $("agent-bar-body");
  const liveEl = $("agent-bar-live");
  const connectionEl = $("connection");
  const foldedStatusEl = $("agent-bar-folded-status");
  const statusEl = $("agent-status");
  const switchEl = /** @type {HTMLInputElement} */ ($("follow-switch"));
  const followRowEl = $("agent-follow-row");
  const pausedRowEl = $("agent-follow-paused-row");
  const feedEl = $("agent-feed");
  const noteFormEl = /** @type {HTMLFormElement} */ ($("agent-note"));
  const fieldEl = /** @type {HTMLTextAreaElement} */ ($("agent-note-field"));
  const errorEl = $("agent-note-error");
  const sendEl = /** @type {HTMLButtonElement} */ ($("agent-note-send"));

  const FOLD_KEY = "artisign.agent-bar.collapsed";
  let userFolded = readBoolPref(storage, FOLD_KEY, false);
  let panelOpen = false;

  makeCardDraggable({ cardEl: barEl, gripEl: $("agent-bar-grip"), storage, key: "artisign.agent-bar.position", label: "Agent bar", liveEl });

  function applyFold() {
    const folded = userFolded || panelOpen;
    barEl.dataset.collapsed = String(folded);
    barEl.dataset.panelFold = String(panelOpen);
    foldedStatusEl.hidden = !folded;
    foldEl.setAttribute("aria-expanded", String(!folded));
    foldIconEl.textContent = folded ? "keyboard_arrow_down" : "keyboard_arrow_up";
    // A bar folded by an open panel stays folded until the panel closes: its control says so instead of doing nothing.
    const label = panelOpen ? "Agent bar is folded while a panel is open" : folded ? "Unfold Agent bar" : "Fold Agent bar";
    foldEl.setAttribute("aria-label", label);
    foldEl.dataset.tooltip = label;
    if (panelOpen) foldEl.setAttribute("aria-disabled", "true");
    else foldEl.removeAttribute("aria-disabled");
    // Focus inside a body that just went away would fall to the page: it stays on the card, at the fold control.
    if (folded && bodyEl.contains(document.activeElement)) foldEl.focus();
  }
  foldEl.addEventListener("click", () => {
    if (panelOpen) return;
    userFolded = !userFolded;
    writeBoolPref(storage, FOLD_KEY, userFolded);
    applyFold();
  });
  applyFold();

  switchEl.addEventListener("change", () => onFollow(switchEl.checked));
  $("follow-resume").addEventListener("click", () => onResume());

  // --- The note field -------------------------------------------------------

  /** @type {ReturnType<typeof noteState>} */
  let note = { enabled: false, key: "none", icon: "desktop_windows", scope: "", reason: "" };
  /** Each scope keeps its own unsent text: follow can move the open screen while one types, and the note must not land on a screen it was not written for. */
  const drafts = new Map();
  let sending = false;

  function syncSend() {
    const blocked = !note.enabled || sending || fieldEl.value.trim() === "";
    sendEl.setAttribute("aria-disabled", String(blocked));
  }
  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = message === "";
  }

  function renderNote(next) {
    if (next.key !== note.key) {
      drafts.set(note.key, fieldEl.value);
      fieldEl.value = drafts.get(next.key) ?? "";
      showError("");
    }
    note = next;
    // Read-only and aria-disabled, not `disabled`: it stays focusable, and its description says why it is off (like the greyed tools).
    fieldEl.readOnly = !next.enabled;
    fieldEl.setAttribute("aria-disabled", String(!next.enabled));
    $("agent-note-reason").textContent = next.reason;
    fieldEl.placeholder = next.enabled ? "Leave a note for the agent" : next.reason;
    $("agent-note-scope-icon").textContent = next.icon;
    $("agent-note-scope-text").textContent = next.scope;
    sendEl.dataset.tooltip = next.enabled ? "Send note" : next.reason;
    sendEl.setAttribute("aria-label", next.enabled ? "Send note" : `Send note, unavailable: ${next.reason}`);
    syncSend();
  }

  fieldEl.addEventListener("input", () => {
    showError("");
    syncSend();
  });
  // Enter sends, Shift+Enter breaks the line — like the comment popover. An Enter that confirms an IME conversion is not a send.
  fieldEl.addEventListener("keydown", (evt) => {
    if (evt.key !== "Enter" || evt.shiftKey || evt.ctrlKey || evt.metaKey || evt.altKey) return;
    evt.preventDefault();
    if (evt.isComposing || evt.keyCode === 229) return;
    noteFormEl.requestSubmit();
  });
  noteFormEl.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const text = fieldEl.value.trim();
    if (!note.enabled || sending || text === "") return;
    const key = note.key;
    sending = true;
    syncSend();
    showError("");
    const result = await onSend(text, key);
    sending = false;
    if (result.ok) {
      // The field may show another scope by now (follow moved on): only the scope the note was written for forgets its text.
      if (note.key === key) fieldEl.value = "";
      else drafts.delete(key);
      liveEl.textContent = "Note sent";
      setTimeout(() => {
        if (liveEl.textContent === "Note sent") liveEl.textContent = "";
      }, 2000);
    } else showError(`Could not send the note: ${result.message}`);
    syncSend();
  });

  return {
    /**
     * Draws the whole bar from the current state.
     * @param {{ feed: object[], follow: { enabled: boolean, paused: boolean }, connected: boolean, now?: number, exists: (event: object) => boolean, note: ReturnType<typeof noteState> }} state
     */
    render({ feed, follow, connected, now = Date.now(), exists, note: nextNote }) {
      barEl.dataset.connection = connected ? "live" : "offline";
      connectionEl.dataset.state = connected ? "live" : "offline";
      $("connection-label").textContent = connected ? "Live" : "Offline";
      connectionEl.dataset.tooltip = connected ? "Live reload: connected" : "Live reload disconnected, retrying";

      const status = agentStatus({ feed, follow, connected, now, exists });
      statusEl.dataset.look = status.look;
      foldedStatusEl.dataset.look = status.look;
      fillActivityText($("agent-status-text"), status.text);
      $("agent-status-detail").textContent = status.detail;
      $("agent-bar-folded-text").textContent = `${status.text.before}${status.text.name ?? ""}${status.text.after}`;
      const paused = follow.enabled && follow.paused;
      followRowEl.hidden = paused;
      pausedRowEl.hidden = !paused;
      switchEl.checked = follow.enabled;

      renderActivityFeed(feedEl, $("agent-feed-empty"), feed, { exists, onSelect, now: () => now });
      renderNote(nextNote);
    },
    /** A tool panel took (or gave back) the column below: fold (or unfold) with it. @param {boolean} open */
    setPanelOpen(open) {
      if (panelOpen === open) return;
      panelOpen = open;
      applyFold();
    },
    /** A new project: nothing typed for the last one carries over. */
    reset() {
      drafts.clear();
      fieldEl.value = "";
      note = { ...note, key: "none" };
      showError("");
      syncSend();
    },
  };
}
