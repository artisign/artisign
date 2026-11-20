import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initProject } from "../init/init-project.js";
import { FsStore } from "../store/index.js";
import { setupGitConfig, setupProject, type GitConfigFixture, type ProjectFixture } from "./test-fixtures.js";
import { deleteEntity } from "./lifecycle.js";
import { getUseCase, listUseCases, setUseCases } from "./usecases.js";
import type { Warning } from "./types.js";
import { TOOLS } from "./registry.js";
import { z } from "zod";
import { resolveParticipant } from "../usecases/index.js";

const execFileAsync = promisify(execFile);

const DIMENSIONS = [
  { id: "household", label: "Household", scope: "constellations", values: [{ id: "two-parents", label: "Two parents" }, { id: "single-parent", label: "Single parent" }] },
  { id: "age-group", label: "Age group", values: [{ id: "school", label: "School" }, { id: "adult", label: "Adult" }] },
];
const PERSONAS = [
  { id: "maria", name: "Maria", kind: "human", traits: { household: "two-parents" } },
  { id: "insurer-north", name: "North Insurance", kind: "organization" },
];
const ENTITIES = [
  { id: "leo", name: "Leo", type: "Child", traits: { "age-group": "school" } },
  { id: "policy-liability", name: "Household liability policy", type: "Policy", object: "policy" },
];
const RELATIONSHIP_TYPES = [
  { id: "parent-of", label: "is parent of", inverse_label: "is child of", same_traits: ["household"] },
  { id: "holds", label: "holds", field: { object: "policy", name: "holder" } },
  { id: "insures", label: "insures" },
];
const CONSTELLATIONS = [
  {
    id: "one-parent-one-child",
    name: "One parent, one co-insured child",
    traits: { household: "single-parent" },
    relationships: [
      { from: "maria", type: "parent-of", to: "leo" },
      { from: "maria", type: "holds", to: "policy-liability" },
      { from: "insurer-north", type: "insures", to: "policy-liability" },
    ],
  },
];
const WORLD = { entities: ENTITIES, relationship_types: RELATIONSHIP_TYPES, constellations: CONSTELLATIONS };

function neutralCase(): Record<string, unknown> {
  return {
    id: "review-premium",
    title: "Review a premium",
    personas: ["maria"],
    inputs: [{ object: "policy", example: { premium: 120 } }],
    outputs: [{ object: "policy", example: { premium: 138 } }],
    steps: [{ id: "open", actor: "maria", action: "Opens the premium" }],
  };
}

