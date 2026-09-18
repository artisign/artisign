// Live reload: subscribes to /events and dispatches each change event to a
// handler. Heartbeat/comment lines (anything not starting with "data: ")
// are ignored by EventSource itself — it only fires onmessage for the
// `data:` field. Also carries project lifecycle events — daemon-wide,
// broadcast to every connected client regardless of which project (or none)
// it resolved to.

/**
 * @param {{
 *   project?: string, // the project root currently displayed, so the server resolves
 *     the right project's change stream (falls back to the daemon's active project when omitted)
 *   onChange: (event: { type: "change", kind: string, name: string }) => void,
 *   onLifecycle?: (event: { type: "project-switched" | "project-opened" | "project-closed", root: string }) => void,
 *   onBoardState?: (event: { type: "board_state", filter: string | null, pinned: string[], source: "agent" | "human" }) => void,
 *     // CHR-624/ADR-005 — the Board's shared filter/pinned state changed, from EITHER door
 *     // (POST /api/tools/set_board_state, i.e. this browser or another tab, or an MCP agent's
 *     // set_board_state). No event for a no-op patch or a pure read. `source` distinguishes
 *     // "agent" (CHR-625's tab-switch/banner, not this ticket) from "human" — always re-render
 *     // from the event regardless of which; there's no cheaper way to tell "another tab" apart
 *     // from "this one, echoed back", and trying to suppress the echo isn't worth the complexity.
 *   onActivity?: (event: { type: "activity", tool: string, kind: "read" | "write", target: object | null, nodes: string[], ok: boolean, at: number }) => void,
 *     // CHR-630/CHR-631/ADR-005 — one per MCP tool call (src/mcp/activity.ts), regardless of
 *     // follow mode's own on/off/paused state — the activity feed fills even while follow is
 *     // off; only navigation/highlighting is gated on follow state, and that gating lives in
 *     // the caller (app.js), not here.
 *   onOpen?: (isReconnect: boolean) => void, // fires on every successful (re)connect;
 *     `isReconnect` is false for the very first connect and true for every one after a drop, so
 *     the caller can resync state it may have missed while disconnected (EventSource itself only
 *     replays messages sent after it re-opens, never the gap)
 *   onDisconnect?: () => void,
 * }} options
 * @returns {EventSource}
 */
export function connectEvents({ project, onChange, onLifecycle, onBoardState, onActivity, onOpen, onDisconnect }) {
  const url = project ? `/events?project=${encodeURIComponent(project)}` : "/events";
  const source = new EventSource(url);
  let hasOpenedBefore = false;

  source.onopen = () => {
    onOpen?.(hasOpenedBefore);
    hasOpenedBefore = true;
  };
  source.onerror = () => onDisconnect?.();

  source.onmessage = (evt) => {
    try {
      const parsed = JSON.parse(evt.data);
      if (parsed.type === "change") onChange(parsed);
      else if (parsed.type === "board_state") onBoardState?.(parsed);
      else if (parsed.type === "activity") onActivity?.(parsed);
      else if (
        parsed.type === "project-switched" ||
        parsed.type === "project-opened" ||
        parsed.type === "project-closed"
      )
        onLifecycle?.(parsed);
    } catch {
      // Non-JSON messages (e.g. the initial ":ok" comment) never reach
      // onmessage, but ignore anything unparseable defensively.
    }
  };

  return source;
}
