import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { listUseCases, getUseCase, setUseCases, generatePersonas, suggestVariants } from "./usecases.js";
import { deleteEntity } from "./lifecycle.js";
import type { Warning } from "./types.js";

// CHR-1124: one invalid entry in a pool file is skipped and reported (like an invalid case file) instead of blocking every read.

const DIMENSIONS = [{ id: "membership", label: "Membership", values: [{ id: "student", label: "Student" }, { id: "staff", label: "Staff" }] }];
const PERSONAS = [{ id: "member-ana", name: "Ana", traits: { membership: "student" } }];
const DATA_OBJECTS = [{ id: "loan", name: "Loan", fields: [{ name: "status", type: "enum", values: ["available", "on-loan"] }] }];
const BORROW = {
  id: "borrow-book",
  title: "Borrow a book",
  group: "catalog/loans",
  personas: ["member-ana"],
  trigger: "A member finds a book",
  goal: "Take it home",
  inputs: [{ object: "loan", source: "catalog", example: { status: "available" } }],
  outputs: [{ object: "loan", target: "catalog", example: { status: "on-loan" } }],
  steps: [{ id: "tap", actor: "member-ana", action: "Taps the book" }],
};

type ListRes = { total: number; use_cases: { id: string }[]; counts: Record<string, number>; personas?: { id: string }[]; dimensions?: { id: string }[]; data_objects?: { id: string }[]; warnings?: Warning[]; invalid_file_count?: number; invalid_pool_entry_count?: number };
type GetRes = { personas: { id: string }[]; warnings: Warning[] };

