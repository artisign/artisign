// Thin wrappers over the preview's internal HTTP API. No caching here —
// each SSE change event triggers a fresh fetch of whatever it invalidates.

/**
 * @param {string} project REQUIRED — every call in this module is scoped to
 *   the project the calling tab is displaying (`activeProjectRoot` in
 *   app.js), same convention as sse.js's `connectEvents` and fetchBoardState/
 *   setBoardState below: an omitted `?project=` falls back to the daemon-WIDE
 *   active project, which is a real gap with two tabs open on different
 *   projects (CHR-651).
 * @returns {Promise<{ name: string, tags: string[], notes: string }[]>}
 */
export async function fetchScreens(project) {
  const res = await fetch(`/api/screens?project=${encodeURIComponent(project)}`);
  const body = await res.json();
  return body.screens;
}

/**
 * Shared GET-and-return-as-a-document logic behind fetchRender and
 * fetchMockupRender — same {ok, html}/{ok: false, status, message} shape
 * either way, just a different URL.
 * @param {string} url
 * @returns {Promise<{ ok: true, html: string } | { ok: false, status: number, message: string }>}
 */
async function fetchRenderAt(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    return { ok: false, status: res.status, message: body.message ?? res.statusText };
  }
  return { ok: true, html: await res.text() };
}

/**
 * @param {string} screen
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ ok: true, html: string } | { ok: false, status: number, message: string }>}
 */
export async function fetchRender(screen, project) {
  return fetchRenderAt(`/api/render/${encodeURIComponent(screen)}?project=${encodeURIComponent(project)}`);
}

/**
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ ok: true, mockups: { name: string, title?: string, description?: string, tags: string[], variants: { id: string, title: string, description?: string }[] }[] } | { ok: false, status: number, message: string }>}
 */
export async function fetchMockups(project) {
  const res = await fetch(`/api/mockups?project=${encodeURIComponent(project)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    return { ok: false, status: res.status, message: body.message ?? res.statusText };
  }
  const body = await res.json();
  return { ok: true, mockups: body.mockups ?? [] };
}

/**
 * @param {string} name
 * @param {string} variant
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ ok: true, html: string } | { ok: false, status: number, message: string }>}
 */
export async function fetchMockupRender(name, variant, project) {
  return fetchRenderAt(`/api/render/mockup/${encodeURIComponent(name)}/${encodeURIComponent(variant)}?project=${encodeURIComponent(project)}`);
}

/**
 * Every tag in the project carrying its own notes (CHR-596) — a spec that
 * spans several screens, set once via set_meta({target:{kind:"tag",tag}})
 * instead of duplicated into every tagged screen's own notes.
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ tag: string, notes: string }[]>}
 */
export async function fetchTags(project) {
  const res = await fetch(`/api/tags?project=${encodeURIComponent(project)}`);
  const body = await res.json();
  return body.tags ?? [];
}

/**
 * All flow edges across every screen, for the Board view.
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ from: string, event: string, to: string, to_kind: string }[]>}
 */
export async function fetchFlows(project) {
  const res = await fetch(`/api/flows?project=${encodeURIComponent(project)}`);
  const body = await res.json();
  return body.flows ?? [];
}

/**
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchDesignSystem(project) {
  const res = await fetch(`/api/design-system?project=${encodeURIComponent(project)}`);
  return res.json();
}

/**
 * All comment records (flat, open and resolved) for one screen, via the
 * dedicated preview route — the storage-facing shape (`node_id`/`text`/
 * `resolved`/`ts`), not the MCP-facing `PublicComment` shape.
 * @param {string} screen
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ id: string, screen: string, node_id: string | null, text: string, author: "human" | "agent", parent_id: string | null, resolved: boolean, ts: string }[]>}
 */
export async function fetchComments(screen, project) {
  const res = await fetch(`/api/comments?screen=${encodeURIComponent(screen)}&project=${encodeURIComponent(project)}`);
  const body = await res.json();
  return body.comments ?? [];
}

/**
 * The daemon's project registry state — every open project plus which one
 * is active, plus recent (previously opened, still-existing) project paths.
 * @returns {Promise<{ active: string | null, open: { root: string, name: string }[], recent: string[] }>}
 */
export async function fetchProjects() {
  const res = await fetch("/api/projects");
  return res.json();
}

/**
 * Opens (if needed) and activates a project already known by its root path
 * — either an already-open one (switch) or an unopened-but-valid directory.
 * @param {string} dir
 * @returns {Promise<{ ok: true, projects: object } | { ok: false, message: string }>}
 */
export async function openProject(dir) {
  const res = await fetch("/api/projects/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: body.message ?? res.statusText };
  return { ok: true, projects: body };
}

/**
 * Scaffolds a new project at `dir` (optionally named `name`), then opens
 * and activates it.
 * @param {string} dir
 * @param {string} [name]
 * @returns {Promise<{ ok: true, projects: object } | { ok: false, message: string }>}
 */
export async function initProject(dir, name) {
  const res = await fetch("/api/projects/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name ? { dir, name } : { dir }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: body.message ?? res.statusText };
  return { ok: true, projects: body };
}

/**
 * Directory listing for the open/init-project folder browser.
 * @param {string} path
 * @returns {Promise<{ ok: true, path: string, parent: string | null, entries: { name: string, path: string, isArtisignProject: boolean }[], home: string } | { ok: false, message: string }>}
 */
export async function fetchFsDirs(path) {
  const res = await fetch(path ? `/api/fs/dirs?path=${encodeURIComponent(path)}` : "/api/fs/dirs");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: body.message ?? res.statusText };
  return { ok: true, ...body };
}

/**
 * Creates one folder inside `parent` (`POST /api/fs/dirs`). `code` carries the
 * route's error code so the folder browser can phrase it (already_exists,
 * validation_failed, permission_denied, not_found).
 * @param {string} parent absolute path of the folder currently shown
 * @param {string} name a single path segment
 * @returns {Promise<{ ok: true, name: string, path: string } | { ok: false, code: string | undefined, message: string }>}
 */
export async function createFsDir(parent, name) {
  const res = await fetch("/api/fs/dirs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent, name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, code: body.code, message: body.message ?? res.statusText };
  return { ok: true, ...body };
}

/**
 * The Elements panel's node list for a screen, in document order: each
 * model node's id/tag plus its refs (component/variant/token), the same
 * shape `get_node`'s summary view returns per node — see reads.ts.
 * @param {string} screen
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ ok: true, nodes: { id: string, tag: string, parent_id: string | null, refs?: { component_ref?: string, variant?: string, token_refs?: Record<string, unknown> } }[] } | { ok: false, message: string }>}
 */
export async function fetchScreenNodes(screen, project) {
  const res = await fetch(`/api/tools/get_screen?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ screen, view: "full", fields: ["nodes"] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: body.message ?? res.statusText };
  // Text nodes appear in `nodes` with no `tag` at all — the Elements panel
  // only lists real elements.
  const nodes = (body.nodes ?? []).filter((n) => typeof n.tag === "string");
  return { ok: true, nodes };
}

