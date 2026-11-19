import { describe, it, expect } from "vitest";
import { useCaseSchema, type UseCase } from "./schema.js";
import { resolveUseCase } from "./resolve.js";
import { matchesFilter, objectIdsOf, personasOf, screensOf, stateSubjectsOf } from "./query.js";
import { validateUseCase, buildPools } from "./validate.js";

// Neutral fixture: a library loan with a limit branch and an offline branch.
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      {
        id: "limit-reached",
        title: "Loan limit reached",
        from: "borrow",
        when: [{ subject: "ana", property: "open-loans", op: "gte", value: 5 }],
        steps: [
          { id: "show-limit", actor: "system", action: "Explains the loan limit", target: { screen: "loan-limit" }, data: [{ object: "limit", after: { max: 5 } }] },
          { id: "dismiss", actor: "ana", action: "Dismisses the hint" },
        ],
        rejoin: "done",
      },
      {
        id: "offline",
        title: "No connection",
        when: [{ subject: "system", property: "connectivity", value: "offline" }],
        steps: [{ id: "show-offline", actor: "system", action: "Shows the saved book", target: { screen: "offline-banner" } }],
        outcome: "Nothing is recorded",
      },
    ],
    ...overrides,
  };
}
const useCase = (overrides: Record<string, unknown> = {}): UseCase => useCaseSchema.parse(raw(overrides));
const variant = (steps: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "v", title: "V", when: { membership: ["staff"] }, steps, ...extra });
const withVariant = (steps: Record<string, unknown>[], extra: Record<string, unknown> = {}): UseCase => useCase({ variants: [variant(steps, extra)] });
const resolve = (c: UseCase) => resolveUseCase(c, c.variants![0]);
const branchOf = (c: UseCase, id: string) => resolve(c).use_case.branches!.find((b) => b.id === id)!;
const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, actor: "system", action: id, ...extra });

describe("branch shape", () => {
  const parses = (overrides: Record<string, unknown>): boolean => useCaseSchema.safeParse(raw(overrides)).success;
  const oneBranch = (extra: Record<string, unknown>) => [{ id: "b", title: "B", when: [{ subject: "ana", property: "p", value: 1 }], steps: [step("s1")], ...extra }];

  it("accepts a case without branches and keeps the key absent", () => {
    expect(parses({ branches: undefined })).toBe(true);
    expect(useCase({ branches: undefined }).branches).toBeUndefined();
  });

  it("accepts from, rejoin and outcome as optional and in any combination", () => {
    expect(parses({ branches: oneBranch({}) })).toBe(true);
    expect(parses({ branches: oneBranch({ from: "open", rejoin: "done", outcome: "x" }) })).toBe(true);
  });

  it("rejects a branch without when, with an empty when, without steps or with an unknown key", () => {
    expect(parses({ branches: oneBranch({ when: undefined }) })).toBe(false);
    expect(parses({ branches: oneBranch({ when: [] }) })).toBe(false);
    expect(parses({ branches: oneBranch({ steps: undefined }) })).toBe(false);
    expect(parses({ branches: oneBranch({ steps: [] }) })).toBe(false);
    expect(parses({ branches: oneBranch({ nested: [] }) })).toBe(false);
  });

  it("reuses conditionSchema for when: op, in and a missing value are checked the same way", () => {
    expect(parses({ branches: oneBranch({ when: [{ subject: "ana", property: "p", op: "in", value: [1, 2] }] }) })).toBe(true);
    expect(parses({ branches: oneBranch({ when: [{ subject: "ana", property: "p", op: "in", value: 1 }] }) })).toBe(false);
    expect(parses({ branches: oneBranch({ when: [{ subject: "ana", property: "p", op: "between", value: 1 }] }) })).toBe(false);
    expect(parses({ branches: oneBranch({ when: [{ subject: "ana", property: "p" }] }) })).toBe(false);
  });

  it("rejects a duplicate branch id", () => {
    expect(parses({ branches: [...oneBranch({}), ...oneBranch({ steps: [step("s2")] })] })).toBe(false);
  });

  it("rejects a step id used twice across the main flow and the branches", () => {
    expect(parses({ branches: oneBranch({ steps: [step("open")] }) })).toBe(false); // main flow
    expect(parses({ branches: [...oneBranch({}), { ...oneBranch({})[0], id: "c" }] })).toBe(false); // another branch (s1 twice)
    expect(parses({ branches: oneBranch({ steps: [step("s1"), step("s1")] }) })).toBe(false); // inside one branch
  });
});