describe("use-case pool files — invalid entries on the read path", () => {
  let fx: ProjectFixture;
  const file = (name: string): string => join(fx.dir, "usecases", name);
  const poolJson = (value: unknown): Promise<void> => writeFile(file("personas.json"), JSON.stringify(value));

  beforeEach(async () => {
    fx = await setupProject();
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, use_cases: [BORROW] });
  });
  afterEach(() => fx.cleanup());

  it("keeps listing and reading when one persona is invalid (the ticket's repro)", async () => {
    await poolJson({ dimensions: [], personas: [{ id: "x" }] });
    const list = (await listUseCases(fx.store, { include: ["personas"] })) as ListRes;
    expect(list.total).toBe(1);
    expect(list.use_cases.map((u) => u.id)).toEqual(["borrow-book"]);
    expect(list.personas).toEqual([]);
    expect(list.warnings).toEqual([
      { kind: "invalid_file", target: "persona:x", message: expect.stringMatching(/^usecases\/personas\.json personas\[0\] \(x\) is not loaded: name: /) },
    ]);
    const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as GetRes;
    expect(bundle.warnings.find((w) => w.kind === "invalid_file")).toMatchObject({ target: "persona:x" });
  });

  it("keeps the valid entries, names entries without an id by position and skips a repeated id", async () => {
    await poolJson({
      dimensions: [{ id: "size", label: "Size", values: [] }, ...DIMENSIONS],
      personas: [{ id: "BAD ID", name: "x" }, ...PERSONAS, { name: "no id" }, { id: "member-ana", name: "Again" }],
    });
    const list = (await listUseCases(fx.store, { include: ["personas", "dimensions"] })) as ListRes;
    expect(list.personas?.map((p) => p.id)).toEqual(["member-ana"]);
    expect(list.dimensions?.map((d) => d.id)).toEqual(["membership"]);
    expect(list.counts).toMatchObject({ personas: 1, dimensions: 1 });
    expect(list.warnings?.map((w) => w.target)).toEqual(["dimension:size", "persona:BAD ID", "persona:#2", "persona:member-ana"]);
    expect(list.warnings?.[3]?.message).toContain("duplicate id");
    expect(list.warnings?.[3]?.message).toContain("personas[3]");
  });

  it("reports an invalid data object and a use case that names a skipped persona still loads", async () => {
    await writeFile(file("data-objects.json"), JSON.stringify({ objects: [...DATA_OBJECTS, { id: "broken" }] }));
    await poolJson({ dimensions: DIMENSIONS, personas: [{ id: "member-ana" }] });
    const list = (await listUseCases(fx.store, {})) as ListRes;
    expect(list.counts).toMatchObject({ data_objects: 1, personas: 0 });
    expect(list.warnings?.map((w) => w.target).sort()).toEqual(["data_object:broken", "persona:member-ana"]);
    const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as GetRes;
    expect(bundle.warnings.map((w) => w.kind)).toContain("invalid_file");
    expect(bundle.warnings.some((w) => w.kind === "unknown_persona")).toBe(true);
  });

  it("reports invalid world entries where the world is read (get_use_case, entity filter)", async () => {
    await writeFile(file("world.json"), JSON.stringify({ entities: [{ id: "branch", name: "Branch" }, { id: "BAD" }], constellations: [{ id: "c" }] }));
    const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as GetRes;
    expect(bundle.warnings.filter((w) => w.kind === "invalid_file").map((w) => w.target)).toEqual(["entity:BAD", "constellation:c"]);
    const list = (await listUseCases(fx.store, { entity: "branch" })) as ListRes;
    expect(list.warnings?.map((w) => w.target)).toEqual(["entity:BAD", "constellation:c"]);
    // A plain listing never reads the world.
    expect(((await listUseCases(fx.store, {})) as ListRes).warnings).toBeUndefined();
  });

  it("caps and counts pool entries and case files separately: neither hides the other", async () => {
    await mkdir(file("cases"), { recursive: true });
    await writeFile(file("cases/broken.json"), "{ nope");
    await poolJson({ dimensions: [], personas: Array.from({ length: 12 }, (_, i) => ({ id: `p-${i}` })) });
    const list = (await listUseCases(fx.store, {})) as ListRes;
    expect(list.warnings).toHaveLength(11);
    expect(list.warnings?.map((w) => w.target)).toEqual([...Array.from({ length: 10 }, (_, i) => `persona:p-${i}`), "use_case:broken"]);
    expect(list.invalid_pool_entry_count).toBe(12);
    expect(list.invalid_file_count).toBeUndefined(); // counts case files only, as before
    for (let i = 0; i < 11; i++) await writeFile(file(`cases/broken-${String(i).padStart(2, "0")}.json`), "{ nope");
    const more = (await listUseCases(fx.store, {})) as ListRes;
    expect(more.warnings?.filter((w) => w.target?.startsWith("use_case:"))).toHaveLength(10);
    expect(more.invalid_file_count).toBe(12);
    expect(more.invalid_pool_entry_count).toBe(12);
  });

  it("marks only the exact skipped id, not an id it is a prefix of", async () => {
    await setUseCases(fx.store, { use_cases: [{ ...BORROW, id: "prefix", personas: ["ana", "ana-staff"], steps: [{ id: "tap", actor: "ana", action: "Taps" }] }] });
    await poolJson({ dimensions: DIMENSIONS, personas: [{ id: "ana" }] });
    const bundle = (await getUseCase(fx.store, { id: "prefix" })) as GetRes;
    const unknown = bundle.warnings.filter((w) => w.kind === "unknown_persona");
    const marked = (id: string): boolean => unknown.filter((w) => w.message.startsWith(`persona "${id}" does not exist`)).every((w) => w.message.includes("is invalid and not loaded"));
    expect(unknown.some((w) => w.message.startsWith('persona "ana" does not exist'))).toBe(true);
    expect(unknown.some((w) => w.message.startsWith('persona "ana-staff" does not exist'))).toBe(true);
    expect(marked("ana")).toBe(true);
    expect(unknown.filter((w) => w.message.startsWith('persona "ana-staff" does not exist')).some((w) => w.message.includes("is invalid and not loaded"))).toBe(false);
  });

  it("marks the world messages about an undeclared relationship type too", async () => {
    await setUseCases(fx.store, {
      entities: [{ id: "branch", name: "Branch" }],
      relationship_types: [{ id: "owns", label: "owns" }],
      constellations: [{ id: "fam", name: "Fam", relationships: [{ from: "member-ana", type: "owns", to: "branch" }] }],
      use_cases: [{ ...BORROW, id: "with-world", constellations: ["fam"] }],
    });
    await writeFile(file("world.json"), JSON.stringify({ entities: [{ id: "branch", name: "Branch" }], relationship_types: [{ id: "owns" }, { id: "own", label: "own" }], constellations: [{ id: "fam", name: "Fam", relationships: [{ from: "member-ana", type: "owns", to: "branch" }] }] }));
    const bundle = (await getUseCase(fx.store, { id: "with-world" })) as GetRes;
    const undeclared = bundle.warnings.find((w) => w.kind === "unknown_relationship_type");
    expect(undeclared?.message).toContain('names undeclared type "owns"');
    expect(undeclared?.message).toContain("its entry in usecases/world.json is invalid and not loaded");
  });

  it("says a skipped entry is unreadable where a case refers to it", async () => {
    await poolJson({ dimensions: DIMENSIONS, personas: [{ id: "member-ana" }] });
    const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as GetRes;
    const unknown = bundle.warnings.find((w) => w.kind === "unknown_persona");
    expect(unknown?.message).toContain("its entry in usecases/personas.json is invalid and not loaded");
  });

  it("suggest_use_case_variants reports skipped entries too", async () => {
    await poolJson({ dimensions: DIMENSIONS, personas: [...PERSONAS, { id: "x" }] });
    const res = (await suggestVariants(fx.store, { id: "borrow-book" })) as { warnings?: Warning[] };
    expect(res.warnings).toEqual([expect.objectContaining({ kind: "invalid_file", target: "persona:x" })]);
  });

  it("a file with nothing to salvage stays invalid_state naming the file", async () => {
    for (const content of ["{ not json", "[]", `{ "personas": {} }`, `{ "personas": [], "extra": 1 }`, "null"]) {
      await writeFile(file("personas.json"), content);
      await expect(listUseCases(fx.store, {})).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("usecases/personas.json") });
      await expect(getUseCase(fx.store, { id: "borrow-book" })).rejects.toMatchObject({ code: "invalid_state" });
    }
    await poolJson({ dimensions: [], personas: [] });
    await writeFile(file("world.json"), "{ not json");
    await expect(getUseCase(fx.store, { id: "borrow-book" })).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("usecases/world.json") });
  });

  it("writes to a pool with an invalid entry stay blocked and leave the file byte-identical", async () => {
    await poolJson({ dimensions: DIMENSIONS, personas: [...PERSONAS, { id: "x" }] });
    const before = await readFile(file("personas.json"), "utf-8");
    const blocked = [
      () => setUseCases(fx.store, { personas: [{ id: "ok", name: "Ok" }] }),
      () => setUseCases(fx.store, { use_cases: [{ ...BORROW, title: "Changed" }] }),
      () => generatePersonas(fx.store, {}),
      () => deleteEntity(fx.store, { kind: "persona", name: "member-ana" }),
      () => deleteEntity(fx.store, { kind: "dimension", name: "membership" }),
    ];
    for (const run of blocked) await expect(run()).rejects.toMatchObject({ message: expect.stringContaining("usecases/personas.json") });
    await expect(setUseCases(fx.store, { personas: [{ id: "ok", name: "Ok" }] })).rejects.toMatchObject({ code: "invalid_state" });
    expect(await readFile(file("personas.json"), "utf-8")).toBe(before);
    // Repaired by hand, writes work again.
    await poolJson({ dimensions: DIMENSIONS, personas: PERSONAS });
    await expect(setUseCases(fx.store, { personas: [{ id: "ok", name: "Ok" }] })).resolves.toMatchObject({ personas: { created: 1 } });
  });

  it("get_use_case puts the case's own warnings first, so skipped pool entries never displace them", async () => {
    await poolJson({ dimensions: DIMENSIONS, personas: Array.from({ length: 60 }, (_, i) => ({ id: `p-${i}` })) });
    const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as GetRes & { warning_count?: number };
    expect(bundle.warnings).toHaveLength(50);
    expect(bundle.warnings[0]?.kind).not.toBe("invalid_file");
    expect(bundle.warnings.some((w) => w.kind === "unknown_persona")).toBe(true);
    expect(bundle.warning_count).toBeGreaterThanOrEqual(61);
  });

  it("suggest_use_case_variants caps and counts its warnings like the other tools", async () => {
    await poolJson({ dimensions: DIMENSIONS, personas: Array.from({ length: 55 }, (_, i) => ({ id: `p-${i}` })) });
    const res = (await suggestVariants(fx.store, { id: "borrow-book" })) as { warnings?: Warning[]; warning_count?: number };
    expect(res.warnings).toHaveLength(50);
    expect(res.warning_count).toBe(55);
  });

  // The strict read (what writes start from) and the lenient read (what reads use) must call the same entries invalid, or a rule added to one path would let a write drop data or a read hide it.
  describe("strict and lenient reads agree", () => {
    const entity = { id: "branch", name: "Branch" };
    const type = { id: "borrows", label: "borrows" };
    const constellation = { id: "c", name: "C", relationships: [{ from: "a", type: "borrows", to: "b" }] };
    const object = { id: "loan", name: "Loan", fields: [{ name: "status", type: "enum", values: ["a"] }] };
    const cases: [string, string, string, unknown[]][] = [
      ["personas.json", "personas", "persona", [{ id: "ok", name: "Ok" }, { id: "x" }, { id: "BAD", name: "x" }, { id: "system", name: "x" }, { id: "a", name: "A", kind: "alien" }, { id: "a", name: "A", extra: 1 }, { id: "a", name: "A", traits: { k: 1 } }, "text", null, []]],
      ["personas.json", "dimensions", "dimension", [DIMENSIONS[0], { id: "d", label: "D", values: [] }, { id: "d", label: "D", values: [{ id: "v", label: "V" }, { id: "v", label: "W" }] }, { id: "d", label: "D", values: [{ id: "v", label: "V" }], scope: "nope" }]],
      ["world.json", "entities", "entity", [entity, { id: "e" }, { id: "system", name: "S" }, { ...entity, traits: { k: 1 } }]],
      ["world.json", "relationship_types", "relationship_type", [type, { id: "t" }, { ...type, field: { object: "o" } }]],
      ["world.json", "constellations", "constellation", [constellation, { id: "c", name: "C" }, { ...constellation, relationships: [{ from: "a" }] }]],
      ["data-objects.json", "objects", "data object", [object, { id: "o" }, { ...object, fields: [{ name: "", type: "string" }] }, { ...object, fields: [{ name: "f", type: "nope" }] }]],
    ];
    const read = {
      "personas.json": [() => fx.store.readPersonaPool(), () => fx.store.readPersonaPoolLenient().then((r) => r.invalid)],
      "world.json": [() => fx.store.readWorld(), () => fx.store.readWorldLenient().then((r) => r.invalid)],
      "data-objects.json": [() => fx.store.readDataObjects(), () => fx.store.readDataObjectsLenient().then((r) => r.invalid)],
    } as const;

    it.each(cases)("%s %s: every fixture, alone and twice", async (name, list, _label, fixtures) => {
      const [strict, lenient] = read[name as keyof typeof read];
      const batches = [...fixtures.map((f) => [f]), ...fixtures.map((f) => [f, f])];
      for (const entries of batches) {
        await writeFile(file(name), JSON.stringify({ [list]: entries }));
        const strictInvalid = await strict().then(() => false, () => true);
        const lenientInvalid = ((await lenient()) as unknown[]).length > 0;
        expect(lenientInvalid, `${list}: ${JSON.stringify(entries)}`).toBe(strictInvalid);
      }
    });
  });
});
