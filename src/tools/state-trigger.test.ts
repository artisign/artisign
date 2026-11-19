import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { deleteEntity } from "./lifecycle.js";
import { getUseCase, listUseCases, setUseCases } from "./usecases.js";

const DIMENSIONS = [{ id: "membership", label: "Membership", values: [{ id: "member", label: "Member" }, { id: "staff", label: "Staff" }] }];

function loanCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "borrow-a-book",
    title: "Borrow a book",
    personas: ["ana"],
    inputs: [{ object: "loan", example: { status: "available" } }],
    outputs: [{ object: "loan", example: { status: "on-loan" } }],
    steps: [{ id: "open", actor: "ana", action: "Opens the book page" }],
    ...overrides,
  };
}

describe("use-case state, structured trigger and constellations (ADR-011)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await setUseCases(fx.store, {
      dimensions: DIMENSIONS,
      data_objects: [{ id: "loan", name: "Loan", fields: [{ name: "status", type: "string" }] }],
      personas: [{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee" }, { id: "library", name: "Library", kind: "organization" }],
    });
  });
  afterEach(() => fx.cleanup());

  it("rejects an empty variant when with validation_failed and writes nothing", async () => {
    await expect(setUseCases(fx.store, { use_cases: [loanCase({ variants: [{ id: "v", title: "V", when: {} }] })] })).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("when must name at least one dimension"),
    });
    expect(await fx.store.listUseCaseIds()).toEqual([]);
  });

  it("rejects the trigger and state shape errors with validation_failed", async () => {
    const bad: Record<string, unknown>[] = [
      { trigger: { text: "t", actor: "system" } },
      { trigger: { text: "t", actor: "ana", at: "2026-12-01" } },
      { trigger: { text: "t", via: "email" } },
      { trigger: { text: "t", at: "soon" } },
      { state: [{ subject: "copy-42", property: "status", op: "eq", value: "x" }] },
      { trigger: { text: "t", state: [{ subject: "copy-42", property: "status", op: "in", value: "x" }] } },
    ];
    for (const extra of bad) {
      await expect(setUseCases(fx.store, { use_cases: [loanCase(extra)] }), JSON.stringify(extra)).rejects.toMatchObject({ code: "validation_failed" });
    }
    expect(await fx.store.listUseCaseIds()).toEqual([]);
  });

  it("stores a string trigger as given and always reads the object form", async () => {
    await setUseCases(fx.store, { use_cases: [loanCase({ trigger: "Ana finds a book" })] });
    expect((await fx.store.readUseCase("borrow-a-book")).trigger).toBe("Ana finds a book");
    const bundle = await getUseCase(fx.store, { id: "borrow-a-book" });
    expect((bundle.use_case as { trigger: unknown }).trigger).toEqual({ text: "Ana finds a book" });
  });

  it("returns an object trigger, state and constellations as written", async () => {
    const trigger = { text: "The loan becomes overdue", state: [{ subject: "copy-42", property: "status", value: "overdue" }], at: "2026-12-01" };
    await setUseCases(fx.store, { use_cases: [loanCase({ trigger, state: [{ subject: "copy-42", property: "status", value: "on-loan" }], constellations: ["ana-and-copy"] })] });
    const bundle = await getUseCase(fx.store, { id: "borrow-a-book" });
    expect(bundle.use_case).toMatchObject({ trigger, state: [{ subject: "copy-42", property: "status", value: "on-loan" }], constellations: ["ana-and-copy"] });
  });

  it("includes the trigger actor in the persona set, the bundle personas and the list filter", async () => {
    await setUseCases(fx.store, { use_cases: [loanCase({ personas: [], steps: [], trigger: { text: "The library recalls the book", actor: "library", via: "email" } })] });
    expect((await listUseCases(fx.store, { persona: "library" })).total).toBe(1);
    expect(((await listUseCases(fx.store, {})).facets as { persona: Record<string, number> }).persona).toEqual({ library: 1 });
    const bundle = await getUseCase(fx.store, { id: "borrow-a-book" });
    expect((bundle.personas as { id: string }[]).map((p) => p.id)).toEqual(["library"]);
  });

  it("warns unknown_persona for a trigger actor that does not exist, base and variant", async () => {
    const res = await setUseCases(fx.store, {
      use_cases: [loanCase({ trigger: { text: "t", actor: "ghost" }, variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, trigger: { text: "t", actor: "phantom" } }] })],
    });
    expect(res.warnings).toEqual([
      expect.objectContaining({ kind: "unknown_persona", target: "use_case:borrow-a-book", message: expect.stringContaining("ghost") }),
      expect.objectContaining({ kind: "unknown_persona", target: "use_case:borrow-a-book#v", message: expect.stringContaining("phantom") }),
    ]);
  });

  describe("variant", () => {
    const variants = [
      {
        id: "staff",
        title: "Staff",
        when: { membership: ["staff"] },
        constellations: ["staff-world"],
        state: [{ subject: "ana", property: "open-loans", value: 9 }, { subject: "copy-42", property: "status", unset: true }, { subject: "ben", property: "x", value: 1 }],
        actors: { ana: "lee" },
      },
    ];
    beforeEach(async () => {
      await setUseCases(fx.store, {
        use_cases: [
          loanCase({
            constellations: ["ana-and-copy"],
            trigger: { text: "Ana finds a book", actor: "ana" },
            state: [{ subject: "ana", property: "open-loans", value: 1 }, { subject: "copy-42", property: "status", value: "available" }],
            variants,
          }),
        ],
      });
    });

    it("merges state, overrides constellations, maps the trigger actor and reports removed_state", async () => {
      const bundle = await getUseCase(fx.store, { id: "borrow-a-book", variant: "staff" });
      expect(bundle.use_case).toMatchObject({
        constellations: ["staff-world"],
        trigger: { text: "Ana finds a book", actor: "lee" },
        state: [{ subject: "ana", property: "open-loans", value: 9, change: "changed" }, { subject: "ben", property: "x", value: 1, change: "added" }],
      });
      expect(bundle.removed_state).toEqual([{ subject: "copy-42", property: "status", value: "available", change: "removed" }]);
      expect((bundle.personas as { id: string }[]).map((p) => p.id).sort()).toEqual(["ana", "lee"]);
    });

    it("leaves the base read and a variant without state alone", async () => {
      const base = await getUseCase(fx.store, { id: "borrow-a-book" });
      expect(base.removed_state).toBeUndefined();
      expect((base.use_case as { state: unknown[] }).state).toHaveLength(2);
      expect((base.use_case as { constellations: string[] }).constellations).toEqual(["ana-and-copy"]);
    });

    it("warns variant_actor_invalid when the map would make the trigger actor the system", async () => {
      const res = await setUseCases(fx.store, { use_cases: [{ id: "borrow-a-book", variants: [{ id: "staff", title: "Staff", when: { membership: ["staff"] }, actors: { ana: "system" } }] }] });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "variant_actor_invalid", target: "use_case:borrow-a-book#staff" })]);
      const bundle = await getUseCase(fx.store, { id: "borrow-a-book", variant: "staff" });
      expect((bundle.use_case as { trigger: { actor: string } }).trigger.actor).toBe("ana");
      expect(bundle.warnings).toEqual([expect.objectContaining({ kind: "variant_actor_invalid" })]);
    });
  });

  it("warns variant_state_missing for an unset of a key the base lacks", async () => {
    const res = await setUseCases(fx.store, {
      use_cases: [loanCase({ state: [{ subject: "a", property: "b", value: 1 }], variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, state: [{ subject: "x", property: "y", unset: true }] }] })],
    });
    expect(res.warnings).toEqual([expect.objectContaining({ kind: "variant_state_missing", target: "use_case:borrow-a-book#v", message: expect.stringContaining("x.y") })]);
  });

  it("rejects a duplicate state key with validation_failed", async () => {
    await expect(setUseCases(fx.store, { use_cases: [loanCase({ state: [{ subject: "a", property: "b", value: 1 }, { subject: "a", property: "b", value: 2 }] })] })).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("duplicate state entry"),
    });
  });

  describe("delete_entity dangling scans", () => {
    const warningsOf = (res: Record<string, unknown>): { kind: string; message: string }[] => res.warnings as { kind: string; message: string }[];

    it("a constellation lists the use cases and variants that name it", async () => {
      await setUseCases(fx.store, {
        entities: [{ id: "copy-42", name: "Copy 42" }],
        constellations: [{ id: "ana-and-copy", name: "Ana and copy", relationships: [] }, { id: "unused", name: "Unused", relationships: [] }],
        use_cases: [
          loanCase({ constellations: ["ana-and-copy"], variants: [{ id: "staff", title: "Staff", when: { membership: ["staff"] }, constellations: ["ana-and-copy"] }, { id: "other", title: "Other", when: { membership: ["member"] }, constellations: ["unused"] }] }),
          loanCase({ id: "return-a-book", title: "Return", variants: [{ id: "late", title: "Late", when: { membership: ["member"] }, constellations: ["ana-and-copy"] }] }),
          loanCase({ id: "renew", title: "Renew" }),
        ],
      });
      const res = await deleteEntity(fx.store, { kind: "constellation", name: "ana-and-copy" });
      expect(warningsOf(res)).toEqual([expect.objectContaining({ kind: "dangling_reference", message: expect.stringContaining("borrow-a-book, borrow-a-book#staff, return-a-book#late") })]);
      expect(warningsOf(res)[0]!.message).toContain("3 use case(s) or variant(s)");
      expect(warningsOf(await deleteEntity(fx.store, { kind: "constellation", name: "unused" }))[0]!.message).toContain("borrow-a-book#other");
    });

    it("a constellation nobody names deletes without a warning", async () => {
      await setUseCases(fx.store, { constellations: [{ id: "lonely", name: "Lonely", relationships: [] }], use_cases: [loanCase()] });
      expect(warningsOf(await deleteEntity(fx.store, { kind: "constellation", name: "lonely" }))).toEqual([]);
    });

    it("an entity lists the use cases naming it as a state, condition or trigger subject", async () => {
      await setUseCases(fx.store, {
        entities: [{ id: "copy-42", name: "Copy 42" }, { id: "shelf", name: "Shelf" }, { id: "idle", name: "Idle" }],
        use_cases: [
          loanCase({ state: [{ subject: "copy-42", property: "status", value: "x" }] }),
          loanCase({ id: "trigger-case", title: "T", trigger: { text: "t", state: [{ subject: "copy-42", property: "status", op: "ne", value: "x" }] } }),
          loanCase({ id: "variant-case", title: "V", variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, state: [{ subject: "copy-42", property: "status", unset: true }] }] }),
          loanCase({ id: "variant-trigger", title: "VT", variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, trigger: { text: "t", state: [{ subject: "copy-42", property: "s", value: 1 }] } }] }),
          loanCase({ id: "other-subject", title: "O", state: [{ subject: "shelf", property: "full", value: true }] }),
        ],
      });
      const res = await deleteEntity(fx.store, { kind: "entity", name: "copy-42" });
      expect(warningsOf(res)).toEqual([expect.objectContaining({ kind: "dangling_reference", message: expect.stringContaining("4 use case(s) as a state, condition or trigger subject") })]);
      expect(warningsOf(res)[0]!.message).toContain("borrow-a-book, trigger-case, variant-case, variant-trigger");
      expect(warningsOf(await deleteEntity(fx.store, { kind: "entity", name: "idle" }))).toEqual([]);
    });

    it("a persona lists the use cases naming it as a state, condition or trigger subject, unless an entity with that id still resolves it", async () => {
      await setUseCases(fx.store, {
        use_cases: [
          loanCase({ id: "subject-case", title: "S", state: [{ subject: "lee", property: "open-loans", value: 1 }] }),
          loanCase({ id: "trigger-case", title: "T", trigger: { text: "t", state: [{ subject: "lee", property: "open-loans", op: "gt", value: 3 }] } }),
        ],
      });
      const res = await deleteEntity(fx.store, { kind: "persona", name: "lee" });
      const messages = warningsOf(res).map((w) => w.message).join("\n");
      expect(messages).toContain("2 use case(s) as a state, condition or trigger subject: subject-case, trigger-case");

      await setUseCases(fx.store, { personas: [{ id: "lee", name: "Lee" }], entities: [{ id: "lee", name: "Lee entity" }] });
      expect(warningsOf(await deleteEntity(fx.store, { kind: "persona", name: "lee" })).map((w) => w.message).join("\n")).not.toContain("subject");
    });

    it("N1: with a persona and an entity sharing an id, deleting one does not warn for what still resolves to the other", async () => {
      const world = {
        entities: [{ id: "leo", name: "Leo the entity" }, { id: "policy", name: "Policy" }],
        relationship_types: [{ id: "covers", label: "covers" }],
        constellations: [{ id: "family", name: "Family", relationships: [{ from: "policy", type: "covers", to: "leo" }] }],
      };
      const sharing = async (): Promise<void> => {
        await setUseCases(fx.store, { personas: [{ id: "leo", name: "Leo the persona" }], ...world, use_cases: [loanCase({ id: "leo-case", title: "L", state: [{ subject: "leo", property: "age", value: 7 }] })] });
      };
      await sharing();
      // The persona goes: the entity still resolves the constellation ref and the state subject.
      const persona = await deleteEntity(fx.store, { kind: "persona", name: "leo" });
      expect(warningsOf(persona).filter((w) => w.message.includes("constellation"))).toEqual([]);
      // Entity "leo" is now alone: deleting it dangles again.
      const entity = await deleteEntity(fx.store, { kind: "entity", name: "leo" });
      expect(warningsOf(entity).map((w) => w.message).join("\n")).toContain("constellation(s): family");
      expect(warningsOf(entity).map((w) => w.message).join("\n")).toContain("leo-case");
    });

    it("N1: deleting the entity while the persona stays warns about nothing", async () => {
      await setUseCases(fx.store, {
        personas: [{ id: "leo", name: "Leo the persona" }],
        entities: [{ id: "leo", name: "Leo the entity" }, { id: "policy", name: "Policy" }],
        relationship_types: [{ id: "covers", label: "covers" }],
        constellations: [{ id: "family", name: "Family", relationships: [{ from: "policy", type: "covers", to: "leo" }] }],
        use_cases: [loanCase({ id: "leo-case", title: "L", state: [{ subject: "leo", property: "age", value: 7 }] })],
      });
      expect(warningsOf(await deleteEntity(fx.store, { kind: "entity", name: "leo" }))).toEqual([]);
    });
  });
});
