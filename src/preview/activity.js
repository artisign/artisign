// Follow mode (CHR-628/CHR-629/CHR-630/CHR-631, ADR-005): the daemon emits
// one `activity` SSE event per MCP tool call (src/mcp/activity.ts —
// `{ tool, kind: "read"|"write", target: {kind,name,variant?}|null, nodes:
// string[], ok, at }`). This module turns that stream into feed rows, a
// navigation decision, and a follow on/off/paused state machine — the pure
// pieces app.js can't unit-test itself. DOM rendering for the feed and the
// follow toggle lives alongside it, same split as comments.js/mockups.js.

import { highlightSelection, bareNodeId } from "./comments.js";
import { handleListArrowKeys, setRovingTabindex } from "./menu-keys.js";

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
 * Deliberately NOT used for a feed click (see navigateToActivity and
 * handleActivityFeedSelect in app.js) — a feed click navigates
 * unconditionally, having already paused follow like every other human
 * navigation; only the LIVE path is gated on it.
 * @param {object} event
 * @param {FollowState} followState
 * @param {{ screenNames: string[], mockupNames: string[] }} lists
 * @returns {{ kind: string, name: string, variant?: string } | null}
 */
export function resolveFollowNavigation(event, followState, lists) {
  if (!canFollowNavigate(followState)) return null;
  // CHR-779 — ADR-005: a component/pattern target navigates too (to the Design System view); activityIsNavigable alone never says so.
  const target = event.target;
  if (event.tool !== "delete_entity" && (target?.kind === "component" || target?.kind === "pattern")) return target;
  return activityIsNavigable(event, lists);
}

/**
 * CHR-779 — whether a live event should be HELD instead of dropped: follow
 * is armed and the event targets a screen/mockup that isn't in the lists
 * YET. `activity` and `change` travel on one stream but the activity event
 * of a create (`write_html`, `promote_mockup`) can beat the `change` that
 * adds the entity, so the lists are merely stale, not the target deleted.
 * `delete_entity` never qualifies — its target is gone for good.
 * @param {object} event
 * @param {FollowState} followState
 * @param {{ screenNames: string[], mockupNames: string[] }} lists
 */
export function followAwaitsTarget(event, followState, lists) {
  if (!canFollowNavigate(followState) || event.tool === "delete_entity") return false;
  return activityNavigationTarget(event) !== null && !activityTargetExists(event, lists);
}

/** The one short node id worth showing after the target label (e.g. "line-4") — omitted for `write_html` (its one node IS the screen root, not a specific element to point at) and whenever there isn't exactly one affected node. */
function nodeLabel(event) {
  if (event.tool === "write_html" || event.nodes.length !== 1) return null;
  return bareNodeId(event.nodes[0]);
}

/** The text of a feed row, in the design's words (`agent-activity`): "Wrote **home**", "Read the project", "Could not update **settings**". `name` is the one bold part.
 * @typedef {{ before: string, name: string | null, after: string }} ActivityText */

const WROTE = ["Wrote", "Writing", "write"];
const UPDATED = ["Updated", "Updating", "update"];
const VERBS = {
  inspect_node: ["Inspected", "Inspecting", "inspect"],
  delete_entity: ["Deleted", "Deleting", "delete"],
  create_comment: ["Commented", "Commenting", "comment"],
  reply_comment: ["Replied to a comment", "Replying to a comment", "reply to a comment"],
  write_html: WROTE,
  write_mockup: WROTE,
  import_html: WROTE,
  promote_mockup: WROTE,
};
const READ = ["Read", "Reading", "read"];

/** What a call with no single target is about, in a few words ("the project"). */
const BROAD_SUBJECTS = {
  get_design_system: "the design system",
  set_tokens: "the design system tokens",
  list_comments: "the comments",
  get_guide: "the guide",
  list_use_cases: "the use cases",
  get_use_case: "the use cases",
  set_use_cases: "the use cases",
  suggest_use_case_variants: "the use cases",
  set_board_state: "the Board",
};

/** @returns {[string, string, string]} past, progressive and base form of the call's verb */
function verbFor(event) {
  const own = VERBS[event.tool];
  if (own) return own;
  return event.kind === "read" ? READ : UPDATED;
}

/**
 * The words of one feed row or of the live status: `progressive` gives "Writing home" (what the agent does now), otherwise "Wrote home" (what it did). A failed call says what failed ("Could not update settings", the daemon sends no reason); a call on a target that is gone says so.
 * @param {{ tool: string, kind: "read" | "write", ok: boolean, target: object | null, nodes: string[] }} event
 * @param {{ gone?: boolean, progressive?: boolean }} [options] `gone`: the target no longer exists
 * @returns {ActivityText}
 */
export function describeActivity(event, { gone = false, progressive = false } = {}) {
  const [past, ing, base] = verbFor(event);
  const target = event.target;
  let pre = "";
  let name = null;
  let post = "";
  // The agent's comment calls carry no target (src/mcp/activity.ts): the verb stands alone, with no invented object.
  if (!target) pre = BROAD_SUBJECTS[event.tool] ?? (event.tool === "create_comment" || event.tool === "reply_comment" ? "" : "the project");
  else if (target.kind === "mockup") {
    pre = "mockup";
    name = target.name;
    post = target.variant ? `, variant ${target.variant}` : "";
  } else if (target.kind === "component" || target.kind === "pattern") {
    pre = target.kind;
    name = target.name;
  } else {
    name = target.name;
    const node = nodeLabel(event);
    post = node ? `, ${node}` : "";
  }
  const words = (verb) => [verb, pre].filter(Boolean).join(" ") + (name !== null ? " " : "");
  if (!event.ok) return { before: words(`Could not ${base}`), name, after: post };
  const suffix = gone && event.tool !== "delete_entity" ? `${post}, which no longer exists` : post;
  return { before: words(progressive ? ing : past), name, after: suffix };
}

