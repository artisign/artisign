import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { deleteEntity } from "./lifecycle.js";
import { getUseCase, listUseCases, setUseCases } from "./usecases.js";
import type { Warning } from "./types.js";

const DIMENSIONS = [
  { id: "membership", label: "Membership", values: [{ id: "member", label: "Member" }, { id: "staff", label: "Staff" }] },
  { id: "branch", label: "Branch", scope: "constellations", values: [{ id: "north", label: "North" }, { id: "south", label: "South" }] },
];
const PERSONAS = [
  { id: "ana", name: "Ana", traits: { membership: "member" } },
  { id: "ben", name: "Ben", traits: { membership: "staff" } },
];
const WORLD = {
  entities: [{ id: "copy-42", name: "Copy 42", object: "book-copy" }],
  relationship_types: [{ id: "borrows", label: "borrows" }],
  constellations: [{ id: "ana-at-north", name: "Ana at north", traits: { branch: "north" }, relationships: [{ from: "ana", type: "borrows", to: "copy-42" }] }],
};
const BOOK_COPY = { id: "book-copy", name: "Book copy", fields: [{ name: "status", type: "enum", values: ["available", "on-loan"] }] };

function borrowCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "borrow-a-book",
    title: "Borrow a book",
    constellations: ["ana-at-north"],
    inputs: [{ object: "book-copy", example: { status: "available" } }],
    outputs: [{ object: "book-copy", example: { status: "on-loan" } }],
    steps: [{ id: "pick", actor: "ana", action: "Picks a copy" }],
    ...overrides,
  };
}

