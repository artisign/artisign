// Follow mode (CHR-628/CHR-629/CHR-630/CHR-631, ADR-005): the daemon emits
// one `activity` SSE event per MCP tool call (src/mcp/activity.ts —
// `{ tool, kind: "read"|"write", target: {kind,name,variant?}|null, nodes:
// string[], ok, at }`). This module turns that stream into feed rows, a
// navigation decision, and a follow on/off/paused state machine — the pure
// pieces app.js can't unit-test itself. DOM rendering for the feed and the
// follow toggle lives alongside it, same split as comments.js/mockups.js.

import { highlightSelection, bareNodeId } from "./comments.js";

export const ACTIVITY_FEED_LIMIT = 50;
export const READ_HIGHLIGHT_MS = 1200;
export const WRITE_HIGHLIGHT_MS = 2500;
// CHR-631 spec: a write's highlight waits for the re-render it caused, or
// this long, whichever comes first — see app.js's scheduleActivityHighlight.
export const WRITE_RERENDER_GRACE_MS = 1000;

/**
 * Prepends `event` to `feed` (newest first) and caps it at
 * ACTIVITY_FEED_LIMIT — the whole "last 50 calls" rule in one place.
 * @param {object[]} feed
 * @param {object} event
 * @returns {object[]}
 */
export function pushActivityEntry(feed, event) {
  const next = [event, ...feed];
  return next.length > ACTIVITY_FEED_LIMIT ? next.slice(0, ACTIVITY_FEED_LIMIT) : next;
}

/**
 * Where a targeted activity event should navigate the preview to — null for
 * a broad read (no single target) and for a component/pattern target
 * (their own view has no per-node addressable highlight surface yet; the
 * feed still lists them, they just don't drive the camera — see app.js's
 * cueDesignSystemEntry for the more limited whole-card cue it gets instead).
 * @param {{ target: { kind: string, name: string, variant?: string } | null }} event
 */
export function activityNavigationTarget(event) {
  const target = event.target;
  if (!target) return null;
  return target.kind === "screen" || target.kind === "mockup" ? target : null;
}

/** @param {"read" | "write"} kind */
export function highlightDurationMs(kind) {
  return kind === "write" ? WRITE_HIGHLIGHT_MS : READ_HIGHLIGHT_MS;
}

/** Feed row visual variant, independent of whether the row's target still exists (see activityTargetExists) — that's the caller's job, since it needs the live screens/mockups lists this module doesn't hold. */
export function activityEntryVariant(event) {
  if (!event.ok) return "error";
  return event.kind === "write" ? "write" : "default";
}

/**
 * Whether a feed entry's own target still exists, given the CURRENT
 * screen/mockup name lists — a row for a deleted target renders inert
 * ("deleted" variant) and must never throw on click. A broad read or a
 * component/pattern target is never considered deleted; there's nothing
 * here to check either against.
 * @param {{ target: { kind: string, name: string } | null }} event
 * @param {{ screenNames: string[], mockupNames: string[] }} lists
 */
export function activityTargetExists(event, { screenNames, mockupNames }) {
  const target = event.target;
  if (!target) return true;
  if (target.kind === "screen") return screenNames.includes(target.name);
  if (target.kind === "mockup") return mockupNames.includes(target.name);
  return true;
}

/**
 * Where a targeted activity event should navigate the preview to, gated on
 * the target still existing — the combination navigateToActivity actually
 * needs (review fix 2/3): `activityNavigationTarget` alone says nothing
 * about a `delete_entity` (or any other write) whose own target has, by
 * the time this event arrives, already vanished. The feed already applies
 * `activityTargetExists` at render time (a deleted-target row never gets a
 * click handler); this is the same check for the LIVE follow/jump path,
 * which has no render step to have applied it in.
 *
 * `delete_entity` is special-cased ahead of the `lists` check, not covered
 * by it: `activity`'s own SSE event for a delete can arrive before the
 * `change` event that removes the entity from `screens`/`mockups` client-
 * side (the same ordering race write_html's own render has, just on the
 * OTHER SSE stream this time) — a `lists`-only check would still pass on a
 * still-stale list and briefly navigate to what the daemon has already
 * deleted. `delete_entity`'s target is gone by definition, so there is no
 * ordering to race: it is never navigable, independent of what `lists`
 * happens to say yet.
 * @param {object} event
 * @param {{ screenNames: string[], mockupNames: string[] }} lists
 * @returns {{ kind: string, name: string, variant?: string } | null}
 */
