import { describe, it, expect } from "vitest";
import {
  buildPools,
  useCaseSchema,
  validateConstellation,
  validateEntity,
  validateRelationshipType,
  validateUseCase,
  type Constellation,
  type DataObject,
  type Dimension,
  type Entity,
  type Persona,
  type RelationshipType,
  type UseCase,
  type World,
} from "./index.js";

const dimensions: Dimension[] = [
  { id: "membership", label: "Membership", values: [{ id: "member", label: "Member" }, { id: "staff", label: "Staff" }] },
  { id: "branch", label: "Branch", scope: "constellations", values: [{ id: "north", label: "North" }, { id: "south", label: "South" }] },
];
const persona = (id: string, traits: Record<string, string> = {}): Persona => ({ id, name: id, traits });
const entity = (id: string, rest: Partial<Entity> = {}): Entity => ({ id, name: id, traits: {}, ...rest });
const personas = [persona("ana", { membership: "member" }), persona("ben", { membership: "staff" })];
const entities = [entity("copy-42", { object: "book-copy" }), entity("shelf", { traits: { branch: "north" } })];
const relationshipTypes: RelationshipType[] = [
  { id: "borrows", label: "borrows" },
  { id: "colleague-of", label: "is colleague of", same_traits: ["membership"] },
  { id: "holds", label: "holds", field: { object: "book-copy", name: "holder" } },
];
const constellation = (id: string, rels: [string, string, string][], traits: Record<string, string> = {}): Constellation => ({
  id,
  name: id,
  traits,
  relationships: rels.map(([from, type, to]) => ({ from, type, to })),
});
const north = constellation("ana-at-north", [["ana", "borrows", "copy-42"], ["copy-42", "holds", "shelf"]], { branch: "north" });
const south = constellation("ben-at-south", [["ben", "colleague-of", "ana"]], { branch: "south" });
const world: World = { entities, relationship_types: relationshipTypes, constellations: [north, south] };
const bookCopy: DataObject = {
  id: "book-copy",
  name: "Book copy",
  fields: [
    { name: "status", type: "enum", values: ["available", "on-loan"] },
    { name: "loans", type: "number" },
    { name: "holder", type: "ref", ref: "book-copy" },
    { name: "title", type: "string" },
  ],
};

function pools(overrides: { world?: World; objects?: DataObject[]; dataModel?: boolean } = {}) {
  return buildPools(dimensions, personas, overrides.objects ?? [bookCopy], overrides.world ?? world, overrides.dataModel ?? true);
}

function useCase(overrides: Record<string, unknown> = {}): UseCase {
  return useCaseSchema.parse({
    id: "borrow-a-book",
    title: "Borrow a book",
    constellations: ["ana-at-north"],
    inputs: [{ object: "book-copy", example: { status: "available" } }],
    outputs: [{ object: "book-copy", example: { status: "on-loan" } }],
    steps: [{ id: "pick", actor: "ana", action: "picks a copy" }],
    ...overrides,
  });
}

const kinds = (warnings: { kind: string }[]): string[] => warnings.map((w) => w.kind);

