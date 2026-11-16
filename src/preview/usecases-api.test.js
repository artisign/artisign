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
      ["deleteDataObject", "deleteDimension", "deletePersona", "deleteUseCase", "fetchUseCaseSource", "generatePersonas", "getUseCase", "getUseCases", "setUseCases", "suggestUseCaseVariants"].sort(),
    );
    expect(api.callTool).toBeUndefined();
  });

  it("sends only the six tool names, with the four delete kinds", async () => {
    const sent = stubFetch();
    await api.getUseCases("/p", { limit: 1 });
    await api.getUseCase("/p", "a");
    await api.suggestUseCaseVariants("/p", "a", 1);
    await api.setUseCases("/p", { personas: [] });
    await api.generatePersonas("/p", { dry_run: true });
    await api.deletePersona("/p", "x");
    await api.deleteDimension("/p", "x");
    await api.deleteDataObject("/p", "x");
    await api.deleteUseCase("/p", "x");
    const tools = sent.map((s) => /\/api\/tools\/([a-z_]+)\?project=/.exec(s.url)?.[1]);
    expect([...new Set(tools)].sort()).toEqual(["delete_entity", "generate_personas", "get_use_case", "get_use_cases", "set_use_cases", "suggest_use_case_variants"]);
    expect(sent.every((s) => s.method === "POST" && s.url.includes("project=%2Fp"))).toBe(true);
    expect(sent.filter((s) => s.url.includes("/delete_entity")).map((s) => s.body)).toEqual([
      { kind: "persona", name: "x" },
      { kind: "dimension", name: "x" },
      { kind: "data_object", name: "x" },
      { kind: "use_case", name: "x" },
    ]);
  });

  it("reads the stored case from the internal route, not from a tool", async () => {
    const sent = stubFetch();
    await api.fetchUseCaseSource("/p", "a b");
    expect(sent[0].url).toBe("/api/use-case?id=a%20b&project=%2Fp");
    expect(sent[0].method).toBe("GET");
  });

  it("no other use-case source module names /api/tools/ (tests and fixtures excluded)", () => {
    const sources = readdirSync(dir).filter((f) => /^usecases.*\.js$/.test(f) && !/\.test(-helper)?\.js$/.test(f) && f !== "usecases-api.js");
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) expect(readFileSync(join(dir, file), "utf-8"), file).not.toContain("/api/tools/");
  });
});