/**
 * The node-level diff of each of `others` against the `base` screen
 * (CHR-738, GET /api/compare) — bare node ids, `low_overlap` members carry
 * no diff lists.
 * @param {string} base the reference screen
 * @param {string[]} others 1-3 screens compared against it
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ ok: true, compare: { base: string, members: { screen: string, status: "ok" | "low_overlap", overlap: { shared: number, base: number, member: number, ratio: number }, added: string[], removed: { id: string, parent: string | null }[], changed: string[], counts: { added: number, removed: number, changed: number } }[] } } | { ok: false, status: number, message: string }>}
 */
export async function fetchCompare(base, others, project) {
  const res = await fetch(
    `/api/compare?base=${encodeURIComponent(base)}&others=${encodeURIComponent(others.join(","))}&project=${encodeURIComponent(project)}`,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, message: body.message ?? res.statusText };
  return { ok: true, compare: body };
}

/**
 * Creates a human-authored comment: a new root comment anchored to a node
 * or the screen itself (`node_id: null`), or — when `parent_id` is given
 * instead of `screen`/`node_id` — a human reply on an existing thread
 * (screen/node are inherited from the thread's root). Agents only ever
 * reply through the separate `reply_comment` MCP tool.
 * @param {{ screen: string, node_id: string | null, text: string } | { parent_id: string, text: string }} input
 * @param {string} project see fetchScreens's own note — required here too.
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function postComment(input, project) {
  const res = await fetch(`/api/comments?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ message: res.statusText }));
    return { ok: false, message: errorBody.message ?? res.statusText };
  }
  return { ok: true };
}

/**
 * The Board's shared filter/pinned state (CHR-624/ADR-005) — for initial
 * paint and resync. Doesn't include `shown_screens` (only the write route
 * echoes that, and only to whichever tab made the write) — every OTHER
 * caller (this one, and every tab's SSE `board_state` handler) derives the
 * visible set itself from `filter`+`pinned`+the already-loaded screen list,
 * via board.js's `computeBoardVisibility`.
 *
 * @param {string} project REQUIRED, not optional — board state is
 *   per-project daemon memory, and both this route and
 *   `POST /api/tools/set_board_state` fall back to the daemon-WIDE active
 *   project when `?project=` is omitted (a real gap found in review: with
 *   two tabs open on different projects, an omitted `?project=` here would
 *   silently read/write whichever project happens to be active elsewhere,
 *   not the one this tab is showing). Always the project THIS tab is
 *   displaying (`activeProjectRoot` in app.js) — same convention as
 *   sse.js's `connectEvents`.
 * @returns {Promise<{ filter: string | null, pinned: string[], expanded: string[] }>} `expanded` (CHR-729/733): the expanded board clusters, names stored as given (a main screen or any variant)
 */
export async function fetchBoardState(project) {
  const res = await fetch(`/api/board-state?project=${encodeURIComponent(project)}`);
  return res.json();
}

