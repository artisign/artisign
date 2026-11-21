// @vitest-environment jsdom
//
// The create/edit forms: draft <-> set_use_cases payload, live reference warnings (never blocking), and the dialogs
// themselves (use case, persona, dimension, data object, generate personas).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { draftFromSource, buildPayload, draftWarnings, openUseCaseDialog } from "./usecases-forms.js";
import { refusalText, buildPersonaPayload, buildDimensionPayload, buildObjectPayload, openPersonaDialog, openDimensionDialog, openObjectDialog, openGenerateDialog } from "./usecases-forms-pool.js";
import { blankVariant } from "./usecases-variant-edit.js";
import { makePool, rawUseCase } from "./usecases.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const button = (label) => $$("dialog .uc-foot-actions button").find((b) => b.textContent === label);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("draft and payload", () => {
  it("round-trips a stored use case: an untouched edit sends no variants and no change of substance", () => {
    const draft = draftFromSource(rawUseCase);
    const { payload } = buildPayload({ id: "map-step", draft, source: rawUseCase });
    expect(payload.title).toBe(rawUseCase.title);
    expect(payload.steps).toEqual(rawUseCase.steps);
    expect(payload.inputs).toEqual(rawUseCase.inputs);
    expect(payload.outputs).toEqual(rawUseCase.outputs);
    expect(payload.variants).toBeUndefined(); // unchanged variants are left out of the merge
    expect(payload.personas).toEqual(["dana"]);
  });

  it("a cleared optional field becomes null (the tool's 'remove this key'); a new case omits empties", () => {
    const draft = draftFromSource(rawUseCase);
    draft.group = "";
    draft.goal = "  ";
    draft.tags = "";
    const { payload } = buildPayload({ id: "map-step", draft, source: rawUseCase });
    expect(payload).toMatchObject({ group: null, goal: null, tags: null });
    const fresh = draftFromSource(null);
    Object.assign(fresh, { title: "New", inputs: [{ object: "mapping", side: "", example: "a: 1" }], outputs: [{ object: "mapping", side: "", example: "a: 2" }] });
    const made = buildPayload({ id: "new", draft: fresh, source: null }).payload;
    expect(Object.keys(made).sort()).toEqual(["id", "inputs", "outputs", "personas", "status", "steps", "title"]);
  });

  it("the only hard requirements: a title, a valid id, an input and an output with examples, parseable examples, a variant title and condition", () => {
    const empty = draftFromSource(null);
    expect(buildPayload({ id: "x", draft: empty, source: null }).errors).toEqual(["A title is required.", "Add at least one input with an example.", "Add at least one output with an example."]);
    const draft = draftFromSource(rawUseCase);
    expect(buildPayload({ id: "Not Valid", draft, source: rawUseCase }).errors[0]).toContain("kebab-case");
    draft.inputs[0].example = "status draft";
    expect(buildPayload({ id: "map-step", draft, source: rawUseCase }).errors.join(" ")).toContain("is not key: value");
    const blank = draftFromSource(rawUseCase);
    blank.inputs[0].example = "";
    blank.inputs[0].orig = undefined;
    expect(buildPayload({ id: "map-step", draft: blank, source: rawUseCase }).errors).toEqual(["Input 1: the example needs at least one key."]);
    const noWhen = draftFromSource(rawUseCase);
    noWhen.variants[0].when = {};
    expect(buildPayload({ id: "map-step", draft: noWhen, source: rawUseCase }).errors.join(" ")).toContain("needs a condition");
  });

  it("builds steps with target kinds (screen / element / none), data changes and fresh unique step ids", () => {
    const draft = draftFromSource(rawUseCase);
    draft.steps[0].kind = "none";
    draft.steps[1].kind = "element";
    draft.steps[1].node = "row-pablo";
    draft.steps.push({ id: "", actor: "dana", action: "Same action", kind: "screen", screen: "editor", node: "", data: [] }, { id: "", actor: "dana", action: "Same action", kind: "screen", screen: "editor", node: "", data: [] });
    const { payload } = buildPayload({ id: "map-step", draft, source: rawUseCase });
    expect(payload.steps[0].target).toBeUndefined();
    expect(payload.steps[1].target).toEqual({ screen: "picker", node: "row-pablo" });
    expect(payload.steps[1].data[0].after).toEqual({ status: "ready", owner: "Pablo" });
    expect(payload.steps.slice(3).map((s) => s.id)).toEqual(["same-action", "same-action-2"]);
  });

  it("an element target without an element id is an error on the node field, not a silent screen mapping", () => {
    const draft = draftFromSource(rawUseCase);
    draft.steps[0].kind = "element";
    draft.steps[0].screen = "editor";
    draft.steps[0].node = "  ";
    const built = buildPayload({ id: "map-step", draft, source: rawUseCase });
    expect(built.errors.join(" ")).toContain("Element id required");
    expect(built.fieldErrors).toContainEqual(expect.objectContaining({ path: "step.0.node", message: "Element id required" }));
    expect(built.payload).toBeUndefined();
  });

  it("a step or trigger actor that is a pool persona joins the case personas once, in order; the system and unknown actors do not", () => {
    const pool = makePool();
    const ids = [...pool.personasById.keys()];
    expect(ids.length).toBeGreaterThan(1);
    const [first, second] = ids;
    const draft = draftFromSource(rawUseCase);
    draft.personas = [second];
    draft.steps[0].actor = first;
    draft.steps[1].actor = "system";
    draft.steps.push({ id: "", actor: first, action: "Again", kind: "none", screen: "", node: "", data: [] }, { id: "", actor: "ghost", action: "Who", kind: "none", screen: "", node: "", data: [] });
    const { payload } = buildPayload({ id: "map-step", draft, source: rawUseCase, personaIds: new Set(ids) });
    expect(payload.personas).toEqual([second, first]);
  });

  it("keeps an empty before/after of a step's data through open and save", () => {
    const source = { ...rawUseCase, steps: [{ id: "s1", actor: "dana", action: "Check", data: [{ object: "mapping", before: {}, after: {} }, { object: "mapping", before: {}, after: { status: "ready" } }] }] };
    const draft = draftFromSource(source);
    expect(buildPayload({ id: "map-step", draft, source }).payload.steps).toEqual(source.steps);
    draft.steps[0].data[1].after = ""; // a cleared non-empty value is still dropped
    expect(buildPayload({ id: "map-step", draft, source }).payload.steps[0].data[1]).toEqual({ object: "mapping", before: {} });
  });

  it("does not count reordered keys alone as a variant change", () => {
    const reordered = { ...rawUseCase, variants: rawUseCase.variants.map((v) => Object.fromEntries(Object.entries(v).reverse())) };
    expect(buildPayload({ id: "map-step", draft: draftFromSource(reordered), source: rawUseCase }).payload.variants).toBeUndefined();
  });

  it("sends the variants when they changed, and null when they were all removed", () => {
    const edited = draftFromSource(rawUseCase);
    edited.variants[0].title = "Renamed";
    expect(buildPayload({ id: "map-step", draft: edited, source: rawUseCase }).payload.variants[0]).toMatchObject({ id: "agent", title: "Renamed", outputs: rawUseCase.variants[0].outputs });
    const removed = draftFromSource(rawUseCase);
    removed.variants = [];
    expect(buildPayload({ id: "map-step", draft: removed, source: rawUseCase }).payload.variants).toBeNull();
  });
});

