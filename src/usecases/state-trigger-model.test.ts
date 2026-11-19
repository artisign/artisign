import { describe, it, expect } from "vitest";
import { normalizeTrigger, useCaseSchema, type UseCase } from "./schema.js";
import { resolveUseCase } from "./resolve.js";
import { matchesFilter, personasOf, stateSubjectsOf } from "./query.js";

function useCase(overrides: Record<string, unknown> = {}): UseCase {
  return useCaseSchema.parse(raw(overrides));
}

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "borrow-a-book",
    title: "Borrow a book",
    personas: ["member-ana"],
    inputs: [{ object: "loan", example: { status: "available" } }],
    outputs: [{ object: "loan", example: { status: "on-loan" } }],
    steps: [{ id: "open", actor: "member-ana", action: "Opens the book page" }],
    ...overrides,
  };
}

const variant = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: "v", title: "V", when: { membership: ["staff"] }, ...extra });
const parses = (overrides: Record<string, unknown>): boolean => useCaseSchema.safeParse(raw(overrides)).success;

describe("trigger shapes", () => {
  it("keeps every string trigger valid and reads it as an object", () => {
    const c = useCase({ trigger: "Ana finds a book" });
    expect(c.trigger).toBe("Ana finds a book");
    expect(normalizeTrigger(c.trigger!)).toEqual({ text: "Ana finds a book" });
    expect(resolveUseCase(c).use_case.trigger).toEqual({ text: "Ana finds a book" });
  });

  it("accepts an action trigger and a state trigger", () => {
    expect(parses({ trigger: { text: "t", actor: "member-ana", via: "webhook" } })).toBe(true);
    expect(parses({ trigger: { text: "t", actor: "member-ana" } })).toBe(true);
    expect(parses({ trigger: { text: "t", state: [{ subject: "copy-42", property: "status", value: "overdue" }] } })).toBe(true);
    expect(parses({ trigger: { text: "t", at: "2026-12-01" } })).toBe(true);
    expect(parses({ trigger: { text: "t", at: "2026-12-01T09:30:00Z", state: [{ subject: "copy-42", property: "status", op: "ne", value: "returned" }] } })).toBe(true);
    expect(parses({ trigger: { text: "only text" } })).toBe(true);
  });

  it("rejects the shape errors", () => {
    expect(parses({ trigger: { text: "t", actor: "member-ana", state: [{ subject: "a", property: "b", value: 1 }] } })).toBe(false);
    expect(parses({ trigger: { text: "t", actor: "member-ana", at: "2026-12-01" } })).toBe(false);
    expect(parses({ trigger: { text: "t", via: "webhook" } })).toBe(false);
    expect(parses({ trigger: { text: "t", actor: "system" } })).toBe(false);
    expect(parses({ trigger: { text: "t", state: [] } })).toBe(false);
    expect(parses({ trigger: { actor: "member-ana" } })).toBe(false);
    expect(parses({ trigger: { text: "t", extra: 1 } })).toBe(false);
    for (const at of ["tomorrow", "2026-02-31", "2026-13-01", "2026-12-01T25:00:00Z", "12/01/2026", ""]) expect(parses({ trigger: { text: "t", at } }), at).toBe(false);
  });

  it("applies the same shape rules to a variant trigger", () => {
    expect(useCaseSchema.safeParse(raw({ variants: [variant({ trigger: { text: "t", actor: "member-ana", via: "email" } })] })).success).toBe(true);
    expect(useCaseSchema.safeParse(raw({ variants: [variant({ trigger: { text: "t", actor: "system" } })] })).success).toBe(false);
  });
});

describe("state and conditions", () => {
  it("accepts a starting state of any JSON value, with no op", () => {
    expect(parses({ state: [{ subject: "copy-42", property: "status", value: "available" }, { subject: "system", property: "n", value: null }, { subject: "ana", property: "tags", value: ["a"] }] })).toBe(true);
  });

  it("rejects op on a starting-state entry and a missing value", () => {
    expect(parses({ state: [{ subject: "a", property: "b", op: "eq", value: 1 }] })).toBe(false);
    expect(parses({ state: [{ subject: "a", property: "b" }] })).toBe(false);
    expect(parses({ state: [{ subject: "", property: "b", value: 1 }] })).toBe(false);
  });

  it("allows op in trigger conditions; in only with an array", () => {
    const at = (cond: Record<string, unknown>): boolean => parses({ trigger: { text: "t", state: [{ subject: "a", property: "b", ...cond }] } });
    for (const op of ["eq", "ne", "lt", "lte", "gt", "gte"]) expect(at({ op, value: 3 }), op).toBe(true);
    expect(at({ op: "in", value: ["x", "y"] })).toBe(true);
    expect(at({ op: "in", value: "x" })).toBe(false);
    expect(at({ op: "between", value: 1 })).toBe(false);
    expect(at({ op: "eq" })).toBe(false);
  });

  it("accepts unset only on a variant state entry, without a value", () => {
    const v = (state: unknown[]): boolean => useCaseSchema.safeParse(raw({ variants: [variant({ state })] })).success;
    expect(v([{ subject: "a", property: "b", unset: true }])).toBe(true);
    expect(v([{ subject: "a", property: "b", value: 2 }])).toBe(true);
    expect(v([{ subject: "a", property: "b", unset: true, value: 2 }])).toBe(false);
    expect(v([{ subject: "a", property: "b" }])).toBe(false);
    expect(v([{ subject: "a", property: "b", op: "gt", value: 2 }])).toBe(false);
    expect(parses({ state: [{ subject: "a", property: "b", unset: true }] })).toBe(false);
  });
});

