import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { deleteEntity } from "./lifecycle.js";
import { setUseCases } from "./usecases.js";
import type { Warning } from "./types.js";

// CHR-1125 / ADR-010 amendment 2026-11-20: a referenced use-case pool entry is refused unless force: true.

const DIMENSIONS = [
  {
    id: "membership",
    name: "Membership",
    values: [
      { id: "student", label: "Student" },
      { id: "staff", label: "Staff" },
    ],
  },
];
const PERSONAS = [
  { id: "member-ana", name: "Ana", traits: { membership: "student" } },
  { id: "staff-lee", name: "Lee", traits: { membership: "staff" } },
  { id: "visitor", name: "Visitor" },
];
const DATA_OBJECTS = [
  { id: "book", name: "Book", fields: [{ name: "title", type: "string" }] },
  { id: "loan", name: "Loan", fields: [{ name: "book", type: "ref", ref: "book" }] },
  { id: "unused", name: "Unused", fields: [] },
];
const WORLD = {
  entities: [
    { id: "copy-42", name: "Copy 42", type: "Copy" },
    { id: "idle", name: "Idle", type: "Copy" },
  ],
  relationship_types: [
    { id: "borrows", label: "borrows" },
    { id: "unused-type", label: "unused" },
  ],
  constellations: [
    {
      id: "ana-and-copy",
      name: "Ana and a copy",
      relationships: [{ from: "member-ana", type: "borrows", to: "copy-42" }],
    },
    { id: "lonely", name: "Lonely", relationships: [] },
  ],
};

function borrowCase(): Record<string, unknown> {
  return {
    id: "borrow-book",
    title: "Borrow a book",
    personas: ["member-ana"],
    constellations: ["ana-and-copy"],
    inputs: [{ object: "loan", example: { book: "b1" } }],
    outputs: [{ object: "loan", example: { book: "b1" } }],
    steps: [{ id: "tap", actor: "member-ana", action: "Taps the book" }],
    variants: [
      {
        id: "staff-for-member",
        title: "Staff lends",
        when: { membership: ["staff"] },
        actors: { "member-ana": "staff-lee" },
      },
    ],
  };
}

