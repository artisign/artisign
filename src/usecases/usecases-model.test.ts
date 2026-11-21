import { describe, it, expect } from "vitest";
import { isValidId, useCaseSchema, personaSchema, dimensionSchema, type Dimension, type Persona, type UseCase } from "./schema.js";
import { resolveUseCase } from "./resolve.js";
import { buildGeneratedPersona, expandCombinations, pairSpace, suggestVariantGaps, WORK_BUDGET } from "./generate.js";
import { compareUseCases, facetCounts, matchesFilter, personasOf, summarize } from "./query.js";

function useCase(overrides: Record<string, unknown> = {}): UseCase {
  return useCaseSchema.parse({
    id: "assign",
    title: "Borrow a book",
    personas: ["member-ana"],
    inputs: [{ object: "loan", example: { status: "available" } }],
    outputs: [{ object: "loan", example: { status: "on-loan" } }],
    steps: [
      { id: "tap", actor: "member-ana", action: "Taps the book", target: { screen: "month", node: "book-14" } },
      { id: "pick", actor: "member-ana", action: "Picks a copy", target: { screen: "sheet" } },
      { id: "done", actor: "system", action: "Loan is recorded" },
    ],
    ...overrides,
  });
}

const dims = (...specs: [string, string[]][]): Dimension[] =>
  specs.map(([id, values]) => dimensionSchema.parse({ id, name: id.toUpperCase(), values: values.map((v) => ({ id: v, label: v.toUpperCase() })) }));

const persona = (id: string, traits: Record<string, string> = {}): Persona => personaSchema.parse({ id, name: id, traits });