export function activityIsNavigable(event, lists) {
  if (event.tool === "delete_entity") return null;
  const target = activityNavigationTarget(event);
  if (!target) return null;
  return activityTargetExists(event, lists) ? target : null;
}

/** Whether follow-mode navigation should actually run right now — the ADR-005 "following, not paused" condition, extracted so both the initial gate and a later re-check (e.g. after a throttle window closes) apply the exact same rule. */
export function canFollowNavigate(state) {
  return state.enabled && !state.paused;
}

/**
 * The single decision behind live follow-mode navigation: given an
 * activity event, the current follow state, and the live screens/mockups
 * lists, should the view navigate to this event's target right now?
 * Combines the follow gate (`canFollowNavigate`) and the existence check
 * (`activityIsNavigable`) that used to be applied separately at each of
 * throttledActivityNavigate's TWO decision points in app.js (the
 * immediate-elapsed branch and the delayed timer-fire branch) — every one
 * of the three high/medium review-round-1 bugs came from one of those two
 * call sites re-deriving (or forgetting to re-derive) part of this rule on
 * its own. app.js now calls this ONE function at both points instead —
 * the "throttle window" itself stays app.js's own timing/queueing
 * concern (it decides WHEN to call this, not what it decides), but the
 * actual navigate-or-not verdict for either call is exactly this.
 *
 * Deliberately NOT used for a feed click (see feedClickPausesFollow and
 * navigateToActivity in app.js) — a feed click navigates unconditionally,
 * regardless of follow's own state; only the LIVE path is gated on it.
 * @param {object} event
 * @param {FollowState} followState
 * @param {{ screenNames: string[], mockupNames: string[] }} lists
 * @returns {{ kind: string, name: string, variant?: string } | null}
 */
export function resolveFollowNavigation(event, followState, lists) {
  if (!canFollowNavigate(followState)) return null;
  return activityIsNavigable(event, lists);
}

/**
 * Whether clicking a feed entry should pause follow — it never does
 * (ADR-005 amendment, decided by Christian on 2026-09-18): browsing the
 * agent's own history is not the human navigating away to design
 * something themselves, so the next live navigating call still pulls the
 * view back to the agent's current target. Pinned here as one pure,
 * tested fact — handleActivityFeedSelect's only job is to honour it —
 * rather than a comment at a call site that simply never calls
 * pauseFollow, which is exactly the shape every review-round-1 bug had.
 * @returns {false}
 */
export function feedClickPausesFollow() {
  return false;
}

/** The one short node id worth showing after the target label (e.g. "line-4") — omitted for `write_html` (its one node IS the screen root, not a specific element to point at) and whenever there isn't exactly one affected node. */
function nodeLabel(event) {
  if (event.tool === "write_html" || event.nodes.length !== 1) return null;
  return bareNodeId(event.nodes[0]);
}

/** @param {{ target: object | null, tool: string, nodes: string[] }} event */
export function formatActivityTarget(event) {
  const target = event.target;
  if (!target) return "project-wide";
  if (target.kind === "mockup") return target.variant ? `mockup · ${target.name} / ${target.variant}` : `mockup · ${target.name}`;
  if (target.kind === "component") return `component · ${target.name}${target.variant ? "#" + target.variant : ""}`;
  if (target.kind === "pattern") return `pattern · ${target.name}`;
  const label = nodeLabel(event);
  return label ? `screen · ${target.name} · ${label}` : `screen · ${target.name}`;
}

/**
 * Relative time for a feed row ("just now", "4s ago", "2m ago", ...).
 * @param {number} at epoch ms
 * @param {number} [now] epoch ms, injectable for tests
 */