describe("delete_entity refuses a referenced pool entry unless force (CHR-1125)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await setUseCases(fx.store, {
      dimensions: DIMENSIONS,
      personas: PERSONAS,
      data_objects: DATA_OBJECTS,
      ...WORLD,
      use_cases: [borrowCase()],
    });
  });
  afterEach(() => fx.cleanup());

  const snapshot = async (): Promise<string> =>
    JSON.stringify([
      await fx.store.readPersonaPool(),
      await fx.store.readWorld(),
      await fx.store.readDataObjects(),
      await fx.store.listUseCaseIds(),
    ]);

  it.each([
    ["persona", "member-ana", "borrow-book"],
    ["persona", "staff-lee", "borrow-book"],
    ["dimension", "membership", "member-ana"],
    ["data_object", "book", "loan"],
    ["data_object", "loan", "borrow-book"],
    ["entity", "copy-42", "ana-and-copy"],
    ["constellation", "ana-and-copy", "borrow-book"],
    ["relationship_type", "borrows", "ana-and-copy"],
  ] as const)(
    "refuses a referenced %s %s with conflict, names the references and writes nothing",
    async (kind, name, referrer) => {
      const before = await snapshot();
      const err = await deleteEntity(fx.store, { kind, name }).catch(
        (e: unknown) => e as Error & { code: string },
      );
      expect(err).toMatchObject({ code: "conflict", message: expect.stringContaining(referrer) });
      expect((err as Error).message).toContain("pass force: true to delete anyway");
      expect(await snapshot()).toBe(before);
      // still there afterwards
      const pool = await fx.store.readPersonaPool();
      const world = await fx.store.readWorld();
      const objects = await fx.store.readDataObjects();
      expect(
        [
          ...pool.personas,
          ...pool.dimensions,
          ...objects,
          ...world.entities,
          ...world.constellations,
          ...world.relationship_types,
        ].some((x) => x.id === name),
      ).toBe(true);
    },
  );

  it("uses the same words for kinds with an underscore in the refusal and in the fail-closed message", async () => {
    await expect(deleteEntity(fx.store, { kind: "data_object", name: "book" })).rejects.toMatchObject({ message: expect.stringContaining('data object "book" is still referenced') });
    await writeFile(join(fx.dir, "usecases", "cases", "broken.json"), "{ not json");
    await expect(deleteEntity(fx.store, { kind: "data_object", name: "unused" })).rejects.toMatchObject({ message: expect.stringContaining('cannot safely delete data object "unused"') });
  });

  it("deletes with force: true and returns the dangling_reference warnings", async () => {
    const res = await deleteEntity(fx.store, { kind: "persona", name: "staff-lee", force: true });
    expect(res.warnings).toEqual([
      expect.objectContaining({ kind: "dangling_reference", target: "persona:staff-lee" }),
    ]);
    expect(res).not.toHaveProperty("invalid_file_count");
    expect((await fx.store.readPersonaPool()).personas.map((p) => p.id)).toEqual([
      "member-ana",
      "visitor",
    ]);
  });

  it("deletes an unreferenced entry without force, and force on it is a plain delete", async () => {
    await expect(
      deleteEntity(fx.store, { kind: "data_object", name: "unused" }),
    ).resolves.toMatchObject({ warnings: [] });
    await expect(
      deleteEntity(fx.store, { kind: "persona", name: "visitor", force: true }),
    ).resolves.toMatchObject({ warnings: [] });
    await expect(
      deleteEntity(fx.store, { kind: "relationship_type", name: "unused-type" }),
    ).resolves.toMatchObject({ warnings: [] });
    await expect(
      deleteEntity(fx.store, { kind: "constellation", name: "lonely" }),
    ).resolves.toMatchObject({ warnings: [] });
    await expect(deleteEntity(fx.store, { kind: "entity", name: "idle" })).resolves.toMatchObject({
      warnings: [],
    });
  });

  it("never refuses a use_case, and rejects force on it", async () => {
    await expect(
      deleteEntity(fx.store, { kind: "use_case", name: "borrow-book", force: true }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      deleteEntity(fx.store, { kind: "use_case", name: "borrow-book", force: false }),
    ).resolves.toMatchObject({ kind: "use_case" });
  });

  it.each(["screen", "component", "pattern", "mockup", "use_case"] as const)(
    "rejects force on %s with validation_failed before not_found",
    async (kind) => {
      await expect(
        deleteEntity(fx.store, { kind, name: "missing", force: true }),
      ).rejects.toMatchObject({
        code: "validation_failed",
        message: expect.stringContaining("force only applies to kinds"),
      });
      await expect(
        deleteEntity(fx.store, { kind, name: "missing", force: false }),
      ).rejects.toMatchObject({ code: "not_found" });
    },
  );

  it("orders the guards variant, cascade, force", async () => {
    await expect(
      deleteEntity(fx.store, { kind: "persona", name: "x", variant: "v", force: true }),
    ).rejects.toMatchObject({ message: expect.stringContaining("variant only applies") });
    await expect(
      deleteEntity(fx.store, { kind: "persona", name: "x", cascade: true, force: true }),
    ).rejects.toMatchObject({ message: expect.stringContaining("cascade only applies") });
  });

  it("answers not_found for an unknown entry even with force", async () => {
    await expect(
      deleteEntity(fx.store, { kind: "persona", name: "nobody", force: true }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  describe("an unreadable case file", () => {
    beforeEach(async () => {
      await writeFile(join(fx.dir, "usecases", "cases", "broken.json"), "{ not json");
    });

    it("fails closed for the kinds whose scan reads case files, even when nothing is referenced", async () => {
      for (const [kind, name] of [
        ["persona", "visitor"],
        ["data_object", "unused"],
        ["constellation", "lonely"],
        ["entity", "idle"],
      ] as const) {
        const err = await deleteEntity(fx.store, { kind, name }).catch(
          (e: unknown) => e as Error & { code: string },
        );
        expect(err, kind).toMatchObject({
          code: "conflict",
          message: expect.stringContaining("usecases/cases/broken.json"),
        });
        expect((err as Error).message, kind).toContain("reference check is incomplete");
      }
    });

    it("fails closed for a dimension too (a dimension nobody uses still needs the case files to rule that out)", async () => {
      await setUseCases(fx.store, {
        dimensions: [
          { id: "language", name: "Language", values: [{ id: "en", label: "English" }] },
        ],
      });
      const err = await deleteEntity(fx.store, { kind: "dimension", name: "language" }).catch(
        (e: unknown) => e as Error & { code: string },
      );
      expect(err).toMatchObject({
        code: "conflict",
        message: expect.stringContaining("usecases/cases/broken.json"),
      });
      const forced = await deleteEntity(fx.store, {
        kind: "dimension",
        name: "language",
        force: true,
      });
      expect(forced.warnings as Warning[]).toEqual([
        expect.objectContaining({ kind: "invalid_file", target: "use_case:broken" }),
      ]);
    });

    describe("when a persona and an entity share an id", () => {
      beforeEach(async () => {
        await setUseCases(fx.store, {
          entities: [{ id: "visitor", name: "Visitor entity", type: "Guest" }],
        });
      });

      it("deleting the entity does not fail closed: the persona still resolves the id, so no case file is scanned", async () => {
        const res = await deleteEntity(fx.store, { kind: "entity", name: "visitor" });
        expect(res).toMatchObject({ kind: "entity", warnings: [] });
      });

      it("deleting the entity with force adds no invalid_file warning and no invalid_file_count", async () => {
        const res = await deleteEntity(fx.store, { kind: "entity", name: "visitor", force: true });
        expect(res.warnings).toEqual([]);
        expect(res).not.toHaveProperty("invalid_file_count");
      });

      it("deleting the persona still scans the case files, so it fails closed", async () => {
        await expect(
          deleteEntity(fx.store, { kind: "persona", name: "visitor" }),
        ).rejects.toMatchObject({
          code: "conflict",
          message: expect.stringContaining("reference check is incomplete"),
        });
      });
    });

    it("does not fail closed for relationship_type, whose scan reads no case file", async () => {
      const res = await deleteEntity(fx.store, { kind: "relationship_type", name: "unused-type" });
      expect(res).toMatchObject({ warnings: [] });
      expect(res).not.toHaveProperty("invalid_file_count");
    });

    it("deletes with force and adds an invalid_file warning (target use_case:<id>)", async () => {
      const res = await deleteEntity(fx.store, { kind: "persona", name: "visitor", force: true });
      expect(res.warnings as Warning[]).toEqual([
        expect.objectContaining({
          kind: "invalid_file",
          target: "use_case:broken",
          message: expect.stringContaining("usecases/cases/broken.json is not loaded"),
        }),
      ]);
      expect((res.warnings as Warning[])[0]!.target).not.toContain("usecases/");
      expect(res).not.toHaveProperty("invalid_file_count");
    });

    it("caps invalid_file at 10 and reports invalid_file_count", async () => {
      for (let i = 0; i < 11; i++)
        await writeFile(join(fx.dir, "usecases", "cases", `broken-${i}.json`), "{");
      const refusal = await deleteEntity(fx.store, { kind: "data_object", name: "unused" }).catch(
        (e: Error) => e,
      );
      expect((refusal as Error).message).toContain("+7 more");
      const res = await deleteEntity(fx.store, {
        kind: "data_object",
        name: "unused",
        force: true,
      });
      expect((res.warnings as Warning[]).filter((w) => w.kind === "invalid_file")).toHaveLength(10);
      expect(res.invalid_file_count).toBe(12);
      expect(res.invalid_file_omitted_count).toBe(2);
    });
  });
});