describe("variant actors map", () => {
  const withMap = (actors: Record<string, string>, extra: Record<string, unknown> = {}, base: Record<string, unknown> = {}): UseCase =>
    useCase({ variants: [{ id: "v", title: "V", when: { size: ["small"] }, actors, ...extra }], ...base });
  const actors = (base: UseCase): [string, string, string | undefined][] =>
    resolveUseCase(base, base.variants![0]).use_case.steps.map((s) => [s.id, s.actor, s.change]);

  it("is optional: a variant without it resolves exactly as before", () => {
    const base = useCase({ variants: [{ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "remove", step_id: "done" }] }] });
    const resolved = resolveUseCase(base, base.variants![0]);
    expect(resolved.use_case.steps.map((s) => [s.id, s.actor, s.change])).toEqual([["tap", "member-ana", undefined], ["pick", "member-ana", undefined]]);
    expect(resolved.use_case.personas).toEqual(["member-ana"]);
  });

  it("accepts ids and system, rejects anything else as a shape error", () => {
    const parse = (map: unknown): boolean => useCaseSchema.safeParse({ ...useCase(), variants: [{ id: "v", title: "V", when: { size: ["small"] }, actors: map }] }).success;
    expect(parse({ "member-ana": "staff-lee", system: "member-ana", "member-lee": "system" })).toBe(true);
    expect(parse({})).toBe(true);
    for (const bad of [{ "Member Ana": "x" }, { x: "Not An Id" }, { x: "" }, { x: 1 }, ["x"], "x"]) expect(parse(bad)).toBe(false);
  });

  it("remaps the actor of every inherited step whose actor is a key and marks it changed", () => {
    expect(actors(withMap({ "member-ana": "staff-lee" }))).toEqual([["tap", "staff-lee", "changed"], ["pick", "staff-lee", "changed"], ["done", "system", undefined]]);
  });

  it("is not chained", () => {
    const base = useCase({ steps: [{ id: "a", actor: "one", action: "A" }, { id: "b", actor: "two", action: "B" }] });
    const chained = useCaseSchema.parse({ ...base, variants: [{ id: "v", title: "V", when: { size: ["small"] }, actors: { one: "two", two: "three" } }] });
    expect(actors(chained)).toEqual([["a", "two", "changed"], ["b", "three", "changed"]]);
  });

  it("ignores a→a and marks a step changed only when its actor really changes", () => {
    expect(actors(withMap({ "member-ana": "member-ana", system: "system" }))).toEqual([["tap", "member-ana", undefined], ["pick", "member-ana", undefined], ["done", "system", undefined]]);
  });

  it("a key system changes steps only, and a value system remaps a step to the system", () => {
    const both = withMap({ system: "staff-lee", "member-ana": "system" });
    const r = resolveUseCase(both, both.variants![0]);
    expect(r.use_case.steps.map((s) => s.actor)).toEqual(["system", "system", "staff-lee"]);
    expect(r.use_case.personas).toEqual([]); // the value system is dropped; personas never hold "system"
  });

  it("remaps the base personas when the variant sets none: listed keys, duplicates dropped, order kept", () => {
    const base = withMap({ b: "c", d: "a" }, {}, { personas: ["a", "b", "c", "d", "e"] });
    expect(resolveUseCase(base, base.variants![0]).use_case.personas).toEqual(["a", "c", "e"]);
  });

  it("remaps the subject of branch conditions, the trigger state and state subjects; entities and the system stay", () => {
    const base = withMap(
      { "member-ana": "staff-lee" },
      {},
      {
        trigger: { text: "Member asks", state: [{ subject: "member-ana", property: "card", value: "expired" }, { subject: "loan", property: "status", value: "available" }] },
        state: [{ subject: "member-ana", property: "card", value: "expired" }, { subject: "loan", property: "status", value: "available" }],
        branches: [
          {
            id: "expired",
            title: "Card expired",
            from: "tap",
            when: [{ subject: "member-ana", property: "card", value: "expired" }, { subject: "loan", property: "status", op: "ne", value: "lost" }, { subject: "system", property: "up", value: true }],
            steps: [{ id: "renew", actor: "member-ana", action: "Renews" }],
            outcome: "Renewed",
          },
        ],
      },
    );
    const r = resolveUseCase(base, base.variants![0]).use_case;
    expect(r.branches![0]!.when.map((c) => c.subject)).toEqual(["staff-lee", "loan", "system"]);
    expect(r.branches![0]!.steps[0]!.actor).toBe("staff-lee");
    expect(r.trigger!.state!.map((c) => c.subject)).toEqual(["staff-lee", "loan"]);
    expect(r.state!.map((e) => e.subject)).toEqual(["staff-lee", "loan"]);
    expect(base.branches![0]!.when[0]!.subject).toBe("member-ana");
  });

  it("remaps an inherited trigger actor but takes state the variant wrote as written", () => {
    const base = withMap(
      { "member-ana": "staff-lee" },
      { state: [{ subject: "member-ana", property: "card", value: "valid" }] },
      { trigger: { text: "Member asks", actor: "member-ana" }, state: [{ subject: "member-ana", property: "card", value: "expired" }] },
    );
    const r = resolveUseCase(base, base.variants![0]).use_case;
    expect(r.trigger!.actor).toBe("staff-lee");
    expect(r.state).toEqual([{ subject: "member-ana", property: "card", value: "valid", change: "changed" }]);
  });

  it("keeps one start-state entry per key after the remap: remapped inherited beats inherited, variant-written beats both", () => {
    const base = withMap({ "member-ana": "staff-lee" }, {}, { state: [{ subject: "member-ana", property: "card", value: "expired" }, { subject: "staff-lee", property: "card", value: "valid" }] });
    const r = resolveUseCase(base, base.variants![0]).use_case;
    expect(r.state).toEqual([{ subject: "staff-lee", property: "card", value: "expired" }]);

    const written = withMap({ "member-ana": "staff-lee" }, { state: [{ subject: "staff-lee", property: "card", value: "blocked" }] }, { state: [{ subject: "member-ana", property: "card", value: "expired" }, { subject: "staff-lee", property: "card", value: "valid" }] });
    expect(resolveUseCase(written, written.variants![0]).use_case.state).toEqual([{ subject: "staff-lee", property: "card", value: "blocked", change: "changed" }]);
  });

  it("takes the variant's own personas as written", () => {
    const base = withMap({ "member-ana": "staff-lee" }, { personas: ["member-ana"] });
    expect(resolveUseCase(base, base.variants![0]).use_case.personas).toEqual(["member-ana"]);
  });

  it("takes steps written by an op as written and lets remove delete a remapped step", () => {
    const base = withMap(
      { "member-ana": "staff-lee" },
      {
        steps: [
          { op: "replace", step_id: "tap", step: { id: "tap", actor: "member-ana", action: "Taps again" } },
          { op: "append", step: { id: "late", actor: "member-ana", action: "Waits" } },
          { op: "remove", step_id: "pick" },
        ],
      },
    );
    const resolved = resolveUseCase(base, base.variants![0]);
    expect(resolved.use_case.steps.map((s) => [s.id, s.actor, s.change])).toEqual([["tap", "member-ana", "changed"], ["done", "system", undefined], ["late", "member-ana", "added"]]);
    expect(resolved.removed_steps).toEqual([expect.objectContaining({ id: "pick", change: "removed", after: "tap" })]);
  });

  it("reports a removed step with its base actor when only the map changed it, and as written when an op wrote it", () => {
    const mapOnly = withMap({ "member-ana": "staff-lee" }, { steps: [{ op: "remove", step_id: "pick" }] });
    const a = resolveUseCase(mapOnly, mapOnly.variants![0]);
    expect(a.removed_steps).toEqual([expect.objectContaining({ id: "pick", actor: "member-ana", change: "removed", after: "tap" })]);

    const written = withMap(
      { "member-ana": "staff-lee" },
      { steps: [{ op: "replace", step_id: "pick", step: { id: "pick", actor: "member-ana", action: "Picks again" } }, { op: "remove", step_id: "pick" }] },
    );
    const b = resolveUseCase(written, written.variants![0]);
    expect(b.removed_steps).toEqual([expect.objectContaining({ id: "pick", actor: "member-ana", action: "Picks again", change: "removed" })]);
    const rewritten = withMap(
      { "member-ana": "staff-lee" },
      { steps: [{ op: "replace", step_id: "pick", step: { id: "pick", actor: "robot", action: "Picks again" } }, { op: "remove", step_id: "pick" }] },
    );
    expect(resolveUseCase(rewritten, rewritten.variants![0]).removed_steps[0]).toMatchObject({ actor: "robot" });
  });

  it("leaves the base personas untouched when every entry maps to itself", () => {
    const base = withMap({ "member-ana": "member-ana" }, {}, { personas: ["a", "a", "b"] });
    expect(resolveUseCase(base, base.variants![0]).use_case.personas).toEqual(["a", "a", "b"]);
  });

  it("does not touch the base use case", () => {
    const base = withMap({ "member-ana": "staff-lee" });
    resolveUseCase(base, base.variants![0]);
    expect(base.steps.map((s) => s.actor)).toEqual(["member-ana", "member-ana", "system"]);
    expect(base.personas).toEqual(["member-ana"]);
  });

  it("a key that happens to be an Object.prototype name does not match", () => {
    const base = withMap({ constructor: "staff-lee" });
    expect(resolveUseCase(base, base.variants![0]).use_case.steps.map((s) => s.change)).toEqual([undefined, undefined, undefined]);
  });

  it("personasOf and the persona filter count keys and values but never system", () => {
    const base = withMap({ "member-ana": "staff-lee", system: "robot" }, {}, { personas: [], steps: [{ id: "s", actor: "system", action: "x" }] });
    expect([...personasOf(base)].sort()).toEqual(["member-ana", "robot", "staff-lee"]);
    expect(matchesFilter(base, { persona: "robot" })).toBe(true);
    expect(matchesFilter(base, { persona: "system" })).toBe(false);
    expect(facetCounts([base]).facets.persona).toEqual({ "member-ana": 1, robot: 1, "staff-lee": 1 });
  });
});

