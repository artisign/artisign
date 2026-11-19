import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { deleteEntity } from "./lifecycle.js";
import { getUseCase, listUseCases, setUseCases } from "./usecases.js";

const DIMENSIONS = [{ id: "membership", label: "Membership", values: [{ id: "member", label: "Member" }, { id: "staff", label: "Staff" }] }];
const when = (subject: string, property = "open-loans", value: unknown = 5) => [{ subject, property, op: "gte", value }];

function loanCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "borrow-a-book",
    title: "Borrow a book",
    personas: ["ana"],
    inputs: [{ object: "loan", example: { status: "available" } }],
    outputs: [{ object: "loan", example: { status: "on-loan" } }],
    steps: [
      { id: "open", actor: "ana", action: "Opens the book page", target: { screen: "book-detail" } },
      { id: "borrow", actor: "ana", action: "Taps Borrow", target: { screen: "book-detail", node: "btn-borrow" } },
      { id: "done", actor: "system", action: "Shows the due date", target: { screen: "loan-confirmation" } },
    ],
    branches: [
      { id: "limit-reached", title: "Loan limit reached", from: "borrow", when: when("ana"), steps: [{ id: "show-limit", actor: "system", action: "Explains the limit", target: { screen: "loan-limit" } }], rejoin: "done" },
    ],
    ...overrides,
  };
}

