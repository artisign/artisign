import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { getUseCase, setUseCases } from "./usecases.js";

const when = [{ subject: "ana", property: "open-loans", op: "gte", value: 5 }];
const branch = (id: string, steps: Record<string, unknown>[]) => ({ id, title: id, when, steps });

function loanCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "borrow-a-book",
    title: "Borrow a book",
    personas: ["ana"],
    inputs: [{ object: "loan", example: { status: "available" } }],
    outputs: [{ object: "loan", example: { status: "on-loan" } }],
    steps: [{ id: "open", actor: "ana", action: "Opens", via: "scanner" }, { id: "done", actor: "system", action: "Done" }],
    ...overrides,
  };
}

describe("step via and replace_branch id (ADR-011 review)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await setUseCases(fx.store, {
      data_objects: [{ id: "loan", name: "Loan", fields: [{ name: "status", type: "string" }] }],
      personas: [{ id: "ana", name: "Ana" }],
      dimensions: [{ id: "membership", label: "Membership", values: [{ id: "staff", label: "Staff" }] }],
    });
  });
  afterEach(() => fx.cleanup());

  it("keeps `via` on a main-flow step, a branch step and a variant op step", async () => {
    await setUseCases(fx.store, {
      use_cases: [
        loanCase({
          branches: [branch("offline", [{ id: "show-offline", actor: "system", action: "Shows", via: "email" }])],
          variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, steps: [{ op: "append", step: { id: "late", actor: "system", action: "Late", via: "webhook" } }, { op: "add_branch", branch: branch("extra", [{ id: "extra-1", actor: "system", action: "E", via: "partner API" }]) }] }],
        }),
      ],
    });
    const stored = await fx.store.readUseCase("borrow-a-book");
    expect(stored.steps[0]!.via).toBe("scanner");
    expect(stored.branches![0]!.steps[0]!.via).toBe("email");
    const bundle = await getUseCase(fx.store, { id: "borrow-a-book" });
    const useCase = bundle.use_case as { steps: { via?: string }[]; branches: { steps: { via?: string }[] }[] };
    expect([useCase.steps[0]!.via, useCase.branches[0]!.steps[0]!.via]).toEqual(["scanner", "email"]);
    const resolved = (await getUseCase(fx.store, { id: "borrow-a-book", variant: "v" })).use_case as { steps: { id: string; via?: string }[]; branches: { id: string; steps: { via?: string }[] }[] };
    expect(resolved.steps.find((s) => s.id === "late")!.via).toBe("webhook");
    expect(resolved.branches.find((b) => b.id === "extra")!.steps[0]!.via).toBe("partner API");
  });

  it("replace_branch must keep the branch id: another id is validation_failed and nothing is written", async () => {
    const withOp = (id: string) => loanCase({ branches: [branch("offline", [{ id: "o1", actor: "system", action: "x" }])], variants: [{ id: "v", title: "V", when: { membership: ["staff"] }, steps: [{ op: "replace_branch", branch_id: "offline", branch: branch(id, [{ id: "o2", actor: "system", action: "y" }]) }] }] });
    await expect(setUseCases(fx.store, { use_cases: [withOp("renamed")] })).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("replace_branch keeps the id") });
    expect(await fx.store.listUseCaseIds()).toEqual([]);
    await setUseCases(fx.store, { use_cases: [withOp("offline")] });
    expect(await fx.store.listUseCaseIds()).toEqual(["borrow-a-book"]);
  });
});