describe("use case schema", () => {
  it("defaults status, personas and steps, and requires inputs and outputs", () => {
    const parsed = useCaseSchema.parse({
      id: "x",
      title: "X",
      inputs: [{ object: "o", example: { id: 1 } }],
      outputs: [{ object: "o", example: { id: 1 } }],
    });
    expect(parsed).toMatchObject({ status: "draft", personas: [], steps: [] });
    expect(useCaseSchema.safeParse({ id: "x", title: "X", inputs: [], outputs: [{ object: "o", example: { id: 1 } }] }).success).toBe(false);
    expect(useCaseSchema.safeParse({ id: "x", title: "X", inputs: [{ object: "o", example: { id: 1 } }] }).success).toBe(false);
  });

  it("rejects ids that are not lowercase kebab-case, unknown keys and duplicate step ids", () => {
    const base = { title: "X", inputs: [{ object: "o", example: { id: 1 } }], outputs: [{ object: "o", example: { id: 1 } }] };
    expect(useCaseSchema.safeParse({ ...base, id: "../evil" }).success).toBe(false);
    expect(useCaseSchema.safeParse({ ...base, id: "Upper" }).success).toBe(false);
    expect(useCaseSchema.safeParse({ ...base, id: "ok", persona: ["typo"] }).success).toBe(false);
    const step = { id: "a", actor: "system", action: "x" };
    expect(useCaseSchema.safeParse({ ...base, id: "ok", steps: [step, step] }).success).toBe(false);
  });
});