describe("world consistency warnings (CHR-1149)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  const kindsOf = (res: { warnings?: unknown }): string[] => ((res.warnings ?? []) as Warning[]).map((w) => w.kind);
  const hasFile = (name: string): Promise<boolean> => access(join(fx.dir, "usecases", name)).then(() => true, () => false);

  it("is quiet for a consistent world and case", async () => {
    const res = await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, ...WORLD, data_objects: [BOOK_COPY], use_cases: [borrowCase()] });
    expect(res.warnings).toEqual([]);
    expect((await getUseCase(fx.store, { id: "borrow-a-book" })).warnings).toEqual([]);
  });

  it("warns on write and read about a case that contradicts the world, and still writes it", async () => {
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, ...WORLD, data_objects: [BOOK_COPY] });
    const bad = borrowCase({
      steps: [{ id: "help", actor: "ben", action: "Helps" }],
      state: [{ subject: "copy-42", property: "status", value: "lost" }],
      variants: [{ id: "south", title: "South", when: { branch: ["south"] }, actors: { ben: "copy-42" } }],
    });
    const res = await setUseCases(fx.store, { use_cases: [bad] });
    expect(new Set(kindsOf(res))).toEqual(new Set(["outside_constellation", "state_value_mismatch", "trait_conflict", "entity_as_actor"]));
    expect(await fx.store.listUseCaseIds()).toEqual(["borrow-a-book"]);
    const read = await getUseCase(fx.store, { id: "borrow-a-book" });
    expect(new Set(kindsOf(read))).toEqual(new Set(kindsOf(res)));
    const variant = await getUseCase(fx.store, { id: "borrow-a-book", variant: "south" });
    expect(kindsOf(variant)).toContain("trait_conflict");
  });

  it("checks the world entities in the call against the pools after the call", async () => {
    const res = await setUseCases(fx.store, {
      dimensions: DIMENSIONS,
      personas: PERSONAS,
      entities: [{ id: "orphan", name: "Orphan", traits: { colour: "red" } }],
      relationship_types: [{ id: "colleague-of", label: "colleague of", same_traits: ["membership"] }],
      constellations: [{ id: "staff-room", name: "Staff room", traits: { branch: "west" }, relationships: [{ from: "ana", type: "colleague-of", to: "ben" }, { from: "ana", type: "mentors", to: "ana" }] }],
    });
    expect(new Set(kindsOf(res))).toEqual(new Set(["unknown_dimension", "entity_unrelated", "unknown_trait_value", "trait_conflict", "unknown_relationship_type", "self_relationship"]));
    expect(await hasFile("world.json")).toBe(true);
  });

  it("checks no data-object reference without data-objects.json, all of them with it", async () => {
    const world = { dimensions: DIMENSIONS, personas: PERSONAS, entities: [{ id: "copy-42", name: "Copy 42", object: "missing" }], relationship_types: [{ id: "holds", label: "holds", field: { object: "missing", name: "x" } }], constellations: WORLD.constellations };
    const noModel = await setUseCases(fx.store, { ...world, use_cases: [borrowCase({ inputs: [{ object: "missing", example: { a: 1 } }], state: [{ subject: "copy-42", property: "nope", value: 1 }] })] });
    expect(await hasFile("data-objects.json")).toBe(false);
    expect(kindsOf(noModel).filter((k) => k.startsWith("unknown_data") || k === "state_value_mismatch")).toEqual([]);

    await setUseCases(fx.store, { data_objects: [BOOK_COPY] });
    const read = await getUseCase(fx.store, { id: "borrow-a-book" });
    expect(kindsOf(read).filter((k) => k === "unknown_data_object")).toEqual(["unknown_data_object", "unknown_data_object"]); // the input, and the bundle's entity with its missing object
    const res = await setUseCases(fx.store, { entities: [{ id: "copy-42", name: "Copy 42", object: "missing" }], relationship_types: [{ id: "holds", label: "holds", field: { object: "missing", name: "x" } }] });
    expect(kindsOf(res).filter((k) => k === "unknown_data_object")).toHaveLength(2);
  });

  it("keeps the data model on when the last data object is deleted (the file stays)", async () => {
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, ...WORLD, data_objects: [BOOK_COPY], use_cases: [borrowCase()] });
    await deleteEntity(fx.store, { kind: "data_object", name: "book-copy", force: true });
    expect(await hasFile("data-objects.json")).toBe(true);
    expect(kindsOf(await getUseCase(fx.store, { id: "borrow-a-book" }))).toContain("unknown_data_object");
  });

  describe("after a member changes", () => {
    const household = [{ id: "household", label: "Household", values: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] }];
    const pair = (traitOfB: string) => [
      { id: "ann", name: "Ann", traits: { household: "red" } },
      { id: "bob", name: "Bob", traits: { household: traitOfB } },
    ];

    it("re-checks the constellations a written persona belongs to, on write and on read", async () => {
      const first = await setUseCases(fx.store, {
        dimensions: household,
        personas: pair("red"),
        relationship_types: [{ id: "partner-of", label: "partner of", same_traits: ["household"] }],
        constellations: [{ id: "pair", name: "Pair", relationships: [{ from: "ann", type: "partner-of", to: "bob" }] }],
        use_cases: [borrowCase({ constellations: ["pair"], steps: [{ id: "pick", actor: "ann", action: "x" }], inputs: [{ object: "any", example: { a: 1 } }], outputs: [{ object: "any", example: { a: 1 } }] })],
      });
      expect(kindsOf(first)).not.toContain("trait_conflict");

      const res = await setUseCases(fx.store, { personas: [{ id: "bob", name: "Bob", traits: { household: "blue" } }] });
      expect((res.warnings as Warning[]).filter((w) => w.kind === "trait_conflict").map((w) => w.target)).toEqual(["constellation:pair"]);
      expect((await getUseCase(fx.store, { id: "borrow-a-book" })).warnings as Warning[]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "trait_conflict", target: "constellation:pair" })]));
    });

    it("re-checks the constellations that use a written relationship type", async () => {
      await setUseCases(fx.store, {
        dimensions: household,
        personas: pair("blue"),
        relationship_types: [{ id: "partner-of", label: "partner of" }],
        constellations: [{ id: "pair", name: "Pair", relationships: [{ from: "ann", type: "partner-of", to: "bob" }] }],
      });
      const res = await setUseCases(fx.store, { relationship_types: [{ id: "partner-of", label: "partner of", same_traits: ["household"] }] });
      expect(kindsOf(res)).toEqual(["trait_conflict"]);
    });
  });

  it("raises outside_constellation once per actor, not per step", async () => {
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, ...WORLD, data_objects: [BOOK_COPY] });
    const steps = ["a", "b", "c"].map((id) => ({ id, actor: "ben", action: id }));
    const res = await setUseCases(fx.store, { use_cases: [borrowCase({ steps })] });
    expect((res.warnings as Warning[]).filter((w) => w.kind === "outside_constellation").map((w) => w.target)).toEqual(["use_case:borrow-a-book/a"]);
  });

  it("lists use cases without reading world.json", async () => {
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, ...WORLD, data_objects: [BOOK_COPY], use_cases: [borrowCase()] });
    await writeFile(join(fx.dir, "usecases", "world.json"), "{ not json");
    expect((await listUseCases(fx.store, {})).use_cases).toHaveLength(1);
    expect((await listUseCases(fx.store, { include: ["personas"] })).use_cases).toHaveLength(1);
    await expect(getUseCase(fx.store, { id: "borrow-a-book" })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("de-duplicates and caps at 50 and reports the count", async () => {
    const cases = Array.from({ length: 80 }, (_, i) => borrowCase({ id: `case-${i}`, steps: [{ id: "a", actor: "copy-42", action: "x" }, { id: "b", actor: `ghost-${i}`, action: "y" }] }));
    const res = await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, ...WORLD, use_cases: cases });
    expect((res.warnings as Warning[]).length).toBe(50);
    expect(res.warning_count).toBeGreaterThanOrEqual(160);
  });
});