export function formatActivityTime(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// --- Follow on/off/paused state machine -----------------------------------

/** @typedef {{ enabled: boolean, paused: boolean }} FollowState */

/** @type {FollowState} */
export const FOLLOW_OFF = { enabled: false, paused: false };

/**
 * The follow toggle's state machine (ADR-005's pause precedence). Every
 * action is a no-op in a state it doesn't apply to (e.g. "pause" while
 * already off or already paused), so callers can fire a trigger
 * unconditionally — "pause on every human navigation" — without checking
 * the current state first.
 * @param {FollowState} state
 * @param {"toggle-on" | "toggle-off" | "pause" | "resume"} action
 * @returns {FollowState}
 */
export function nextFollowState(state, action) {
  switch (action) {
    case "toggle-on":
      return { enabled: true, paused: false };
    case "toggle-off":
      return FOLLOW_OFF;
    case "pause":
      return state.enabled && !state.paused ? { enabled: true, paused: true } : state;
    case "resume":
      return state.enabled && state.paused ? { enabled: true, paused: false } : state;
    default:
      return state;
  }
}

/**
 * Which action a click on the follow toggle resolves to. `hitResume` is
 * true only when the click landed on the "Resume" affordance itself (only
 * present/hittable while paused, per the `$follow-toggle` `paused` variant)
 * — clicking anywhere else on an already-paused toggle turns follow off
 * outright, same as clicking an active "following" toggle does.
 * @param {FollowState} state
 * @param {boolean} hitResume
 */
export function followToggleClickAction(state, hitResume) {
  if (!state.enabled) return "toggle-on";
  if (state.paused) return hitResume ? "resume" : "toggle-off";
  return "toggle-off";
}

// --- DOM: follow toggle ----------------------------------------------------

/**
 * Syncs the follow toggle to `state` — `data-state` on the outer pill
 * drives the off/following/paused look (style.css), the divider/"Resume"
 * button included; `aria-pressed` belongs on the actual toggle BUTTON
 * (review fix 4 — it's a sibling of "Resume" now, not the same element),
 * so this takes both separately.
 * @param {HTMLElement} containerEl the outer `.follow-toggle` pill
 * @param {HTMLElement} toggleButtonEl the toggle button (dot + label)
 * @param {HTMLElement} labelEl
 * @param {FollowState} state
 */
export function renderFollowToggle(containerEl, toggleButtonEl, labelEl, state) {
  const uiState = !state.enabled ? "off" : state.paused ? "paused" : "following";
  containerEl.dataset.state = uiState;
  toggleButtonEl.setAttribute("aria-pressed", String(state.enabled && !state.paused));
  labelEl.textContent = uiState === "off" ? "Follow" : uiState === "following" ? "Following" : "Follow paused";
}

// --- DOM: activity feed ----------------------------------------------------

/**
 * Renders the activity feed list — `activity-entry`'s four variants
 * (default/write/error/deleted) via a class, and only wires a click handler
 * on rows that are actually navigable (not a failed call, not a deleted
 * target) so an inert row can never throw on click.
 * @param {HTMLElement} listEl
 * @param {HTMLElement} emptyEl
 * @param {object[]} feed newest first — see pushActivityEntry
 * @param {{ exists: (event: object) => boolean, onSelect: (event: object) => void, now?: () => number }} options
 */
export function renderActivityFeed(listEl, emptyEl, feed, { exists, onSelect, now = Date.now }) {
  listEl.innerHTML = "";
  emptyEl.hidden = feed.length > 0;
  const nowMs = now();
  for (const event of feed) {
    const gone = !exists(event);
    const variant = gone ? "deleted" : activityEntryVariant(event);
    const inert = variant === "error" || gone;

    // A real <button> (same pattern as screens.js/mockups.js's own list
    // rows), not a <li> with a click listener (review fix 4): Enter/Space
    // activation and tab-stop focus come for free from the native element
    // instead of a hand-rolled keydown handler. `aria-disabled`, not the
    // `disabled` attribute, on an inert row — same reasoning as the board
    // zoom buttons' own aria-disabled use — keeps it perceivable to a
    // screen reader as a distinct state while staying focusable; no click
    // handler is attached at all for one, so activating it is a no-op
    // rather than something that has to check its own inertness first.
    const li = document.createElement("li");
    li.className = "activity-entry-row";

    const row = document.createElement("button");
    row.type = "button";
    row.className = `activity-entry activity-entry-${variant}`;
    if (inert) row.setAttribute("aria-disabled", "true");

    const mark = document.createElement("span");
    mark.className = "activity-entry-mark";
    mark.setAttribute("aria-hidden", "true");
    row.appendChild(mark);

    const body = document.createElement("span");
    body.className = "activity-entry-body";
    const tool = document.createElement("span");
    tool.className = "activity-entry-tool";
    tool.textContent = event.tool;
    body.appendChild(tool);
    const target = document.createElement("span");
    target.className = "activity-entry-target";
    target.textContent = gone ? "target removed" : formatActivityTarget(event);
    body.appendChild(target);
    row.appendChild(body);

    const time = document.createElement("span");
    time.className = "activity-entry-time";
    time.textContent = formatActivityTime(event.at, nowMs);
    row.appendChild(time);

    if (!inert) row.addEventListener("click", () => onSelect(event));
    li.appendChild(row);
    listEl.appendChild(li);
  }
}

// --- Node/screen highlight --------------------------------------------------

// Literal colors, not var(--color-...): these apply inline inside the
// sandboxed iframe document, which never sees the preview shell's own
// stylesheet/custom properties — same reason comments.js's own outline
// styles are literal hex, not CSS variables.
const READ_NODE_STYLE = "outline: 2px solid #0d9488; outline-offset: 1px;";
const WRITE_NODE_STYLE = "outline: 2px dashed #7c3aed; outline-offset: 1px; background: rgba(124, 58, 237, 0.08);";

/**
 * Highlights one or more nodes of `doc` — reusing comments.js's
 * highlightSelection mechanism (capture/restore the element's inline
 * style) with the read/write styles instead of the comment-selection one —
 * and auto-clears after the read/write duration. Falls back to the screen
 * root when `bareNodeIds` is empty (a targeted read/write with no specific
 * node, e.g. `get_screen`/`write_html`). Returns a cancel function that
 * clears the highlight early (e.g. a screen switch mid-highlight).
 * @param {Document} doc
 * @param {string[]} bareNodeIds
 * @param {"read" | "write"} kind
 * @returns {() => void}
 */
export function highlightNodes(doc, bareNodeIds, kind) {
  const style = kind === "write" ? WRITE_NODE_STYLE : READ_NODE_STYLE;
  const ids = bareNodeIds.length > 0 ? bareNodeIds : [null];
  const cleanups = ids.map((id) => highlightSelection(doc, id, style));
  const clearAll = () => cleanups.forEach((fn) => fn());
  const timer = setTimeout(clearAll, highlightDurationMs(kind));
  return () => {
    clearTimeout(timer);
    clearAll();
  };
}

/**
 * Shows the whole-screen highlight on `overlayEl` — a border sibling of the
 * iframe inside #screen-holder, sized via `inset: 0` in style.css rather
 * than a getBoundingClientRect copy, since the iframe already fills that
 * container exactly. Used for `write_html` (dashed violet + "Updated"
 * badge, style.css's default look) and for any OTHER targeted call whose
 * `nodes` resolved to none — e.g. `get_screen`/`get_mockup`, a whole-screen
 * read with no specific element to point at (solid teal, no badge,
 * `activity-screen-highlight-read` — an outline drawn on the screen ROOT
 * element itself, inside the iframe, would otherwise sit exactly on the
 * iframe's own edge and get clipped by its nested browsing context; this
 * overlay lives in the PARENT document instead, same as the write case).
 * Auto-hides after the read/write duration. Returns a cancel function that
 * hides it early.
 * @param {HTMLElement} overlayEl
 * @param {"read" | "write"} kind
 * @returns {() => void}
 */
export function highlightScreen(overlayEl, kind) {
  overlayEl.classList.toggle("activity-screen-highlight-read", kind === "read");
  overlayEl.hidden = false;
  const timer = setTimeout(() => {
    overlayEl.hidden = true;
  }, highlightDurationMs(kind));
  return () => {
    clearTimeout(timer);
    overlayEl.hidden = true;
  };
}
