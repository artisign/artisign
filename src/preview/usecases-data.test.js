import { describe, it, expect } from "vitest";
import {
  slugify,
  uniqueId,
  isValidId,
  initials,
  avatarOf,
  actorName,
  buildQuery,
  hasActiveFilters,
  EMPTY_FILTERS,
  buildGroupTree,
  groupAncestors,
  flattenTree,
  pageSize,
  formatValue,
  flattenFlat,
  rowTops,
  visibleWindow,
  treeKeyNav,
  changedKeys,
  exampleLines,
  fieldRows,
  ioChangedKeys,
  formatExample,
  parseExample,
  undeclaredExampleKeys,
  invalidExampleValues,
  stepScope,
  mappingFor,
  buildFlowRows,
  variantChangeCount,
  whenEntries,
  matchingPersonas,
  coverageMatrix,
  traitCounts,
  matchesPersonaQuery,
  warningSummary,
  plural,
  indexById,
  safeColor,
  parseOrKeep,
  isCanonicalGroup,
  removeStepTarget,
  describeLoadProblem,
  splitInvalidWarnings,
} from "./usecases-data.js";

describe("ids and text", () => {
  it("slugify makes kebab-case ids and strips diacritics", () => {
    expect(slugify("Map a Step!")).toBe("map-a-step");
    expect(slugify("  \u00dcber  caf\u00e9  ")).toBe("uber-cafe");
    expect(slugify("***")).toBe("");
    expect(slugify("a".repeat(120)).length).toBe(80);
  });

  it("validates ids like the backend", () => {
    expect(isValidId("map-step-1")).toBe(true);
    expect(isValidId("Assign")).toBe(false);
    expect(isValidId("a--b")).toBe(false);
    expect(isValidId("")).toBe(false);
  });

  it("uniqueId appends a counter until free", () => {
    expect(uniqueId("dana", new Set())).toBe("dana");
    expect(uniqueId("dana", new Set(["dana"]))).toBe("dana-2");
    expect(uniqueId("dana", ["dana", "dana-2"])).toBe("dana-3");
    expect(uniqueId("", new Set(["x"]))).toBe("");
  });

  it("formats counts and plurals", () => {
    expect(plural(1, "use case")).toBe("1 use case");
    expect(plural(1284, "use case")).toBe("1,284 use cases");
  });

  it("initials and avatars", () => {
    expect(initials("Medium project")).toBe("MP");
    expect(initials("Dana")).toBe("DA");
    expect(initials("")).toBe("?");
    const personas = indexById([
      { id: "dana", name: "Dana", avatar: { emoji: "👨", color: "#4F7CAC" } },
      { id: "gen", name: "Medium project", avatar: { color: "#111111" } },
    ]);
    expect(avatarOf("dana", personas)).toEqual({ kind: "emoji", text: "👨", color: "#4F7CAC" });
    expect(avatarOf("gen", personas)).toEqual({ kind: "initials", text: "MP", color: "#111111" });
    expect(avatarOf("system", personas).kind).toBe("system");
    expect(avatarOf("ghost", personas).kind).toBe("unknown");
    expect(actorName("system", personas)).toBe("System");
    expect(actorName("dana", personas)).toBe("Dana");
    expect(actorName("ghost", personas)).toBe("ghost");
  });
});

describe("list queries", () => {
  it("sends only what is set", () => {
    expect(buildQuery(EMPTY_FILTERS)).toEqual({});
    expect(buildQuery({ ...EMPTY_FILTERS, query: " actor ", status: "ready", hasVariants: true }, { limit: 5 })).toEqual({
      query: "actor",
      status: "ready",
      has_variants: true,
      limit: 5,
    });
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, screen: "editor-main" })).toBe(true);
  });
});