describe("world pool (ADR-011)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  const world = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(fx.dir, "usecases", "world.json"), "utf-8"));

  describe("persona kind and dimension scope", () => {
    it("accepts the four kinds and both scopes and stores them", async () => {
      const res = await setUseCases(fx.store, {
        dimensions: DIMENSIONS,
        personas: ["human", "agent", "service", "organization"].map((kind) => ({ id: `p-${kind}`, name: kind, kind })),
      });
      expect(res).toMatchObject({ dimensions: { created: 2 }, personas: { created: 4 } });
      const pool = await fx.store.readPersonaPool();
      expect(pool.dimensions.map((d) => d.scope)).toEqual(["constellations", undefined]);
      expect(pool.personas.map((p) => p.kind)).toEqual(["human", "agent", "service", "organization"]);
    });

    it.each([
      ["an unknown kind", { personas: [{ id: "bot", name: "Bot", kind: "robot" }] }, /personas\[0\] \(bot\)\.kind/],
      ["an unknown scope", { dimensions: [{ ...DIMENSIONS[0], scope: "worlds" }] }, /dimensions\[0\] \(household\)\.scope/],
      ["the persona id system", { personas: [{ id: "system", name: "System" }] }, /personas\[0\] \(system\)\.id: .*reserved/],
      ["the entity id system", { entities: [{ id: "system", name: "System" }] }, /entities\[0\] \(system\)\.id: .*reserved/],
    ])("refuses %s and writes nothing", async (_label, input, message) => {
      await expect(setUseCases(fx.store, input)).rejects.toMatchObject({ code: "validation_failed", message: expect.stringMatching(message) });
      await expect(readFile(join(fx.dir, "usecases", "personas.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(fx.dir, "usecases", "world.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("leaves a stored file without kind and scope valid", async () => {
      await mkdir(join(fx.dir, "usecases"), { recursive: true });
      await writeFile(join(fx.dir, "usecases", "personas.json"), JSON.stringify({ dimensions: [{ id: "d", label: "D", values: [{ id: "a", label: "A" }] }], personas: [{ id: "p", name: "P" }] }));
      await expect(fx.store.readPersonaPool()).resolves.toMatchObject({ personas: [{ id: "p" }] });
      await expect(listUseCases(fx.store, {})).resolves.not.toHaveProperty("warnings");
    });
  });

  describe("set_use_cases and the world file", () => {
    it("creates world.json lazily, reports created per kind and keeps order", async () => {
      await expect(readFile(join(fx.dir, "usecases", "world.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
      const res = await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, ...WORLD });
      expect(res).toMatchObject({ entities: { created: 2, updated: 0 }, relationship_types: { created: 3, updated: 0 }, constellations: { created: 1, updated: 0 } });
      const stored = await world();
      expect(stored).toMatchObject({
        entities: [{ id: "leo" }, { id: "policy-liability" }],
        relationship_types: [{ id: "parent-of" }, { id: "holds" }, { id: "insures" }],
        constellations: [{ id: "one-parent-one-child" }],
      });
      expect(await readFile(join(fx.dir, "usecases", "world.json"), "utf-8")).toMatch(/\n$/);
      await expect(fx.store.readWorld()).resolves.toEqual(stored);
    });

    it("merges an existing entity shallowly, null removes a key, relationships replace whole", async () => {
      await setUseCases(fx.store, WORLD);
      const res = await setUseCases(fx.store, {
        entities: [{ id: "leo", name: "Leo S.", type: null }],
        constellations: [{ id: "one-parent-one-child", relationships: [{ from: "maria", type: "parent-of", to: "leo" }] }],
      });
      expect(res).toMatchObject({ entities: { created: 0, updated: 1 }, constellations: { created: 0, updated: 1 } });
      const stored = (await fx.store.readWorld());
      expect(stored.entities[0]).toEqual({ id: "leo", name: "Leo S.", traits: { "age-group": "school" } });
      expect(stored.constellations[0]!.relationships).toHaveLength(1);
      expect(stored.entities).toHaveLength(2);
    });

    it("refuses a malformed world entity as a whole and writes nothing of the call", async () => {
      await expect(
        setUseCases(fx.store, { personas: PERSONAS, entities: ENTITIES, constellations: [{ id: "no-relationships", name: "Broken" }] }),
      ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("constellations[0] (no-relationships).relationships") });
      await expect(readFile(join(fx.dir, "usecases", "personas.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(fx.dir, "usecases", "world.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects an unknown key (strict shapes) and a duplicate id in the call", async () => {
      await expect(setUseCases(fx.store, { entities: [{ id: "leo", name: "Leo", color: "red" }] })).rejects.toMatchObject({ code: "validation_failed" });
      await expect(setUseCases(fx.store, { entities: [ENTITIES[0]!, ENTITIES[0]!] })).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("appears twice") });
    });

    it("requires at least one key, naming all of them", async () => {
      await expect(setUseCases(fx.store, {})).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("entities, relationship_types, constellations") });
    });

    it("refuses a world.json it cannot trust instead of coercing it away", async () => {
      await mkdir(join(fx.dir, "usecases"), { recursive: true });
      await writeFile(join(fx.dir, "usecases", "world.json"), `{ "entities": [{ "id": "BAD" }] }`);
      await expect(setUseCases(fx.store, { entities: ENTITIES })).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("usecases/world.json") });
      await expect(fx.store.writeWorld({ entities: [{ id: "BAD", name: "x", traits: {} }], relationship_types: [], constellations: [] })).rejects.toThrow(/refusing to write/);
    });

    it("writes personas, then world, then data objects, then cases, in one commit file set", async () => {
      const order: string[] = [];
      const store = fx.store;
      for (const method of ["writePersonaPool", "writeWorld", "writeDataObjects", "writeUseCase"] as const) {
        const original = store[method].bind(store) as (arg: never) => Promise<void>;
        (store as unknown as Record<string, unknown>)[method] = async (arg: never): Promise<void> => {
          order.push(method);
          await original(arg);
        };
      }
      await setUseCases(store, { use_cases: [neutralCase()], data_objects: [{ id: "policy", name: "Policy", fields: [] }], ...WORLD, personas: PERSONAS, dimensions: DIMENSIONS });
      expect(order).toEqual(["writePersonaPool", "writeWorld", "writeDataObjects", "writeUseCase"]);
    });

    it("does not touch world.json when the call names no world entity", async () => {
      await setUseCases(fx.store, { personas: PERSONAS });
      await expect(readFile(join(fx.dir, "usecases", "world.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("ambiguous_id", () => {
    it("warns on write, still writes both and names the ids the call touched", async () => {
      const res = await setUseCases(fx.store, { personas: [{ id: "leo", name: "Leo the persona" }], entities: [{ id: "leo", name: "Leo the entity" }] });
      expect(res).toMatchObject({ personas: { created: 1 }, entities: { created: 1 } });
      expect((res.warnings as Warning[]).filter((w) => w.kind === "ambiguous_id")).toEqual([expect.objectContaining({ target: "persona:leo", message: expect.stringContaining("resolve to the persona") })]);
      expect((await fx.store.readPersonaPool()).personas.map((p) => p.id)).toEqual(["leo"]);
      expect((await fx.store.readWorld()).entities.map((e) => e.id)).toEqual(["leo"]);
    });

    it("warns when a later call creates the second one, and not for untouched ids", async () => {
      await setUseCases(fx.store, { personas: [{ id: "leo", name: "Leo" }, { id: "maria", name: "Maria" }] });
      const ambiguous = (res: { warnings?: unknown }): Warning[] => (res.warnings as Warning[]).filter((w) => w.kind === "ambiguous_id");
      expect(ambiguous(await setUseCases(fx.store, { entities: [{ id: "policy", name: "Policy" }] }))).toEqual([]);
      const res = await setUseCases(fx.store, { entities: [{ id: "leo", name: "Leo" }] });
      expect(ambiguous(res)).toEqual([expect.objectContaining({ target: "persona:leo" })]);
    });

    it("also warns on read, in get_use_case", async () => {
      await setUseCases(fx.store, { personas: [{ id: "maria", name: "Maria" }], use_cases: [neutralCase()], data_objects: [{ id: "policy", name: "Policy", fields: [{ name: "premium", type: "number" }] }] });
      expect((await getUseCase(fx.store, { id: "review-premium" })).warnings).toEqual([]);
      await setUseCases(fx.store, { entities: [{ id: "maria", name: "Maria" }] });
      expect((await getUseCase(fx.store, { id: "review-premium" })).warnings).toEqual([expect.objectContaining({ kind: "ambiguous_id", target: "persona:maria" })]);
    });

    it("resolves a shared id to the persona", async () => {
      await setUseCases(fx.store, { personas: [{ id: "leo", name: "Leo" }], entities: [{ id: "leo", name: "Leo" }, { id: "policy", name: "Policy" }] });
      const personas = (await fx.store.readPersonaPool()).personas;
      const entities = (await fx.store.readWorld()).entities;
      expect(resolveParticipant("leo", personas, entities)).toBe("persona");
      expect(resolveParticipant("policy", personas, entities)).toBe("entity");
      expect(resolveParticipant("nobody", personas, entities)).toBeUndefined();
    });
  });

  describe("delete_entity kinds", () => {
    beforeEach(async () => {
      await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: [{ id: "policy", name: "Policy", fields: [] }], ...WORLD });
    });

    it("deletes an entity from world.json and warns about the constellations naming it", async () => {
      const res = await deleteEntity(fx.store, { kind: "entity", name: "leo", force: true });
      expect(res).toMatchObject({ kind: "entity", name: "leo", path: "usecases/world.json" });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "dangling_reference", target: "entity:leo", message: expect.stringContaining("one-parent-one-child") })]);
      expect((await fx.store.readWorld()).entities.map((e) => e.id)).toEqual(["policy-liability"]);
      expect((await fx.store.readWorld()).constellations).toHaveLength(1);
    });

    it("deletes a relationship type and warns about the constellations using it", async () => {
      const res = await deleteEntity(fx.store, { kind: "relationship_type", name: "parent-of", force: true });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "dangling_reference", target: "relationship_type:parent-of", message: expect.stringContaining("one-parent-one-child") })]);
      expect((await fx.store.readWorld()).relationship_types.map((t) => t.id)).toEqual(["holds", "insures"]);
    });

    it("deletes a constellation without a warning", async () => {
      const res = await deleteEntity(fx.store, { kind: "constellation", name: "one-parent-one-child", force: true });
      expect(res).toMatchObject({ kind: "constellation", path: "usecases/world.json", warnings: [] });
      expect((await fx.store.readWorld()).constellations).toEqual([]);
    });

    it.each(["entity", "constellation", "relationship_type"] as const)("answers not_found for an unknown %s", async (kind) => {
      await expect(deleteEntity(fx.store, { kind, name: "nope" })).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses cascade like every use-case kind", async () => {
      await expect(deleteEntity(fx.store, { kind: "entity", name: "leo", cascade: true })).rejects.toMatchObject({ code: "validation_failed" });
    });

    it("extends the persona, dimension and data_object scans to the world", async () => {
      const persona = await deleteEntity(fx.store, { kind: "persona", name: "maria", force: true });
      expect(persona.warnings).toEqual([expect.objectContaining({ target: "persona:maria", message: expect.stringContaining("constellation") })]);

      const dimension = await deleteEntity(fx.store, { kind: "dimension", name: "household", force: true });
      const messages = (dimension.warnings as { message: string }[]).map((w) => w.message).join("\n");
      expect(messages).toContain("constellation(s)"); // constellation trait
      expect(messages).toContain("relationship type(s) via same_traits");

      const age = await deleteEntity(fx.store, { kind: "dimension", name: "age-group", force: true });
      expect((age.warnings as { message: string }[])[0]!.message).toContain("entity(ies)");

      const object = await deleteEntity(fx.store, { kind: "data_object", name: "policy", force: true });
      const objectMessages = (object.warnings as { message: string }[]).map((w) => w.message).join("\n");
      expect(objectMessages).toContain("entity(ies)");
      expect(objectMessages).toContain("relationship type(s) via field");
    });
  });

  describe("tool surface", () => {
    it("names every use-case kind and the new set_use_cases keys in the tool definitions", () => {
      const del = TOOLS.find((t) => t.name === "delete_entity")!;
      for (const kind of ["persona", "dimension", "entity", "relationship_type", "constellation", "data_object", "use_case"]) expect(del.description).toContain(kind);
      const delShape = z.object(del.inputShape);
      expect(delShape.safeParse({ kind: "constellation", name: "x" }).success).toBe(true);
      expect(delShape.safeParse({ kind: "nonsense", name: "x" }).success).toBe(false);
      const set = TOOLS.find((t) => t.name === "set_use_cases")!;
      for (const key of ["entities", "relationship_types", "constellations"]) expect(set.description).toContain(key);
    });
  });
});