describe("resolveUseCase", () => {
  it("returns the base flow without a variant", () => {
    const resolved = resolveUseCase(useCase());
    expect(resolved.use_case.steps.map((s) => s.id)).toEqual(["tap", "pick", "done"]);
    expect(resolved.use_case.steps.every((s) => s.change === undefined)).toBe(true);
    expect(resolved.removed_steps).toEqual([]);
    expect(resolved.use_case).not.toHaveProperty("variants");
  });

  it("applies replace / insert_after / append / remove and marks changed, added and removed", () => {
    const base = useCase({
      variants: [
        {
          id: "all-branches",
          title: "No branch limit",
          when: { "branch-access": ["all-branches"] },
          personas: ["staff-lee"],
          goal: "Borrow two books",
          outputs: [{ object: "loan", example: { status: "on-loan", borrower: "member-ana" } }],
          steps: [
            { op: "replace", step_id: "pick", step: { id: "pick", actor: "staff-lee", action: "Picks a copy" } },
            { op: "insert_after", step_id: "tap", step: { id: "confirm", actor: "staff-lee", action: "Confirms the cost" } },
            { op: "append", step: { id: "receipt", actor: "system", action: "Sends a receipt" } },
            { op: "remove", step_id: "done" },
          ],
        },
      ],
    });
    const resolved = resolveUseCase(base, base.variants![0]);
    expect(resolved.use_case.steps.map((s) => [s.id, s.change])).toEqual([
      ["tap", undefined],
      ["confirm", "added"],
      ["pick", "changed"],
      ["receipt", "added"],
    ]);
    expect(resolved.removed_steps).toEqual([expect.objectContaining({ id: "done", change: "removed", after: "pick" })]);
    expect(resolved.use_case.personas).toEqual(["staff-lee"]);
    expect(resolved.use_case.goal).toBe("Borrow two books");
    expect(resolved.use_case.outputs[0]!.example).toEqual({ status: "on-loan", borrower: "member-ana" });
    expect(resolved.use_case.inputs).toEqual(base.inputs); // not overridden
    expect(resolved.issues).toEqual([]);
  });

  it("skips an op pointing at a missing step and reports it", () => {
    const base = useCase({
      variants: [{ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "remove", step_id: "ghost" }, { op: "replace", step_id: "ghost2", step: { id: "x", actor: "system", action: "x" } }] }],
    });
    const resolved = resolveUseCase(base, base.variants![0]);
    expect(resolved.use_case.steps).toHaveLength(3);
    expect(resolved.issues.map((i) => (i.kind === "missing_step" ? i.step_id : null))).toEqual(["ghost", "ghost2"]);
  });

  it("does not mutate the base use case", () => {
    const base = useCase({ variants: [{ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "remove", step_id: "tap" }] }] });
    const before = JSON.stringify(base);
    resolveUseCase(base, base.variants![0]);
    expect(JSON.stringify(base)).toBe(before);
  });

  it("drops a step the variant added and then removed without a trace", () => {
    const base = useCase({
      variants: [{ id: "v", title: "V", when: { size: ["small"] }, steps: [{ op: "append", step: { id: "tmp", actor: "system", action: "x" } }, { op: "remove", step_id: "tmp" }] }],
    });
    const resolved = resolveUseCase(base, base.variants![0]);
    expect(resolved.use_case.steps.map((s) => s.id)).toEqual(["tap", "pick", "done"]);
    expect(resolved.removed_steps).toEqual([]);
  });
});