describe("group tree", () => {
  const facet = { "mapping/elements": 38, mapping: 3, "mapping/screens": 31, personas: 54 };

  it("sums counts up the path and keeps direct counts", () => {
    const { roots, byPath } = buildGroupTree(facet);
    expect(roots.map((n) => n.name)).toEqual(["mapping", "personas"]);
    expect(byPath.get("mapping")).toMatchObject({ count: 72, direct: 3, depth: 0 });
    expect(byPath.get("mapping/elements")).toMatchObject({ count: 38, direct: 38, depth: 1 });
    expect(roots[0].children.map((n) => n.name)).toEqual(["elements", "screens"]);
  });

  it("creates intermediate nodes with no direct cases", () => {
    const { byPath } = buildGroupTree({ "a/b/c": 2 });
    expect(byPath.get("a")).toMatchObject({ count: 2, direct: 0 });
    expect(byPath.get("a/b")).toMatchObject({ count: 2, direct: 0 });
  });

  it("lists ancestors", () => {
    expect(groupAncestors("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
    expect(groupAncestors(undefined)).toEqual([]);
  });

  it("flattens only what is open: collapsed groups hide their rows", () => {
    const tree = buildGroupTree(facet);
    const closed = flattenTree({ roots: tree.roots, expanded: new Set(), groupState: new Map(), ungrouped: null });
    expect(closed.map((r) => r.key)).toEqual(["g:mapping", "g:personas"]);
    const rows = flattenTree({
      roots: tree.roots,
      expanded: new Set(["mapping", "mapping/elements"]),
      groupState: new Map([
        ["mapping", { rows: [{ id: "a" }], loading: false }],
        ["mapping/elements", { rows: [{ id: "b" }, { id: "c" }], loading: false }],
      ]),
      ungrouped: null,
    });
    expect(rows.map((r) => r.key)).toEqual(["g:mapping", "c:a", "m:mapping", "g:mapping/elements", "c:b", "c:c", "m:mapping/elements", "g:mapping/screens", "g:personas"]);
    expect(rows.find((r) => r.key === "m:mapping")).toMatchObject({ remaining: 2, depth: 1 });
    expect(rows.find((r) => r.key === "m:mapping/elements").remaining).toBe(36);
  });

  it("shows a loading row instead of 'more' while a page is on its way, and the ungrouped bucket last", () => {
    const tree = buildGroupTree({ x: 3 });
    const rows = flattenTree({
      roots: tree.roots,
      expanded: new Set(["x", ""]),
      groupState: new Map([["x", { rows: [], loading: true }]]),
      ungrouped: { count: 2, rows: [{ id: "u" }], loading: false },
    });
    expect(rows.map((r) => r.kind)).toEqual(["group", "loading", "ungrouped", "case", "more"]);
  });

  it("flat list inserts group headers only when asked and ends with a 'more' row", () => {
    const items = [{ id: "a", group: "x/y" }, { id: "b", group: "x/y" }, { id: "c" }];
    expect(flattenFlat({ items, withHeaders: false, total: 3, loading: false }).map((r) => r.kind)).toEqual(["case", "case", "case"]);
    const rows = flattenFlat({ items, withHeaders: true, total: 10, loading: false });
    expect(rows.map((r) => r.kind)).toEqual(["header", "case", "case", "header", "case", "more"]);
    expect(rows[0].name).toBe("x › y");
    expect(rows[3].name).toBe("No group");
    expect(flattenFlat({ items, withHeaders: false, total: 10, loading: true }).at(-1).kind).toBe("loading");
  });
});

describe("virtual list", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ kind: "case", key: `c${i}` }));

  it("computes tops from per-kind heights", () => {
    const { tops, total } = rowTops([{ kind: "group" }, { kind: "case" }, { kind: "more" }]);
    expect(tops).toEqual([0, 28, 74]);
    expect(total).toBe(100);
  });

  it("windows a thousand rows to a handful", () => {
    const { tops } = rowTops(rows);
    const win = visibleWindow(tops, 0, 400, 4);
    expect(win.start).toBe(0);
    expect(win.end).toBeLessThan(20);
    const mid = visibleWindow(tops, 46 * 500, 400, 4);
    expect(mid.start).toBe(496);
    expect(mid.end - mid.start).toBeLessThan(25);
    const end = visibleWindow(tops, 46 * 999, 400, 4);
    expect(end.end).toBe(1000);
    expect(visibleWindow([], 0, 100)).toEqual({ start: 0, end: 0 });
  });
});

