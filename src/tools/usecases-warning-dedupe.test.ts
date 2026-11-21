import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { setUseCases, getUseCase, listUseCases } from "./usecases.js";
import { deleteEntity } from "./lifecycle.js";
// @ts-expect-error the preview modules are plain JS without declarations
import { orphansOf } from "../preview/usecases-orphans.js";
import type { Warning } from "./types.js";

const OBJECTS = [{ id: "book", name: "Book", fields: [{ name: "status", type: "string" }] }];
const PERSONAS = [{ id: "regular", name: "Regular", traits: {} }];

const libraryCase = {
  id: "borrow-book",
  title: "Borrow a book",
  personas: ["regular"],
  trigger: "A member finds a book",
  goal: "Take it home",
  inputs: [{ object: "book", source: "catalog", example: { stock: 1 } }],
  outputs: [{ object: "book", target: "catalog", example: { stock: 2 } }],
  steps: [
    { id: "pick", actor: "regular", action: "Picks a copy", data: [{ object: "book", before: { stock: 1 }, after: { stock: 2 } }] },
    { id: "scan", actor: "regular", action: "Scans the card" },
    { id: "leave", actor: "regular", action: "Leaves" },
  ],
};

const count = (warnings: Warning[], kind: string, fragment: string): number => warnings.filter((w) => w.kind === kind && w.message.includes(fragment)).length;

describe("use cases: one warning per finding, persona facet", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("reports an unknown data field once in set_use_cases and get_use_case (B2/B3)", async () => {
    const written = (await setUseCases(fx.store, { dimensions: [], personas: PERSONAS, data_objects: OBJECTS, use_cases: [libraryCase] })) as { warnings: Warning[] };
    expect(count(written.warnings, "unknown_data_field", '"stock"')).toBe(1);
    const read = (await getUseCase(fx.store, { id: "borrow-book" })) as { warnings: Warning[] };
    expect(count(read.warnings, "unknown_data_field", '"stock"')).toBe(1);
  });

  it("reports an unknown persona once after a forced delete (J6)", async () => {
    await setUseCases(fx.store, { dimensions: [], personas: PERSONAS, data_objects: OBJECTS, use_cases: [libraryCase] });
    const deleted = await deleteEntity(fx.store, { kind: "persona", name: "regular", force: true });
    expect(count(deleted.warnings as Warning[], "dangling_reference", '"regular"')).toBe(1);
    const read = (await getUseCase(fx.store, { id: "borrow-book" })) as { warnings: Warning[] };
    expect(count(read.warnings, "unknown_persona", '"regular"')).toBe(1);
  });

  it("counts only pool personas in the persona facet, while the persona filter still matches by id", async () => {
    await setUseCases(fx.store, {
      dimensions: [],
      personas: PERSONAS,
      data_objects: OBJECTS,
      use_cases: [{ ...libraryCase, steps: [...libraryCase.steps, { id: "ghost-step", actor: "ghost", action: "Appears" }] }],
    });
    const res = (await listUseCases(fx.store, {})) as { facets: { persona: Record<string, number> } };
    expect(res.facets.persona).toEqual({ regular: 1 });
    const byGhost = (await listUseCases(fx.store, { persona: "ghost" })) as { total: number };
    expect(byGhost.total).toBe(1);
  });

  it("keeps one unknown_dimension warning per variant, and the preview marks both conditions", async () => {
    const res = (await setUseCases(fx.store, {
      dimensions: [],
      personas: PERSONAS,
      data_objects: OBJECTS,
      use_cases: [{ ...libraryCase, variants: [{ id: "v1", title: "V1", when: { ghostdim: ["a"] } }, { id: "v2", title: "V2", when: { ghostdim: ["a"] } }] }],
    })) as { warnings: Warning[] };
    expect(count(res.warnings, "unknown_dimension", "ghostdim")).toBe(2);
    const read = (await getUseCase(fx.store, { id: "borrow-book" })) as { warnings: Warning[] };
    const orphans = orphansOf(read.warnings, "borrow-book");
    expect(orphans.conditions.map((c: { variant: string }) => c.variant).sort()).toEqual(["v1", "v2"]);
  });

  it("keeps one warning per persona with the same stale trait", async () => {
    const res = (await setUseCases(fx.store, {
      dimensions: [],
      personas: [{ id: "a", name: "A", traits: { ghostdim: "x" } }, { id: "b", name: "B", traits: { ghostdim: "x" } }],
      data_objects: OBJECTS,
      use_cases: [],
    })) as { warnings: Warning[] };
    const hits = res.warnings.filter((w) => w.kind.startsWith("unknown_") && w.message.includes("ghostdim"));
    expect(hits.map((w) => w.target).sort()).toEqual(["persona:a", "persona:b"]);
  });
});