describe("branch ops of a variant", () => {
  it("accepts the three branch ops and `append` with a branch; rejects unknown keys on them", () => {
    const ok = (steps: Record<string, unknown>[]): boolean => useCaseSchema.safeParse(raw({ variants: [variant(steps)] })).success;
    const branch = { id: "extra", title: "Extra", when: [{ subject: "ana", property: "p", value: 1 }], steps: [step("extra-1")] };
    expect(ok([{ op: "add_branch", branch }])).toBe(true);
    expect(ok([{ op: "replace_branch", branch_id: "extra", branch }])).toBe(true);
    expect(ok([{ op: "remove_branch", branch_id: "offline" }])).toBe(true);
    expect(ok([{ op: "append", step: step("x"), branch: "offline" }])).toBe(true);
    expect(ok([{ op: "add_branch", branch: { ...branch, steps: [] } }])).toBe(false);
    expect(ok([{ op: "remove_branch", branch_id: "offline", step_id: "x" }])).toBe(false);
  });

  it("finds steps in a branch for replace, insert_after and remove", () => {
    const c = withVariant([
      { op: "replace", step_id: "show-limit", step: step("show-limit", { action: "Explains it differently" }) },
      { op: "insert_after", step_id: "show-limit", step: step("explain-more") },
      { op: "remove", step_id: "dismiss" },
    ]);
    const resolved = resolve(c);
    const branch = resolved.use_case.branches!.find((b) => b.id === "limit-reached")!;
    expect(branch.steps.map((s) => [s.id, s.change])).toEqual([["show-limit", "changed"], ["explain-more", "added"]]);
    expect(resolved.use_case.steps.map((s) => s.id)).toEqual(["open", "borrow", "done"]);
    expect(resolved.issues).toEqual([]);
  });

  it("reports a removed branch step with its branch and its previous step in that branch", () => {
    const resolved = resolve(withVariant([{ op: "remove", step_id: "dismiss" }, { op: "remove", step_id: "show-limit" }]));
    expect(resolved.removed_steps).toEqual([
      expect.objectContaining({ id: "dismiss", change: "removed", after: "show-limit", branch: "limit-reached" }),
      expect.objectContaining({ id: "show-limit", change: "removed", after: null, branch: "limit-reached" }),
    ]);
    // a main-flow removal carries no branch
    expect(resolve(withVariant([{ op: "remove", step_id: "done" }])).removed_steps).toEqual([expect.not.objectContaining({ branch: expect.anything() })]);
  });

  it("leaves a branch with no steps in place when a variant removes them all (branch_empty is a validation warning)", () => {
    const c = withVariant([{ op: "remove", step_id: "show-offline" }]);
    expect(branchOf(c, "offline").steps).toEqual([]);
  });

  it("appends to a branch with `branch`, to the main flow without it, and skips a missing branch", () => {
    const resolved = resolve(withVariant([{ op: "append", step: step("late"), branch: "offline" }, { op: "append", step: step("tail") }, { op: "append", step: step("ghost-step"), branch: "ghost" }]));
    expect(resolved.use_case.branches!.find((b) => b.id === "offline")!.steps.map((s) => [s.id, s.change])).toEqual([["show-offline", undefined], ["late", "added"]]);
    expect(resolved.use_case.steps.map((s) => s.id)).toEqual(["open", "borrow", "done", "tail"]);
    expect(resolved.issues).toEqual([expect.objectContaining({ kind: "missing_branch", branch_id: "ghost", op: 2 })]);
  });

  it("adds a branch as `added` with its steps `added`", () => {
    const extra = { id: "extra", title: "Extra", when: [{ subject: "ana", property: "p", value: 1 }], steps: [step("extra-1")] };
    const resolved = resolve(withVariant([{ op: "add_branch", branch: extra }]));
    const added = resolved.use_case.branches!.at(-1)!;
    expect(added).toMatchObject({ id: "extra", change: "added" });
    expect(added.steps.map((s) => s.change)).toEqual(["added"]);
    expect(resolved.use_case.branches!.map((b) => b.change)).toEqual([undefined, undefined, "added"]);
  });

  it("replaces a branch whole: `changed`, kept ids `changed`, new ids `added`; replacing an added branch keeps it `added`", () => {
    const next = { id: "limit-reached", title: "Limit", from: "open", when: [{ subject: "ana", property: "open-loans", value: 9 }], steps: [step("show-limit"), step("brand-new")] };
    const branch = branchOf(withVariant([{ op: "replace_branch", branch_id: "limit-reached", branch: next }]), "limit-reached");
    expect(branch).toMatchObject({ title: "Limit", from: "open", change: "changed" });
    expect(branch.rejoin).toBeUndefined();
    expect(branch.steps.map((s) => [s.id, s.change])).toEqual([["show-limit", "changed"], ["brand-new", "added"]]);
    const twice = resolve(
      withVariant([
        { op: "add_branch", branch: { ...next, id: "mine", steps: [step("mine-1")] } },
        { op: "replace_branch", branch_id: "mine", branch: { ...next, id: "mine", steps: [step("mine-2")] } },
      ]),
    );
    expect(twice.use_case.branches!.find((b) => b.id === "mine")!.change).toBe("added");
  });

  it("removes a branch and reports it whole in removed_branches; removing a branch the variant added leaves no trace", () => {
    const resolved = resolve(withVariant([{ op: "remove_branch", branch_id: "limit-reached" }]));
    expect(resolved.use_case.branches!.map((b) => b.id)).toEqual(["offline"]);
    expect(resolved.removed_branches).toEqual([expect.objectContaining({ id: "limit-reached", change: "removed", from: "borrow", rejoin: "done" })]);
    expect(resolved.removed_branches[0]!.steps.map((s) => s.id)).toEqual(["show-limit", "dismiss"]);
    const gone = resolve(withVariant([{ op: "add_branch", branch: { id: "tmp", title: "T", when: [{ subject: "ana", property: "p", value: 1 }], steps: [step("tmp-1")] } }, { op: "remove_branch", branch_id: "tmp" }]));
    expect(gone.removed_branches).toEqual([]);
    const all = resolve(withVariant([{ op: "remove_branch", branch_id: "limit-reached" }, { op: "remove_branch", branch_id: "offline" }]));
    expect(all.use_case.branches).toBeUndefined();
  });

  it("skips an op naming a missing branch and reports it as a branch issue", () => {
    const resolved = resolve(withVariant([{ op: "remove_branch", branch_id: "ghost" }, { op: "replace_branch", branch_id: "ghost", branch: { id: "ghost", title: "X", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("x1")] } }]));
    expect(resolved.issues).toEqual([expect.objectContaining({ kind: "missing_branch", branch_id: "ghost", op: 0 }), expect.objectContaining({ kind: "missing_branch", branch_id: "ghost", op: 1 })]);
    expect(resolved.use_case.branches).toHaveLength(2);
  });

  it("refuses a second step id or branch id: the op is skipped and reported", () => {
    const sameStep = resolve(withVariant([{ op: "insert_after", step_id: "open", step: step("show-limit") }, { op: "append", step: step("show-offline"), branch: "limit-reached" }]));
    expect(sameStep.issues.map((i) => i.kind)).toEqual(["duplicate_step_id", "duplicate_step_id"]);
    expect(sameStep.use_case.steps).toHaveLength(3);
    const extra = { id: "offline", title: "Again", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("again")] };
    expect(resolve(withVariant([{ op: "add_branch", branch: extra }])).issues).toEqual([expect.objectContaining({ kind: "duplicate_branch_id", branch_id: "offline" })]);
    const intoMain = { ...extra, id: "fresh", steps: [step("done")] };
    expect(resolve(withVariant([{ op: "add_branch", branch: intoMain }])).issues).toEqual([expect.objectContaining({ kind: "duplicate_step_id", step_id: "done" })]);
    // a replace_branch may keep the ids of the branch it replaces
    expect(resolve(withVariant([{ op: "replace_branch", branch_id: "offline", branch: { ...extra, steps: [step("show-offline")] } }])).issues).toEqual([]);
  });

  it("never evaluates a condition and never picks a branch", () => {
    const resolved = resolve(withVariant([]));
    expect(resolved.use_case.branches!.map((b) => b.id)).toEqual(["limit-reached", "offline"]);
    expect(resolved.use_case.steps.map((s) => s.id)).toEqual(["open", "borrow", "done"]);
  });

  it("applies the actors map to inherited branch steps, not to steps an op writes", () => {
    const c = withVariant([{ op: "append", step: step("by-ana", { actor: "ana" }), branch: "offline" }], { actors: { ana: "lee" } });
    const resolved = resolve(c);
    const limit = resolved.use_case.branches!.find((b) => b.id === "limit-reached")!;
    expect(limit.steps.map((s) => [s.id, s.actor, s.change])).toEqual([["show-limit", "system", undefined], ["dismiss", "lee", "changed"]]);
    expect(resolved.use_case.branches!.find((b) => b.id === "offline")!.steps.at(-1)).toMatchObject({ id: "by-ana", actor: "ana" });
  });

  it("reports a branch removed after the actors map only changed it with its base actors", () => {
    const resolved = resolve(withVariant([{ op: "remove_branch", branch_id: "limit-reached" }], { actors: { ana: "lee" } }));
    expect(resolved.removed_branches[0]!.steps.map((s) => [s.actor, (s as { change?: string }).change])).toEqual([["system", undefined], ["ana", undefined]]);
  });

  it("does not mutate the base use case", () => {
    const c = withVariant([{ op: "remove_branch", branch_id: "offline" }, { op: "remove", step_id: "dismiss" }], { actors: { ana: "lee" } });
    const before = JSON.stringify(c);
    resolve(c);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe("ResolveIssue is a discriminated shape", () => {
  it("carries step_id only on step issues, subject/property on state issues and branch_id on branch issues", () => {
    const c = useCase({
      variants: [variant([{ op: "remove", step_id: "ghost" }, { op: "remove_branch", branch_id: "nope" }], { state: [{ subject: "ana", property: "gone", unset: true }] })],
    });
    expect(resolve(c).issues).toEqual([
      expect.objectContaining({ kind: "missing_state", subject: "ana", property: "gone" }),
      expect.objectContaining({ kind: "missing_step", step_id: "ghost", op: 0 }),
      expect.objectContaining({ kind: "missing_branch", branch_id: "nope", op: 1 }),
    ]);
    for (const issue of resolve(c).issues) {
      if (issue.kind === "missing_state") expect(issue).not.toHaveProperty("step_id");
      expect(issue).not.toHaveProperty("op", -1);
    }
  });

  it("reports the trigger actor problem without a fake op or step id", () => {
    const c = useCase({ trigger: { text: "t", actor: "ana" }, variants: [variant([], { actors: { ana: "system" } })] });
    const [issue] = resolve(c).issues;
    expect(issue).toEqual(expect.objectContaining({ kind: "actor_invalid", actor: "ana" }));
    expect(issue).not.toHaveProperty("op");
    expect(issue).not.toHaveProperty("step_id");
  });
});

describe("queries see branch steps", () => {
  it("lists branch screens and matches the screen / node filters on branch steps, including steps a variant writes", () => {
    const c = useCase({ variants: [variant([{ op: "add_branch", branch: { id: "extra", title: "E", when: [{ subject: "ana", property: "p", value: 1 }], steps: [step("extra-1", { target: { screen: "extra-screen", node: "extra-node" } })] } }])] });
    expect(screensOf(c)).toEqual(expect.arrayContaining(["loan-limit", "offline-banner", "extra-screen"]));
    expect(matchesFilter(c, { screen: "loan-limit" })).toBe(true);
    expect(matchesFilter(c, { screen: "extra-screen", node: "extra-node" })).toBe(true);
    expect(matchesFilter(c, { screen: "loan-limit", node: "btn-borrow" })).toBe(false);
    expect(matchesFilter(useCase({ branches: undefined }), { screen: "loan-limit" })).toBe(false);
  });

  it("puts branch actors in the persona set, and branch data objects and condition subjects in their scans", () => {
    const c = useCase({
      branches: [{ id: "b", title: "B", when: [{ subject: "lee", property: "p", value: 1 }], steps: [step("b1", { actor: "dex", data: [{ object: "fine", after: { amount: 1 } }] })] }],
      variants: [variant([{ op: "add_branch", branch: { id: "vb", title: "VB", when: [{ subject: "kim", property: "p", value: 1 }], steps: [step("vb1", { actor: "kim", data: [{ object: "hold" }] })] } }])],
    });
    expect([...personasOf(c)].sort()).toEqual(["ana", "dex", "kim"]);
    expect([...stateSubjectsOf(c)].sort()).toEqual(["kim", "lee"]);
    expect([...objectIdsOf(c)].sort()).toEqual(["fine", "hold", "loan"]);
  });
});

describe("branch warnings", () => {
  const pools = buildPools([], [], []);
  const warningsOf = async (c: UseCase) => (await validateUseCase(c, pools)).filter((w) => w.kind.startsWith("branch_"));

  it("is silent for a consistent case", async () => {
    expect(await warningsOf(useCase())).toEqual([]);
  });

  it("warns when from or rejoin is not a main-flow step (a branch step does not count: no nesting)", async () => {
    const c = useCase({ branches: [{ id: "b", title: "B", from: "ghost", rejoin: "dismiss-me", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("dismiss-me")] }] });
    expect((await warningsOf(c)).map((w) => w.kind).sort()).toEqual(["branch_from_missing", "branch_rejoin_missing"]);
    const nested = useCase({ branches: [...(raw().branches as unknown[]), { id: "n", title: "N", from: "show-limit", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("n1")] }] });
    expect((await warningsOf(nested)).map((w) => w.kind)).toEqual(["branch_from_missing"]);
  });

  it("warns branch_empty for a variant that empties a branch, once, on that variant", async () => {
    const c = withVariant([{ op: "remove", step_id: "show-offline" }]);
    expect(await warningsOf(c)).toEqual([expect.objectContaining({ kind: "branch_empty", target: "use_case:borrow-a-book#v/branch:offline" })]);
  });

  it("warns branch_from_missing for a variant that removes the fork step, but does not repeat what the base already has", async () => {
    const removed = withVariant([{ op: "remove", step_id: "borrow" }]);
    expect(await warningsOf(removed)).toEqual([expect.objectContaining({ kind: "branch_from_missing", target: "use_case:borrow-a-book#v/branch:limit-reached" })]);
    const brokenBase = useCase({
      branches: [{ id: "b", title: "B", from: "ghost", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("b1")] }],
      variants: [variant([{ op: "remove", step_id: "done" }])],
    });
    expect(await warningsOf(brokenBase)).toHaveLength(1);
  });

  it("maps a missing branch op to variant_step_missing and a duplicate branch id to its own warning", async () => {
    const c = withVariant([{ op: "remove_branch", branch_id: "ghost" }, { op: "add_branch", branch: { id: "offline", title: "O", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("o1")] } }]);
    const kinds = (await validateUseCase(c, pools)).map((w) => w.kind);
    expect(kinds).toEqual(expect.arrayContaining(["variant_step_missing", "duplicate_branch_id"]));
  });
});