describe("tree keyboard", () => {
  const rows = [
    { kind: "group", key: "g:a", path: "a", depth: 0, open: true },
    { kind: "group", key: "g:a/b", path: "a/b", depth: 1, open: false },
    { kind: "case", key: "c:x", u: { id: "x" }, depth: 2 },
    { kind: "more", key: "m:a", path: "a", depth: 1 },
  ];

  it("moves with the arrows and clamps at the ends", () => {
    expect(treeKeyNav(rows, "g:a", "ArrowDown").activeKey).toBe("g:a/b");
    expect(treeKeyNav(rows, "g:a", "ArrowUp").activeKey).toBe("g:a");
    expect(treeKeyNav(rows, "m:a", "ArrowDown").activeKey).toBe("m:a");
    expect(treeKeyNav(rows, "g:a/b", "End").activeKey).toBe("m:a");
    expect(treeKeyNav(rows, null, "ArrowDown").activeKey).toBe("g:a");
    expect(treeKeyNav([], null, "ArrowDown")).toEqual({ activeKey: null, action: null });
  });

  it("Right opens a closed group and enters an open one; Left closes or climbs", () => {
    expect(treeKeyNav(rows, "g:a/b", "ArrowRight").action).toEqual({ type: "toggle", path: "a/b" });
    expect(treeKeyNav(rows, "g:a", "ArrowRight").activeKey).toBe("g:a/b");
    expect(treeKeyNav(rows, "g:a", "ArrowLeft").action).toEqual({ type: "toggle", path: "a" });
    expect(treeKeyNav(rows, "c:x", "ArrowLeft").activeKey).toBe("g:a/b");
  });

  it("Left from a case under \"No group\" moves to the No group row, not to an unrelated root group", () => {
    const withUngrouped = [
      { kind: "group", key: "g:a", path: "a", depth: 0, open: true },
      { kind: "case", key: "c:y", u: { id: "y" }, depth: 1 },
      { kind: "ungrouped", key: "g:", path: "", name: "No group", depth: 0, open: true },
      { kind: "case", key: "c:z", u: { id: "z" }, depth: 1 },
      { kind: "more", key: "m:", path: "", depth: 1 },
    ];
    expect(treeKeyNav(withUngrouped, "c:z", "ArrowLeft").activeKey).toBe("g:");
    expect(treeKeyNav(withUngrouped, "m:", "ArrowLeft").activeKey).toBe("g:");
    expect(treeKeyNav(withUngrouped, "c:y", "ArrowLeft").activeKey).toBe("g:a");
  });

  it("Enter opens a case, toggles a group, loads more", () => {
    expect(treeKeyNav(rows, "c:x", "Enter").action).toEqual({ type: "open", id: "x" });
    expect(treeKeyNav(rows, "g:a/b", "Enter").action).toEqual({ type: "toggle", path: "a/b" });
    expect(treeKeyNav(rows, "m:a", "Enter").action).toEqual({ type: "more", path: "a" });
  });
});

