// Use Cases tab — the preview's calls to the daemon. Every use-case tool call goes through one of the fixed wrappers
// below; `callTool` is private, so no caller can name a tool or a delete kind (ADR-010). The one extra read,
// GET /api/use-case (`fetchUseCaseSource`) and GET /api/world (`fetchWorldSource`), are internal routes, not tools: the stored case
// for the edit form, and the stored world pool (entities, relationship types, constellations) for the World tab and the filter.
// Every call names its project (see api.js fetchScreens).

/** @typedef {{ ok: true, data: Record<string, any> } | { ok: false, status: number, code?: string, message: string }} ToolResult */

/**
 * @param {string} project
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {Promise<ToolResult>}
 */
async function callTool(project, tool, input = {}) {
  let res;
  try {
    res = await fetch(`/api/tools/${tool}?project=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, code: body.code, message: body.message ?? res.statusText };
  return { ok: true, data: body };
}

/** One page of use-case summaries (`limit` at most 100) with facets and counts on the first page; empty filters mean "no filter". */
export const listUseCases = (project, input) => callTool(project, "list_use_cases", input);

export const getUseCase = (project, id, variant) => callTool(project, "get_use_case", variant ? { id, variant } : { id });

export const suggestUseCaseVariants = (project, id, limit) => callTool(project, "suggest_use_case_variants", limit === undefined ? { id } : { id, limit });

/** Bulk upsert (shallow merge) of any of dimensions / personas / data_objects / use_cases. Warnings come back in the response and never block. */
export const setUseCases = (project, payload) => callTool(project, "set_use_cases", payload);

export const generatePersonas = (project, input) => callTool(project, "generate_personas", input);

export const deletePersona = (project, id) => callTool(project, "delete_entity", { kind: "persona", name: id });

export const deleteDimension = (project, id) => callTool(project, "delete_entity", { kind: "dimension", name: id });

export const deleteDataObject = (project, id) => callTool(project, "delete_entity", { kind: "data_object", name: id });

export const deleteUseCase = (project, id) => callTool(project, "delete_entity", { kind: "use_case", name: id });

// The three world kinds (ADR-011): fixed wrappers like the four above, so the seven kinds stay the only ones the preview can name.
export const deleteMainEntity = (project, id) => callTool(project, "delete_entity", { kind: "entity", name: id });

export const deleteConstellation = (project, id) => callTool(project, "delete_entity", { kind: "constellation", name: id });

export const deleteRelationshipType = (project, id) => callTool(project, "delete_entity", { kind: "relationship_type", name: id });

/**
 * The stored use case as written (variants with their step ops included).
 * @returns {Promise<{ ok: true, useCase: Record<string, any> } | { ok: false, status: number, code?: string, message: string }>}
 */
export async function fetchUseCaseSource(project, id) {
  let res;
  try {
    res = await fetch(`/api/use-case?id=${encodeURIComponent(id)}&project=${encodeURIComponent(project)}`);
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, code: body.code, message: body.message ?? res.statusText };
  return { ok: true, useCase: body.use_case };
}

/**
 * The world pool as stored: entities, relationship types and constellations (GET /api/world, an internal route, not a tool).
 * A project without world.json answers empty lists.
 * @returns {Promise<{ ok: true, world: { entities: any[], relationship_types: any[], constellations: any[] }, warnings: any[] } | { ok: false, status: number, code?: string, message: string }>}
 */
export async function fetchWorldSource(project) {
  let res;
  try {
    res = await fetch(`/api/world?project=${encodeURIComponent(project)}`);
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, code: body.code, message: body.message ?? res.statusText };
  return { ok: true, world: { entities: body.entities ?? [], relationship_types: body.relationship_types ?? [], constellations: body.constellations ?? [] }, warnings: body.warnings ?? [] };
}