describe("removed branches report the pristine base branch (review fixes)", () => {
  const pristine = () => useCase().branches!.find((b) => b.id === "limit-reached")!;

  it("an append into the branch before its removal leaves no trace of the appended step", () => {
    const resolved = resolve(withVariant([{ op: "append", step: step("never-existed"), branch: "limit-reached" }, { op: "remove_branch", branch_id: "limit-reached" }]));
    expect(resolved.removed_branches).toEqual([{ ...pristine(), change: "removed" }]);
    expect(resolved.removed_steps).toEqual([]);
  });

  it("a replace_branch before the removal does not change what is reported", () => {
    const next = { id: "limit-reached", title: "Other", when: [{ subject: "ana", property: "p", value: 1 }], steps: [step("b9")] };
    const resolved = resolve(withVariant([{ op: "replace_branch", branch_id: "limit-reached", branch: next }, { op: "remove_branch", branch_id: "limit-reached" }]));
    expect(resolved.removed_branches).toEqual([{ ...pristine(), change: "removed" }]);
    expect(resolved.removed_branches[0]!.steps.every((s) => !("change" in s))).toBe(true);
  });

  it("removing a step and then the branch lists the step once, with the branch", () => {
    const resolved = resolve(withVariant([{ op: "remove", step_id: "show-limit" }, { op: "remove_branch", branch_id: "limit-reached" }]));
    expect(resolved.removed_branches[0]!.steps.map((s) => s.id)).toEqual(["show-limit", "dismiss"]);
    expect(resolved.removed_steps).toEqual([]);
  });

  it("a removed step of a branch that stays is still listed as a removed step", () => {
    expect(resolve(withVariant([{ op: "remove", step_id: "dismiss" }])).removed_steps).toEqual([expect.objectContaining({ id: "dismiss", branch: "limit-reached" })]);
  });
});