describe("data cards", () => {
  it("highlights new and changed keys only", () => {
    const changed = changedKeys({ datum: "d", status: "draft" }, { datum: "d", status: "ready", owner: "Pablo" });
    expect([...changed]).toEqual(["status", "owner"]);
    expect([...changedKeys(undefined, { a: 1 })]).toEqual(["a"]);
    expect(exampleLines({ a: 1, b: "x", c: { d: 1 } }, new Set(["b"]))).toEqual([
      { key: "a", text: "1", changed: false },
      { key: "b", text: "x", changed: true },
      { key: "c", text: '{"d":1}', changed: false },
    ]);
  });

  it("lists the object's fields plus undeclared example keys", () => {
    const object = { fields: [{ name: "status", type: "enum" }, { name: "owner", type: "ref", ref: "owner" }] };
    const rows = fieldRows(object, { status: "ready", color: "teal" });
    expect(rows).toEqual([
      { name: "status", type: "enum", hasExample: true, example: "ready", declared: true },
      { name: "owner", type: "ref → owner", hasExample: false, example: undefined, declared: true },
      { name: "color", type: "", hasExample: true, example: "teal", declared: false },
    ]);
    expect(undeclaredExampleKeys(object, { status: 1, color: 2 })).toEqual(["color"]);
    expect(undeclaredExampleKeys(undefined, { a: 1 })).toEqual([]);
  });

  it("lists example values that do not fit their field, worded like the server", () => {
    const object = {
      id: "loan",
      fields: [
        { name: "status", type: "enum", values: ["active", "returned"] },
        { name: "title", type: "string" },
        { name: "due", type: "date" },
        { name: "tags", type: "list" },
        { name: "owner", type: "ref", ref: "member" },
      ],
    };
    expect(invalidExampleValues(object, { status: "lost", title: 5, due: "2026-02-31", tags: "x", owner: 3, extra: 1 })).toEqual([
      '"lost" is not a value of enum loan.status (active, returned)',
      "loan.title: expected string, got number",
      'loan.due: expected a date (YYYY-MM-DD), got "2026-02-31"',
      "loan.tags: expected list, got string",
      "loan.owner: expected a ref (id string), got number",
    ]);
    expect(invalidExampleValues(object, { status: "active", title: null, due: "2026-12-01", tags: [], owner: "m-1" })).toEqual([]);
    expect(invalidExampleValues(undefined, { a: 1 })).toEqual([]);
    expect(invalidExampleValues(object, { status: "x".repeat(50) })).toEqual([`"${"x".repeat(29)}… is not a value of enum loan.status (active, returned)`]);
    expect(invalidExampleValues({ id: "loan", fields: [{ name: "status", type: "enum", values: [] }] }, { status: "a" })).toEqual(['"a" is not a value of enum loan.status (it declares no values)']);
  });

  it("marks output keys that differ from the same object's input", () => {
    const inputs = [{ object: "mapping", example: { status: "draft" } }];
    expect([...ioChangedKeys({ object: "mapping", example: { status: "ready" } }, inputs)]).toEqual(["status"]);
    expect([...ioChangedKeys({ object: "other", example: { a: 1 } }, inputs)]).toEqual(["a"]);
  });
});

describe("example text", () => {
  it("round-trips typed values without changing their type", () => {
    const example = { status: "ready", count: 2, ok: true, none: null, text: "true", num: "12", list: [1, 2], nested: { a: 1 }, comma: "a, b: c" };
    const parsed = parseExample(formatExample(example));
    expect(parsed).toEqual({ ok: true, value: example });
  });

  it("leaves dates and other text that merely starts like a number unquoted", () => {
    expect(formatExample({ datum: "2026-05-14", id: "42" })).toBe('datum: 2026-05-14, id: "42"');
    expect(parseExample("datum: 2026-05-14")).toEqual({ ok: true, value: { datum: "2026-05-14" } });
  });

  it("splits entries only where a key follows the comma", () => {
    expect(parseExample("text: Pablo takes over on Thu, 14 May, status: ready")).toEqual({
      ok: true,
      value: { text: "Pablo takes over on Thu, 14 May", status: "ready" },
    });
  });

  it("reports a malformed entry and treats empty as an empty object", () => {
    expect(parseExample("status ready").ok).toBe(false);
    expect(parseExample("   ")).toEqual({ ok: true, value: {} });
  });
});

