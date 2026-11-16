import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initProject } from "../init/init-project.js";
import { FsStore } from "../store/index.js";
import { setupGitConfig, setupProject, type GitConfigFixture, type ProjectFixture } from "./test-fixtures.js";
import { getProject, getScreen, getDesignSystem, findNodes, listComments } from "./reads.js";
import { writeHtml } from "./writes.js";
import { deleteEntity } from "./lifecycle.js";
import { listUseCases, getUseCase, setUseCases, generatePersonas, suggestVariants } from "./usecases.js";
import { z } from "zod";
import { TOOLS } from "./registry.js";
import type { Warning } from "./types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

const DIMENSIONS = [
  { id: "membership", label: "Membership", values: [{ id: "student", label: "Student" }, { id: "staff", label: "Staff" }] },
  { id: "branch-access", label: "Branch access", values: [{ id: "single", label: "Single" }, { id: "all-branches", label: "All branches" }] },
];
const PERSONAS = [
  { id: "member-ana", name: "Ana", role: "Member", traits: { membership: "student", "branch-access": "single" } },
  { id: "staff-lee", name: "Lee", traits: { membership: "staff", "branch-access": "all-branches" } },
];
const DATA_OBJECTS = [
  { id: "loan", name: "Loan", fields: [{ name: "status", type: "enum", values: ["available", "on-loan"] }, { name: "member", type: "ref", ref: "member" }] },
  { id: "member", name: "Member", fields: [{ name: "name", type: "string" }] },
];

function borrowCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "borrow-book",
    title: "Borrow a book",
    group: "catalog/loans",
    tags: ["loans"],
    personas: ["member-ana"],
    trigger: "A member finds a book",
    goal: "Take it home",
    inputs: [{ object: "loan", source: "catalog", example: { status: "available" } }],
    outputs: [{ object: "loan", target: "catalog", example: { status: "on-loan", member: "Guest" } }],
    steps: [
      { id: "tap-book", actor: "member-ana", action: "Taps the book", target: { screen: "shelf", node: "book-14" } },
      { id: "pick", actor: "member-ana", action: "Picks a copy", target: { screen: "sheet" }, data: [{ object: "loan", before: { status: "available" }, after: { status: "on-loan" } }] },
      { id: "done", actor: "system", action: "Loan is recorded" },
    ],
    ...overrides,
  };
}

type Row = { id: string; [key: string]: unknown };
type ListRes = {
  total: number;
  use_cases: Row[];
  next_cursor?: string;
  counts: Record<string, number>;
  facets: Record<string, Record<string, number>>;
  personas?: Row[];
  dimensions?: Row[];
  warnings?: Warning[];
};
type Bundle = {
  use_case: { personas: string[]; steps: { id: string; change?: string }[]; outputs: { example: unknown }[]; [key: string]: unknown };
  variant?: Row;
  variants?: Row[];
  removed_steps?: Row[];
  personas: Row[];
  dimensions: Row[];
  data_objects: Row[];
  screens: { screen: string; mappings: unknown[] }[];
  warnings: Warning[];
};
type GenRes = { would_create: number; personas: { id: string; traits: object }[] };
type SuggestRes = { suggestions: Row[] };

const kinds = (warnings: unknown): string[] => (warnings as Warning[]).map((w) => w.kind);