describe("when needs a dimension", () => {
  it("rejects an empty variant when", () => {
    expect(useCaseSchema.safeParse(raw({ variants: [variant({ when: {} })] })).success).toBe(false);
    expect(useCaseSchema.safeParse(raw({ variants: [variant({})] })).success).toBe(true);
  });
});

describe("constellations", () => {
  it("defaults to an empty list on the case and is optional on a variant", () => {
    expect(useCase().constellations).toEqual([]);
    const c = useCase({ constellations: ["ana-and-copy"], variants: [variant({ constellations: ["staff-world"] })] });
    expect(c.constellations).toEqual(["ana-and-copy"]);
    expect(resolveUseCase(c, c.variants![0]).use_case.constellations).toEqual(["staff-world"]);
    expect(resolveUseCase(c).use_case.constellations).toEqual(["ana-and-copy"]);
  });

  it("lets a variant override with an empty list", () => {
    const c = useCase({ constellations: ["ana-and-copy"], variants: [variant({ constellations: [] })] });
    expect(resolveUseCase(c, c.variants![0]).use_case.constellations).toEqual([]);
  });
});

describe("variant state merge", () => {
  const base = { state: [{ subject: "copy-42", property: "status", value: "available" }, { subject: "ana", property: "open-loans", value: 1 }, { subject: "system", property: "mode", value: "online" }] };
  const merged = (state: unknown[], extra: Record<string, unknown> = {}): ReturnType<typeof resolveUseCase> => {
    const c = useCase({ ...base, variants: [variant({ state, ...extra })] });
    return resolveUseCase(c, c.variants![0]);
  };

  it("returns the base state untouched without a variant, and without a variant state", () => {
    const c = useCase({ ...base, variants: [variant({})] });
    expect(resolveUseCase(c).use_case.state).toEqual(base.state);
    expect(resolveUseCase(c, c.variants![0]).use_case.state).toEqual(base.state);
    expect(resolveUseCase(c, c.variants![0]).removed_state).toEqual([]);
  });

  it("replaces by (subject, property) and marks it changed", () => {
    const r = merged([{ subject: "ana", property: "open-loans", value: 5 }]);
    expect(r.use_case.state).toEqual([
      { subject: "copy-42", property: "status", value: "available" },
      { subject: "ana", property: "open-loans", value: 5, change: "changed" },
      { subject: "system", property: "mode", value: "online" },
    ]);
  });

  it("treats the same property of another subject as another entry", () => {
    const r = merged([{ subject: "ben", property: "open-loans", value: 2 }]);
    expect(r.use_case.state).toHaveLength(4);
    expect(r.use_case.state![3]).toEqual({ subject: "ben", property: "open-loans", value: 2, change: "added" });
  });

  it("unset removes the entry and reports it in removed_state", () => {
    const r = merged([{ subject: "copy-42", property: "status", unset: true }]);
    expect(r.use_case.state!.map((e) => `${e.subject}.${e.property}`)).toEqual(["ana.open-loans", "system.mode"]);
    expect(r.removed_state).toEqual([{ subject: "copy-42", property: "status", value: "available", change: "removed" }]);
  });

  it("drops the state key when everything is unset, and ignores an unset of a missing key", () => {
    const r = merged([
      { subject: "copy-42", property: "status", unset: true },
      { subject: "ana", property: "open-loans", unset: true },
      { subject: "system", property: "mode", unset: true },
      { subject: "nobody", property: "none", unset: true },
    ]);
    expect(r.use_case.state).toBeUndefined();
    expect(r.removed_state).toHaveLength(3);
  });

  it("reports an unset of a key the base lacks as missing_state and changes nothing", () => {
    const r = merged([{ subject: "nobody", property: "none", unset: true }]);
    expect(r.issues).toEqual([expect.objectContaining({ kind: "missing_state", step_id: "nobody.none" })]);
    expect(r.use_case.state).toHaveLength(3);
  });

  it("rejects a duplicate (subject, property) in case state and in variant state", () => {
    const dup = [{ subject: "a", property: "b", value: 1 }, { subject: "a", property: "b", value: 2 }];
    expect(parses({ state: dup })).toBe(false);
    expect(useCaseSchema.safeParse(raw({ variants: [variant({ state: dup })] })).success).toBe(false);
    expect(useCaseSchema.safeParse(raw({ variants: [variant({ state: [{ subject: "a", property: "b", value: 1 }, { subject: "a", property: "b", unset: true }] })] })).success).toBe(false);
    expect(parses({ state: [{ subject: "a", property: "b", value: 1 }, { subject: "c", property: "b", value: 1 }] })).toBe(true);
  });

  it("adds state to a case without one", () => {
    const c = useCase({ variants: [variant({ state: [{ subject: "a", property: "b", value: 1 }] })] });
    expect(resolveUseCase(c, c.variants![0]).use_case.state).toEqual([{ subject: "a", property: "b", value: 1, change: "added" }]);
  });

  it("does not mutate the base case", () => {
    const c = useCase({ ...base, variants: [variant({ state: [{ subject: "ana", property: "open-loans", value: 9 }, { subject: "copy-42", property: "status", unset: true }] })] });
    const before = JSON.stringify(c);
    resolveUseCase(c, c.variants![0]);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe("actors map on trigger.actor", () => {
  const withTrigger = (map: Record<string, string>, extra: Record<string, unknown> = {}): ReturnType<typeof resolveUseCase> => {
    const c = useCase({ trigger: { text: "t", actor: "member-ana", via: "app" }, variants: [variant({ actors: map, ...extra })] });
    return resolveUseCase(c, c.variants![0]);
  };

  it("maps an inherited trigger actor", () => {
    expect(withTrigger({ "member-ana": "staff-lee" }).use_case.trigger).toEqual({ text: "t", actor: "staff-lee", via: "app" });
  });

  it("does not map a trigger the variant wrote itself", () => {
    expect(withTrigger({ "member-ana": "staff-lee" }, { trigger: { text: "own", actor: "member-ana" } }).use_case.trigger).toEqual({ text: "own", actor: "member-ana" });
  });

  it("does not apply system to a trigger actor and reports actor_invalid", () => {
    const r = withTrigger({ "member-ana": "system" });
    expect(r.use_case.trigger).toEqual({ text: "t", actor: "member-ana", via: "app" });
    expect(r.issues).toEqual([expect.objectContaining({ kind: "actor_invalid", variant: "v" })]);
    expect(r.use_case.steps[0]!.actor).toBe("system");
  });

  it("leaves a trigger without an actor alone", () => {
    const c = useCase({ trigger: "text only", variants: [variant({ actors: { "member-ana": "system" } })] });
    const r = resolveUseCase(c, c.variants![0]);
    expect(r.use_case.trigger).toEqual({ text: "text only" });
    expect(r.issues).toEqual([]);
  });
});

describe("persona set and filters with triggers", () => {
  it("includes the trigger actor of the case and of every variant, never system", () => {
    const c = useCase({ personas: [], steps: [], trigger: { text: "t", actor: "insurer-north" }, variants: [variant({ trigger: { text: "v", actor: "partner-api" } })] });
    expect([...personasOf(c)].sort()).toEqual(["insurer-north", "partner-api"]);
    expect(matchesFilter(c, { persona: "partner-api" })).toBe(true);
    expect(matchesFilter(c, { persona: "nobody" })).toBe(false);
  });

  it("searches the text of an object trigger", () => {
    const c = useCase({ trigger: { text: "The loan becomes overdue", at: "2026-12-01" } });
    expect(matchesFilter(c, { query: "overdue" })).toBe(true);
  });

  it("collects state subjects from state, trigger conditions and variants", () => {
    const c = useCase({
      state: [{ subject: "copy-42", property: "status", value: "x" }],
      trigger: { text: "t", state: [{ subject: "ana", property: "p", op: "gt", value: 1 }] },
      variants: [variant({ state: [{ subject: "ben", property: "p", unset: true }], trigger: { text: "t", state: [{ subject: "shelf", property: "p", value: 1 }] } })],
    });
    expect([...stateSubjectsOf(c)].sort()).toEqual(["ana", "ben", "copy-42", "shelf"]);
  });
});