describe("flow rows", () => {
  const baseSteps = [
    { id: "a", actor: "dana", action: "Taps", target: { screen: "s1", node: "n" } },
    { id: "b", actor: "dana", action: "Picks Pablo", target: { screen: "s2" } },
    { id: "c", actor: "system", action: "Mapped" },
  ];

  it("numbers the base flow and leaves change empty", () => {
    const rows = buildFlowRows({ steps: baseSteps });
    expect(rows.map((r) => [r.kind, r.number, r.change])).toEqual([["step", 1, null], ["step", 2, null], ["step", 3, null]]);
  });

  it("flags changed / added / base steps, says what changed, and keeps removed steps in place", () => {
    const variantSteps = [
      { id: "a", actor: "dex", action: "Taps", target: { screen: "s1", node: "n" }, change: "changed" },
      { id: "b", actor: "dana", action: "Picks the agent", target: { screen: "s2" }, change: "changed" },
      { id: "x", actor: "dex", action: "Sets time", change: "added" },
      { id: "c", actor: "system", action: "Mapped" },
    ];
    const removed = [{ id: "d", actor: "system", action: "Push", change: "removed", after: "c" }, { id: "e", actor: "x", action: "start", change: "removed", after: null }];
    const rows = buildFlowRows({ steps: variantSteps, removedSteps: removed, baseSteps, variantSelected: true });
    expect(rows.map((r) => `${r.kind}:${r.step.id}`)).toEqual(["removed:e", "step:a", "step:b", "step:x", "step:c", "removed:d"]);
    expect(rows[1]).toMatchObject({ number: 1, change: "changed", was: { actor: "dana" } });
    expect(rows[2].was).toEqual({ action: "Picks Pablo" });
    expect(rows[3]).toMatchObject({ number: 3, change: "added", was: null });
    expect(rows[4]).toMatchObject({ number: 4, change: "base" });
  });

  it("derives the target scope badge", () => {
    expect(stepScope({ target: { screen: "s", node: "n" } }, {})).toBe("element");
    expect(stepScope({ target: { screen: "s" } }, {})).toBe("screen");
    expect(stepScope({ target: { screen: "s", node: "n" } }, { stale: true })).toBe("stale");
    expect(stepScope({}, null)).toBe("none");
  });

  it("finds a step's mapping, the base flow's own first", () => {
    const bundle = {
      screens: [
        { screen: "s1", mappings: [{ step: "a", scope: "element", variants: ["v"] }, { step: "a", scope: "screen" }] },
        { screen: "s2", mappings: [{ step: "z", scope: "screen", variants: ["v"] }] },
      ],
    };
    expect(mappingFor(bundle, "a").mapping.variants).toBeUndefined();
    expect(mappingFor(bundle, "z").screen.screen).toBe("s2");
    expect(mappingFor(bundle, "nope")).toBeNull();
  });

  it("counts a variant's differences", () => {
    expect(variantChangeCount({ steps: [{}, {}], outputs: [] })).toBe(3);
    expect(variantChangeCount({})).toBe(0);
  });

  it("counts each actor swap that changes a step, and ignores one that changes nothing (spec §4)", () => {
    const base = [{ actor: "dana" }, { actor: "dana" }, { actor: "system" }];
    // one entry that remaps two steps counts once; a→a and a key no base step has change nothing
    expect(variantChangeCount({ actors: { dana: "dex" } }, base)).toBe(1);
    expect(variantChangeCount({ actors: { dana: "dex", system: "dana", dex: "dana", sol: "dex", mia: "mia" } }, base)).toBe(2);
    expect(variantChangeCount({ actors: { dana: "dana" } }, base)).toBe(0);
    // added to the other differences
    expect(variantChangeCount({ actors: { dana: "dex" }, steps: [{}], inputs: [{}], outputs: [{}] }, base)).toBe(4);
    // a swap counts only for base steps the ops leave alone: removed or replaced steps are taken as written
    const removing = { actors: { dana: "dex" }, steps: [{ op: "remove", step_id: "a" }, { op: "replace", step_id: "b" }] };
    expect(variantChangeCount(removing, [{ id: "a", actor: "dana" }, { id: "b", actor: "dana" }])).toBe(2);
    expect(variantChangeCount(removing, [{ id: "a", actor: "dana" }, { id: "b", actor: "dana" }, { id: "c", actor: "dana" }])).toBe(3);
    // an actor-swap-only variant is not "0 changes"; without base steps nothing can be counted
    expect(variantChangeCount({ actors: { dana: "dex" } })).toBe(0);
  });
});

