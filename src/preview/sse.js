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
 *   onOpen?: (isReconnect: boolean) => void, // fires on every successful (re)connect;
 *     `isReconnect` is false for the very first connect and true for every one after a drop, so
 *     the caller can resync state it may have missed while disconnected (EventSource itself only
 *     replays messages sent after it re-opens, never the gap)
 *   onDisconnect?: () => void,
 * }} options
 * @returns {EventSource}
 */
export function connectEvents({ project, onChange, onLifecycle, onOpen, onDisconnect }) {
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