describe("review fixes", () => {
  it("an example the user did not touch is saved exactly as stored; a unicode key never blocks saving", () => {
    const source = { ...rawUseCase, inputs: [{ object: "mapping", example: { caf\u00e9: 5, "a b": "x, y: z" } }], variants: undefined };
    const draft = draftFromSource(source);
    expect(buildPayload({ id: "map-step", draft, source }).payload.inputs).toEqual(source.inputs);
    draft.outputs[0].example = "a: 1, caf\u00e9: 5";
    expect(buildPayload({ id: "map-step", draft, source }).payload.outputs[0].example).toEqual({ a: 1, caf\u00e9: 5 });
  });

  it("generated step and variant ids never collide with any id the case already has", () => {
    const source = { ...rawUseCase };
    const draft = draftFromSource(source);
    draft.steps.push({ id: "", actor: "dana", action: "Time", kind: "none", screen: "", node: "", data: [] }); // "time" is the id of a step a variant adds
    draft.variants.push({ ...blankVariant(), title: "Agent", when: { actor: ["human"] } }); // "agent" exists
    const { payload } = buildPayload({ id: "map-step", draft, source });
    expect(payload.steps.at(-1).id).toBe("time-2");
    expect(payload.variants.at(-1).id).toBe("agent-2");
  });
});

describe("live warnings", () => {
  const pool = makePool();
  const screens = ["editor", "picker"];

  it("flags example keys the object does not declare, unknown personas, unknown screens and elements", () => {
    const draft = draftFromSource(rawUseCase);
    draft.outputs[0].example = "status: ready, color: teal";
    draft.personas.push("ghost");
    draft.steps[2].screen = "gone-screen";
    draft.steps[0].node = "not-there";
    const warnings = draftWarnings({ draft, pool, screens, nodes: { editor: ["btn-map"] } });
    const text = warnings.map((w) => `${w.path}: ${w.message}`).join("\n");
    expect(text).toContain("output.0: color is not a field of Mapping.");
    expect(text).toContain("persona.ghost: Persona ghost does not exist.");
    expect(text).toContain(`step.2.screen: Screen "gone-screen" not found.`);
    expect(text).toContain(`step.0.node: Element "not-there" not found on screen "editor".`);
  });

  it("flags example values that do not fit the field, next to the key warnings", () => {
    const draft = draftFromSource(rawUseCase);
    draft.outputs[0].example = "status: lost, owner: 5";
    const warnings = draftWarnings({ draft, pool, screens, nodes: { editor: ["btn-map"] } }).filter((w) => w.path === "output.0");
    expect(warnings.map((w) => w.message)).toEqual([
      '"lost" is not a value of enum mapping.status (draft, ready).',
      "mapping.owner: expected a ref (id string), got number.",
    ]);
  });

  it("is quiet for a clean draft", () => {
    const draft = draftFromSource(rawUseCase);
    draft.steps[2].screen = "picker";
    expect(draftWarnings({ draft, pool, screens, nodes: { editor: ["btn-map"] } })).toEqual([]);
  });
});