describe("variants and coverage", () => {
  const dimensions = [
    { id: "size", name: "Project size", values: [{ id: "small", label: "Small project" }, { id: "large", label: "Large project" }, { id: "medium", label: "Medium project" }] },
    { id: "actor", name: "Actor type", values: [{ id: "human", label: "Human" }, { id: "agent", label: "Agent" }, { id: "none", label: "None" }] },
    { id: "unused", name: "Unused", values: [{ id: "x", label: "X" }] },
  ];
  const pool = [
    { id: "dana", traits: { size: "small", actor: "human" } },
    { id: "dex", traits: { size: "large", actor: "agent" } },
    { id: "gen", traits: { size: "medium" } },
  ];

  it("resolves a when condition to labels and to matching personas", () => {
    const byId = indexById(dimensions);
    expect(whenEntries({ actor: ["agent"] }, byId)).toEqual([{ dimension: "actor", label: "Actor type", values: [{ id: "agent", label: "Agent" }] }]);
    expect(whenEntries({ ghost: ["v"] }, byId)[0].label).toBe("ghost");
    expect(matchingPersonas({ actor: ["agent", "human"] }, pool).map((p) => p.id)).toEqual(["dana", "dex"]);
    expect(matchingPersonas({ size: ["small"], actor: ["agent"] }, pool)).toEqual([]);
    expect(matchingPersonas({}, pool)).toEqual([]);
  });

  it("rows are Base and each variant, columns the pool's values; gaps are columns nobody covers", () => {
    const matrix = coverageMatrix({
      dimensions,
      pool,
      basePersonas: [pool[0]],
      variants: [{ id: "agent", title: "Agent", when: { actor: ["agent"] } }, { id: "large", title: "Large", when: { size: ["large"] } }],
    });
    expect(matrix.rows.map((r) => r.id)).toEqual(["base", "agent", "large"]);
    // "none" is not used by any pool persona, so it is no column
    expect(matrix.columns.map((c) => [c.dimension, c.values.map((v) => v.value)])).toEqual([["size", ["small", "large", "medium"]], ["actor", ["human", "agent"]]]);
    const [base, agent, sep] = matrix.rows;
    expect([...base.dims.size.marks]).toEqual(["small"]);
    expect(agent.dims.size).toEqual({ any: true }); // a variant's when does not constrain size
    expect([...agent.dims.actor.marks]).toEqual(["agent"]);
    expect([...sep.dims.size.marks]).toEqual(["large"]);
    expect(matrix.columns[0].values.map((v) => v.gap)).toEqual([false, false, true]);
    expect(matrix.gaps).toBe(1);
  });

  it("takes the gaps from suggest_use_case_variants when given, so UI and tool agree", () => {
    const matrix = coverageMatrix({ dimensions, pool, basePersonas: [pool[0]], variants: [], uncovered: [{ dimension: "size", uncovered: ["large"] }, { dimension: "actor", uncovered: [] }] });
    expect(matrix.columns[0].values.map((v) => v.gap)).toEqual([false, true, false]);
    expect(matrix.gaps).toBe(1);
  });

  it("a base persona without the trait is 'any' on that dimension and covers every value there", () => {
    const matrix = coverageMatrix({ dimensions, pool, basePersonas: [pool[2]], variants: [] });
    expect(matrix.rows[0].dims.actor).toEqual({ any: true });
    expect([...matrix.rows[0].dims.size.marks]).toEqual(["medium"]);
    expect(matrix.columns.find((c) => c.dimension === "actor").values.every((v) => !v.gap)).toBe(true);
    expect(matrix.gaps).toBe(2);
  });
});