/** The visual variant of a feed row (design `agent-activity`): independent of anything but the event and whether its target is gone. */
export function activityVariant(event, gone = false) {
  if (!event.ok) return "error";
  if (gone && event.tool !== "delete_entity") return "deleted";
  if (event.tool === "create_comment" || event.tool === "reply_comment") return "agent-comment";
  return event.kind === "write" ? "write" : "default";
}

const VARIANT_ICONS = { default: "visibility", write: "edit", "agent-comment": "chat_bubble", error: "error", deleted: "link_off" };

/**
 * Whether clicking a feed row does anything: a call that worked, on a target that exists, which the view can go to (a screen, a mockup, or a component/pattern in the Design System).
 * @param {object} event
 * @param {boolean} exists
 */
export function activityIsActionable(event, exists) {
  if (!event.ok || !exists || event.tool === "delete_entity") return false;
  const kind = event.target?.kind;
  return kind === "screen" || kind === "mockup" || kind === "component" || kind === "pattern";
}

/**
 * Relative time for a feed row, in the design's words ("now", "1 min ago", "2 h ago").
 * @param {number} at epoch ms
 * @param {number} [now] epoch ms, injectable for tests
 */
export function formatActivityTime(at, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
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
 * Which action a click on the Follow switch resolves to: off → on; on or paused → off (a paused follow is resumed by its own Resume button).
 * @param {FollowState} state
 * @returns {"toggle-on" | "toggle-off"}
 */
export function followToggleClickAction(state) {
  return state.enabled ? "toggle-off" : "toggle-on";
}

// --- DOM: activity feed ----------------------------------------------------

/**
 * Fills `el` with an activity text: the words, the one name in bold.
 * @param {HTMLElement} el
 * @param {ActivityText} text
 */
export function fillActivityText(el, { before, name, after }) {
  el.textContent = before;
  if (name !== null) {
    const bold = document.createElement("b");
    bold.textContent = name;
    el.append(bold);
  }
  if (after) el.append(after);
}

/** The event behind each actionable row, to find a row again after a re-render. */
const rowEvents = new WeakMap();

/**
 * Renders the Activity feed (design `agent-activity`): an icon box, the words, the time. A row the view can go to is a real <button> (Enter/Space for free); the arrow keys move between them with a roving tab stop, so a feed of fifty is one Tab stop. A failed call, a deleted target and a broad read are plain text: nothing to open.
 * @param {HTMLElement} listEl the <ol>
 * @param {HTMLElement} emptyEl
 * @param {object[]} feed newest first — see pushActivityEntry
 * @param {{ exists: (event: object) => boolean, onSelect: (event: object) => void, now?: () => number }} options
 */
export function renderActivityFeed(listEl, emptyEl, feed, { exists, onSelect, now = Date.now }) {
  // The feed re-renders on every call: the row that had the tab stop (or focus) keeps it, found again by its event.
  const current = /** @type {HTMLElement | null} */ (listEl.contains(document.activeElement) ? document.activeElement : listEl.querySelector('button.agent-activity[tabindex="0"]'));
  const keptEvent = current?.closest("button.agent-activity") ? rowEvents.get(/** @type {HTMLElement} */ (current.closest("button.agent-activity"))) : undefined;
  const hadFocus = listEl.contains(document.activeElement) && document.activeElement !== listEl;
  listEl.innerHTML = "";
  emptyEl.hidden = feed.length > 0;
  listEl.hidden = feed.length === 0;
  const nowMs = now();
  const rows = [];
  for (const event of feed) {
    const stillThere = exists(event);
    const variant = activityVariant(event, !stillThere);
    const li = document.createElement("li");

    const row = document.createElement(activityIsActionable(event, stillThere) ? "button" : "div");
    row.className = "agent-activity";
    row.dataset.variant = variant;
    if (row instanceof HTMLButtonElement) {
      row.type = "button";
      row.addEventListener("click", () => onSelect(event));
      rowEvents.set(row, event);
      rows.push(row);
    }

    const icon = document.createElement("span");
    icon.className = "agent-activity-icon icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = VARIANT_ICONS[variant];
    row.appendChild(icon);

    const main = document.createElement("span");
    main.className = "agent-activity-main";
    const text = document.createElement("span");
    text.className = "agent-activity-text";
    fillActivityText(text, describeActivity(event, { gone: !stillThere }));
    main.appendChild(text);
    const time = document.createElement("time");
    time.className = "agent-activity-time";
    time.dateTime = new Date(event.at).toISOString();
    time.textContent = formatActivityTime(event.at, nowMs);
    main.appendChild(time);
    row.appendChild(main);

    li.appendChild(row);
    listEl.appendChild(li);
  }
  const kept = rows.find((row) => rowEvents.get(row) === keptEvent) ?? rows[0];
  setRovingTabindex(rows, kept);
  if (hadFocus && kept) kept.focus();
  if (!listEl.dataset.keys) {
    listEl.dataset.keys = "on";
    listEl.addEventListener("keydown", (evt) => {
      const actionable = [...listEl.querySelectorAll("button.agent-activity")];
      if (handleListArrowKeys(evt, actionable, { wrap: false })) setRovingTabindex(actionable, /** @type {HTMLElement} */ (document.activeElement));
    });
  }
}

// --- Node/screen highlight --------------------------------------------------

// Literal colors, not var(--chrome-...): these apply inline inside the
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