describe("expandCombinations", () => {
  const d = dims(["membership", ["student", "staff"]], ["limit", ["1", "2", "3"]], ["access", ["single", "all"]]);

  it("all: cartesian product in declared order, deterministic", () => {
    const result = expandCombinations(d, "all", [], 100);
    expect(result.total).toBe(12);
    expect(result.combinations).toHaveLength(12);
    expect(result.combinations[0]).toEqual({ membership: "student", limit: "1", access: "single" });
    expect(result.combinations[1]).toEqual({ membership: "student", limit: "1", access: "all" });
    expect(expandCombinations(d, "all", [], 100)).toEqual(result);
  });

  it("pairwise: covers every value pair with fewer rows than the full product", () => {
    const result = expandCombinations(d, "pairwise", [], 100);
    expect(result.combinations.length).toBeLessThan(12);
    expect(result.combinations.length).toBeGreaterThanOrEqual(6); // 3x2 pairs is the lower bound
    const seen = new Set<string>();
    for (const row of result.combinations) {
      const ids = d.map((x) => `${x.id}=${row[x.id]}`);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) seen.add(`${ids[i]}|${ids[j]}`);
    }
    expect(seen.size).toBe(result.total); // 2*3 + 2*2 + 3*2 = 16
    expect(result.total).toBe(16);
    expect(expandCombinations(d, "pairwise", [], 100)).toEqual(result);
  });

  it("skips combinations an existing persona covers; a persona without traits covers nothing", () => {
    const existing = [persona("any"), persona("ana", { membership: "student", limit: "1", access: "single" })];
    const result = expandCombinations(d, "all", existing, 100);
    expect(result.skipped_covered).toBe(1);
    expect(result.combinations).toHaveLength(11);
    const partial = expandCombinations(d, "all", [persona("sep", { membership: "staff" })], 100);
    expect(partial.skipped_covered).toBe(6);
  });

  it("pairwise skips pairs an existing persona already stands for", () => {
    const full = expandCombinations(d, "pairwise", [], 100).combinations;
    const existing = full.map((row, i) => persona(`p${i}`, row));
    const none = expandCombinations(d, "pairwise", existing, 100);
    expect(none.combinations).toEqual([]);
    expect(none.skipped_covered).toBe(16);
  });

  it("pairwise applies the any-value rule: a persona with one trait covers every pair that trait leaves open", () => {
    const staff = [persona("staff", { membership: "staff" })];
    const pairwise = expandCombinations(d, "pairwise", staff, 100);
    expect(pairwise.total).toBe(16);
    expect(pairwise.skipped_covered).toBe(11); // (staff, limit) 3 + (staff, access) 2 + (limit, access) 6
    expect(expandCombinations(d, "all", staff, 100).skipped_covered).toBe(6); // all stays at 6 of 12
    // Only the five pairs involving the student value remain.
    const seen = new Set<string>();
    for (const row of pairwise.combinations) {
      for (const [a, b] of [["membership", "limit"], ["membership", "access"], ["limit", "access"]] as const) seen.add(`${a}=${row[a]}|${b}=${row[b]}`);
    }
    for (const limit of ["1", "2", "3"]) expect(seen).toContain(`membership=student|limit=${limit}`);
    for (const access of ["single", "all"]) expect(seen).toContain(`membership=student|access=${access}`);
  });

  it("pairwise: a persona without traits on the expanded dimensions covers nothing, also when it has others", () => {
    const outside = [persona("none"), persona("other", { region: "north" })];
    const result = expandCombinations(d, "pairwise", outside, 100);
    expect(result.skipped_covered).toBe(0);
    expect(result).toEqual(expandCombinations(d, "pairwise", [], 100));
  });

  it("pairwise: a persona with a value that is not in its dimension covers nothing, as in all", () => {
    const two = dims(["a", ["v0", "v1"]], ["b", ["v0", "v1"]]);
    const mixed = expandCombinations(two, "pairwise", [persona("m", { a: "v1", b: "stale" })], 100);
    expect(mixed.skipped_covered).toBe(0);
    expect(mixed.combinations).toContainEqual({ a: "v0", b: "v1" });
    expect(expandCombinations(two, "all", [persona("m", { a: "v1", b: "stale" })], 100).skipped_covered).toBe(0);
    const three = dims(["a", ["v0", "v1"]], ["b", ["v0", "v1"]], ["c", ["v0", "v1"]]);
    expect(expandCombinations(three, "pairwise", [persona("c", { c: "stale" })], 100).skipped_covered).toBe(0);
    expect(expandCombinations(three, "all", [persona("c", { c: "stale" })], 100).skipped_covered).toBe(0);
    expect(expandCombinations(three, "pairwise", [persona("k", { a: "v0", c: "stale" })], 100).skipped_covered).toBe(0);
  });

  it("pairwise: a pool that covers every combination covers every pair", () => {
    const pool = expandCombinations(d, "all", [], 100).combinations.map((row, i) => persona(`p${i}`, row));
    expect(expandCombinations(d, "pairwise", pool, 100).skipped_covered).toBe(16);
  });

  it("limit truncates and says so", () => {
    const result = expandCombinations(d, "all", [], 5);
    expect(result.combinations).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(expandCombinations(d.slice(0, 1), "pairwise", [], 1).truncated).toBe(true);
  });

  it("a single dimension yields one combination per value", () => {
    expect(expandCombinations(d.slice(0, 1), "pairwise", [], 10).combinations).toEqual([{ membership: "student" }, { membership: "staff" }]);
  });

  it("buildGeneratedPersona derives a valid, collision-free id and marks the persona generated", () => {
    const taken = new Set<string>(["gen-student-1"]);
    const built = buildGeneratedPersona({ membership: "student", limit: "1" }, d.slice(0, 2), taken, 0);
    expect(built).toMatchObject({ id: "gen-student-1-2", generated: true, traits: { membership: "student", limit: "1" } });
    expect(personaSchema.safeParse(built).success).toBe(true);
  });
});