describe("persona pool", () => {
  it("counts personas per dimension value", () => {
    const counts = traitCounts(
      [{ id: "size", values: [{ id: "small" }, { id: "large" }] }],
      [{ traits: { size: "small" } }, { traits: { size: "small" } }, { traits: {} }, { traits: { size: "alien" } }],
    );
    expect(counts).toEqual({ size: { small: 2, large: 0 } });
  });

  it("searches name, role, goals and traits", () => {
    const dana = { id: "dana", name: "Dana", role: "Designer", goals: ["Plans on Monday"], traits: { actor: "human" } };
    expect(matchesPersonaQuery(dana, "")).toBe(true);
    expect(matchesPersonaQuery(dana, "monday")).toBe(true);
    expect(matchesPersonaQuery(dana, "HUMAN")).toBe(true);
    expect(matchesPersonaQuery(dana, "pablo")).toBe(false);
  });

  it("summarises warnings", () => {
    expect(warningSummary([])).toBe("");
    expect(warningSummary([{}, {}])).toBe("2 warnings. Saving is never blocked.");
    expect(warningSummary([{}], 60)).toBe("60 warnings. Saving is never blocked.");
  });
});

describe("review fixes", () => {
  it("example text round-trips any string key and values with commas and colons, losslessly", () => {
    const examples = [
      { caf\u00e9: 5, a: 1 },
      { "a b": "x, y: z", "na\u00efve/plain": true },
      { a: "1, caf\u00e9: 5" },
      { "": "empty key", "k:ey": "v" },
      { nested: { "\u00fc": [1, "2, b: c"] }, s: "{not json" },
    ];
    for (const example of examples) {
      const text = formatExample(example);
      expect(parseExample(text)).toEqual({ ok: true, value: example });
    }
    expect(parseExample("a: 1, caf\u00e9: 5")).toEqual({ ok: true, value: { a: 1, caf\u00e9: 5 } }); // not one glued string
  });

  it("an untouched example is kept as the original object, an edited one is parsed", () => {
    const original = { "": 1, "a b": [1, 2], t: "true" };
    expect(parseOrKeep(formatExample(original), original)).toEqual({ ok: true, value: original });
    expect(parseOrKeep("t: 2", original)).toEqual({ ok: true, value: { t: 2 } });
  });

  it("only safe persona colours reach CSS", () => {
    expect(safeColor("#4F7CAC")).toBe("#4F7CAC");
    expect(safeColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(safeColor("hsl(200 50% 40%)")).toBe("hsl(200 50% 40%)");
    for (const bad of ["url(https://x/y)", "red; background: url(x)", "var(--x)", "", undefined, "#12"]) expect(safeColor(bad)).toBe("");
    expect(avatarOf("p", indexById([{ id: "p", name: "P", avatar: { color: "url(x)" } }])).color).toBe("");
  });

  it("only canonical group paths go into the tree", () => {
    expect(["a", "a/b"].every(isCanonicalGroup)).toBe(true);
    for (const bad of ["", "a/", "/a", "a//b"]) expect(isCanonicalGroup(bad)).toBe(false);
  });

  it("a flat list ends with an error row instead of a 'more' row after a failed page", () => {
    const rows = flattenFlat({ items: [{ id: "a" }], withHeaders: false, total: 5, loading: false, error: "boom" });
    expect(rows.at(-1)).toMatchObject({ kind: "error", message: "boom" });
    expect(rows.some((r) => r.kind === "more")).toBe(false);
  });

  it("removeStepTarget changes the variant's op when a variant is selected, else the base, and says when nothing changed", () => {
    const source = {
      steps: [{ id: "a", actor: "x", action: "A", target: { screen: "s" } }, { id: "b", actor: "x", action: "B", target: { screen: "t" } }],
      variants: [{ id: "v", title: "V", when: {}, steps: [{ op: "replace", step_id: "a", step: { id: "a", actor: "x", action: "A2", target: { screen: "s2" } } }] }],
    };
    const inVariant = removeStepTarget(source, "a", "v");
    expect(inVariant).toMatchObject({ changed: true, where: "variant" });
    expect(inVariant.patch.variants[0].steps[0].step.target).toBeUndefined();
    expect(source.variants[0].steps[0].step.target).toEqual({ screen: "s2" }); // the input is not mutated
    const baseStep = removeStepTarget(source, "b", "v"); // an unchanged base step
    expect(baseStep).toMatchObject({ changed: true, where: "base" });
    expect(baseStep.patch.steps[1].target).toBeUndefined();
    expect(removeStepTarget(source, "a", null).patch.steps[0].target).toBeUndefined();
    expect(removeStepTarget(source, "missing", "v")).toEqual({ changed: false });
    expect(removeStepTarget({ steps: [{ id: "n", actor: "x", action: "N" }] }, "n", null)).toEqual({ changed: false });
  });

  it("removeStepTarget edits the op that produces the effective step: an append followed by a replace of the same step changes the replace", () => {
    const step = (action, screen) => ({ id: "t", actor: "x", action, target: { screen } });
    const source = {
      steps: [],
      variants: [{ id: "v", title: "V", when: {}, steps: [{ op: "append", step: step("first", "s1") }, { op: "replace", step_id: "t", step: step("second", "s2") }] }],
    };
    const result = removeStepTarget(source, "t", "v");
    expect(result).toMatchObject({ changed: true, where: "variant" });
    expect(result.patch.variants[0].steps[0].step.target).toEqual({ screen: "s1" });
    expect(result.patch.variants[0].steps[1].step.target).toBeUndefined();
    // the effective step has no target: nothing to change, and the earlier op is not touched
    const bare = { ...source, variants: [{ ...source.variants[0], steps: [source.variants[0].steps[0], { op: "replace", step_id: "t", step: { id: "t", actor: "x", action: "second" } }] }] };
    expect(removeStepTarget(bare, "t", "v")).toEqual({ changed: false });
  });
});

describe("load problems (CHR-1124)", () => {
  it("names the file and the problem and drops the agent remedy", () => {
    expect(describeLoadProblem("invalid usecases/personas.json: personas.0.name: Invalid input: expected string, received undefined — repair or remove the file by hand (the one case where usecases/ may be edited directly)")).toEqual({
      file: "usecases/personas.json",
      detail: "personas.0.name: Invalid input: expected string, received undefined",
    });
    expect(describeLoadProblem("invalid usecases/world.json: not valid JSON — repair or remove the file by hand")).toEqual({ file: "usecases/world.json", detail: "not valid JSON" });
    expect(describeLoadProblem("invalid usecases/data-objects.json: (root): expected an object")).toEqual({ file: "usecases/data-objects.json", detail: "(root): expected an object" });
  });

  it("has no file for a failure that names none", () => {
    expect(describeLoadProblem("disk on fire")).toEqual({ file: null, detail: "disk on fire" });
    expect(describeLoadProblem(undefined)).toEqual({ file: null, detail: "" });
  });

  it("splits pool entries from unreadable case files", () => {
    const caseFile = { kind: "invalid_file", target: "use_case:a", message: "usecases/cases/a.json is not loaded" };
    const entry = { kind: "invalid_file", target: "persona:x", message: "usecases/personas.json personas[0] (x) is not loaded" };
    const bare = { kind: "invalid_file", message: "no target" };
    expect(splitInvalidWarnings([caseFile, entry, bare])).toEqual({ entries: [entry], files: [caseFile, bare] });
    expect(splitInvalidWarnings(undefined)).toEqual({ entries: [], files: [] });
  });
});

describe("single leftover rows and empty strings", () => {
  it("pageSize takes a single leftover row along but keeps paging for more", () => {
    expect(pageSize(5, 4)).toBe(5);
    expect(pageSize(4, 4)).toBe(4);
    expect(pageSize(6, 4)).toBe(4);
    expect(pageSize(26, 25)).toBe(26);
    expect(pageSize(27, 25)).toBe(25);
  });

  it("formatValue renders an empty string visibly, in example lines too", () => {
    expect(formatValue("")).toBe('""');
    expect(formatValue("x")).toBe("x");
    expect(exampleLines({ a: "" }, new Set(["a"]))).toEqual([{ key: "a", text: '""', changed: true }]);
  });
});
