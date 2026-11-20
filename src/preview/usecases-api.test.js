// Pins the API boundary of the Use Cases tab (ADR-010): the preview reaches the daemon's use-case tools only through the
// fixed wrappers of usecases-api.js. The tool names and delete kinds are asserted here, and no other module may name /api/tools/.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "./usecases-api.js";

const dir = dirname(fileURLToPath(import.meta.url));

function stubFetch() {
  const sent = [];
  vi.stubGlobal("fetch", async (url, init) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, method: init?.method ?? "GET" });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("usecases-api", () => {
  it("exports exactly the fixed wrappers, and callTool stays private", () => {
    expect(Object.keys(api).sort()).toEqual(
      ["deleteConstellation", "deleteDataObject", "deleteDimension", "deleteMainEntity", "deletePersona", "deleteRelationshipType", "deleteUseCase", "fetchUseCaseSource", "fetchWorldSource", "generatePersonas", "getUseCase", "listUseCases", "setUseCases", "suggestUseCaseVariants"].sort(),
    );
    expect(api.callTool).toBeUndefined();
  });

  it("sends only the six tool names, with the seven delete kinds", async () => {
    const sent = stubFetch();
    await api.listUseCases("/p", { limit: 1 });
    await api.getUseCase("/p", "a");
    await api.suggestUseCaseVariants("/p", "a", 1);
    await api.setUseCases("/p", { personas: [] });
    await api.generatePersonas("/p", { dry_run: true });
    await api.deletePersona("/p", "x");
    await api.deleteDimension("/p", "x");
    await api.deleteDataObject("/p", "x");
    await api.deleteUseCase("/p", "x");
    await api.deleteMainEntity("/p", "x");
    await api.deleteConstellation("/p", "x");
    await api.deleteRelationshipType("/p", "x");
    const tools = sent.map((s) => /\/api\/tools\/([a-z_]+)\?project=/.exec(s.url)?.[1]);
    expect([...new Set(tools)].sort()).toEqual(["delete_entity", "generate_personas", "get_use_case", "list_use_cases", "set_use_cases", "suggest_use_case_variants"]);
    expect(sent.every((s) => s.method === "POST" && s.url.includes("project=%2Fp"))).toBe(true);
    expect(sent.filter((s) => s.url.includes("/delete_entity")).map((s) => s.body)).toEqual([
      { kind: "persona", name: "x" },
      { kind: "dimension", name: "x" },
      { kind: "data_object", name: "x" },
      { kind: "use_case", name: "x" },
      { kind: "entity", name: "x" },
      { kind: "constellation", name: "x" },
      { kind: "relationship_type", name: "x" },
    ]);
  });

  it("sends force: true only when asked, and only from the six pool wrappers (deleteUseCase never sends it)", async () => {
    const sent = stubFetch();
    await api.deletePersona("/p", "x", true);
    await api.deleteDimension("/p", "x", true);
    await api.deleteDataObject("/p", "x", true);
    await api.deleteMainEntity("/p", "x", true);
    await api.deleteConstellation("/p", "x", true);
    await api.deleteRelationshipType("/p", "x", true);
    await api.deletePersona("/p", "y", false);
    await api.deleteUseCase("/p", "x", true);
    expect(sent.map((s) => s.body)).toEqual([
      { kind: "persona", name: "x", force: true },
      { kind: "dimension", name: "x", force: true },
      { kind: "data_object", name: "x", force: true },
      { kind: "entity", name: "x", force: true },
      { kind: "constellation", name: "x", force: true },
      { kind: "relationship_type", name: "x", force: true },
      { kind: "persona", name: "y" },
      { kind: "use_case", name: "x" },
    ]);
  });

  it("reads the stored case from the internal route, not from a tool", async () => {
    const sent = stubFetch();
    await api.fetchUseCaseSource("/p", "a b");
    expect(sent[0].url).toBe("/api/use-case?id=a%20b&project=%2Fp");
    expect(sent[0].method).toBe("GET");
  });

  it("reads the world pool from its own internal route and tolerates a missing list", async () => {
    const sent = stubFetch();
    const res = await api.fetchWorldSource("/p");
    expect(sent[0].url).toBe("/api/world?project=%2Fp");
    expect(sent[0].method).toBe("GET");
    expect(res).toEqual({ ok: true, world: { entities: [], relationship_types: [], constellations: [] }, warnings: [] });
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 422, statusText: "x", json: async () => ({ code: "invalid_state", message: "bad file" }) }));
    expect(await api.fetchWorldSource("/p")).toEqual({ ok: false, status: 422, code: "invalid_state", message: "bad file" });
  });

  it("no other use-case source module names /api/tools/ (tests and fixtures excluded)", () => {
    const sources = readdirSync(dir).filter((f) => /^usecases.*\.js$/.test(f) && !/\.test(-helper)?\.js$/.test(f) && f !== "usecases-api.js");
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) expect(readFileSync(join(dir, file), "utf-8"), file).not.toContain("/api/tools/");
  });
});