describe("world warnings on a case", () => {
  it("is quiet for a consistent case", async () => {
    expect(await validateUseCase(useCase({ state: [{ subject: "copy-42", property: "status", value: "available" }] }), pools())).toEqual([]);
  });

  it("raises entity_as_actor for an entity actor instead of unknown_persona, on step and trigger", async () => {
    const warnings = await validateUseCase(
      useCase({ trigger: { text: "t", actor: "copy-42" }, steps: [{ id: "pick", actor: "copy-42", action: "x" }, { id: "ghost", actor: "nobody", action: "y" }] }),
      pools(),
    );
    expect(warnings.filter((w) => w.kind === "entity_as_actor").map((w) => w.target)).toEqual(["use_case:borrow-a-book", "use_case:borrow-a-book/pick"]);
    expect(warnings.filter((w) => w.kind === "unknown_persona").map((w) => w.target)).toEqual(["use_case:borrow-a-book/ghost"]);
  });

  it("names the constellation a participant is missing from", async () => {
    const warnings = await validateUseCase(useCase({ steps: [{ id: "help", actor: "ben", action: "helps" }], state: [{ subject: "shelf", property: "p", value: 1 }, { subject: "system", property: "p", value: 1 }] }), pools({ dataModel: false }));
    const outside = warnings.filter((w) => w.kind === "outside_constellation");
    expect(outside.map((w) => w.target)).toEqual(["use_case:borrow-a-book/help"]);
    expect(outside[0]!.message).toContain('"ana-at-north"');
  });

  it("does not check membership without constellations, and skips unknown constellations", async () => {
    expect(kinds(await validateUseCase(useCase({ constellations: [], steps: [{ id: "help", actor: "ben", action: "h" }] }), pools()))).toEqual([]);
    const warnings = await validateUseCase(useCase({ constellations: ["nowhere"], steps: [{ id: "help", actor: "ben", action: "h" }] }), pools());
    expect(kinds(warnings)).toEqual(["unknown_constellation"]);
  });

  it("flags a state subject and a branch condition subject that is no participant", async () => {
    const warnings = await validateUseCase(
      useCase({
        state: [{ subject: "ghost", property: "p", value: 1 }],
        steps: [{ id: "pick", actor: "ana", action: "x" }],
        branches: [{ id: "late", title: "Late", from: "pick", when: [{ subject: "phantom", property: "p", value: 1 }], steps: [{ id: "fine", actor: "system", action: "z" }] }],
      }),
      pools({ dataModel: false }),
    );
    expect(warnings.filter((w) => w.kind === "unknown_participant").map((w) => w.target)).toEqual(["use_case:borrow-a-book", "use_case:borrow-a-book/branch:late"]);
  });

  describe("variants are judged on their resolved state", () => {
    it("flags the actor a variant maps to, once, on the variant", async () => {
      const warnings = await validateUseCase(useCase({ variants: [{ id: "staff", title: "Staff", when: { membership: ["staff"] }, actors: { ana: "ben" } }] }), pools());
      expect(warnings.filter((w) => w.kind === "outside_constellation").map((w) => w.target)).toEqual(["use_case:borrow-a-book#staff/pick"]);
    });

    it("does not repeat a base problem on the variant", async () => {
      const base = { steps: [{ id: "help", actor: "ben", action: "h" }] };
      const warnings = await validateUseCase(useCase({ ...base, variants: [{ id: "v", title: "V", when: { membership: ["member"] }, goal: "other" }] }), pools());
      expect(warnings.filter((w) => w.kind === "outside_constellation")).toHaveLength(1);
    });

    it("uses the variant's own constellations", async () => {
      const warnings = await validateUseCase(
        useCase({ steps: [{ id: "help", actor: "ben", action: "h" }], variants: [{ id: "south", title: "South", when: { branch: ["south"] }, constellations: ["ben-at-south"] }] }),
        pools(),
      );
      expect(warnings.filter((w) => w.kind === "outside_constellation").map((w) => w.target)).toEqual(["use_case:borrow-a-book/help"]);
    });

    it("reports a constellation-trait conflict against the variant's when (form 3)", async () => {
      const warnings = await validateUseCase(useCase({ variants: [{ id: "south", title: "South", when: { branch: ["south"] } }] }), pools());
      const conflicts = warnings.filter((w) => w.kind === "trait_conflict");
      expect(conflicts.map((w) => w.target)).toEqual(["use_case:borrow-a-book#south"]);
      expect(conflicts[0]!.message).toContain("ana-at-north");
      const covered = await validateUseCase(useCase({ variants: [{ id: "north", title: "North", when: { branch: ["north", "south"] } }] }), pools());
      expect(kinds(covered)).not.toContain("trait_conflict");
    });

    it("checks the starting state a variant sets", async () => {
      const warnings = await validateUseCase(
        useCase({ variants: [{ id: "v", title: "V", when: { membership: ["member"] }, state: [{ subject: "ghost", property: "p", value: 1 }] }] }),
        pools(),
      );
      expect(warnings.filter((w) => w.kind === "unknown_participant").map((w) => w.target)).toEqual(["use_case:borrow-a-book#v"]);
    });
  });
});