describe("use case dialog", () => {
  function options(over = {}) {
    return {
      mode: "edit",
      source: rawUseCase,
      pool: () => makePool(),
      screens: () => ["editor", "picker"],
      groups: () => ["mapping/elements"],
      takenIds: () => new Set(["map-step"]),
      loadNodes: async () => ["btn-map", "row-agent"],
      save: vi.fn(async () => ({ ok: true, data: { warnings: [] } })),
      newObject: vi.fn(async () => {}),
      ...over,
    };
  }

  it("placeholders show the shape of a data value, never a step target", async () => {
    openUseCaseDialog(options());
    await flush();
    const add = (label) => $$("dialog button").find((b) => b.textContent.includes(label));
    add("Input").click();
    add("Output").click();
    add("Data change").click();
    await flush();
    const byLabel = (re) => $$("dialog input").filter((i) => re.test(i.getAttribute("aria-label") ?? ""));
    const examples = byLabel(/^(Input|Output) \d+ example$/);
    expect(examples.length).toBeGreaterThan(0);
    for (const input of examples) expect(input.placeholder).toBe("status: ready");
    expect(byLabel(/data \d+ before$/)[0].placeholder).toBe("status: draft");
    expect(byLabel(/data \d+ after$/)[0].placeholder).toBe("status: ready");
    expect([...$$("dialog input")].some((i) => /btn-mapping|usecases-detail|scope:/.test(i.placeholder))).toBe(false);
  });

  it("has a two-option status (draft, ready) and no priority control, and saves no priority", async () => {
    const opts = options({ source: { ...rawUseCase, priority: "must" } });
    const closed = openUseCaseDialog(opts);
    await flush();
    const status = $$("dialog .uc-segmented").find((g) => g.getAttribute("aria-label") === "Status");
    expect([...status.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Draft", "Ready"]);
    expect($$("dialog .uc-segmented").some((g) => /priority/i.test(g.getAttribute("aria-label")))).toBe(false);
    expect($("dialog").textContent).not.toMatch(/priority/i);
    button("Save use case").click();
    await flush();
    expect(Object.keys(opts.save.mock.calls[0][0])).not.toContain("priority");
    await closed;
  });

  it("a blank example is reported under the row's position in the full list, even when an earlier row has no data object", async () => {
    const source = { ...rawUseCase, inputs: [{ object: "", example: { a: 1 } }, { object: "mapping", example: {} }] };
    openUseCaseDialog(options({ source }));
    await flush();
    expect($(".uc-foot-msg").textContent).toBe("Input 2: the example needs at least one key.");
    expect(button("Save use case").disabled).toBe(true);
  });

  it("opens as a labelled dialog and shows the warnings count live, saving stays enabled", async () => {
    const opts = options();
    const closed = openUseCaseDialog(opts);
    await flush();
    const dialog = $("dialog");
    expect(dialog.hasAttribute("open")).toBe(true);
    expect($("#" + dialog.getAttribute("aria-labelledby")).textContent).toBe("Edit use case");
    expect($(".uc-foot-msg", dialog).textContent).toBe("1 warning. Saving is never blocked."); // step 3 maps to a screen that no longer exists
    expect(button("Save use case").disabled).toBe(false);
    type($("[data-path='output.0']", dialog), "status: ready, color: teal");
    expect($(".uc-foot-msg", dialog).textContent).toBe("2 warnings. Saving is never blocked.");
    expect($("[data-path='output.0']", dialog).classList.contains("is-warning")).toBe(true);
    expect($(".uc-field-warn[data-path='output.0']", dialog).textContent).toContain("color is not a field");
    button("Cancel").click(); // dirty: the dialog stays open and says why
    expect($(".uc-foot-msg", dialog).textContent).toBe("You have unsaved changes. Discard them?");
    expect(button("Discard").getAttribute("aria-describedby")).toBe($(".uc-foot-msg", dialog).id);
    expect(document.activeElement).toBe(button("Discard"));
    expect(button("Cancel")).toBeTruthy(); // the existing buttons stay where they are
    button("Discard").click();
    expect(await closed).toBeNull();
    expect($("dialog")).toBeNull();
    expect(opts.save).not.toHaveBeenCalled();
  });

  it("saves the edit through the tool, closes and returns the id and the response", async () => {
    const opts = options();
    const closed = openUseCaseDialog(opts);
    await flush();
    type($("dialog input[autofocus]"), "Assign it faster");
    button("Save use case").click();
    const result = await closed;
    expect(opts.save).toHaveBeenCalledTimes(1);
    const payload = opts.save.mock.calls[0][0];
    expect(payload).toMatchObject({ id: "map-step", title: "Assign it faster" });
    expect(payload.variants).toBeUndefined();
    expect(result).toEqual({ id: "map-step", data: { warnings: [] } });
  });

  it("a rejected save shows the problem without the agent's remedy", async () => {
    const opts = options({ save: vi.fn(async () => ({ ok: false, message: "invalid usecases/personas.json: personas.0.name: required — repair or remove the file by hand (the one case where usecases/ may be edited directly)" })) });
    openUseCaseDialog(opts);
    await flush();
    type($("dialog input[autofocus]"), "x");
    button("Save use case").click();
    await flush();
    const text = $(".uc-foot-msg").textContent;
    expect(text).toContain("personas.0.name: required");
    expect(text).not.toContain("by hand");
    expect(text).not.toContain("may be edited directly");
  });

  it("the placeholders are neutral library examples", async () => {
    openUseCaseDialog(options({ mode: "new", source: null }));
    await flush();
    const placeholders = $$("dialog input").map((el) => el.placeholder).join("|");
    expect(placeholders).toContain("Borrow a book");
    expect(placeholders).toContain("lending/loans");
    expect(placeholders).not.toMatch(/mapping|Use case editor|design/i);
  });

  it("a rejected save keeps the dialog open with the message", async () => {
    const opts = options({ save: vi.fn(async () => ({ ok: false, message: "validation_failed: steps.0.id" })) });
    openUseCaseDialog(opts);
    await flush();
    type($("dialog input[autofocus]"), "x");
    button("Save use case").click();
    await flush();
    expect($("dialog")).not.toBeNull();
    expect($(".uc-foot-msg").textContent).toBe("validation_failed: steps.0.id");
  });

  it("a new use case derives its id from the title until the id is edited, and Save waits for the hard requirements", async () => {
    const opts = options({ mode: "new", source: null });
    const closed = openUseCaseDialog(opts);
    await flush();
    expect(button("Create use case").disabled).toBe(true);
    expect($(".uc-foot-msg").textContent).toBe("A title is required.");
    type($("dialog input[autofocus]"), "Map a Step, Pablo steps in");
    const idInput = $$("dialog input.uc-mono").find((i) => i.placeholder === "derived from the title");
    expect(idInput.value).toBe("map-a-step-pablo-steps-in");
    $("dialog .uc-io-add .uc-link-btn").click(); // + Input
    const [inSelect] = $$("dialog .uc-io-row select");
    type(inSelect, "mapping");
    type($("[data-path='input.0']"), "status: draft");
    $$("dialog .uc-io-add .uc-link-btn")[1].click(); // + Output
    type($$("dialog .uc-io-row select")[1], "mapping");
    type($("[data-path='output.0']"), "status: ready");
    expect(button("Create use case").disabled).toBe(false);
    button("Create use case").click();
    const result = await closed;
    expect(result.id).toBe("map-a-step-pablo-steps-in");
    expect(opts.save.mock.calls[0][0]).toMatchObject({ id: "map-a-step-pablo-steps-in", status: "draft", personas: [], steps: [] });
  });

  it("a derived id steps around taken ids; a hand-typed taken id is refused with a message instead of overwriting", async () => {
    const opts = options({ mode: "new", source: null, takenIds: () => new Set(["taken-id"]) });
    openUseCaseDialog(opts);
    await flush();
    type($("dialog input[autofocus]"), "Taken id");
    const idInput = $$("dialog input.uc-mono").find((i) => i.placeholder === "derived from the title");
    expect(idInput.value).toBe("taken-id-2");
    type(idInput, "taken-id");
    $("dialog .uc-io-add .uc-link-btn").click();
    type($$("dialog .uc-io-row select")[0], "mapping");
    type($("[data-path='input.0']"), "a: 1");
    $$("dialog .uc-io-add .uc-link-btn")[1].click();
    type($$("dialog .uc-io-row select")[1], "mapping");
    type($("[data-path='output.0']"), "a: 2");
    button("Create use case").click();
    await flush();
    expect($(".uc-foot-msg").textContent).toBe("The id taken-id is already taken.");
    expect(opts.save).not.toHaveBeenCalled();
  });

  it("never overwrites: an id the daemon already has (not among the loaded rows) is stepped around, or refused when typed by hand", async () => {
    const onDaemon = new Set(["pick-up", "pick-up-2"]);
    const fill = async (opts, title, typedId) => {
      const closed = openUseCaseDialog(opts);
      await flush();
      type($("dialog input[autofocus]"), title);
      if (typedId) type($$("dialog input.uc-mono").find((i) => i.placeholder === "derived from the title"), typedId);
      $("dialog .uc-io-add .uc-link-btn").click();
      type($$("dialog .uc-io-row select")[0], "mapping");
      type($("[data-path='input.0']"), "a: 1");
      $$("dialog .uc-io-add .uc-link-btn")[1].click();
      type($$("dialog .uc-io-row select")[1], "mapping");
      type($("[data-path='output.0']"), "a: 2");
      button("Create use case").click();
      return closed;
    };
    const opts = options({ mode: "new", source: null, takenIds: () => new Set(), exists: vi.fn(async (id) => onDaemon.has(id)) });
    const result = await fill(opts, "Pick up");
    expect(result.id).toBe("pick-up-3");
    expect(opts.save.mock.calls[0][0].id).toBe("pick-up-3");
    const refused = options({ mode: "new", source: null, takenIds: () => new Set(), exists: vi.fn(async (id) => onDaemon.has(id)) });
    fill(refused, "Whatever", "pick-up");
    await flush();
    expect($(".uc-foot-msg").textContent).toBe("The id pick-up is already taken.");
    expect(refused.save).not.toHaveBeenCalled();
  });

  it("steps: add, move and remove; the target kind switches the inputs; variants edit when / title", async () => {
    const opts = options();
    openUseCaseDialog(opts);
    await flush();
    const dialog = $("dialog");
    expect($$(".uc-step-edit", dialog)).toHaveLength(3);
    $("button[aria-label='Actions for step 2']", dialog).click();
    $("[role=menuitem][data-value=up]").click();
    expect($$(".uc-step-edit input[aria-label$='action']", dialog).map((i) => i.value)).toEqual(["Picks Pablo", "Taps the step", "Dex gets a push"]);
    $("button[aria-label='Remove step 3']", dialog).click();
    expect($$(".uc-step-edit", dialog)).toHaveLength(2);
    $$(".uc-steps-edit > .uc-link-btn", dialog).at(-1).click();
    expect($$(".uc-step-edit", dialog)).toHaveLength(3);
    const first = $$(".uc-step-edit", dialog)[0];
    $$(".uc-segmented button", first).find((b) => b.textContent === "None").click();
    expect($("input[aria-label='Step 1 screen']", first)).toBeNull();
    $$(".uc-segmented button", first).find((b) => b.textContent === "Element").click();
    expect($("input[aria-label='Step 1 element']", first)).not.toBeNull();
    // variants: toggle a 'when' value
    const variant = $(".uc-variant-edit", dialog);
    const toggle = $$(".uc-value-toggle", variant).find((b) => b.textContent === "Human");
    toggle.click();
    expect($$(".uc-value-toggle", variant).find((b) => b.textContent === "Human").getAttribute("aria-pressed")).toBe("true");
    expect($$(".uc-value-toggle", variant).find((b) => b.textContent === "Agent").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens straight on a fresh variant when asked, and the persona picker adds and removes chips", async () => {
    const draft = draftFromSource(rawUseCase);
    draft.variants.push(blankVariant());
    openUseCaseDialog(options({ initialDraft: draft, focus: { variants: true } }));
    await flush();
    expect($$(".uc-variant-edit")).toHaveLength(3);
    expect(document.activeElement.getAttribute("aria-label")).toBe("Variant 3 title");
    const baseChips = () => $$(".uc-person-chip").filter((chip) => !chip.closest(".uc-variant-edit"));
    $("button[aria-label='Remove Dana']").click();
    expect(baseChips()).toHaveLength(0);
    $(".uc-chip-row .uc-link-btn").click();
    const labels = $$(".uc-menu .uc-menu-item").map((i) => i.querySelector(".uc-menu-label").textContent);
    expect(labels).toContain("Dana");
    $$(".uc-menu .uc-menu-item")[labels.indexOf("Dana")].click();
    expect(baseChips()).toHaveLength(1);
  });
});

describe("persona dialog", () => {
  it("builds the persona payload: traits only where set, goals per line, nulls for cleared fields, generated kept", () => {
    const draft = { name: "Sol", role: "", emoji: "👨", color: "#C27A3A", traits: { size: "medium", actor: "" }, goals: "Find cover\n\n Never ask twice ", description: "", generated: false };
    expect(buildPersonaPayload({ id: "sol", draft, source: null }).payload).toEqual({ id: "sol", name: "Sol", avatar: { emoji: "👨", color: "#C27A3A" }, traits: { size: "medium" }, goals: ["Find cover", "Never ask twice"] });
    const cleared = buildPersonaPayload({ id: "dana", draft: { ...draft, goals: "", role: "" }, source: { role: "Designer", goals: ["x"], generated: true } }).payload;
    expect(cleared).toMatchObject({ role: null, goals: null, generated: null });
    expect(buildPersonaPayload({ id: "BAD", draft, source: null }).errors[0]).toContain("kebab-case");
    expect(buildPersonaPayload({ id: "x", draft: { ...draft, name: " " }, source: null }).errors).toEqual(["A name is required."]);
  });

  it("creates a persona: id from the name, traits from the selects, a hint when a trait value is new to the pool", async () => {
    const save = vi.fn(async () => ({ ok: true, data: {} }));
    const closed = openPersonaDialog({ mode: "new", source: null, pool: () => makePool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    expect(button("Create persona").disabled).toBe(true);
    type($("dialog input[autofocus]"), "Sol");
    const selects = $$("dialog select");
    expect(selects[0].getAttribute("aria-label")).toBe("Kind"); // a new persona starts as a human
    expect(selects[0].value).toBe("human");
    type(selects[1], "large"); // size: Large project (Dex has it) ...
    type(selects[2], ""); // ... the next dimension stays Any
    expect($(".uc-hint").hidden).toBe(true);
    type(document.querySelectorAll("dialog textarea")[1], "Find cover\nNever ask twice"); // [0] is the description
    button("Create persona").click();
    const result = await closed;
    expect(result.id).toBe("sol");
    expect(save.mock.calls[0][0]).toMatchObject({ id: "sol", name: "Sol", kind: "human", traits: { size: "large" }, goals: ["Find cover", "Never ask twice"] });
  });

  it("keeps a stored named colour byte-identical on save, and a swatch click still sets the colour", async () => {
    const source = { ...makePool().personas[2], avatar: { emoji: "🧑", color: "teal" } };
    const save = vi.fn(async () => ({ ok: true, data: {} }));
    const kept = openPersonaDialog({ mode: "edit", source, pool: () => makePool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Renamed");
    button("Save persona").click();
    await kept;
    expect(save.mock.calls[0][0].avatar.color).toBe("teal");
    const save2 = vi.fn(async () => ({ ok: true, data: {} }));
    const picked = openPersonaDialog({ mode: "edit", source, pool: () => makePool(), takenIds: () => new Set(), save: save2, remove: vi.fn() });
    await flush();
    const swatch = $$("dialog .uc-swatch-btn")[1];
    swatch.click();
    button("Save persona").click();
    await picked;
    expect(save2.mock.calls[0][0].avatar.color).toBe(swatch.getAttribute("aria-label"));
    expect(save2.mock.calls[0][0].avatar.color).not.toBe("teal");
  });

  it("a persona stored without a colour stays without one on save, until a swatch is clicked", async () => {
    const source = { ...makePool().personas[2], avatar: { emoji: "🧑" } };
    const save = vi.fn(async () => ({ ok: true, data: {} }));
    const kept = openPersonaDialog({ mode: "edit", source, pool: () => makePool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Renamed");
    button("Save persona").click();
    await kept;
    expect(save.mock.calls[0][0].avatar).toEqual({ emoji: "🧑" });
    const save2 = vi.fn(async () => ({ ok: true, data: {} }));
    const picked = openPersonaDialog({ mode: "edit", source, pool: () => makePool(), takenIds: () => new Set(), save: save2, remove: vi.fn() });
    await flush();
    $$("dialog .uc-swatch-btn")[0].click();
    button("Save persona").click();
    await picked;
    expect(save2.mock.calls[0][0].avatar.color).toBeTruthy();
  });

  it("a new persona still gets the default palette colour", async () => {
    const save = vi.fn(async () => ({ ok: true, data: {} }));
    const closed = openPersonaDialog({ mode: "new", source: null, pool: () => makePool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Sol");
    button("Create persona").click();
    await closed;
    expect(save.mock.calls[0][0].avatar.color).toMatch(/^#/);
  });

  it("edit mode keeps the id, marks a generated persona and deletes after a confirmation line", async () => {
    const remove = vi.fn(async () => ({ ok: true, data: { warnings: [{ kind: "dangling_reference", message: "used by assign" }] } }));
    const closed = openPersonaDialog({ mode: "edit", source: makePool().personas[2], pool: () => makePool(), takenIds: () => new Set(), save: vi.fn(), remove });
    await flush();
    expect($("dialog .uc-generated").textContent).toContain("Generated");
    expect($$("dialog input.uc-mono").find((i) => i.readOnly)).toBeTruthy();
    button("Delete").click();
    expect($(".uc-foot-msg").textContent).toContain("Nothing is repaired");
    button("Delete Medium project").click();
    await flush();
    const result = await closed;
    expect(remove).toHaveBeenCalledWith("gen-medium");
    expect(result).toMatchObject({ id: "gen-medium", deleted: true });
  });
});

describe("dimension dialog and data object dialog", () => {
  it("builds dimension payloads: ids from the labels, unique, at least one value", () => {
    const draft = { name: "Actor type", description: "", values: [{ id: "", label: "Human" }, { id: "agent", label: "Agent" }] };
    expect(buildDimensionPayload({ id: "actor", draft, source: null }).payload).toEqual({ id: "actor", name: "Actor type", values: [{ id: "human", label: "Human" }, { id: "agent", label: "Agent" }] });
    expect(buildDimensionPayload({ id: "actor", draft: { ...draft, values: [] }, source: null }).errors).toContain("Add at least one value.");
    expect(buildDimensionPayload({ id: "actor", draft: { ...draft, values: [{ id: "", label: "A" }, { id: "a", label: "Again" }] }, source: null }).errors).toContain("Two values share an id.");
  });

  it("creates a dimension through the dialog", async () => {
    const save = vi.fn(async () => ({ ok: true, data: {} }));
    const closed = openDimensionDialog({ mode: "new", source: null, takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Work schedule");
    const values = $$("dialog .uc-value-row input");
    type(values[0], "Office hours");
    type(values[1], "Shifts");
    button("Create dimension").click();
    await closed;
    expect(save.mock.calls[0][0]).toEqual({ id: "work-schedule", name: "Work schedule", values: [{ id: "office-hours", label: "Office hours" }, { id: "shifts", label: "Shifts" }] });
  });

  it("builds data object payloads: typed examples, enum values, ref target, undeclared field descriptions kept", () => {
    const draft = {
      name: "Mapping",
      description: "",
      fields: [
        { name: "datum", type: "date", values: "", ref: "", example: "2026-05-14" },
        { name: "status", type: "enum", values: "draft, ready", ref: "", example: "ready", description: "state" },
        { name: "owner", type: "ref", values: "", ref: "owner", example: "" },
        { name: "anzahl", type: "number", values: "", ref: "", example: "3" },
      ],
    };
    expect(buildObjectPayload({ id: "mapping", draft, source: null }).payload.fields).toEqual([
      { name: "datum", type: "date", example: "2026-05-14" },
      { name: "status", type: "enum", values: ["draft", "ready"], description: "state", example: "ready" },
      { name: "owner", type: "ref", ref: "owner" },
      { name: "anzahl", type: "number", example: 3 },
    ]);
    expect(buildObjectPayload({ id: "x", draft: { ...draft, fields: [{ name: "a", type: "string", values: "", ref: "", example: "" }, { name: "a", type: "string", values: "", ref: "", example: "" }] }, source: null }).errors).toEqual(["The field a appears twice."]);
  });

  it("creates a data object through the dialog", async () => {
    const save = vi.fn(async () => ({ ok: true, data: {} }));
    const closed = openObjectDialog({ mode: "new", source: null, pool: () => makePool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Notification");
    const row = $(".uc-field-row");
    type($("input[aria-label='Field 1 name']", row), "text");
    type($("input[aria-label='Field 1 example']", row), "Pablo takes over");
    button("Create data object").click();
    await closed;
    expect(save.mock.calls[0][0]).toEqual({ id: "notification", name: "Notification", fields: [{ name: "text", type: "string", example: "Pablo takes over" }] });
  });
});

describe("generate personas dialog", () => {
  it("previews with a dry run first, writes nothing until 'Create', and sends the same settings", async () => {
    const generate = vi.fn(async (input) =>
      input.dry_run
        ? { ok: true, data: { dry_run: true, strategy: "pairwise", total: 45, skipped_covered: 9, would_create: 2, personas: [{ id: "a", name: "A · 1", traits: { size: "small" } }, { id: "b", name: "B · 2", traits: { size: "large" } }] } }
        : { ok: true, data: { created: 2, ids: ["a", "b"] } },
    );
    const closed = openGenerateDialog({ pool: () => makePool(), generate });
    await flush();
    expect(button("Create personas").disabled).toBe(true); // nothing previewed yet
    $$("dialog button").find((b) => b.textContent.includes("Preview")).click();
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toEqual({ strategy: "pairwise", limit: 100, dry_run: true });
    expect($(".uc-preview-summary").textContent).toContain("2 would be created");
    expect($(".uc-preview-summary").textContent).toContain("45 value pairs");
    expect($$(".uc-preview-list li")).toHaveLength(2);
    type($("dialog input[type=number]"), "10"); // changing a setting invalidates the preview
    expect(button("Create 2 personas") ?? button("Create personas")).toBeTruthy();
    expect($(".uc-preview-summary")).toBeNull();
    $$("dialog button").find((b) => b.textContent.includes("Preview")).click();
    await flush();
    expect(generate.mock.calls[1][0]).toMatchObject({ limit: 10, dry_run: true });
    $$("dialog .uc-foot-actions button").pop().click();
    const result = await closed;
    expect(generate.mock.calls[2][0]).toEqual({ strategy: "pairwise", limit: 10 });
    expect(result.created).toBe(2);
  });

  it("starts with Preview disabled and a note when no persona-scoped dimension exists (CHR-1144)", async () => {
    const generate = vi.fn();
    openGenerateDialog({ pool: () => makePool({ dimensions: [{ id: "household", name: "Household", scope: "constellations", values: [{ id: "single", label: "Single" }] }] }), generate });
    await flush();
    expect($$("dialog button").find((b) => b.textContent.includes("Preview")).disabled).toBe(true);
    expect($("dialog").textContent).toContain("Only persona-scoped dimensions apply");
    expect($$("dialog .uc-gen-dims input")).toHaveLength(0);
  });

  it("restricts to the checked dimensions and offers all combinations as a strategy", async () => {
    const generate = vi.fn(async () => ({ ok: true, data: { dry_run: true, strategy: "all", total: 3, skipped_covered: 0, would_create: 0, personas: [] } }));
    openGenerateDialog({ pool: () => makePool(), generate });
    await flush();
    $$("dialog .uc-segmented button").find((b) => b.textContent === "All combinations").click();
    const boxes = $$("dialog input[type=checkbox]");
    boxes[1].checked = false;
    boxes[1].dispatchEvent(new Event("change", { bubbles: true }));
    $$("dialog button").find((b) => b.textContent.includes("Preview")).click();
    await flush();
    expect(generate.mock.calls[0][0]).toEqual({ strategy: "all", dimensions: ["size"], limit: 100, dry_run: true });
    expect($(".uc-preview").textContent).toContain("Nothing to create");
    expect($$("dialog .uc-foot-actions button").pop().disabled).toBe(true);
  });
});

describe("generate personas: partial result", () => {
  it("the dry run says when the result is only a prefix (partial_result), and the preview counts from would_create", async () => {
    const warning = { kind: "partial_result", message: "generation stopped at its work budget" };
    const personas = Array.from({ length: 50 }, (_, i) => ({ id: "p" + i, name: "P " + i, traits: {} }));
    const generate = vi.fn(async () => ({ ok: true, data: { dry_run: true, strategy: "pairwise", total: 900, skipped_covered: 0, would_create: 80, personas_truncated: true, partial: true, warnings: [warning], personas } }));
    openGenerateDialog({ pool: () => makePool(), generate });
    await flush();
    $$("dialog button").find((b) => b.textContent.includes("Preview")).click();
    await flush();
    const text = $(".uc-preview").textContent;
    expect(text).toContain("80 would be created");
    expect(text).toContain("generation stopped at its work budget");
    expect(text).toContain("and 68 more");
    expect(text).not.toContain("null"); // an absent block must not leave a text node behind
    expect($$("dialog .uc-foot-actions button").pop().textContent).toBe("Create 80 personas");
  });
});

describe("menu with typed values", () => {
  it("a list the facets could not hold completely lets the typed text be picked", async () => {
    const { openMenu } = await import("./usecases-menu.js");
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const onPick = vi.fn();
    openMenu({ anchor, label: "Tag", items: [{ value: "actor", label: "actor" }], filterable: true, allowCustom: true, onPick });
    const input = document.querySelector(".uc-menu-filter");
    input.value = "rare-tag";
    input.dispatchEvent(new Event("input"));
    const custom = [...document.querySelectorAll(".uc-menu-item")].find((i) => i.textContent.includes("Filter by"));
    custom.click();
    expect(onPick).toHaveBeenCalledWith("rare-tag");
  });

  it("a refused delete lists the references and offers Delete anyway, which is the only call with force", async () => {
    const refusal = { ok: false, status: 409, code: "conflict", message: 'persona "gen-medium" is still referenced by 1 use case(s): borrow-book — remove these references first (set_use_cases), or pass force: true to delete anyway' };
    const remove = vi.fn(async (_id, force) => (force ? { ok: true, data: { warnings: [] } } : refusal));
    const closed = openPersonaDialog({ mode: "edit", source: makePool().personas[2], pool: () => makePool(), takenIds: () => new Set(), save: vi.fn(), remove });
    await flush();
    button("Delete").click();
    button("Delete Medium project").click();
    await flush();
    expect(remove.mock.calls).toEqual([["gen-medium"]]); // the first call never sends force
    expect($(".uc-foot-msg").textContent).toContain("Medium project is still used by 1 use case: Borrow book.");
    expect($(".uc-foot-msg").textContent).not.toContain("(s)");
    expect($(".uc-foot-msg").textContent).not.toContain("force: true");
    expect($("dialog")).not.toBeNull(); // still open, nothing deleted
    button("Delete anyway").click();
    await flush();
    expect(remove.mock.calls).toEqual([["gen-medium"], ["gen-medium", true]]);
    expect(await closed).toMatchObject({ id: "gen-medium", deleted: true });
  });

  it("Keep it after a refusal deletes nothing and never sends force", async () => {
    const remove = vi.fn(async () => ({ ok: false, status: 409, code: "conflict", message: 'cannot safely delete persona "x" — reference check is incomplete because the following case file(s) failed to load: usecases/cases/a.json — repair them, or pass force: true to delete anyway' }));
    openPersonaDialog({ mode: "edit", source: makePool().personas[2], pool: () => makePool(), takenIds: () => new Set(), save: vi.fn(), remove });
    await flush();
    button("Delete").click();
    button("Delete Medium project").click();
    await flush();
    expect($(".uc-foot-msg").textContent).toContain("usecases/cases/a.json could not be read");
    button("Keep it").click();
    expect(button("Delete anyway")).toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("gen-medium");
  });
});

describe("refusalText: the human sentence of a refused delete", () => {
  const msg = (text) => `${text} — remove these references first (set_use_cases), or pass force: true to delete anyway`;

  it("singular: one referrer, no (s), uppercase start, the display name", () => {
    expect(refusalText(msg('persona "staff-lee" is still referenced by 1 use case(s): borrow-book'), "staff Lee")).toBe("Staff Lee is still used by 1 use case: Borrow book.");
  });

  it("plural: several referrers as a list, the +N more tail kept as words", () => {
    expect(refusalText(msg('persona "staff-lee" is still referenced by 7 use case(s): borrow-book, return-book, renew-loan, pay-fine, join-library, +2 more'), "Lee")).toBe(
      "Lee is still used by 7 use cases: Borrow book, Return book, Renew loan, Pay fine, Join library and 2 more.",
    );
  });

  it("several groups become several sentences; (ies) and variant ids read naturally", () => {
    const text = refusalText(msg('entity "copy-42" is still referenced by 1 constellation(s): ana-and-copy; entity "copy-42" is still referenced by 2 use case(s) as a state, condition or trigger subject: borrow-book, return-book'), "Copy 42");
    expect(text).toBe("Copy 42 is still used by 1 constellation: Ana and copy. It is also still used by 2 use cases as a state, condition or trigger subject: Borrow book, Return book.");
    expect(refusalText(msg('dimension "membership" is still referenced by 2 entity(ies): a, b'), "Membership")).toContain("2 entities");
    expect(refusalText(msg('dimension "membership" is still referenced by 1 entity(ies): a'), "Membership")).toContain("1 entity:");
    expect(refusalText(msg('constellation "x" is still referenced by 1 use case(s) or variant(s): borrow-book#staff-for-member'), "X")).toContain("Borrow book, variant staff for member");
  });

  it("the unreadable-files refusal keeps its own sentence", () => {
    expect(refusalText('cannot safely delete persona "x" — reference check is incomplete because the following case file(s) failed to load: usecases/cases/a.json — repair them, or pass force: true to delete anyway', "X")).toBe("The reference check is incomplete: usecases/cases/a.json could not be read.");
  });
});
