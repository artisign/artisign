import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { getUseCase, listUseCases, setUseCases } from "./usecases.js";

// Neutral fixture: a household insurance world with one constellation and a second, unrelated one.
const DIMENSIONS = [
  { id: "household", label: "Household", scope: "constellations", values: [{ id: "two-parents", label: "Two" }, { id: "single-parent", label: "Single" }] },
  { id: "age-group", label: "Age group", values: [{ id: "school", label: "School" }, { id: "adult", label: "Adult" }] },
  { id: "region", label: "Region", values: [{ id: "north", label: "North" }, { id: "south", label: "South" }] },
];
const PERSONAS = [
  { id: "maria", name: "Maria", kind: "human", traits: { household: "two-parents" } },
  { id: "insurer-north", name: "North Insurance", kind: "organization" },
  { id: "broker", name: "Broker", kind: "human" },
];
const ENTITIES = [
  { id: "leo", name: "Leo", type: "Child", traits: { "age-group": "school" } },
  { id: "policy-liability", name: "Liability policy", type: "Policy", object: "policy" },
  { id: "claim", name: "Claim", type: "Claim" },
  { id: "unused", name: "Unused", type: "Thing" },
];
const RELATIONSHIP_TYPES = [
  { id: "parent-of", label: "is parent of", same_traits: ["household"] },
  { id: "holds", label: "holds", field: { object: "policy", name: "holder" } },
  { id: "insures", label: "insures" },
  { id: "files", label: "files" },
];
const CONSTELLATIONS = [
  {
    id: "one-parent-one-child",
    name: "One parent, one child",
    traits: { household: "single-parent" },
    relationships: [
      { from: "maria", type: "parent-of", to: "leo" },
      { from: "maria", type: "holds", to: "policy-liability" },
      { from: "insurer-north", type: "insures", to: "policy-liability" },
    ],
  },
  { id: "claim-case", name: "A claim", traits: { region: "north" }, relationships: [{ from: "broker", type: "files", to: "claim" }] },
];
const DATA_OBJECTS = [
  { id: "policy", name: "Policy", fields: [{ name: "premium", type: "number" }, { name: "holder", type: "ref", ref: "customer" }] },
  { id: "customer", name: "Customer", fields: [{ name: "address", type: "ref", ref: "address" }] },
  { id: "address", name: "Address", fields: [] },
  { id: "other", name: "Other", fields: [] },
];

const base = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "review-premium",
  title: "Review a premium",
  personas: ["maria"],
  constellations: ["one-parent-one-child"],
  inputs: [{ object: "other", example: { a: 1 } }],
  outputs: [{ object: "other", example: { a: 2 } }],
  steps: [{ id: "open", actor: "maria", action: "Opens the premium" }],
  branches: [{ id: "late", title: "Late", when: [{ subject: "claim", property: "status", value: "open" }], steps: [{ id: "warn", actor: "system", action: "Warns" }] }],
  variants: [{ id: "claim-variant", title: "With a claim", when: { region: ["north"] }, constellations: ["claim-case"] }],
  ...extra,
});