describe("suggestVariantGaps", () => {
  const d = dims(["membership", ["student", "staff"]], ["access", ["single", "all"]]);
  const pool = [persona("ana", { membership: "student", access: "single" }), persona("lee", { membership: "staff", access: "all" })];

  it("reports values neither the case's personas nor a variant cover, with skeletons", () => {
    const base = useCase({ personas: ["ana"] });
    const { coverage, suggestions } = suggestVariantGaps(base, d, pool);
    expect(coverage).toEqual([
      { dimension: "membership", covered: ["student"], uncovered: ["staff"] },
      { dimension: "access", covered: ["single"], uncovered: ["all"] },
    ]);
    expect(suggestions).toEqual([
      { id: "membership-staff", title: "Borrow a book — MEMBERSHIP: STAFF", when: { membership: ["staff"] }, personas: ["lee"] },
      { id: "access-all", title: "Borrow a book — ACCESS: ALL", when: { access: ["all"] }, personas: ["lee"] },
    ]);
  });

  it("a variant's when closes the gap, a persona without the trait stands for any value", () => {
    const withVariant = useCase({ personas: ["ana"], variants: [{ id: "branches", title: "All branches", when: { access: ["all"] } }] });
    expect(suggestVariantGaps(withVariant, d, pool).suggestions.map((s) => s.id)).toEqual(["membership-staff"]);
    const generic = useCase({ personas: ["anyone"] });
    expect(suggestVariantGaps(generic, d, [...pool, persona("anyone")]).suggestions).toEqual([]);
  });
});