describe("world.json in preview commits (ctx.source: human)", () => {
  const human = { source: "human" as const };
  let dir: string;
  let store: FsStore;
  let gitConfig: GitConfigFixture;

  const gitRaw = async (...args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd: dir })).stdout;
  const git = async (...args: string[]): Promise<string> => (await gitRaw(...args)).trim();
  const lastFiles = async (): Promise<string[]> => (await git("show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean).sort();
  const dirty = async (): Promise<string[]> => (await gitRaw("status", "--porcelain", "-uall")).split("\n").filter(Boolean).map((line) => line.slice(3)).sort();

  beforeEach(async () => {
    gitConfig = await setupGitConfig({ name: "Test", email: "test@example.com" });
    dir = await mkdtemp(join(tmpdir(), "artisign-world-preview-"));
    await initProject(dir);
    store = new FsStore(dir);
    await setUseCases(store, { dimensions: DIMENSIONS, personas: PERSONAS });
  });
  afterEach(async () => {
    await gitConfig.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("commits a new world.json alone", async () => {
    await writeFile(join(dir, "stray.txt"), "left over");
    const res = await setUseCases(store, WORLD, human);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git("log", "-1", "--format=%s")).toBe("set_use_cases (preview): 2 entities, 3 relationship_types, 1 constellations");
    expect(await lastFiles()).toEqual(["usecases/world.json"]);
    expect(await dirty()).toEqual(["stray.txt"]);
  });

  it("commits a modified tracked world.json alone and keeps personas.json out of it", async () => {
    await setUseCases(store, WORLD);
    expect(await dirty()).toEqual([]);
    await writeFile(join(dir, "usecases", "personas.json"), `${JSON.stringify({ ...(await store.readPersonaPool()), personas: [] })}\n`);
    const res = await setUseCases(store, { entities: [{ id: "leo", name: "Leo S." }] }, human);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await lastFiles()).toEqual(["usecases/world.json"]);
    expect(await dirty()).toEqual(["usecases/personas.json"]);
  });

  it("commits the world.json a world delete rewrote", async () => {
    await setUseCases(store, WORLD);
    await deleteEntity(store, { kind: "relationship_type", name: "insures", force: true }, human);
    expect(await git("log", "-1", "--format=%s")).toBe("delete_entity (preview): relationship_type:insures");
    expect(await lastFiles()).toEqual(["usecases/world.json"]);
  });
});