/**
 * Writes a Board-state patch — a filter change, a pin/unpin, or Clear pins
 * — as `ctx.source: "human"` (an agent's equivalent write goes through MCP
 * `set_board_state` instead). Broadcasts to every tab on this project via
 * SSE, INCLUDING the one that called this; the response here is used only
 * to detect a failed write, never applied directly — see sse.js's
 * `board_state` handling in app.js for why (the "simplest correct client":
 * always re-render from the broadcast, never try to suppress your own echo).
 *
 * @param {string} project see fetchBoardState's own note — required here too.
 * @param {{
 *   filter?: string | null,
 *   pins?: { op: "add" | "remove" | "set", screens: string[] } | { op: "clear" },
 *   expanded?: { op: "add" | "remove" | "set", screens: string[] } | { op: "clear" },
 * }} patch `expanded` (CHR-733) has the same shape as `pins`
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function setBoardState(project, patch) {
  const res = await fetch(`/api/tools/set_board_state?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    return { ok: false, message: body.message ?? res.statusText };
  }
  return { ok: true };
}

/**
 * The daemon-stored preview preferences (CHR-924, GET /api/settings). A failed
 * request or a malformed body is `null` — the caller then runs without
 * persistence rather than crashing the preview.
 * @returns {Promise<{ prefs: Record<string, string>, migrated: boolean } | null>}
 */
export async function fetchSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return null;
    return parseSettings(await res.json());
  } catch {
    return null;
  }
}

/**
 * Merges `prefs` into the stored settings (POST /api/settings); a `null` value removes the key. Best-effort: resolves `false` on any failure.
 * @param {Record<string, string | null>} prefs
 * @returns {Promise<boolean>}
 */
export async function saveSettings(prefs) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefs }),
      keepalive: true, // a pref changed right before a reload or close still reaches the daemon
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One-time carry-over of this browser's localStorage prefs (POST /api/settings/import) — the daemon applies it only while its settings are not yet `migrated`. `null` on failure or an unusable response.
 * @param {Record<string, string>} prefs
 * @returns {Promise<{ prefs: Record<string, string>, migrated: boolean } | null>}
 */
export async function importSettings(prefs) {
  try {
    const res = await fetch("/api/settings/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefs }),
    });
    if (!res.ok) return null;
    return parseSettings(await res.json());
  } catch {
    return null;
  }
}

/** Tolerant reading of a settings body; `{}` counts as "nothing stored, not migrated", anything that is not an object with string-only prefs is rejected. */
function parseSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const prefs = body.prefs ?? {};
  if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) return null;
  const clean = {};
  for (const [k, v] of Object.entries(prefs)) if (typeof v === "string") clean[k] = v;
  return { prefs: clean, migrated: body.migrated === true };
}

/**
 * Facts about the running daemon (GET /api/about): the version for the settings menu, and the update check (CHR-927) — `updateCheck` is "off" when the user disabled it, `latest` the newest published version once the daemon knows it. Fields an older daemon does not send read as "check on, nothing known". `null` on any failure.
 * @returns {Promise<{ version: string, updateCheck: "on" | "off", latest?: string, updateAvailable: boolean } | null>}
 */
export async function fetchAbout() {
  try {
    const res = await fetch("/api/about");
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.version !== "string") return null;
    const latest = typeof body.latest === "string" ? body.latest : undefined;
    return { version: body.version, updateCheck: body.updateCheck === "off" ? "off" : "on", latest, updateAvailable: body.updateAvailable === true && latest !== undefined };
  } catch {
    return null;
  }
}

/**
 * Which AI tools are installed / connected and what to copy to connect each by hand (CHR-926, GET /api/setup — the daemon reads the disk on every call). Copy-only: nothing is written. `null` on any failure or a malformed body.
 * @returns {Promise<{ command: string, clients: { name: string, found: boolean, connected: boolean, manual: { kind: "command", text: string } | { kind: "config", path?: string, text: string } }[] } | null>}
 */
export async function fetchSetup() {
  try {
    const res = await fetch("/api/setup");
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.command !== "string" || !Array.isArray(body.clients)) return null;
    const clients = body.clients.filter(
      (c) => typeof c?.name === "string" && typeof c.manual?.text === "string" && (c.manual.kind === "command" || c.manual.kind === "config"),
    );
    return { command: body.command, clients };
  } catch {
    return null;
  }
}

/**
 * Release notes from the CHANGELOG the running daemon shipped with (CHR-928, GET /api/whats-new): the released sections newer than `since` up to the running version, newest first — every released section without `since`. `null` on any failure or a malformed body.
 * @param {string | null} [since]
 * @returns {Promise<{ version: string, releases: { version: string, date: string | null, body: string }[] } | null>}
 */
export async function fetchWhatsNew(since) {
  try {
    const res = await fetch(since ? `/api/whats-new?since=${encodeURIComponent(since)}` : "/api/whats-new");
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.version !== "string" || !Array.isArray(body.releases)) return null;
    const releases = body.releases.filter((r) => typeof r?.version === "string" && typeof r.body === "string").map((r) => ({ version: r.version, date: typeof r.date === "string" ? r.date : null, body: r.body }));
    return { version: body.version, releases };
  } catch {
    return null;
  }
}