describe("replace_branch keeps what the variant added itself `added` (review fixes)", () => {
  const next = (steps: Record<string, unknown>[]) => ({ id: "limit-reached", title: "L", when: [{ subject: "ana", property: "p", value: 1 }], steps });

  it("add_branch then replace_branch: the branch and its kept step stay added", () => {
    const added = { id: "mine", title: "M", when: [{ subject: "ana", property: "p", value: 1 }], steps: [step("m1")] };
    const resolved = resolve(withVariant([{ op: "add_branch", branch: added }, { op: "replace_branch", branch_id: "mine", branch: { ...added, steps: [step("m1"), step("m2")] } }]));
    const mine = resolved.use_case.branches!.find((b) => b.id === "mine")!;
    expect([mine.change, ...mine.steps.map((s) => s.change)]).toEqual(["added", "added", "added"]);
  });

  it("insert_after into a base branch, then replace_branch: the inserted step stays added, a base step becomes changed", () => {
    const resolved = resolve(withVariant([{ op: "insert_after", step_id: "show-limit", step: step("b1x") }, { op: "replace_branch", branch_id: "limit-reached", branch: next([step("show-limit"), step("b1x")]) }]));
    const branch = resolved.use_case.branches!.find((b) => b.id === "limit-reached")!;
    expect(branch.steps.map((s) => [s.id, s.change])).toEqual([["show-limit", "changed"], ["b1x", "added"]]);
  });
});