describe("world block in get_use_case and list filters (CHR-1150)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, data_objects: DATA_OBJECTS, entities: ENTITIES, relationship_types: RELATIONSHIP_TYPES, constellations: CONSTELLATIONS });
    await setUseCases(fx.store, { use_cases: [base(), { id: "plain", title: "Plain", personas: ["maria"], inputs: base().inputs, outputs: base().outputs, steps: [] }] });
  });
  afterEach(() => fx.cleanup());

  const ids = (res: Record<string, unknown>, key: string): string[] => (res[key] as { id: string }[]).map((x) => x.id);

  describe("get_use_case", () => {
    it("without a variant carries the constellations of the case and every variant, and what they name", async () => {
      const res = await getUseCase(fx.store, { id: "review-premium" });
      expect(ids(res, "constellations")).toEqual(["one-parent-one-child", "claim-case"]);
      expect(ids(res, "relationship_types")).toEqual(["parent-of", "holds", "insures", "files"]);
      // members plus the branch `when` subject; the unrelated entity stays out
      expect(ids(res, "entities")).toEqual(["leo", "policy-liability", "claim"]);
      // persona members travel along (insurer-north, broker), no entity does
      expect(ids(res, "personas")).toEqual(["maria", "insurer-north", "broker"]);
      // traits of personas, entities and constellations
      expect(ids(res, "dimensions").sort()).toEqual(["age-group", "household", "region"]);
      // entity.object and relationship type field.object, plus the objects the case names
      expect(ids(res, "data_objects")).toEqual(["policy", "customer", "address", "other"]);
    });

    it("with a variant carries the effective case's constellations only", async () => {
      const plain = await getUseCase(fx.store, { id: "review-premium", variant: "claim-variant" });
      expect(ids(plain, "constellations")).toEqual(["claim-case"]);
      expect(ids(plain, "relationship_types")).toEqual(["files"]);
      expect(ids(plain, "entities")).toEqual(["claim"]);
      expect(ids(plain, "personas")).toEqual(["maria", "broker"]);
    });

    it("keeps removed_branches and removed_state for a variant that removes them", async () => {
      await setUseCases(fx.store, {
        use_cases: [
          base({
            state: [{ subject: "leo", property: "insured", value: true }],
            variants: [{ id: "lean", title: "Lean", when: { region: ["south"] }, state: [{ subject: "leo", property: "insured", unset: true }], steps: [{ op: "remove_branch", branch_id: "late" }] }],
          }),
        ],
      });
      const res = await getUseCase(fx.store, { id: "review-premium", variant: "lean" });
      expect(res.removed_branches).toMatchObject([{ id: "late", change: "removed" }]);
      expect(res.removed_state).toMatchObject([{ subject: "leo", property: "insured", change: "removed" }]);
    });

    it("follows ref fields of the objects the world brings, transitively", async () => {
      const res = await getUseCase(fx.store, { id: "review-premium", variant: "claim-variant" });
      expect(ids(res, "data_objects")).toEqual(["other"]);
      const full = await getUseCase(fx.store, { id: "review-premium" });
      expect(ids(full, "data_objects")).toEqual(expect.arrayContaining(["policy", "customer", "address"]));
    });

    it("keeps the subjects of removed state and removed branches resolvable under a variant", async () => {
      await setUseCases(fx.store, {
        use_cases: [
          base({
            state: [{ subject: "unused", property: "flag", value: true }],
            variants: [{ id: "lean", title: "Lean", when: { region: ["south"] }, state: [{ subject: "unused", property: "flag", unset: true }], steps: [{ op: "remove_branch", branch_id: "late" }] }],
          }),
        ],
      });
      const res = await getUseCase(fx.store, { id: "review-premium", variant: "lean" });
      expect(ids(res, "entities")).toEqual(expect.arrayContaining(["claim", "unused"]));
    });

    it("omits the world keys for a case without constellations or state subjects", async () => {
      const res = await getUseCase(fx.store, { id: "plain" });
      for (const key of ["entities", "constellations", "relationship_types"]) expect(res).not.toHaveProperty(key);
    });

    it("answers the same for a project without a world file as before", async () => {
      const bare = await setupProject();
      try {
        await setUseCases(bare.store, { personas: [{ id: "ana", name: "Ana" }], use_cases: [{ id: "c", title: "C", personas: ["ana"], inputs: base().inputs, outputs: base().outputs, steps: [{ id: "s", actor: "ana", action: "Acts" }] }] });
        const res = await getUseCase(bare.store, { id: "c" });
        expect(Object.keys(res).sort()).toEqual(["data_objects", "dimensions", "personas", "screens", "use_case", "warnings"]);
      } finally {
        await bare.cleanup();
      }
    });
  });

  describe("list_use_cases", () => {
    const list = async (filter: Record<string, unknown>): Promise<string[]> => ids(await listUseCases(fx.store, filter as never), "use_cases");

    it("filters by constellation, case or variant, exact match", async () => {
      expect(await list({ constellation: "one-parent-one-child" })).toEqual(["review-premium"]);
      expect(await list({ constellation: "claim-case" })).toEqual(["review-premium"]);
      expect(await list({ constellation: "one-parent" })).toEqual([]);
    });

    it("filters by entity: constellation member or state subject, branch when included", async () => {
      expect(await list({ entity: "leo" })).toEqual(["review-premium"]);
      expect(await list({ entity: "claim" })).toEqual(["review-premium"]);
      expect(await list({ entity: "unused" })).toEqual([]);
    });

    it("matches only ids that resolve to an entity, not personas", async () => {
      expect(await list({ entity: "maria" })).toEqual([]);
      expect(await list({ entity: "broker" })).toEqual([]);
    });

    it("treats an empty or blank string as no filter", async () => {
      const all = await list({});
      expect(all).toHaveLength(2);
      for (const key of ["constellation", "entity"]) {
        expect(await list({ [key]: "" })).toEqual(all);
        expect(await list({ [key]: "  " })).toEqual(all);
      }
    });

    it("carries branches and constellations in the summary and adds no facet", async () => {
      const res = await listUseCases(fx.store, {});
      const summary = (res.use_cases as Record<string, unknown>[]).find((u) => u.id === "review-premium")!;
      expect(summary).toMatchObject({ branches: 1, constellations: ["one-parent-one-child", "claim-case"] });
      const plain = (res.use_cases as Record<string, unknown>[]).find((u) => u.id === "plain")!;
      expect(plain).not.toHaveProperty("branches");
      expect(plain).not.toHaveProperty("constellations");
      expect(Object.keys(res.facets as object).sort()).toEqual(["group", "persona", "status", "tag"]);
    });
  });
});