describe("query helpers", () => {
  const cases = [
    useCase({ id: "a", title: "Beta", group: "catalog/loans", tags: ["loans"], steps: [] }),
    useCase({ id: "b", title: "Alpha", group: "catalog", status: "ready", steps: [{ id: "s", actor: "staff-lee", action: "Opens the sheet", target: { screen: "sheet", node: "row" } }] }),
    useCase({ id: "c", title: "Gamma", group: "catalog-x", steps: [], variants: [{ id: "v", title: "V", when: { size: ["small"] }, personas: ["guest"] }] }),
  ];

  it("filters by path-prefix group, persona (base, step actor, variant), screen+node, tag, status, text and variants", () => {
    const ids = (filter: Parameters<typeof matchesFilter>[1]): string[] => cases.filter((c) => matchesFilter(c, filter)).map((c) => c.id);
    expect(ids({ group: "catalog" })).toEqual(["a", "b"]);
    expect(ids({ group: "catalog/loans" })).toEqual(["a"]);
    expect(ids({ persona: "staff-lee" })).toEqual(["b"]);
    expect(ids({ persona: "guest" })).toEqual(["c"]);
    expect(ids({ screen: "sheet" })).toEqual(["b"]);
    expect(ids({ screen: "sheet", node: "row" })).toEqual(["b"]);
    expect(ids({ node: "nope" })).toEqual([]);
    expect(ids({ tag: "LOANS" })).toEqual(["a"]);
    expect(ids({ status: "ready" })).toEqual(["b"]);
    expect(ids({ query: "opens the SHEET" })).toEqual(["b"]);
    expect(ids({ has_variants: true })).toEqual(["c"]);
    expect(ids({ has_variants: false })).toEqual(["a", "b"]);
  });

  it("sorts by group by default, then by the chosen key with stable tie-breakers", () => {
    expect([...cases].sort(compareUseCases("group")).map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect([...cases].sort(compareUseCases("title")).map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect([...cases].sort(compareUseCases("status")).map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("summarize omits empty fields and facets count over the given set", () => {
    expect(summarize(cases[2]!)).toEqual({ id: "c", title: "Gamma", group: "catalog-x", status: "draft", personas: ["member-ana"], steps: 0, variants: 1 });
    const { facets } = facetCounts(cases);
    expect(facets.status).toEqual({ draft: 2, ready: 1 });
    expect(facets.tag).toEqual({ loans: 1 });
    expect(facets.persona["member-ana"]).toBe(3);
    expect(facets.persona.guest).toBe(1);
  });
});

describe("expansion work budget", () => {
  const dim = (id: string, count: number): Dimension => ({ id, name: id, values: Array.from({ length: count }, (_, i) => ({ id: `v${i}`, label: `V${i}` })) });

  it("stops all at the budget and says the result is partial; the default budget leaves normal calls alone", () => {
    const dims = [dim("a", 10), dim("b", 10), dim("c", 10)];
    const full = expandCombinations(dims, "all", [], 5000);
    expect(full.partial).toBeUndefined();
    expect(full.combinations).toHaveLength(1000);

    const cut = expandCombinations(dims, "all", [], 5000, 50);
    expect(cut.partial).toBe(true);
    expect(cut.combinations.length).toBeLessThanOrEqual(50);
    expect(cut.combinations).toEqual(full.combinations.slice(0, cut.combinations.length));
  });

  it("counts the existing personas against the budget, so a long walk over a mostly covered space ends early", () => {
    const dims = [dim("a", 4), dim("b", 4), dim("c", 4), dim("d", 4), dim("e", 4), dim("f", 4), dim("g", 4), dim("h", 4), dim("i", 4)]; // 262,144 combinations
    const covering = Array.from({ length: 30 }, (_, i) => persona(`cover-${i}`, { a: "v0" }));
    const result = expandCombinations(dims, "all", covering, 100);
    expect(result.partial).toBe(true);
    expect(result.combinations).toEqual([]);
    expect(WORK_BUDGET).toBeLessThanOrEqual(2_000_000);
  });

  it("stops pairwise at the budget too, and pairSpace is the number of value pairs", () => {
    const dims = [dim("a", 5), dim("b", 5), dim("c", 5)];
    expect(pairSpace(dims)).toBe(75);
    expect(expandCombinations(dims, "pairwise", [], 100).partial).toBeUndefined();
    const cut = expandCombinations(dims, "pairwise", [], 100, 100);
    expect(cut.partial).toBe(true);
    expect(cut.combinations.length).toBeGreaterThan(0);
    expect(cut.combinations.length).toBeLessThan(expandCombinations(dims, "pairwise", [], 100).combinations.length);
  });
});

describe("pairwise coverage work budget", () => {
  const dim = (id: string, count: number): Dimension => ({ id, name: id, values: Array.from({ length: count }, (_, i) => ({ id: `v${i}`, label: `V${i}` })) });

  it("returns partial with nothing generated when the budget runs out before coverage is known", () => {
    const dims = [dim("a", 5), dim("b", 5), dim("c", 5)];
    const pool = Array.from({ length: 40 }, (_, i) => persona(`p${i}`, { a: "v0" }));
    const full = expandCombinations(dims, "pairwise", pool, 100);
    expect(full.partial).toBeUndefined();
    expect(full.skipped_covered).toBe(35); // (a = v0, b) 5 + (a = v0, c) 5 + every (b, c) pair 25
    const cut = expandCombinations(dims, "pairwise", pool, 100, 100);
    expect(cut).toEqual({ combinations: [], total: 75, skipped_covered: 0, truncated: false, partial: true });
  });

  it("counts every persona check against a pair, not just the pairs", () => {
    const dims = [dim("a", 2), dim("b", 2)];
    const few = Array.from({ length: 2 }, (_, i) => persona(`f${i}`, { a: "v0" }));
    const many = Array.from({ length: 200 }, (_, i) => persona(`m${i}`, { a: "v0" }));
    expect(expandCombinations(dims, "pairwise", few, 10, 100).partial).toBeUndefined();
    expect(expandCombinations(dims, "pairwise", many, 10, 100).partial).toBe(true);
  });

  it("a single dimension counts its persona checks too", () => {
    const only = [dim("a", 10)];
    const many = Array.from({ length: 50 }, (_, i) => persona(`m${i}`, { a: "v9" }));
    expect(expandCombinations(only, "pairwise", many, 100).partial).toBeUndefined();
    expect(expandCombinations(only, "pairwise", many, 100, 100).partial).toBe(true);
  });

  it("stays fast on contrived inputs with many dimensions, also when the budget runs out", () => {
    const wide = Array.from({ length: 700 }, (_, i) => dim(`d${i}`, 2)); // 978,600 value pairs, just under the refusal limit
    const mixed = Array.from({ length: 120 }, (_, i) => dim(`d${i}`, 3));
    const dims40 = Array.from({ length: 40 }, (_, i) => dim(`d${i}`, 3));
    const pool = Array.from({ length: 300 }, (_, i) => persona(`p${i}`, { [`d${i % 120}`]: "v1", [`d${(i * 7) % 120}`]: "v2" }));
    for (const [dims, existing] of [[wide, []], [mixed, pool], [dims40, []]] as const) {
      const started = performance.now();
      const result = expandCombinations([...dims], "pairwise", [...existing], 5000);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(500);
      expect(result.total).toBe(pairSpace([...dims]));
      expect(result.partial).toBe(dims === wide ? true : undefined);
    }
  });
});

describe("variant skeleton ids", () => {
  const dimension = (id: string, values: string[]): Dimension => ({ id, name: id, values: values.map((v) => ({ id: v, label: v })) });

  it("stay valid kebab-case and unique among each other and against existing variants", () => {
    const dims = [dimension("plan", ["free", "pro", "team"])];
    const pool = [persona("a", { plan: "free" }), persona("b", { plan: "pro" }), persona("c", { plan: "team" })];
    const withClash = useCase({ personas: [], variants: [{ id: "plan-pro", title: "Taken", when: { size: ["small"] } }] });
    const ids = suggestVariantGaps(withClash, dims, pool).suggestions.map((s) => s.id);
    expect(ids).toEqual(["plan-free", "plan-pro-2", "plan-team"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never ends in a hyphen or exceeds 80 characters when a dimension id is almost as long as an id may be", () => {
    const longId = "d".repeat(79);
    const dims = [dimension(longId, ["x", "y"])];
    const pool = [persona("a", { [longId]: "x" }), persona("b", { [longId]: "y" })];
    const ids = suggestVariantGaps(useCase({ personas: [] }), dims, pool).suggestions.map((s) => s.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(isValidId(id), id).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });
});