describe("data-model checks", () => {
  const stateCase = (state: unknown[]) => useCase({ state });

  it("checks nothing data-related while there is no data model", async () => {
    const off = pools({ objects: [], dataModel: false });
    const warnings = await validateUseCase(
      useCase({ inputs: [{ object: "missing", example: { a: 1 } }], state: [{ subject: "copy-42", property: "nope", value: 1 }] }),
      off,
    );
    expect(warnings).toEqual([]);
    expect(validateEntity(entity("copy-42", { object: "missing" }), off)).toEqual([]);
    expect(validateRelationshipType({ id: "holds", label: "holds", field: { object: "missing", name: "x" } }, off)).toEqual([]);
  });

  it("applies everything once the file exists, even with no object in it", async () => {
    const warnings = await validateUseCase(useCase({ inputs: [{ object: "missing", example: { a: 1 } }] }), pools({ objects: [], dataModel: true }));
    expect(kinds(warnings)).toContain("unknown_data_object");
  });

  it("flags a state property the entity's object does not declare", async () => {
    const warnings = await validateUseCase(stateCase([{ subject: "copy-42", property: "colour", value: "red" }]), pools());
    expect(warnings.map((w) => [w.kind, w.target])).toEqual([["unknown_data_field", "use_case:borrow-a-book"]]);
  });

  it("flags a value that does not fit the field's type or enum values", async () => {
    const mismatches = async (state: unknown[]) => (await validateUseCase(stateCase(state), pools())).filter((w) => w.kind === "state_value_mismatch");
    expect(await mismatches([{ subject: "copy-42", property: "status", value: "lost" }])).toHaveLength(1);
    expect(await mismatches([{ subject: "copy-42", property: "loans", value: "three" }])).toHaveLength(1);
    expect(await mismatches([{ subject: "copy-42", property: "status", value: "on-loan" }, { subject: "copy-42", property: "loans", value: 3 }])).toHaveLength(0);
  });

  it("checks every element of an in-condition and the trigger and branch conditions", async () => {
    const c = useCase({
      trigger: { text: "t", state: [{ subject: "copy-42", property: "status", op: "in", value: ["available", "lost"] }] },
      branches: [{ id: "b", title: "B", when: [{ subject: "copy-42", property: "loans", op: "gt", value: "many" }], steps: [{ id: "x", actor: "system", action: "x" }] }],
    });
    const warnings = (await validateUseCase(c, pools())).filter((w) => w.kind === "state_value_mismatch");
    expect(warnings.map((w) => w.target)).toEqual(["use_case:borrow-a-book", "use_case:borrow-a-book/branch:b"]);
  });

  it("checks entity.object and relationship_type.field", () => {
    const p = pools();
    expect(validateEntity(entity("copy-42", { object: "missing" }), p).map((w) => w.kind)).toContain("unknown_data_object");
    expect(validateRelationshipType({ id: "t", label: "t", field: { object: "missing", name: "x" } }, p).map((w) => w.kind)).toEqual(["unknown_data_object"]);
    expect(validateRelationshipType({ id: "t", label: "t", field: { object: "book-copy", name: "absent" } }, p).map((w) => w.kind)).toEqual(["unknown_data_field"]);
    expect(validateRelationshipType({ id: "t", label: "t", field: { object: "book-copy", name: "title" } }, p).map((w) => w.kind)).toEqual(["unknown_data_field"]);
    expect(validateRelationshipType(relationshipTypes[2]!, p)).toEqual([]);
  });
});

describe("world entities", () => {
  it("checks entity and constellation traits against the dimensions", () => {
    const p = pools();
    expect(kinds(validateEntity(entity("lamp", { traits: { colour: "red", branch: "west" } }), p))).toEqual(["unknown_dimension", "unknown_trait_value", "entity_unrelated"]);
    expect(kinds(validateConstellation({ ...north, traits: { colour: "red", branch: "west" } }, p))).toEqual(["unknown_dimension", "unknown_trait_value", "trait_conflict"]);
  });

  it("flags an entity no constellation names", () => {
    expect(kinds(validateEntity(entity("orphan"), pools()))).toEqual(["entity_unrelated"]);
    expect(validateEntity(entities[0]!, pools())).toEqual([]);
  });

  it("reports unknown participants and relationship types, self and duplicate relationships", () => {
    const c = constellation("odd", [["ana", "borrows", "ana"], ["ana", "unknown-type", "copy-42"], ["ghost", "borrows", "copy-42"], ["ana", "borrows", "copy-42"], ["ana", "borrows", "copy-42"]]);
    expect(kinds(validateConstellation(c, pools())).sort()).toEqual(["duplicate_relationship", "self_relationship", "unknown_participant", "unknown_relationship_type"]);
  });

  it("reports trait_conflict forms 1 and 2", () => {
    const form1 = validateConstellation(constellation("c1", [["ana", "colleague-of", "ben"]]), pools());
    expect(form1.filter((w) => w.kind === "trait_conflict")).toHaveLength(1);
    const form2 = validateConstellation(constellation("c2", [["ana", "borrows", "shelf"]], { branch: "south" }), pools());
    expect(form2.filter((w) => w.kind === "trait_conflict")).toHaveLength(1);
    expect(form2[0]!.message).toContain("shelf");
    expect(validateConstellation(north, pools()).filter((w) => w.kind === "trait_conflict")).toEqual([]);
  });

  it("lets a persona win over an entity of the same id when reading traits", () => {
    const shadow = pools({ world: { ...world, entities: [entity("ana", { traits: { membership: "staff" } })] } });
    const c = constellation("c", [["ana", "colleague-of", "ben"]]);
    expect(validateConstellation(c, shadow).filter((w) => w.kind === "trait_conflict")).toHaveLength(1);
  });
});