describe("use case tools", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  async function seed(): Promise<void> {
    await writeHtml(fx.store, { screen: "shelf", mode: "create", title: "Shelf", html_aug: `<section id="root"><button id="book-14">14</button></section>` });
    await writeHtml(fx.store, { screen: "sheet", mode: "create", title: "Sheet", html_aug: `<section id="sheet-root"><h1 id="sheet-title">Choose a copy</h1></section>` });
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, use_cases: [borrowCase()] });
  }

  describe("optionality — a project without usecases/", () => {
    it("leaves the existing tools' responses unchanged and creates nothing on any read", async () => {
      await writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug: `<div id="n1">Hi</div>` });
      const existing = async (): Promise<string> =>
        JSON.stringify([
          await getProject(fx.store, {}),
          await getProject(fx.store, { view: "tree" }),
          await getProject(fx.store, { view: "full" }),
          await getScreen(fx.store, { screen: "home" }),
          await getDesignSystem(fx.store, {}),
          await findNodes(fx.store, { where: [{ kind: "has_flow" }] }),
          await listComments(fx.store, {}),
        ]);
      const before = await existing();

      const list = await listUseCases(fx.store, { include: ["personas", "dimensions", "data_objects"] });
      expect(list).toMatchObject({ total: 0, use_cases: [], counts: { use_cases: 0, personas: 0, dimensions: 0, data_objects: 0 }, personas: [], dimensions: [], data_objects: [] });
      await expect(getUseCase(fx.store, { id: "nope" })).rejects.toMatchObject({ code: "not_found" });
      await expect(suggestVariants(fx.store, { id: "nope" })).rejects.toMatchObject({ code: "not_found" });
      await expect(generatePersonas(fx.store, { dry_run: true })).rejects.toMatchObject({ code: "validation_failed" });
      for (const kind of ["persona", "data_object", "use_case", "dimension"] as const) {
        await expect(deleteEntity(fx.store, { kind, name: "nope" })).rejects.toMatchObject({ code: "not_found" });
      }

      expect(await existing()).toBe(before);
      await expect(stat(join(fx.dir, "usecases"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(Object.keys(await getProject(fx.store, {})).filter((key) => /use|persona/.test(key))).toEqual([]);
    });
  });

  describe("existing tools do not see use cases", () => {
    it("keeps get_project, get_screen, get_design_system, find_nodes and last_write_at identical once usecases/ exists", async () => {
      await writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug: `<div id="n1">Hi</div>` });
      const existing = async (): Promise<string> =>
        JSON.stringify([
          await getProject(fx.store, {}),
          await getProject(fx.store, { view: "tree" }),
          await getProject(fx.store, { view: "full" }),
          await getScreen(fx.store, { screen: "home" }),
          await getDesignSystem(fx.store, {}),
          await findNodes(fx.store, { where: [{ kind: "has_flow" }] }),
        ]);
      const before = await existing();
      const stamp = ((await getProject(fx.store, {})) as { last_write_at: string }).last_write_at;
      await new Promise((resolve) => setTimeout(resolve, 40));

      await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, use_cases: [borrowCase()] });
      await new Promise((resolve) => setTimeout(resolve, 40));
      await setUseCases(fx.store, { use_cases: [{ id: "borrow-book", title: "Changed" }] });
      await deleteEntity(fx.store, { kind: "persona", name: "staff-lee" });

      expect(await existing()).toBe(before);
      expect(((await getProject(fx.store, {})) as { last_write_at: string }).last_write_at).toBe(stamp);
    });
  });

  describe("inputs and outputs need an example", () => {
    it("rejects an input or output without an example and writes nothing", async () => {
      await expect(setUseCases(fx.store, { use_cases: [borrowCase({ inputs: [{ object: "loan" }] })] })).rejects.toMatchObject({ code: "validation_failed" });
      await expect(setUseCases(fx.store, { use_cases: [borrowCase({ outputs: [{ object: "loan", target: "catalog" }] })] })).rejects.toMatchObject({ code: "validation_failed" });
      await expect(setUseCases(fx.store, { use_cases: [borrowCase({ inputs: [] })] })).rejects.toMatchObject({ code: "validation_failed" });
      await expect(stat(join(fx.dir, "usecases"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("palette", () => {
    it("registers the five use-case tools next to the existing ones", () => {
      const names = TOOLS.map((t) => t.name);
      for (const name of ["list_use_cases", "get_use_case", "set_use_cases", "generate_personas", "suggest_use_case_variants"]) expect(names).toContain(name);
      expect(names).toHaveLength(30);
    });
  });

  describe("generate_personas bounds", () => {
    const wide = (count: number, values: number): Record<string, unknown>[] =>
      Array.from({ length: count }, (_, i) => ({ id: `dim-${i}`, label: `Dim ${i}`, values: Array.from({ length: values }, (_, v) => ({ id: `v${v}`, label: `V${v}` })) }));

    it("refuses pairwise beyond the same space cap as all, without writing", async () => {
      await setUseCases(fx.store, { dimensions: wide(6, 300) }); // 15 dimension pairs x 90,000 = 1,350,000 value pairs
      await expect(generatePersonas(fx.store, { strategy: "pairwise" })).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("value pairs") });
      await expect(generatePersonas(fx.store, { strategy: "pairwise", dimensions: ["dim-0", "dim-1", "dim-2"] })).resolves.toMatchObject({ created: expect.any(Number) });
    });
  });

  describe("set_use_cases", () => {
    it("creates the files lazily, reports created/updated and writes one file per case", async () => {
      const res = await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, use_cases: [borrowCase()] });
      expect(res).toMatchObject({
        dimensions: { created: 2, updated: 0 },
        personas: { created: 2, updated: 0 },
        data_objects: { created: 2, updated: 0 },
        use_cases: { created: 1, updated: 0 },
        commit: null,
      });
      for (const kind of ["dimensions", "personas", "data_objects", "use_cases"] as const) {
        expect(res[kind]).not.toHaveProperty("created_ids");
        expect(res[kind]).not.toHaveProperty("updated_ids");
      }
      expect(JSON.parse(await readFile(join(fx.dir, "usecases", "personas.json"), "utf-8"))).toMatchObject({ dimensions: [{ id: "membership" }, { id: "branch-access" }], personas: [{ id: "member-ana" }, { id: "staff-lee" }] });
      expect(JSON.parse(await readFile(join(fx.dir, "usecases", "data-objects.json"), "utf-8"))).toMatchObject({ objects: [{ id: "loan" }, { id: "member" }] });
      expect(JSON.parse(await readFile(join(fx.dir, "usecases", "cases", "borrow-book.json"), "utf-8"))).toMatchObject({ id: "borrow-book", status: "draft" });
      expect(await readFile(join(fx.dir, "usecases", "cases", "borrow-book.json"), "utf-8")).toMatch(/\n$/);
    });

    describe("a named case whose stored file is invalid", () => {
      const caseFile = (): string => join(fx.dir, "usecases", "cases", "borrow-book.json");
      const BROKEN = `{ "id": "borrow-book" }`; // schema-invalid

      beforeEach(async () => {
        await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, use_cases: [borrowCase()] });
        await writeFile(caseFile(), BROKEN);
      });

      it.each([
        ["schema-invalid", BROKEN],
        ["not valid JSON", "{ not json"],
        ["an id that does not match the filename", JSON.stringify(borrowCase({ id: "other-id" }))],
      ])("fails a partial patch with invalid_state naming the file and leaves it byte-identical (%s)", async (_cause, content) => {
        await writeFile(caseFile(), content);
        const err = await setUseCases(fx.store, { use_cases: [{ id: "borrow-book", status: "ready" }] }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "invalid_state", message: expect.stringContaining("usecases/cases/borrow-book.json") });
        expect(await readFile(caseFile(), "utf-8")).toBe(content);
      });

      it("fails a complete valid replacement too and writes nothing, not even another entity of the same call", async () => {
        const before = await readFile(join(fx.dir, "usecases", "personas.json"), "utf-8");
        const err = await setUseCases(fx.store, {
          personas: [{ id: "guest-kim", name: "Kim" }],
          use_cases: [borrowCase(), borrowCase({ id: "second-case" })],
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "invalid_state", message: expect.stringContaining("usecases/cases/borrow-book.json") });
        expect(await readFile(caseFile(), "utf-8")).toBe(BROKEN);
        expect(await readFile(join(fx.dir, "usecases", "personas.json"), "utf-8")).toBe(before);
        expect(await fx.store.listUseCaseIds()).toEqual(["borrow-book"]);
      });

      it("names every invalid stored case of the call in one invalid_state and writes nothing", async () => {
        await setUseCases(fx.store, { use_cases: [borrowCase({ id: "second-case" }), borrowCase({ id: "third-case" })] });
        const dir = join(fx.dir, "usecases", "cases");
        await writeFile(join(dir, "second-case.json"), "{ not json");
        const before = await readFile(join(fx.dir, "usecases", "personas.json"), "utf-8");
        const err = await setUseCases(fx.store, {
          personas: [{ id: "guest-kim", name: "Kim" }],
          use_cases: [borrowCase(), borrowCase({ id: "second-case" }), borrowCase({ id: "third-case" }), borrowCase({ id: "fresh-case" })],
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "invalid_state" });
        const message = (err as Error).message;
        expect(message).toContain("2 stored use cases are invalid");
        expect(message).toContain("usecases/cases/borrow-book.json");
        expect(message).toContain("usecases/cases/second-case.json");
        expect(message).not.toContain("third-case.json");
        expect(message).toContain('delete_entity {kind: "use_case"');
        expect(await readFile(join(dir, "second-case.json"), "utf-8")).toBe("{ not json");
        expect(await readFile(caseFile(), "utf-8")).toBe(BROKEN);
        expect(await readFile(join(fx.dir, "usecases", "personas.json"), "utf-8")).toBe(before);
        expect(await fx.store.listUseCaseIds()).not.toContain("fresh-case");
      });

      it("caps the named files of a multi-file invalid_state and counts the rest", async () => {
        const ids = Array.from({ length: 14 }, (_, i) => `broken-${String(i).padStart(2, "0")}`);
        await setUseCases(fx.store, { use_cases: ids.map((id) => borrowCase({ id })) });
        for (const id of ids) await writeFile(join(fx.dir, "usecases", "cases", `${id}.json`), BROKEN);
        const err = await setUseCases(fx.store, { use_cases: ids.map((id) => ({ id, status: "ready" })) }).catch((e: unknown) => e);
        const message = (err as Error).message;
        expect(err).toMatchObject({ code: "invalid_state" });
        expect(message).toContain("14 stored use cases are invalid, nothing written");
        expect(message).toContain("broken-09.json");
        expect(message).not.toContain("broken-10.json");
        expect(message).toContain("(+4 more)");
        expect(message).toContain(" | ");
      });

      it("reads more existing cases than one batch holds and still finds the invalid ones", async () => {
        const ids = Array.from({ length: 70 }, (_, i) => `bulk-${String(i).padStart(2, "0")}`);
        await setUseCases(fx.store, { use_cases: ids.map((id) => borrowCase({ id })) });
        await writeFile(join(fx.dir, "usecases", "cases", "bulk-03.json"), BROKEN);
        await writeFile(join(fx.dir, "usecases", "cases", "bulk-66.json"), BROKEN);
        const err = await setUseCases(fx.store, { use_cases: ids.map((id) => ({ id, status: "ready" })) }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "invalid_state", message: expect.stringContaining("bulk-03.json") });
        expect((err as Error).message).toContain("bulk-66.json");
        expect((err as Error).message).not.toContain("bulk-04.json");
      });

      it("is repaired by delete_entity followed by set_use_cases with the full case", async () => {
        await deleteEntity(fx.store, { kind: "use_case", name: "borrow-book" });
        const res = await setUseCases(fx.store, { use_cases: [borrowCase()] });
        expect(res).toMatchObject({ use_cases: { created: 1, updated: 0 } });
      });
    });

    it("merges into an existing entity at top level: given keys replace, null removes, the rest stays", async () => {
      await setUseCases(fx.store, { use_cases: [borrowCase()] });
      const res = await setUseCases(fx.store, { use_cases: [{ id: "borrow-book", status: "ready", group: null }] });
      expect(res.use_cases).toMatchObject({ created: 0, updated: 1 });
      expect(res.use_cases).not.toHaveProperty("updated_ids");
      const stored = await fx.store.readUseCase("borrow-book");
      expect(stored).toMatchObject({ status: "ready", title: "Borrow a book", tags: ["loans"] });
      expect(stored.group).toBeUndefined();
      expect(stored.steps).toHaveLength(3);
      // arrays replace whole
      await setUseCases(fx.store, { use_cases: [{ id: "borrow-book", steps: [{ id: "only", actor: "system", action: "x" }] }] });
      expect((await fx.store.readUseCase("borrow-book")).steps.map((s) => s.id)).toEqual(["only"]);
    });

    it("keeps existing persona order on upsert and appends new ones", async () => {
      await setUseCases(fx.store, { personas: PERSONAS });
      await setUseCases(fx.store, { personas: [{ id: "guest", name: "Guest" }, { id: "member-ana", name: "Anna" }] });
      expect((await fx.store.readPersonaPool()).personas.map((p) => [p.id, p.name])).toEqual([["member-ana", "Anna"], ["staff-lee", "Lee"], ["guest", "Guest"]]);
    });

    it("validates the whole call before writing anything", async () => {
      const bad = { ...borrowCase({ id: "second" }), outputs: [] };
      await expect(setUseCases(fx.store, { personas: PERSONAS, use_cases: [borrowCase(), bad] })).rejects.toMatchObject({
        code: "validation_failed",
        message: expect.stringMatching(/nothing written.*use_cases\[1\] \(second\)\.outputs/),
      });
      await expect(stat(join(fx.dir, "usecases"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("requires a non-empty example on inputs and outputs (base and variant), allows empty step data, writes nothing on refusal", async () => {
      const variant = (patch: Record<string, unknown>): Record<string, unknown> => ({ id: "late", title: "Late", when: { membership: ["student"] }, ...patch });
      const refused: [string, Record<string, unknown>, RegExp][] = [
        ["base input", borrowCase({ inputs: [{ object: "loan", example: {} }] }), /\.inputs\.0\.example: example must be/],
        ["base output", borrowCase({ outputs: [{ object: "loan", example: {} }] }), /\.outputs\.0\.example: example must be/],
        ["variant input", borrowCase({ variants: [variant({ inputs: [{ object: "loan", example: {} }] })] }), /variants\.0\.inputs\.0\.example: example must be/],
        ["variant output", borrowCase({ variants: [variant({ outputs: [{ object: "loan", example: {} }] })] }), /variants\.0\.outputs\.0\.example: example must be/],
      ];
      for (const [label, useCase, path] of refused) {
        await expect(setUseCases(fx.store, { use_cases: [useCase] }), label).rejects.toMatchObject({ code: "validation_failed", message: expect.stringMatching(path) });
      }
      await expect(stat(join(fx.dir, "usecases"))).rejects.toMatchObject({ code: "ENOENT" });
      const emptyStepData = borrowCase({ steps: [{ id: "pick", actor: "member-ana", action: "Picks", data: [{ object: "loan", before: {}, after: {} }] }] });
      await expect(setUseCases(fx.store, { use_cases: [emptyStepData] })).resolves.toMatchObject({ use_cases: { created: 1 } });
    });

    it("rejects missing ids, repeated ids, bad ids, unknown keys and empty calls", async () => {
      await expect(setUseCases(fx.store, { personas: [{ name: "x" }] })).rejects.toThrow(/personas\[0\]: id is required/);
      await expect(setUseCases(fx.store, { personas: [{ id: "a", name: "x" }, { id: "a", name: "y" }] })).rejects.toThrow(/appears twice/);
      await expect(setUseCases(fx.store, { personas: [{ id: "Bad Id", name: "x" }] })).rejects.toThrow(/kebab-case/);
      await expect(setUseCases(fx.store, { personas: [{ id: "a", name: "x", nmae: "typo" }] })).rejects.toThrow(/nmae/);
      await expect(setUseCases(fx.store, {})).rejects.toMatchObject({ code: "validation_failed" });
    });

    it("warns, never blocks, about unknown references", async () => {
      const res = await setUseCases(fx.store, {
        dimensions: DIMENSIONS,
        personas: [{ id: "ghost-fan", name: "G", traits: { membership: "nope", weather: "rain" } }],
        data_objects: [{ id: "loan", name: "Loan", fields: [{ name: "member", type: "ref", ref: "missing-object" }] }],
        use_cases: [
          borrowCase({
            personas: ["nobody"],
            inputs: [{ object: "unknown-object", example: { a: 1 } }],
            outputs: [{ object: "loan", example: { undeclared: 1 } }],
            steps: [{ id: "s", actor: "ghost", action: "x", target: { screen: "no-such-screen" } }],
            variants: [
              { id: "v", title: "V", when: { membership: ["nope"], weather: ["rain"] }, steps: [{ op: "remove", step_id: "ghost-step" }] },
            ],
          }),
        ],
      });
      expect(new Set(kinds(res.warnings))).toEqual(
        new Set(["unknown_dimension", "unknown_trait_value", "unknown_data_object", "unknown_persona", "unknown_data_field", "mapping_stale", "variant_step_missing"]),
      );
      expect(await fx.store.listUseCaseIds()).toEqual(["borrow-book"]); // written regardless
    });

    it("flags a mapping to a missing screen or node as mapping_stale on write", async () => {
      await seed();
      const res = await setUseCases(fx.store, {
        use_cases: [borrowCase({ steps: [{ id: "a", actor: "system", action: "x", target: { screen: "shelf", node: "book-99" } }, { id: "b", actor: "system", action: "y", target: { screen: "shelf", node: "book-14" } }] })],
      });
      expect((res.warnings as Warning[]).filter((w) => w.kind === "mapping_stale").map((w) => w.target)).toEqual(["use_case:borrow-book/a"]);
    });

    it("caps and de-duplicates a flood of warnings but reports the count", async () => {
      const cases = Array.from({ length: 80 }, (_, i) => borrowCase({ id: `case-${i}`, personas: [`ghost-${i}`] }));
      const res = await setUseCases(fx.store, { use_cases: cases });
      expect((res.warnings as Warning[]).length).toBe(50);
      expect(res.warning_count).toBeGreaterThanOrEqual(80);
    });
  });

  describe("get_use_case", () => {
    it("bundles the use case with personas, dimensions, data objects (incl. refs) and mapped screens", async () => {
      await seed();
      const res = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
      expect(res.use_case).toMatchObject({ id: "borrow-book", goal: "Take it home" });
      expect(res.use_case).not.toHaveProperty("variants");
      expect(res.personas.map((p) => p.id)).toEqual(["member-ana"]);
      expect(res.dimensions.map((d) => d.id).sort()).toEqual(["branch-access", "membership"]);
      expect(res.data_objects.map((o) => o.id).sort()).toEqual(["loan", "member"]); // member via a ref field
      expect(res.screens).toEqual([
        { screen: "shelf", exists: true, title: "Shelf", mappings: [{ step: "tap-book", scope: "element", node: { id: "book-14", tag: "button", text: "14" } }] },
        { screen: "sheet", exists: true, title: "Sheet", mappings: [{ step: "pick", scope: "screen" }] },
      ]);
      expect(res.warnings).toEqual([]);
    });

    it("marks mappings to a missing node or screen stale and keeps reading", async () => {
      await seed();
      await setUseCases(fx.store, {
        use_cases: [borrowCase({ steps: [{ id: "a", actor: "system", action: "x", target: { screen: "shelf", node: "gone" } }, { id: "b", actor: "system", action: "y", target: { screen: "deleted-screen" } }] })],
      });
      const res = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
      expect(res.screens).toEqual([
        { screen: "shelf", exists: true, title: "Shelf", mappings: [{ step: "a", scope: "element", node: { id: "gone", tag: "", text: "" }, stale: true }] },
        { screen: "deleted-screen", exists: false, mappings: [{ step: "b", scope: "screen", stale: true }] },
      ]);
      expect(kinds(res.warnings)).toEqual(["mapping_stale", "mapping_stale"]);
    });

    it("resolves a variant: effective flow with change markers, removed steps, variant personas", async () => {
      await seed();
      await setUseCases(fx.store, {
        use_cases: [
          {
            id: "borrow-book",
            variants: [
              {
                id: "all-branches",
                title: "No branch limit",
                when: { "branch-access": ["all-branches"] },
                personas: ["staff-lee"],
                steps: [
                  { op: "replace", step_id: "pick", step: { id: "pick", actor: "staff-lee", action: "Picks a copy", target: { screen: "sheet", node: "sheet-title" } } },
                  { op: "remove", step_id: "done" },
                  { op: "append", step: { id: "bill", actor: "system", action: "Bills the late fee" } },
                ],
              },
            ],
          },
        ],
      });
      const base = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
      expect(base.variants).toEqual([{ id: "all-branches", title: "No branch limit", when: { "branch-access": ["all-branches"] } }]);
      expect(base.personas.map((p) => p.id).sort()).toEqual(["member-ana", "staff-lee"]);

      const res = (await getUseCase(fx.store, { id: "borrow-book", variant: "all-branches" })) as Bundle;
      expect(res.variant).toMatchObject({ id: "all-branches" });
      expect(res).not.toHaveProperty("variants");
      expect(res.use_case.personas).toEqual(["staff-lee"]);
      expect(res.use_case.steps.map((s) => [s.id, s.change])).toEqual([["tap-book", undefined], ["pick", "changed"], ["bill", "added"]]);
      expect(res.removed_steps).toEqual([expect.objectContaining({ id: "done", change: "removed", after: "pick" })]);
      expect(res.screens.find((s) => s.screen === "sheet")!.mappings).toEqual([{ step: "pick", scope: "element", node: { id: "sheet-title", tag: "h1", text: "Choose a copy" } }]);
      await expect(getUseCase(fx.store, { id: "borrow-book", variant: "nope" })).rejects.toMatchObject({ code: "not_found" });
    });

    it("reads nested and component-slot text as a node's text", async () => {
      await writeHtml(fx.store, { screen: "chip", mode: "create", kind: "component", html_aug: `<span id="chip-root"><span data-slot="label">x</span></span>` });
      await writeHtml(fx.store, {
        screen: "home",
        mode: "create",
        title: "Home",
        html_aug: `<main id="home-root"><div id="card"><b id="b1">Open</b> <i id="i1">days</i></div><span id="c1" class="$chip"><span data-slot="label">Hello slot</span></span></main>`,
      });
      await setUseCases(fx.store, {
        use_cases: [borrowCase({ steps: [{ id: "a", actor: "system", action: "x", target: { screen: "home", node: "card" } }, { id: "b", actor: "system", action: "y", target: { screen: "home", node: "c1" } }] })],
      });
      const res = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
      expect(res.screens[0]!.mappings).toEqual([
        { step: "a", scope: "element", node: { id: "card", tag: "div", text: "Open days" } },
        { step: "b", scope: "element", node: { id: "c1", tag: "span", text: "Hello slot" } },
      ]);
    });

    describe("slot-fill elements (CHR-1101)", () => {
      const mapTo = (screen: string, node: string) =>
        setUseCases(fx.store, { use_cases: [borrowCase({ steps: [{ id: "a", actor: "system", action: "x", target: { screen, node } }] })] });

      beforeEach(async () => {
        await writeHtml(fx.store, { screen: "chip", mode: "create", kind: "component", html_aug: `<span id="chip-root"><span data-slot="label">x</span></span>` });
        await writeHtml(fx.store, {
          screen: "home",
          mode: "create",
          title: "Home",
          html_aug: `<main id="home-root"><span id="c1" class="$chip"><b id="fill-label">Hello <i id="fill-inner">slot</i></b></span><span id="c2" class="$chip"><b>No id</b></span></main>`,
        });
      });

      it("resolves a fill element by its authored id with tag and text, without a stale flag", async () => {
        const res = await mapTo("home", "fill-label");
        expect((res.warnings as Warning[]).filter((w) => w.kind === "mapping_stale")).toEqual([]);
        const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
        expect(bundle.screens[0]!.mappings).toEqual([{ step: "a", scope: "element", node: { id: "fill-label", tag: "b", text: "Hello slot" } }]);
      });

      it("includes slot content of an instance inside a container's text", async () => {
        await mapTo("home", "home-root");
        const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
        expect(bundle.screens[0]!.mappings).toEqual([{ step: "a", scope: "element", node: { id: "home-root", tag: "main", text: "Hello slot No id" } }]);
      });

      it("includes the slot content of an instance nested in a fill", async () => {
        await writeHtml(fx.store, {
          screen: "nest",
          mode: "create",
          title: "Nest",
          html_aug: `<main id="nest-root"><span id="outer" class="$chip"><div data-slot="label"><i>A</i><span id="inner" class="$chip"><b>B</b></span></div></span></main>`,
        });
        await mapTo("nest", "outer");
        const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
        expect(bundle.screens[0]!.mappings).toEqual([{ step: "a", scope: "element", node: { id: "outer", tag: "span", text: "A B" } }]);
      });

      it("resolves a nested fill element", async () => {
        await mapTo("home", "fill-inner");
        const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
        expect(bundle.screens[0]!.mappings).toEqual([{ step: "a", scope: "element", node: { id: "fill-inner", tag: "i", text: "slot" } }]);
      });

      it("keeps a fill without an authored id unmappable (an id that matches no node or authored fill id is stale)", async () => {
        const res = await mapTo("home", "n999");
        expect((res.warnings as Warning[]).some((w) => w.kind === "mapping_stale")).toBe(true);
        const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
        expect(bundle.screens[0]!.mappings[0]).toMatchObject({ stale: true });
      });

      it("keeps backdrop-layer nodes unmappable on the overlay screen", async () => {
        await writeHtml(fx.store, { screen: "base", mode: "create", title: "Base", html_aug: `<div id="base-root"><button id="base-btn">Go</button></div>` });
        await writeHtml(fx.store, { screen: "sheet", mode: "create", title: "Sheet", html_aug: `<div id="sheet-root" data-backdrop="base"><p id="sheet-p">Hi</p></div>` });
        const res = await mapTo("sheet", "base-btn");
        expect((res.warnings as Warning[]).some((w) => w.kind === "mapping_stale")).toBe(true);
      });
    });

    it("does not follow a path-traversal id out of usecases/cases", async () => {
      await expect(getUseCase(fx.store, { id: "../personas" })).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("status is spec maturity only", () => {
    it("accepts draft and ready and rejects implemented and priority, writing nothing", async () => {
      await expect(setUseCases(fx.store, { use_cases: [borrowCase({ status: "implemented" })] })).rejects.toMatchObject({ code: "validation_failed" });
      await expect(setUseCases(fx.store, { use_cases: [borrowCase({ priority: "must" })] })).rejects.toThrow(/priority/);
      await expect(stat(join(fx.dir, "usecases"))).rejects.toMatchObject({ code: "ENOENT" });
      await setUseCases(fx.store, { use_cases: [borrowCase({ status: "ready" })] });
      expect(await fx.store.readUseCase("borrow-book")).toMatchObject({ status: "ready" });
    });

    it("has no priority sort, facet, filter or summary field and no priority in any tool description", async () => {
      await setUseCases(fx.store, { personas: PERSONAS, use_cases: [borrowCase()] });
      await expect(listUseCases(fx.store, { sort: "priority" as never })).rejects.toMatchObject({ code: "validation_failed" });
      const res = (await listUseCases(fx.store, {})) as ListRes;
      expect(Object.keys(res.facets).sort()).toEqual(["group", "persona", "status", "tag"]);
      expect(res.use_cases[0]).not.toHaveProperty("priority");
      const useCaseTools = TOOLS.filter((t) => /use_case|personas/.test(t.name));
      expect(useCaseTools).toHaveLength(5);
      for (const tool of useCaseTools) expect(`${tool.description} ${Object.keys(tool.inputShape).join(" ")}`).not.toMatch(/priority|implemented/i);
      expect(z.object(TOOLS.find((t) => t.name === "list_use_cases")!.inputShape).safeParse({ status: "implemented" }).success).toBe(false);
      const limitShape = z.object(TOOLS.find((t) => t.name === "list_use_cases")!.inputShape);
      expect(limitShape.safeParse({ limit: 100 }).success).toBe(true);
      expect(limitShape.safeParse({ limit: 101 }).success).toBe(false);
    });

    it("leaves a stored status of an old file as invalid_state instead of coercing it", async () => {
      await setUseCases(fx.store, { use_cases: [borrowCase()] });
      const file = join(fx.dir, "usecases", "cases", "borrow-book.json");
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf-8")), status: "implemented" }));
      await expect(getUseCase(fx.store, { id: "borrow-book" })).rejects.toMatchObject({ code: "invalid_state" });
    });

    it("treats an old file with an empty input example as invalid: list skips it with invalid_file, get_use_case says invalid_state", async () => {
      await setUseCases(fx.store, { use_cases: [borrowCase(), borrowCase({ id: "other-case" })] });
      const file = join(fx.dir, "usecases", "cases", "borrow-book.json");
      const stored = JSON.parse(await readFile(file, "utf-8"));
      await writeFile(file, JSON.stringify({ ...stored, inputs: [{ object: "loan", example: {} }] })); // written past the schema
      const res = (await listUseCases(fx.store, {})) as ListRes & { warnings?: unknown[] };
      expect(res.use_cases.map((u) => u.id)).toEqual(["other-case"]);
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "invalid_file", target: "use_case:borrow-book" })]);
      await expect(getUseCase(fx.store, { id: "borrow-book" })).rejects.toMatchObject({ code: "invalid_state" });
    });
  });

  describe("list_use_cases", () => {
    beforeEach(async () => {
      await setUseCases(fx.store, {
        personas: PERSONAS,
        use_cases: [
          borrowCase({ id: "c-1", title: "Gamma", group: "catalog/loans" }),
          borrowCase({ id: "c-2", title: "Alpha", group: "catalog/loans", status: "ready" }),
          borrowCase({ id: "c-3", title: "Beta", group: "settings", tags: ["profile"], personas: ["staff-lee"], steps: [{ id: "s", actor: "staff-lee", action: "Edits the profile", target: { screen: "profile" } }] }),
        ],
      });
    });

    it("lists summaries sorted by group then title, with total, counts and facets", async () => {
      const res = (await listUseCases(fx.store, {})) as ListRes;
      expect(res.total).toBe(3);
      expect(res.use_cases.map((u) => u.id)).toEqual(["c-2", "c-1", "c-3"]);
      expect(res.use_cases[0]).toEqual({ id: "c-2", title: "Alpha", group: "catalog/loans", status: "ready", personas: ["member-ana"], tags: ["loans"], steps: 3, screens: ["sheet", "shelf"] });
      expect(res.counts).toEqual({ use_cases: 3, personas: 2, dimensions: 0, data_objects: 0 });
      expect(res.facets.status).toEqual({ draft: 2, ready: 1 });
      expect(res.facets.group).toEqual({ "catalog/loans": 2, settings: 1 });
      expect(res).not.toHaveProperty("personas");
    });

    it("filters and reports facets over the filtered set", async () => {
      expect(((await listUseCases(fx.store, { group: "catalog" })) as ListRes).total).toBe(2);
      expect(((await listUseCases(fx.store, { persona: "staff-lee" })) as ListRes).use_cases.map((u) => u.id)).toEqual(["c-3"]);
      expect(((await listUseCases(fx.store, { screen: "profile" })) as ListRes).total).toBe(1);
      expect(((await listUseCases(fx.store, { screen: "shelf", node: "book-14", status: "ready" })) as ListRes).use_cases.map((u) => u.id)).toEqual(["c-2"]);
      const filtered = (await listUseCases(fx.store, { query: "profile" })) as ListRes;
      expect(filtered.total).toBe(1);
      expect(filtered.facets.tag).toEqual({ profile: 1 });
    });

    it("treats an empty-string filter as no filter, like an empty query", async () => {
      const all = ((await listUseCases(fx.store, {})) as ListRes).total;
      for (const empty of [{ group: "" }, { group: "/" }, { persona: "" }, { tag: "" }, { screen: "" }, { node: "" }, { query: "" }, { group: "  " }]) {
        expect(((await listUseCases(fx.store, empty)) as ListRes).total, JSON.stringify(empty)).toBe(all);
      }
      // A real value next to an empty one still filters.
      expect(((await listUseCases(fx.store, { group: "", persona: "staff-lee" })) as ListRes).use_cases.map((u) => u.id)).toEqual(["c-3"]);
    });

    it("pages with a cursor, repeating neither counts nor facets", async () => {
      const first = (await listUseCases(fx.store, { limit: 2, sort: "id" })) as ListRes;
      expect(first.use_cases.map((u) => u.id)).toEqual(["c-1", "c-2"]);
      expect(first.next_cursor).toBe("2");
      const second = (await listUseCases(fx.store, { limit: 2, sort: "id", cursor: first.next_cursor })) as ListRes;
      expect(second.use_cases.map((u) => u.id)).toEqual(["c-3"]);
      expect(second).not.toHaveProperty("next_cursor");
      expect(second).not.toHaveProperty("facets");
      expect(second).not.toHaveProperty("counts");
      await expect(listUseCases(fx.store, { cursor: "abc" })).rejects.toMatchObject({ code: "validation_failed" });
    });

    it("include returns the requested pools", async () => {
      const res = (await listUseCases(fx.store, { include: ["personas"], limit: 1 })) as ListRes;
      expect(res.personas!.map((p) => p.id)).toEqual(["member-ana", "staff-lee"]);
      expect(res).not.toHaveProperty("dimensions");
    });

    it("reports a case file that no longer validates instead of failing the list", async () => {
      await writeFile(join(fx.dir, "usecases", "cases", "broken.json"), `{ "id": "broken", "title": 3 }`);
      await writeFile(join(fx.dir, "usecases", "cases", "garbage.json"), `not json`);
      const res = (await listUseCases(fx.store, {})) as ListRes;
      expect(res.total).toBe(3);
      expect(res.warnings).toEqual([
        expect.objectContaining({ kind: "invalid_file", target: "use_case:broken" }),
        expect.objectContaining({ kind: "invalid_file", target: "use_case:garbage", message: expect.stringContaining("not valid JSON") }),
      ]);
    });

    it("sees an edit made outside the tools (the read cache follows the file)", async () => {
      await listUseCases(fx.store, {});
      const path = join(fx.dir, "usecases", "cases", "c-1.json");
      const edited = { ...(JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>), title: "Renamed by hand" };
      await writeFile(path, JSON.stringify(edited));
      const res = (await listUseCases(fx.store, { query: "renamed by hand" })) as ListRes;
      expect(res.use_cases.map((u) => u.id)).toEqual(["c-1"]);
    });
  });

  describe("generate_personas", () => {
    beforeEach(async () => {
      await setUseCases(fx.store, { dimensions: DIMENSIONS });
    });

    it("dry_run previews and writes nothing", async () => {
      const res = (await generatePersonas(fx.store, { strategy: "all", dry_run: true })) as GenRes;
      expect(res).toMatchObject({ dry_run: true, strategy: "all", total: 4, would_create: 4, skipped_covered: 0 });
      expect(res.personas[0]).toEqual({ id: "gen-student-single", name: "Student · Single", traits: { membership: "student", "branch-access": "single" } });
      expect((await fx.store.readPersonaPool()).personas).toEqual([]);
    });

    it("writes generated personas, then skips what is already covered", async () => {
      await setUseCases(fx.store, { personas: [PERSONAS[0]!] });
      const res = (await generatePersonas(fx.store, { strategy: "all" })) as GenRes;
      expect(res).toMatchObject({ created: 3, skipped_covered: 1, commit: null });
      const personas = (await fx.store.readPersonaPool()).personas;
      expect(personas).toHaveLength(4);
      expect(personas.filter((p) => p.generated === true)).toHaveLength(3);
      const again = (await generatePersonas(fx.store, { strategy: "all" })) as GenRes;
      expect(again).toMatchObject({ created: 0, skipped_covered: 4 });
      expect((await fx.store.readPersonaPool()).personas).toHaveLength(4);
    });

    it("defaults to pairwise, honours limit and a dimension subset, and refuses unknown dimensions", async () => {
      const pairwise = (await generatePersonas(fx.store, { dry_run: true })) as GenRes;
      expect(pairwise).toMatchObject({ strategy: "pairwise", total: 4, would_create: 4 });
      const limited = (await generatePersonas(fx.store, { strategy: "all", limit: 2, dry_run: true })) as GenRes;
      expect(limited).toMatchObject({ would_create: 2, truncated: true });
      const subset = (await generatePersonas(fx.store, { dimensions: ["membership"], dry_run: true })) as GenRes;
      expect(subset.personas.map((p) => p.traits)).toEqual([{ membership: "student" }, { membership: "staff" }]);
      await expect(generatePersonas(fx.store, { dimensions: ["nope"] })).rejects.toMatchObject({ code: "not_found" });
    });

    it("dry_run lists at most 50 personas, keeps the full would_create and flags the cut", async () => {
      const dims = Array.from({ length: 2 }, (_, d) => ({ id: `d${d}`, label: `D${d}`, values: Array.from({ length: 8 }, (_, v) => ({ id: `v${v}`, label: `V${v}` })) }));
      await setUseCases(fx.store, { dimensions: dims });
      const big = (await generatePersonas(fx.store, { strategy: "all", dimensions: ["d0", "d1"], dry_run: true })) as GenRes & { personas_truncated?: boolean };
      expect(big.would_create).toBe(64);
      expect(big.personas).toHaveLength(50);
      expect(big.personas_truncated).toBe(true);
      const small = (await generatePersonas(fx.store, { strategy: "all", dimensions: ["d0", "d1"], limit: 50, dry_run: true })) as GenRes;
      expect(small.would_create).toBe(50);
      expect(small.personas).toHaveLength(50);
      expect(small).not.toHaveProperty("personas_truncated");
      expect((await fx.store.readPersonaPool()).personas).toEqual([]);
    });

    it("refuses an all-strategy explosion", async () => {
      const wide = Array.from({ length: 8 }, (_, d) => ({ id: `d${d}`, label: `D${d}`, values: Array.from({ length: 10 }, (_, v) => ({ id: `v${v}`, label: `V${v}` })) }));
      await setUseCases(fx.store, { dimensions: wide });
      await expect(generatePersonas(fx.store, { strategy: "all", dimensions: wide.map((d) => d.id) })).rejects.toMatchObject({ code: "validation_failed" });
      expect(((await generatePersonas(fx.store, { dimensions: wide.map((d) => d.id), limit: 5, dry_run: true })) as GenRes).would_create).toBe(5);
    });
  });

  describe("suggest_use_case_variants", () => {
    it("lists uncovered trait values with skeletons and shrinks as variants are added", async () => {
      await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, use_cases: [borrowCase()] });
      const res = (await suggestVariants(fx.store, { id: "borrow-book" })) as SuggestRes;
      expect(res.suggestions.map((s) => s.id)).toEqual(["membership-staff", "branch-access-all-branches"]);
      expect(res.suggestions[0]).toEqual({ id: "membership-staff", title: "Borrow a book — Membership: Staff", when: { membership: ["staff"] }, personas: ["staff-lee"] });
      await setUseCases(fx.store, { use_cases: [{ id: "borrow-book", variants: [{ id: "sep", title: "Staff", when: { membership: ["staff"] } }] }] });
      const after = (await suggestVariants(fx.store, { id: "borrow-book" })) as SuggestRes;
      expect(after.suggestions.map((s) => s.id)).toEqual(["branch-access-all-branches"]);
    });

    it("hints when there is nothing to derive suggestions from", async () => {
      await setUseCases(fx.store, { use_cases: [borrowCase()] });
      expect(await suggestVariants(fx.store, { id: "borrow-book" })).toMatchObject({ suggestions: [], hint: expect.stringContaining("dimensions and personas") });
    });
  });

  describe("delete_entity — use-case kinds", () => {
    beforeEach(async () => {
      await setUseCases(fx.store, {
        dimensions: DIMENSIONS,
        personas: PERSONAS,
        data_objects: DATA_OBJECTS,
        use_cases: [borrowCase({ variants: [{ id: "branches", title: "All branches", when: { "branch-access": ["all-branches"] } }] })],
      });
    });

    it("deletes a use case without warnings", async () => {
      const res = await deleteEntity(fx.store, { kind: "use_case", name: "borrow-book" });
      expect(res).toMatchObject({ kind: "use_case", name: "borrow-book", path: "usecases/cases/borrow-book.json", warnings: [] });
      expect(await fx.store.listUseCaseIds()).toEqual([]);
    });

    it("deletes a persona and warns about the use cases still naming it", async () => {
      const res = await deleteEntity(fx.store, { kind: "persona", name: "member-ana" });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "dangling_reference", target: "persona:member-ana", message: expect.stringContaining("borrow-book") })]);
      expect((await fx.store.readPersonaPool()).personas.map((p) => p.id)).toEqual(["staff-lee"]);
      expect(await fx.store.listUseCaseIds()).toEqual(["borrow-book"]); // the reference is reported, not repaired
    });

    it("deletes a data object and warns about use cases and other objects pointing at it", async () => {
      const res = await deleteEntity(fx.store, { kind: "data_object", name: "member" });
      expect(res.warnings as Warning[]).toHaveLength(1);
      expect((res.warnings as Warning[])[0]!.message).toContain("loan");
      const second = await deleteEntity(fx.store, { kind: "data_object", name: "loan" });
      expect((second.warnings as Warning[])[0]!.message).toContain("borrow-book");
      expect(await fx.store.readDataObjects()).toEqual([]);
    });

    it("deletes a dimension and warns about personas and variant conditions using it", async () => {
      const res = await deleteEntity(fx.store, { kind: "dimension", name: "branch-access" });
      expect((res.warnings as Warning[]).map((w) => w.message)).toEqual([expect.stringContaining("member-ana, staff-lee"), expect.stringContaining("borrow-book")]);
      expect((await fx.store.readPersonaPool()).dimensions.map((d) => d.id)).toEqual(["membership"]);
    });

    it("keeps refusing a cascade on the new kinds and leaves the old kinds alone", async () => {
      await expect(deleteEntity(fx.store, { kind: "persona", name: "member-ana", cascade: true })).rejects.toMatchObject({ code: "validation_failed" });
      await expect(deleteEntity(fx.store, { kind: "screen", name: "member-ana" })).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("review round", () => {
    it("skips a case file with a non-kebab name and reports it; delete_entity keeps working", async () => {
      await setUseCases(fx.store, { personas: PERSONAS, use_cases: [borrowCase()] });
      await writeFile(join(fx.dir, "usecases", "cases", "Bad Name.json"), "{}");
      const res = (await listUseCases(fx.store, {})) as ListRes;
      expect(res.total).toBe(1);
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "invalid_file", target: "use_case:Bad Name", message: expect.stringContaining("not a valid use case id") })]);
      await expect(deleteEntity(fx.store, { kind: "persona", name: "staff-lee" })).resolves.toMatchObject({ kind: "persona" });
    });

    it("warns mapping_unstable for an element mapping onto a generated node id, in set_use_cases and get_use_case", async () => {
      await writeHtml(fx.store, { screen: "shelf", mode: "create", title: "Shelf", html_aug: `<section id="root"><button>14</button><button id="book-14">15</button></section>` });
            const nodeId = (await fx.store.readScreen("shelf")).match(/id="(n\d+)"/)![1]!;
      const res = await setUseCases(fx.store, {
        use_cases: [borrowCase({ steps: [{ id: "a", actor: "system", action: "x", target: { screen: "shelf", node: nodeId } }, { id: "b", actor: "system", action: "y", target: { screen: "shelf", node: "book-14" } }] })],
      });
      expect((res.warnings as Warning[]).filter((w) => w.kind === "mapping_unstable").map((w) => w.target)).toEqual(["use_case:borrow-book/a"]);
      const bundle = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
      expect(kinds(bundle.warnings)).toContain("mapping_unstable");
      expect(bundle.screens[0]!.mappings).toEqual([
        { step: "a", scope: "element", node: expect.objectContaining({ id: nodeId }), unstable: true },
        { step: "b", scope: "element", node: expect.objectContaining({ id: "book-14" }) },
      ]);
    });

    it("keeps generated persona ids within the id limit, collision suffix included, and the pool readable", async () => {
      const long = (tag: string): string => `${tag}-${"x".repeat(35)}`;
      const dims = [
        { id: "a", label: "A", values: [{ id: long("a1"), label: "A1" }, { id: long("a2"), label: "A2" }] },
        { id: "b", label: "B", values: Array.from({ length: 12 }, (_, i) => ({ id: `${long("b")}-${i}`, label: `B${i}` })) },
      ];
      await setUseCases(fx.store, { dimensions: dims });
      await generatePersonas(fx.store, { strategy: "all" });
      const personas = (await fx.store.readPersonaPool()).personas;
      expect(personas).toHaveLength(24);
      expect(personas.every((p) => p.id.length <= 80)).toBe(true);
      expect(new Set(personas.map((p) => p.id)).size).toBe(24);
    });

    it("refuses to write a pool it could not read back", async () => {
      await expect(fx.store.writePersonaPool({ dimensions: [], personas: [{ id: "Bad Id", name: "x", traits: {} }] })).rejects.toThrow(/usecases\/personas\.json/);
      await expect(stat(join(fx.dir, "usecases"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("serializes parallel writers so no pool update is lost", async () => {
      await Promise.all([
        setUseCases(fx.store, { personas: [{ id: "p1", name: "P1" }] }),
        setUseCases(fx.store, { personas: [{ id: "p2", name: "P2" }] }),
        setUseCases(fx.store, { dimensions: DIMENSIONS }),
        generatePersonas(fx.store, { dimensions: ["membership"] }).catch(() => undefined),
        setUseCases(fx.store, { personas: [{ id: "p3", name: "P3" }] }),
      ]);
      const ids = (await fx.store.readPersonaPool()).personas.map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(["p1", "p2", "p3"]));
      expect((await fx.store.readPersonaPool()).dimensions).toHaveLength(2);
    });

    it("survives ids that collide with Object.prototype members", async () => {
      await writeHtml(fx.store, { screen: "shelf", mode: "create", title: "Shelf", html_aug: `<section id="root"><button id="book-14">14</button></section>` });
      const dims = [{ id: "constructor", label: "C", values: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }];
      const res = await setUseCases(fx.store, {
        dimensions: dims,
        personas: [{ id: "ana", name: "Ana", traits: { constructor: "x" } }, { id: "anyone", name: "Any" }, { id: "yy", name: "YY", traits: { constructor: "y" } }],
        use_cases: [borrowCase({ personas: ["ana"], steps: [{ id: "a", actor: "ana", action: "x", target: { screen: "shelf", node: "constructor" } }] , variants: [{ id: "v", title: "V", when: { toString: ["z"] } }] })],
      });
      expect(kinds(res.warnings)).toEqual(expect.arrayContaining(["mapping_stale", "unknown_dimension"]));
      await expect(getUseCase(fx.store, { id: "borrow-book" })).resolves.toMatchObject({ screens: [{ mappings: [{ stale: true }] }] });
      expect(((await suggestVariants(fx.store, { id: "borrow-book" })) as SuggestRes).suggestions.map((x) => x.id)).toEqual(["constructor-y"]);
      await expect(deleteEntity(fx.store, { kind: "dimension", name: "constructor" })).resolves.toMatchObject({ warnings: expect.any(Array) });
    });

    it("reports an invalid case or pool file as invalid_state naming the file, with the way out", async () => {
      await setUseCases(fx.store, { use_cases: [borrowCase()] });
      await writeFile(join(fx.dir, "usecases", "cases", "borrow-book.json"), `{ "id": "borrow-book" }`);
      const err = await getUseCase(fx.store, { id: "borrow-book" }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "invalid_state", message: expect.stringContaining("usecases/cases/borrow-book.json") });
      expect((err as Error).message).toMatch(/by hand.*delete_entity/);
      await expect(suggestVariants(fx.store, { id: "borrow-book" })).rejects.toMatchObject({ code: "invalid_state" });
      await expect(deleteEntity(fx.store, { kind: "use_case", name: "borrow-book" })).resolves.toMatchObject({ kind: "use_case" });

      await writeFile(join(fx.dir, "usecases", "personas.json"), `{ "personas": [{ "id": "BAD" }] }`);
      for (const run of [() => setUseCases(fx.store, { personas: [{ id: "ok", name: "Ok" }] }), () => listUseCases(fx.store, {}), () => generatePersonas(fx.store, {})]) {
        await expect(run()).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("usecases/personas.json") });
      }
    });

    it("rejects a variant op that would duplicate a step id, and warns about one found in a file", async () => {
      const dup = (op: Record<string, unknown>): Record<string, unknown> => borrowCase({ variants: [{ id: "v", title: "V", when: {}, steps: [op] }] });
      const step = { id: "pick", actor: "system", action: "again" };
      for (const op of [{ op: "append", step }, { op: "insert_after", step_id: "tap-book", step }, { op: "replace", step_id: "tap-book", step }]) {
        await expect(setUseCases(fx.store, { use_cases: [dup(op)] })).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("second step \"pick\"") });
      }
      await expect(stat(join(fx.dir, "usecases"))).rejects.toMatchObject({ code: "ENOENT" });
      // Re-using its own id in a replace, or an id freed by an earlier remove, is fine.
      await setUseCases(fx.store, { use_cases: [dup({ op: "replace", step_id: "tap-book", step: { id: "tap-book", actor: "system", action: "x" } })] });
      await setUseCases(fx.store, { use_cases: [borrowCase({ variants: [{ id: "v", title: "V", when: {}, steps: [{ op: "remove", step_id: "pick" }, { op: "append", step }] }] })] });
      // A hand-edited file still gets a warning.
      const path = join(fx.dir, "usecases", "cases", "borrow-book.json");
      const stored = JSON.parse(await readFile(path, "utf-8")) as { variants: { steps: unknown[] }[] };
      stored.variants[0]!.steps = [{ op: "append", step }];
      await writeFile(path, JSON.stringify(stored));
      expect(kinds(((await getUseCase(fx.store, { id: "borrow-book" })) as Bundle).warnings)).toContain("duplicate_step_id");
    });

    it("generate_personas with a dimensions subset ignores traits outside it, for all and pairwise alike", async () => {
      await setUseCases(fx.store, { dimensions: DIMENSIONS });
      await generatePersonas(fx.store, { strategy: "all" });
      for (const strategy of ["all", "pairwise"] as const) {
        const res = (await generatePersonas(fx.store, { strategy, dimensions: ["membership"], dry_run: true })) as { would_create: number; skipped_covered: number };
        expect(res).toMatchObject({ would_create: 0, skipped_covered: 2 });
      }
    });

    it("get_use_case without variant also maps what only variant steps touch, tagged with the variants", async () => {
      await seed();
      await setUseCases(fx.store, {
        use_cases: [
          {
            id: "borrow-book",
            variants: [
              { id: "v1", title: "V1", when: {}, steps: [{ op: "append", step: { id: "x", actor: "system", action: "x", target: { screen: "sheet", node: "sheet-title" } } }] },
              { id: "v2", title: "V2", when: {}, steps: [{ op: "append", step: { id: "x", actor: "system", action: "x", target: { screen: "sheet", node: "sheet-title" } } }, { op: "remove", step_id: "done" }] },
            ],
          },
        ],
      });
      const base = (await getUseCase(fx.store, { id: "borrow-book" })) as Bundle;
      const sheet = base.screens.find((s) => s.screen === "sheet")!;
      expect(sheet.mappings).toEqual([
        { step: "pick", scope: "screen" },
        { step: "x", scope: "element", node: expect.objectContaining({ id: "sheet-title" }), variants: ["v1", "v2"] },
      ]);
      const resolved = (await getUseCase(fx.store, { id: "borrow-book", variant: "v1" })) as Bundle;
      expect(JSON.stringify(resolved.screens)).not.toContain("variants");
    });
  });

  describe("scale", () => {
    it("filters, sorts and pages 2,500 use cases fast, cold and warm", async () => {
      const groups = ["catalog", "settings", "onboarding", "billing", "loans"];
      const cases = Array.from({ length: 2500 }, (_, i) =>
        borrowCase({
          id: `case-${String(i).padStart(4, "0")}`,
          title: `Use case ${i}`,
          group: `${groups[i % groups.length]}/sub-${i % 7}`,
          tags: [`tag-${i % 11}`],
          status: i % 3 === 0 ? "ready" : "draft",
          personas: [i % 2 === 0 ? "member-ana" : "staff-lee"],
          steps: [{ id: "s", actor: "member-ana", action: `Step for case ${i}`, target: { screen: `screen-${i % 40}` } }],
          variants: i % 5 === 0 ? [{ id: "v", title: "V", when: { membership: ["staff"] } }] : undefined,
        }),
      );
      const written = await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, use_cases: cases });
      expect(written.use_cases).toMatchObject({ created: 2500 });

      // A new store has no read cache: this is the cold path.
      const cold = new FsStore(fx.dir);
      let t = performance.now();
      const first = (await listUseCases(cold, { group: "catalog", status: "ready", sort: "title", limit: 25 })) as ListRes;
      const coldMs = performance.now() - t;
      expect(first.use_cases).toHaveLength(25);
      expect(first.counts.use_cases).toBe(2500);

      const expected = cases.filter((c, i) => i % 5 === 0 && i % 3 === 0).length; // catalog = i % 5 === 0, ready = i % 3 === 0
      expect(first.total).toBe(expected);

      t = performance.now();
      const warm = (await listUseCases(cold, { persona: "staff-lee", query: "case 1", sort: "title", cursor: "50", limit: 50 })) as ListRes;
      const warmMs = performance.now() - t;
      expect(warm.use_cases).toHaveLength(50);
      expect(warm.use_cases.every((u) => (u.personas as string[]).includes("staff-lee"))).toBe(true);

      console.info(`2500 use cases: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`);
      expect(coldMs).toBeLessThan(4000);
      expect(warmMs).toBeLessThan(500);

      // One file change re-parses just that file.
      await setUseCases(cold, { use_cases: [{ id: "case-0000", title: "Edited" }] });
      expect(((await listUseCases(cold, { query: "edited" })) as ListRes).total).toBe(1);
    }, 30_000);
  });
});