describe("branches inside a use case (ADR-011)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await setUseCases(fx.store, {
      dimensions: DIMENSIONS,
      data_objects: [{ id: "loan", name: "Loan", fields: [{ name: "status", type: "string" }] }],
      personas: [{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee" }],
      entities: [{ id: "copy-42", name: "Copy 42" }],
    });
  });
  afterEach(() => fx.cleanup());

  it("round-trips branches through the store and returns them with the case", async () => {
    const res = await setUseCases(fx.store, { use_cases: [loanCase()] });
    // the screens do not exist: branch steps are checked like main-flow steps (mapping_stale), and nothing else is wrong
    expect((res.warnings as { kind: string; target: string }[]).map((w) => [w.kind, w.target])).toContainEqual(["mapping_stale", "use_case:borrow-a-book/show-limit"]);
    expect((res.warnings as { kind: string }[]).filter((w) => w.kind !== "mapping_stale")).toEqual([]);
    const stored = await fx.store.readUseCase("borrow-a-book");
    expect(stored.branches).toHaveLength(1);
    const bundle = await getUseCase(fx.store, { id: "borrow-a-book" });
    expect((bundle.use_case as { branches: { id: string }[] }).branches.map((b) => b.id)).toEqual(["limit-reached"]);
  });

  it("rejects the shape errors with validation_failed and writes nothing", async () => {
    const branch = (extra: Record<string, unknown>) => [{ id: "b", title: "B", when: when("ana"), steps: [{ id: "b1", actor: "system", action: "x" }], ...extra }];
    const bad: Record<string, unknown>[] = [
      { branches: branch({ when: undefined }) },
      { branches: branch({ steps: undefined }) },
      { branches: branch({ steps: [] }) },
      { branches: [...branch({}), ...branch({ steps: [{ id: "b2", actor: "system", action: "y" }] })] }, // duplicate branch id
      { branches: branch({ steps: [{ id: "open", actor: "system", action: "y" }] }) }, // duplicate step id across the namespace
    ];
    for (const extra of bad) {
      await expect(setUseCases(fx.store, { use_cases: [loanCase(extra)] }), JSON.stringify(extra)).rejects.toMatchObject({ code: "validation_failed" });
    }
    expect(await fx.store.listUseCaseIds()).toEqual([]);
  });

  it("refuses a variant op that would add a second step id or branch id", async () => {
    const v = (steps: unknown[]) => [{ id: "v", title: "V", when: { membership: ["staff"] }, steps }];
    const branch = { id: "limit-reached", title: "Again", when: when("ana"), steps: [{ id: "again", actor: "system", action: "x" }] };
    await expect(setUseCases(fx.store, { use_cases: [loanCase({ variants: v([{ op: "add_branch", branch }]) })] })).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("second branch") });
    const dup = { ...branch, id: "fresh", steps: [{ id: "show-limit", actor: "system", action: "x" }] };
    await expect(setUseCases(fx.store, { use_cases: [loanCase({ variants: v([{ op: "add_branch", branch: dup }]) })] })).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("second step") });
    expect(await fx.store.listUseCaseIds()).toEqual([]);
  });

  it("warns branch_from_missing, branch_rejoin_missing and branch_empty on write", async () => {
    const res = await setUseCases(fx.store, {
      use_cases: [
        loanCase({
          branches: [{ id: "b", title: "B", from: "ghost", rejoin: "also-ghost", when: when("ana"), steps: [{ id: "b1", actor: "system", action: "x" }] }],
          variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, steps: [{ op: "add_branch", branch: { id: "c", title: "C", when: when("ana"), steps: [{ id: "c1", actor: "system", action: "x" }] } }, { op: "remove", step_id: "c1" }] }],
        }),
      ],
    });
    const kinds = (res.warnings as { kind: string }[]).map((w) => w.kind);
    expect(kinds).toEqual(expect.arrayContaining(["branch_from_missing", "branch_rejoin_missing", "branch_empty"]));
  });

  describe("get_use_case", () => {
    beforeEach(async () => {
      await setUseCases(fx.store, {
        use_cases: [
          loanCase({
            variants: [
              {
                id: "staff",
                title: "Staff",
                when: { membership: ["staff"] },
                steps: [
                  { op: "remove_branch", branch_id: "limit-reached" },
                  { op: "add_branch", branch: { id: "staff-hold", title: "Hold", from: "open", when: when("lee", "holds", 1), steps: [{ id: "show-hold", actor: "system", action: "Shows the hold", target: { screen: "hold-screen", node: "hold-banner" } }] } },
                  { op: "remove", step_id: "done" },
                ],
              },
            ],
          }),
        ],
      });
    });

    it("maps branch steps with `branch`, the base and (without a variant) the steps variants add", async () => {
      const bundle = await getUseCase(fx.store, { id: "borrow-a-book" });
      const screens = bundle.screens as { screen: string; mappings: { step: string; branch?: string; variants?: string[] }[] }[];
      expect(screens.find((s) => s.screen === "loan-limit")!.mappings).toEqual([expect.objectContaining({ step: "show-limit", branch: "limit-reached" })]);
      expect(screens.find((s) => s.screen === "hold-screen")!.mappings).toEqual([expect.objectContaining({ step: "show-hold", branch: "staff-hold", variants: ["staff"], scope: "element" })]);
      // a main-flow mapping carries no branch
      expect(screens.find((s) => s.screen === "book-detail")!.mappings.every((m) => m.branch === undefined)).toBe(true);
    });

    it("with a variant: the effective branches, removed_branches and branch on removed steps", async () => {
      const bundle = await getUseCase(fx.store, { id: "borrow-a-book", variant: "staff" });
      expect((bundle.use_case as { branches: { id: string; change?: string }[] }).branches).toEqual([expect.objectContaining({ id: "staff-hold", change: "added" })]);
      expect((bundle.removed_branches as { id: string; change: string }[]).map((b) => [b.id, b.change])).toEqual([["limit-reached", "removed"]]);
      expect(bundle.removed_steps).toEqual([expect.objectContaining({ id: "done" })]);
      expect((bundle.removed_steps as { branch?: string }[])[0]!.branch).toBeUndefined();
      const screens = bundle.screens as { screen: string; mappings: { step: string; branch?: string }[] }[];
      expect(screens.map((s) => s.screen)).not.toContain("loan-limit");
      expect(screens.find((s) => s.screen === "hold-screen")!.mappings).toEqual([expect.objectContaining({ step: "show-hold", branch: "staff-hold" })]);
    });

    it("lists no removed_branches key when nothing was removed", async () => {
      expect(await getUseCase(fx.store, { id: "borrow-a-book" })).not.toHaveProperty("removed_branches");
    });

    it("includes branch actors in the bundle personas", async () => {
      await setUseCases(fx.store, { use_cases: [loanCase({ id: "other", title: "O", branches: [{ id: "b", title: "B", when: when("ana"), steps: [{ id: "b1", actor: "lee", action: "x" }] }] })] });
      const bundle = await getUseCase(fx.store, { id: "other" });
      expect((bundle.personas as { id: string }[]).map((p) => p.id).sort()).toEqual(["ana", "lee"]);
    });
  });

  describe("list_use_cases filters", () => {
    it("the screen and node filters match branch steps and the steps variants add", async () => {
      await setUseCases(fx.store, {
        use_cases: [
          loanCase(),
          loanCase({ id: "plain", title: "Plain", branches: undefined, steps: [{ id: "p1", actor: "ana", action: "x", target: { screen: "other" } }] }),
          loanCase({ id: "variant-only", title: "V", branches: undefined, steps: [{ id: "v1", actor: "ana", action: "x" }], variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, steps: [{ op: "add_branch", branch: { id: "vb", title: "VB", when: when("ana"), steps: [{ id: "vb1", actor: "system", action: "x", target: { screen: "loan-limit", node: "limit-text" } }] } }] }] }),
        ],
      });
      expect((await listUseCases(fx.store, { screen: "loan-limit" })).use_cases).toEqual([expect.objectContaining({ id: "borrow-a-book" }), expect.objectContaining({ id: "variant-only" })]);
      expect((await listUseCases(fx.store, { screen: "loan-limit", node: "limit-text" })).use_cases).toEqual([expect.objectContaining({ id: "variant-only" })]);
      expect((await listUseCases(fx.store, { screen: "nowhere" })).total).toBe(0);
    });

    it("the persona filter and facet include branch step actors", async () => {
      await setUseCases(fx.store, { use_cases: [loanCase({ branches: [{ id: "b", title: "B", when: when("ana"), steps: [{ id: "b1", actor: "lee", action: "x" }] }] })] });
      expect((await listUseCases(fx.store, { persona: "lee" })).total).toBe(1);
    });
  });

  describe("delete_entity scans branch conditions", () => {
    const warningsOf = (res: Record<string, unknown>): { kind: string; message: string }[] => res.warnings as { kind: string; message: string }[];

    it("an entity named only by a branch condition, base or variant, is still referenced", async () => {
      await setUseCases(fx.store, {
        entities: [{ id: "shelf", name: "Shelf" }],
        use_cases: [
          loanCase({ branches: [{ id: "b", title: "B", when: [{ subject: "copy-42", property: "status", value: "lost" }], steps: [{ id: "b1", actor: "system", action: "x" }] }] }),
          loanCase({ id: "variant-branch", title: "V", branches: undefined, variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, steps: [{ op: "add_branch", branch: { id: "vb", title: "VB", when: [{ subject: "copy-42", property: "status", value: "lost" }], steps: [{ id: "vb1", actor: "system", action: "x" }] } }] }] }),
        ],
      });
      const res = await deleteEntity(fx.store, { kind: "entity", name: "copy-42" });
      expect(warningsOf(res)).toEqual([expect.objectContaining({ kind: "dangling_reference", message: expect.stringContaining("2 use case(s) as a state, condition or trigger subject") })]);
      expect(warningsOf(await deleteEntity(fx.store, { kind: "entity", name: "shelf" }))).toEqual([]);
    });

    it("a persona named only by a branch condition lists the case (the persona set already holds branch actors)", async () => {
      await setUseCases(fx.store, { use_cases: [loanCase({ personas: [], steps: [], branches: [{ id: "b", title: "B", when: when("lee"), steps: [{ id: "b1", actor: "system", action: "x" }] }] })] });
      const res = await deleteEntity(fx.store, { kind: "persona", name: "lee" });
      expect(warningsOf(res).map((w) => w.message).join(" ")).toContain("borrow-a-book");
    });
  });
});
