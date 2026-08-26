// Thin wrappers over the preview's internal HTTP API. No caching here —
// each SSE change event triggers a fresh fetch of whatever it invalidates.

/** @returns {Promise<{ name: string, tags: string[], notes: string }[]>} */
export async function fetchScreens() {
  const res = await fetch("/api/screens");
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
 * @returns {Promise<{ ok: true, html: string } | { ok: false, status: number, message: string }>}
 */
export async function fetchRender(screen) {
  return fetchRenderAt(`/api/render/${encodeURIComponent(screen)}`);
}

/**
 * @returns {Promise<{ ok: true, mockups: { name: string, title?: string, description?: string, tags: string[], variants: { id: string, title: string, description?: string }[] }[] } | { ok: false, status: number, message: string }>}
 */
export async function fetchMockups() {
  const res = await fetch("/api/mockups");
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
 * @returns {Promise<{ ok: true, html: string } | { ok: false, status: number, message: string }>}
 */
export async function fetchMockupRender(name, variant) {
  return fetchRenderAt(`/api/render/mockup/${encodeURIComponent(name)}/${encodeURIComponent(variant)}`);
}

/**
 * All flow edges across every screen, for the Board view.
 * @returns {Promise<{ from: string, event: string, to: string, to_kind: string }[]>}
 */
export async function fetchFlows() {
  const res = await fetch("/api/flows");
  const body = await res.json();
  return body.flows ?? [];
}

/** @returns {Promise<Record<string, unknown>>} */
export async function fetchDesignSystem() {
  const res = await fetch("/api/design-system");
  return res.json();
}

/**
 * All comment records (flat, open and resolved) for one screen, via the
 * dedicated preview route — the storage-facing shape (`node_id`/`text`/
 * `resolved`/`ts`), not the MCP-facing `PublicComment` shape.
 * @param {string} screen
 * @returns {Promise<{ id: string, screen: string, node_id: string | null, text: string, author: "human" | "agent", parent_id: string | null, resolved: boolean, ts: string }[]>}
 */
export async function fetchComments(screen) {
  const res = await fetch(`/api/comments?screen=${encodeURIComponent(screen)}`);
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
 * Switches the active project among the ones already open — no filesystem
 * work, just a registry pointer flip.
 * @param {string} root
 * @returns {Promise<{ ok: true, projects: object } | { ok: false, message: string }>}
 */
export async function activateProject(root) {
  const res = await fetch("/api/projects/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
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
 * The Elements panel's node list for a screen, in document order: each
 * model node's id/tag plus its refs (component/variant/token), the same
 * shape `get_node`'s summary view returns per node — see reads.ts.
 * @param {string} screen
 * @returns {Promise<{ ok: true, nodes: { id: string, tag: string, parent_id: string | null, refs?: { component_ref?: string, variant?: string, token_refs?: Record<string, unknown> } }[] } | { ok: false, message: string }>}
 */
export async function fetchScreenNodes(screen) {
  const res = await fetch("/api/tools/get_screen", {
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
 * Creates a human-authored comment: a new root comment anchored to a node
 * or the screen itself (`node_id: null`), or — when `parent_id` is given
 * instead of `screen`/`node_id` — a human reply on an existing thread
 * (screen/node are inherited from the thread's root). Agents only ever
 * reply through the separate `reply_comment` MCP tool.
 * @param {{ screen: string, node_id: string | null, text: string } | { parent_id: string, text: string }} input
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function postComment(input) {
  const res = await fetch("/api/comments", {
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