describe("use cases in the store", () => {
  let dir: string;
  let gitConfig: GitConfigFixture;

  beforeEach(async () => {
    gitConfig = await setupGitConfig({ name: "Test", email: "test@example.com" });
    dir = await mkdtemp(join(tmpdir(), "artisign-usecases-git-"));
    await initProject(dir);
  });
  afterEach(async () => {
    await gitConfig.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("auto-commits once per write call, named by tool and what it wrote", async () => {
    const store = new FsStore(dir);
    const first = await setUseCases(store, { personas: PERSONAS, use_cases: [borrowCase()] });
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    await deleteEntity(store, { kind: "use_case", name: "borrow-book" });
    const { stdout } = await execFileAsync("git", ["log", "--format=%s"], { cwd: dir });
    expect(stdout.trim().split("\n").slice(0, 2)).toEqual(["delete_entity: use_case:borrow-book", "set_use_cases: 2 personas, 1 use_cases"]);
  });

  it("refuses a pool file it cannot trust instead of coercing it away", async () => {
    const store = new FsStore(dir);
    await mkdir(join(dir, "usecases"), { recursive: true });
    await writeFile(join(dir, "usecases", "personas.json"), `{ "dimensions": [], "personas": [{ "id": "BAD" }] }`);
    await expect(store.readPersonaPool()).rejects.toThrow(/invalid usecases\/personas\.json/);
    await expect(setUseCases(store, { personas: [{ id: "ok", name: "Ok" }] })).rejects.toThrow(/invalid usecases\/personas\.json/);
  });
});

describe("preview commits (ctx.source: human)", () => {
  const human = { source: "human" as const };
  let dir: string;
  let store: FsStore;
  let gitConfig: GitConfigFixture;

  const gitRaw = async (...args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd: dir })).stdout;
  const git = async (...args: string[]): Promise<string> => (await gitRaw(...args)).trim();
  const lastFiles = async (): Promise<string[]> => (await git("show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean).sort();
  const lastSubject = (): Promise<string> => git("log", "-1", "--format=%s");
  const dirty = async (): Promise<string[]> => (await gitRaw("status", "--porcelain", "-uall")).split("\n").filter(Boolean).map((line) => line.slice(3)).sort();

  beforeEach(async () => {
    gitConfig = await setupGitConfig({ name: "Test", email: "test@example.com" });
    dir = await mkdtemp(join(tmpdir(), "artisign-usecases-preview-"));
    await initProject(dir);
    store = new FsStore(dir);
    // One baseline commit with everything tracked; each test starts from a clean tree.
    await setUseCases(store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, use_cases: [borrowCase()] });
    expect(await dirty()).toEqual([]);
  });
  afterEach(async () => {
    await gitConfig.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("marks the message and commits a new, untracked case file alone", async () => {
    await writeFile(join(dir, "stray.txt"), "left over");
    const res = await setUseCases(store, { use_cases: [borrowCase({ id: "renew-loan", title: "Renew a loan" })] }, human);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await lastSubject()).toBe("set_use_cases (preview): 1 use_cases");
    expect(await lastFiles()).toEqual(["usecases/cases/renew-loan.json"]);
    expect(await dirty()).toEqual(["stray.txt"]);
  });

  it("commits a changed tracked pool file and leaves a leftover change outside the call's files uncommitted", async () => {
    await writeFile(join(dir, "usecases", "cases", "borrow-book.json"), `${JSON.stringify({ ...(await store.readUseCase("borrow-book")), title: "Hand edit" })}\n`);
    await writeHtmlAndLeave();
    const res = await setUseCases(store, { personas: [{ id: "member-ana", name: "Anna" }] }, human);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await lastSubject()).toBe("set_use_cases (preview): 1 personas");
    expect(await lastFiles()).toEqual(["usecases/personas.json"]);
    expect(await dirty()).toEqual(["screens/leftover.html", "usecases/cases/borrow-book.json"]);
    // The next agent commit picks the leftovers up, unmarked.
    await setUseCases(store, { personas: [{ id: "staff-lee", name: "Leigh" }] });
    expect(await lastSubject()).toBe("set_use_cases: 1 personas");
    expect(await dirty()).toEqual([]);
  });

  async function writeHtmlAndLeave(): Promise<void> {
    await writeFile(join(dir, "screens", "leftover.html"), `<div id="n1">x</div>`);
  }

  it("commits the deletion of a tracked case file and nothing else", async () => {
    await writeFile(join(dir, "stray.txt"), "left over");
    const res = await deleteEntity(store, { kind: "use_case", name: "borrow-book" }, human);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await lastSubject()).toBe("delete_entity (preview): use_case:borrow-book");
    expect(await lastFiles()).toEqual(["usecases/cases/borrow-book.json"]);
    expect(await dirty()).toEqual(["stray.txt"]);
  });

  it("drops a deleted case file that was never committed and reports why when nothing remains", async () => {
    await store.writeUseCase(await store.readUseCase("borrow-book").then((c) => ({ ...c, id: "never-committed" })));
    const before = await git("rev-parse", "HEAD");
    const res = await deleteEntity(store, { kind: "use_case", name: "never-committed" }, human);
    expect(res).toMatchObject({ commit: null, commit_skipped_reason: "nothing_to_commit", path: "usecases/cases/never-committed.json" });
    expect(await git("rev-parse", "HEAD")).toBe(before);
    expect(await dirty()).toEqual([]);
  });

  it("a staged-then-deleted never-committed file does not leak into a later commit", async () => {
    await store.writeUseCase(await store.readUseCase("borrow-book").then((c) => ({ ...c, id: "staged-only" })));
    await git("add", "--", "usecases/cases/staged-only.json");
    await deleteEntity(store, { kind: "use_case", name: "staged-only" }, human);
    await setUseCases(store, { use_cases: [borrowCase({ id: "renew-loan", title: "Renew a loan" })] }, human);
    expect(await lastFiles()).toEqual(["usecases/cases/renew-loan.json"]);
  });

  it("commits a deletion that is already staged", async () => {
    const file = "usecases/cases/borrow-book.json";
    await git("rm", "--quiet", "--", file);
    await writeFile(join(dir, "stray.txt"), "left over");
    const res = await store.commitPaths("delete_entity (preview): use_case:borrow-book", [file]);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.skipped_reason).toBeUndefined();
    expect(await lastFiles()).toEqual([file]);
    expect(await dirty()).toEqual(["stray.txt"]);
  });

  it("reports merge_in_progress instead of git_error during an unfinished merge", async () => {
    await git("checkout", "-q", "-b", "side");
    await writeFile(join(dir, "side.txt"), "side");
    await git("add", "side.txt");
    await git("commit", "-q", "-m", "side change");
    await git("checkout", "-q", "-");
    await writeFile(join(dir, "main.txt"), "main");
    await git("add", "main.txt");
    await git("commit", "-q", "-m", "main change");
    await git("merge", "--no-commit", "--no-ff", "side");
    const head = await git("rev-parse", "HEAD");
    const res = await setUseCases(store, { use_cases: [borrowCase({ id: "renew-loan", title: "Renew a loan" })] }, human);
    expect(res).toMatchObject({ commit: null, commit_skipped_reason: "merge_in_progress" });
    expect(await git("rev-parse", "HEAD")).toBe(head);
  });

  it("generate_personas commits personas.json only; a dry run commits nothing", async () => {
    const head = await git("rev-parse", "HEAD");
    await generatePersonas(store, { dry_run: true }, human);
    expect(await git("rev-parse", "HEAD")).toBe(head);
    await generatePersonas(store, { strategy: "all" }, human);
    expect(await lastSubject()).toMatch(/^generate_personas \(preview\): \d+ all$/);
    expect(await lastFiles()).toEqual(["usecases/personas.json"]);
  });

  it("a write with no changed file reports nothing_to_commit", async () => {
    const head = await git("rev-parse", "HEAD");
    const res = await setUseCases(store, { personas: [{ id: "member-ana" }] }, human);
    expect(res).toMatchObject({ commit: null, commit_skipped_reason: "nothing_to_commit" });
    expect(await git("rev-parse", "HEAD")).toBe(head);
  });

  it("autoCommit: false suppresses the preview commit", async () => {
    const config = await store.readArtisignConfig();
    config.settings.autoCommit = false;
    await store.writeArtisignConfig(config);
    const head = await git("rev-parse", "HEAD");
    const res = await setUseCases(store, { use_cases: [borrowCase({ id: "renew-loan", title: "Renew a loan" })] }, human);
    expect(res).toMatchObject({ commit: null, commit_skipped_reason: "disabled" });
    expect(await git("rev-parse", "HEAD")).toBe(head);
  });

  it("skips a project nested in another repository, as every commit does", async () => {
    const outer = await mkdtemp(join(tmpdir(), "artisign-usecases-outer-"));
    try {
      await execFileAsync("git", ["init"], { cwd: outer });
      const nested = join(outer, "project");
      await initProject(nested);
      const nestedStore = new FsStore(nested);
      const res = await setUseCases(nestedStore, { use_cases: [borrowCase()] }, human);
      expect(res).toMatchObject({ commit: null, commit_skipped_reason: "nested_repo" });
      await expect(execFileAsync("git", ["rev-parse", "HEAD"], { cwd: outer })).rejects.toBeTruthy();
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it("commits in a fresh project that has no commit yet", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "artisign-usecases-fresh-"));
    try {
      await initProject(fresh);
      const res = await setUseCases(new FsStore(fresh), { use_cases: [borrowCase()] }, human);
      expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
      const { stdout } = await execFileAsync("git", ["show", "--name-only", "--format=%s", "HEAD"], { cwd: fresh });
      expect(stdout.trim().split("\n")).toEqual(["set_use_cases (preview): 1 use_cases", "", "usecases/cases/borrow-book.json"]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