describe("base branch warnings are not repeated per variant (review)", () => {
  const pools = buildPools([], [], []);
  const warningsOf = async (c: UseCase) => (await validateUseCase(c, pools)).filter((w) => w.kind.startsWith("branch_"));

  it("matches by kind and target without the variant, so a base problem shows once however many variants there are", async () => {
    const c = useCase({
      branches: [{ id: "b", title: "B", from: "ghost", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("b1")] }],
      variants: [variant([{ op: "remove", step_id: "done" }], { id: "v1" }), variant([{ op: "remove", step_id: "open" }], { id: "v2" })],
    });
    expect(await warningsOf(c)).toEqual([expect.objectContaining({ kind: "branch_from_missing", target: "use_case:borrow-a-book/branch:b" })]);
  });

  it("still reports what only the variant causes, on the same branch", async () => {
    const c = useCase({
      branches: [{ id: "b", title: "B", from: "open", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("b1")], rejoin: "ghost" }],
      variants: [variant([{ op: "remove", step_id: "open" }])],
    });
    expect((await warningsOf(c)).map((w) => [w.kind, w.target])).toEqual([
      ["branch_rejoin_missing", "use_case:borrow-a-book/branch:b"],
      ["branch_from_missing", "use_case:borrow-a-book#v/branch:b"],
    ]);
  });
});

describe("replace_branch keeps the id (shape)", () => {
  it("is a shape error when branch.id differs from branch_id", () => {
    const branch = (id: string) => ({ id, title: "T", when: [{ subject: "a", property: "p", value: 1 }], steps: [step("s9")] });
    const ok = (id: string) => useCaseSchema.safeParse(raw({ variants: [variant([{ op: "replace_branch", branch_id: "offline", branch: branch(id) }])] })).success;
    expect(ok("offline")).toBe(true);
    expect(ok("other")).toBe(false);
  });
});
